import json

from fastapi.testclient import TestClient

from fury_render.api import FRAME_KEY, BlobStore, frame_digest, validate_request
from fury_render.frames import FrameCache, S3Frames
from fury_render.gateway import create_gateway
from scene_kit import Kit, request


class FakeRemote:
    def __init__(self):
        self.objects: dict[str, bytes] = {}
        self.reads = 0

    def get(self, key):
        self.reads += 1
        return self.objects.get(key)

    def put(self, key, data):
        self.objects[key] = data


def test_frame_cache_reads_local_then_remote_and_backfills(tmp_path):
    remote = FakeRemote()
    local = BlobStore(str(tmp_path), 1 << 20)
    cache = FrameCache(local, remote)
    key = "a" * 64
    assert cache.read(key) is None and cache.hits["miss"] == 1
    remote.objects[key] = b"from the bucket"
    assert cache.read(key) == b"from the bucket" and cache.hits["remote"] == 1
    # Back-filled: the next read never touches the bucket.
    reads = remote.reads
    assert cache.read(key) == b"from the bucket" and remote.reads == reads
    # A write lands in both.
    other = "b" * 64
    cache.put(other, b"rendered")
    cache.flush()
    assert remote.objects[other] == b"rendered" and local.read(other) == b"rendered"


def test_frame_cache_without_a_bucket_is_just_the_local_store(tmp_path):
    cache = FrameCache(BlobStore(str(tmp_path), 1 << 20))
    cache.put("c" * 64, b"x")
    assert cache.read("c" * 64) == b"x" and cache.read("d" * 64) is None


def test_s3_frames_treats_a_missing_key_as_a_miss_and_an_outage_as_a_miss():
    class Body:
        def read(self):
            return b"webp"

    class Client:
        def __init__(self):
            self.calls = []

        def get_object(self, Bucket, Key):
            self.calls.append(("get", Bucket, Key))
            if Key.endswith("missing"):
                error = Exception("nope")
                error.response = {"Error": {"Code": "NoSuchKey"}}
                raise error
            if Key.endswith("down"):
                raise ConnectionError("outage")
            return {"Body": Body()}

        def put_object(self, **kwargs):
            self.calls.append(("put", kwargs["Bucket"], kwargs["Key"]))

    store = S3Frames("bucket", prefix="frames/", endpoint="https://r2.example")
    store._client = Client()
    assert store.get("present") == b"webp"
    assert store.get("missing") is None
    assert store.get("down") is None
    store.put("new", b"data")
    assert store._client.calls[-1] == ("put", "bucket", "frames/new")


def test_gateway_answers_a_stored_frame_without_waking_a_gpu():
    calls = []

    async def dispatch(method, path, body, client, session):
        calls.append(path)
        return 200, {"x-render-ms": "9"}, b"rendered"

    remote = FakeRemote()
    app = create_gateway(dispatch, r"^https://test\.example$", frames=remote)
    body = request(Kit().scene())
    body["output"] = "frame"
    body["quality"] = {"samples": 256, "threshold": 0.03, "timeLimit": 6}
    body["finish"] = {"exposure": 1, "gain": 1.1892}
    with TestClient(app) as client:
        # Nothing stored: the GPU renders it.
        first = client.post("/render?session=abcdefgh", json=body)
        assert first.status_code == 200 and first.content == b"rendered"
        assert calls == ["/render"]
        # The key the renderer would store it under: the gateway computes the same one, from the
        # body as it forwards it (time limit capped, session prefixed, both outside the digest).
        forwarded = json.loads(json.dumps(body))
        forwarded["quality"]["timeLimit"] = min(15, forwarded["quality"]["timeLimit"])
        key = frame_digest(validate_request(forwarded))
        remote.objects[key] = FRAME_KEY.pack(-1.25) + b"\x52IFFwebp"
        second = client.post("/render?session=abcdefgh", json=body)
        assert second.status_code == 200
        assert second.content == b"\x52IFFwebp"
        assert second.headers["x-cache"] == "hit"
        assert second.headers["x-cache-store"] == "gateway"
        assert second.headers["x-traced-key"] == "-1.2500"
        assert second.headers["content-type"] == "image/webp"
        # No GPU call, and the session did not take a GPU place.
        assert calls == ["/render"]
        health = client.get("/health").json()
        assert health["sessions"]["active"] == 1  # the first render admitted it
        # A view (not a frame) never consults the bucket.
        view = request(Kit().scene())
        client.post("/render?session=abcdefgh", json=view)
        assert calls == ["/render", "/render"]
