import gzip
import hashlib
import json

import pytest
from fastapi.testclient import TestClient

from fury_render.gateway import create_gateway
from fury_render.protocol import ProtocolError, decompress
from scene_kit import Kit, request


@pytest.fixture
def gateway():
    calls = []

    async def dispatch(method, path, body, client, session):
        calls.append((method, path, body, client, session))
        return 200, {"x-device": "test"}, b"result"

    app = create_gateway(dispatch, r"^https://test\.example$")
    with TestClient(app) as client:
        yield client, calls


def test_forwards_renders_and_uploads_without_a_pin(gateway):
    client, calls = gateway
    assert client.get("/health").json()["ok"]
    assert client.post("/auth", json={"pin": "fury"}).status_code in (404, 405)
    response = client.post("/render", json=request(Kit().scene()))
    assert response.status_code == 200 and response.content == b"result"
    assert response.headers["cache-control"] == "no-store"
    assert len(calls) == 1
    data = b"geometry"
    assert (
        client.put(
            "/blobs/" + hashlib.sha256(data).hexdigest(), content=gzip.compress(data)
        ).status_code
        == 200
    )
    assert calls[-1][2] == data


def test_caps_render_time(gateway):
    client, calls = gateway
    body = request(Kit().scene())
    body["quality"] = {"timeLimit": 60}
    assert client.post("/render", json=body).status_code == 200
    forwarded = json.loads(calls[-1][2])
    assert forwarded["quality"]["timeLimit"] == 15


def test_bad_inputs_and_render_throttle(gateway, monkeypatch):
    import fury_render.api as api

    # A frozen clock: the bucket does not refill while the test sends its requests.
    monkeypatch.setattr(api.time, "monotonic", lambda: 1000.0)
    client, calls = gateway
    assert client.post("/render", content=b"[]").status_code == 400
    assert client.put("/blobs/" + "a" * 64, content=b"wrong").status_code == 400
    # The malformed request above took one of the burst of 240.
    body = request(Kit().scene())
    for _ in range(239):
        assert client.post("/render", json=body).status_code == 200
    assert client.post("/render", json=body).status_code == 429
    assert len(calls) == 239


def test_bounded_gzip_and_concatenated_members():
    assert decompress(gzip.compress(b"abc"), 3) == b"abc"
    with pytest.raises(ProtocolError):
        decompress(gzip.compress(b"x" * 10000), 100)
    with pytest.raises(ProtocolError):
        decompress(gzip.compress(b"ab") + gzip.compress(b"cd"), 3)
    with pytest.raises(ProtocolError):
        decompress(b"\x1f\x8b\x08\x00\x00\x00\x00\x00\x00\xff\xff\xff", 100)


def test_gzip_bomb_never_dispatches(gateway, monkeypatch):
    import fury_render.gateway as module

    client, calls = gateway
    monkeypatch.setattr(module, "MAX_SCENE_BYTES", 100)
    assert client.post("/render", content=gzip.compress(b"x" * 1000)).status_code == 400
    assert calls == []


def test_texture_urls_are_never_fetched(tmp_path):
    import asyncio
    from fury_render.api import Service, Settings

    kit = Kit()
    scene = kit.scene()
    assert scene["textures"]
    for texture in scene["textures"].values():
        texture["url"] = "http://127.0.0.1:8787/private"
    service = Service(Settings(blob_dir=str(tmp_path)))
    missing = asyncio.run(service.missing(scene))
    assert all(texture["blob"] in missing for texture in scene["textures"].values())


def test_cors(gateway):
    client, calls = gateway
    for origin, expected in [("https://test.example", 200), ("https://evil.example", 400)]:
        response = client.options(
            "/render",
            headers={
                "Origin": origin,
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type",
            },
        )
        assert response.status_code == expected
    assert calls == []


def test_images_stay_compressed_through_the_private_call():
    import asyncio

    from fastapi import FastAPI
    from fastapi.responses import Response

    from fury_render.rpc import call_app

    image = bytes(range(256)) * 4096
    packed = gzip.compress(image, mtime=0)
    renderer = FastAPI()

    @renderer.post("/render")
    async def render():
        return Response(packed, headers={"Content-Encoding": "gzip", "X-Image-Width": "2"})

    status, headers, content = asyncio.run(call_app(renderer, "POST", "/render", b"{}", "s"))
    assert status == 200 and content == packed
    assert headers["content-encoding"] == "gzip" and "content-length" not in headers

    async def dispatch(method, path, body, client, session):
        return await call_app(renderer, method, path, body, client)

    app = create_gateway(dispatch, r"^https://test\.example$")
    with TestClient(app) as client:
        response = client.post("/render", json=request(Kit().scene()))
    # The browser receives the compressed bytes and inflates them itself.
    assert response.headers["content-encoding"] == "gzip"
    assert int(response.headers["content-length"]) == len(packed)
    assert response.content == image and response.headers["x-image-width"] == "2"


def test_a_call_the_gateway_stops_waiting_for_is_cancelled():
    import asyncio
    from types import SimpleNamespace

    from fury_render.rpc import answer_or_cancel

    class Call:
        def __init__(self, answer=None):
            self.answer, self.cancelled = answer, False

            async def get():
                if self.answer is None:
                    await asyncio.Event().wait()  # Still waiting for a GPU to be placed.
                return self.answer

            async def cancel():
                self.cancelled = True

            self.get, self.cancel = SimpleNamespace(aio=get), SimpleNamespace(aio=cancel)

    async def spawn(call, accepted=None):
        if accepted:
            await accepted.wait()
        return call

    async def scenario():
        answered, stuck, late = Call((200, {}, b"frame")), Call(), Call()
        assert await answer_or_cancel(spawn(answered)) == (200, {}, b"frame")
        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(answer_or_cancel(spawn(stuck)), 0.01)
        # The wait ends while Modal is still accepting the call: it is cancelled once it exists.
        accepted = asyncio.Event()
        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(answer_or_cancel(spawn(late, accepted)), 0.01)
        assert not late.cancelled
        accepted.set()
        for _ in range(3):
            await asyncio.sleep(0)
        return answered.cancelled, stuck.cancelled, late.cancelled

    # Left queued, these calls would be rendered for no one once the GPU starts.
    assert asyncio.run(scenario()) == (False, True, True)


def test_each_render_session_has_a_gpu_of_its_own(gateway):
    client, calls = gateway
    body = request(Kit().scene())
    for session in ("visitor-one", "visitor-two"):
        assert client.post("/render", json=body, params={"session": session}).status_code == 200
    data = b"geometry"
    key = hashlib.sha256(data).hexdigest()
    client.put(f"/blobs/{key}", content=data, params={"session": "visitor-two"})
    assert [call[4] for call in calls] == ["visitor-one", "visitor-two", "visitor-two"]
    # A page from before sessions shares one; a malformed session is refused.
    client.post("/render", json=body)
    assert calls[-1][4] == "shared-session"
    count = len(calls)
    assert client.post("/render", json=body, params={"session": "a/b"}).status_code == 400
    assert len(calls) == count


def test_sessions_beyond_the_limit_render_on_their_own(monkeypatch):
    import fury_render.gateway as gateway_module

    calls = []

    async def dispatch(method, path, body, client, session):
        calls.append(session)
        return 200, {}, b"frame"

    clock = [1000.0]
    monkeypatch.setattr(gateway_module.time, "monotonic", lambda: clock[0])
    app = create_gateway(dispatch, r"^https://test\.example$", max_sessions=2)
    body = request(Kit().scene())

    def post(session):
        return client.post("/render", json=body, params={"session": session})

    with TestClient(app) as client:
        # A malformed request takes no place.
        bad = client.post("/render", content=b"[]", params={"session": "session-zz"})
        assert bad.status_code == 400
        assert post("session-aa").status_code == 200
        assert post("session-bb").status_code == 200
        # Both GPUs are taken: a third session is told so, without starting a GPU.
        full = post("session-cc")
        assert full.status_code == 503 and full.json()["full"] is True
        assert calls == ["session-aa", "session-bb"]
        # A session that has its GPU keeps it.
        clock[0] += 100
        assert post("session-aa").status_code == 200
        # Once the other has been idle for two minutes, its place goes to the waiting session.
        clock[0] += 30
        assert post("session-cc").status_code == 200
        assert post("session-bb").json()["full"] is True
    assert calls == ["session-aa", "session-bb", "session-aa", "session-cc"]


def test_timing_headers_and_health_report_sessions():
    """The gateway stamps its dispatch time on every forwarded response, and /health reports the
    session table and, for a session holding a GPU, that renderer's own state."""
    calls = []

    async def dispatch(method, path, body, client, session):
        calls.append((method, path, session))
        if path == "/health":
            return 200, {}, json.dumps({"ok": True, "device": "OPTIX", "bootMs": 12345}).encode()
        return 200, {"x-render-ms": "7", "x-cold": "1"}, b"result"

    app = create_gateway(dispatch, r"^https://test\.example$", max_sessions=2)
    with TestClient(app) as client:
        # Before any render: the table is empty and no GPU is asked anything.
        health = client.get("/health").json()
        assert health["sessions"] == {"limit": 2, "active": 0, "idleSeconds": 120, "ages": {}}
        assert "renderer" not in health
        # A session that has not rendered gets no renderer report (that would start a GPU).
        assert "renderer" not in client.get("/health?session=abcdefgh").json()
        assert calls == []

        response = client.post("/render?session=abcdefgh", json=request(Kit().scene()))
        assert response.status_code == 200
        assert int(response.headers["x-dispatch-ms"]) >= 0
        # The renderer's own cold-start headers pass through.
        assert response.headers["x-cold"] == "1" and response.headers["x-render-ms"] == "7"

        health = client.get("/health?session=abcdefgh").json()
        assert health["sessions"]["active"] == 1 and "abcdefgh" in health["sessions"]["ages"]
        assert health["renderer"] == {"ok": True, "device": "OPTIX", "bootMs": 12345}
        assert health["rendererMs"] >= 0
        assert calls[-1] == ("GET", "/health", "abcdefgh")
