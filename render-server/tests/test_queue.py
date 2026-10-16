"""The render queue's order and the blob store's budget (no Blender needed)."""

import asyncio
import os

import pytest

from fury_render.api import PRIORITY, BlobStore, RenderQueue, uninterrupted


def test_waiting_views_go_ahead_of_pre_renders():
    async def scenario():
        queue = RenderQueue()
        order = []

        async def job(name, kind, hold=0.0):
            async with queue.turn(PRIORITY[kind]):
                order.append(name)
                await asyncio.sleep(hold)

        # A pre-render is in progress; it is never interrupted.
        first = asyncio.create_task(job("orbit-1", "orbit", 0.05))
        await asyncio.sleep(0.01)
        waiting = [
            asyncio.create_task(job("orbit-2", "orbit")),
            asyncio.create_task(job("view", "view")),
            asyncio.create_task(job("preview", "preview")),
        ]
        await asyncio.gather(first, *waiting)
        return order

    assert asyncio.run(scenario()) == ["orbit-1", "preview", "view", "orbit-2"]


def test_a_cancelled_wait_does_not_block_the_queue():
    async def scenario():
        queue = RenderQueue()
        await queue.acquire(1)
        gone = asyncio.create_task(queue.acquire(0))
        await asyncio.sleep(0)
        gone.cancel()
        later = asyncio.create_task(queue.acquire(1))
        await asyncio.sleep(0)
        queue.release()
        await asyncio.wait_for(later, 1)
        queue.release()
        return queue.busy

    assert asyncio.run(scenario()) is False


def test_a_render_cancelled_midway_keeps_its_worker_until_it_ends():
    async def scenario():
        queue = RenderQueue()
        rendered = asyncio.Event()
        order = []

        async def blender():
            await rendered.wait()
            order.append("first rendered")
            return "frame"

        async def job(name, work):
            async with queue.turn(1):
                order.append(name)
                return await uninterrupted(work)

        first = asyncio.create_task(job("first", blender()))
        await asyncio.sleep(0.01)
        second = asyncio.create_task(job("second", asyncio.sleep(0, "frame")))
        await asyncio.sleep(0.01)
        # The gateway stopped waiting: the render goes on, and so does the worker's turn.
        first.cancel()
        await asyncio.sleep(0.01)
        assert order == ["first"] and queue.busy
        rendered.set()
        assert await asyncio.wait_for(second, 1) == "frame"
        with pytest.raises(asyncio.CancelledError):
            await first
        return order, queue.busy

    assert asyncio.run(scenario()) == (["first", "first rendered", "second"], False)


def test_uninterrupted_work_reports_its_own_failure():
    async def scenario():
        async def broken():
            raise RuntimeError("the renderer stopped")

        await uninterrupted(broken())

    with pytest.raises(RuntimeError, match="the renderer stopped"):
        asyncio.run(scenario())


def test_renders_side_by_side_on_every_worker():
    async def scenario():
        queue = RenderQueue(workers=2)
        running, most, order = set(), 0, []

        async def job(name, priority):
            nonlocal most
            async with queue.turn(priority) as worker:
                assert worker not in running
                running.add(worker)
                most = max(most, len(running))
                order.append(name)
                await asyncio.sleep(0.02)
                running.discard(worker)

        tasks = [asyncio.create_task(job("a", 5)), asyncio.create_task(job("b", 5))]
        await asyncio.sleep(0.005)
        # Both workers are busy: these wait, the more urgent first.
        tasks += [asyncio.create_task(job("later", 5)), asyncio.create_task(job("now", 0))]
        await asyncio.gather(*tasks)
        return most, order, queue.busy, sorted(queue.free)

    assert asyncio.run(scenario()) == (2, ["a", "b", "now", "later"], False, [0, 1])


def test_blob_store_prunes_oldest_beyond_budget(tmp_path):
    store = BlobStore(str(tmp_path), budget=250)
    keys = [f"{i:064x}" for i in range(3)]
    for i, key in enumerate(keys):
        store.put(key, bytes(100))
        os.utime(store.path(key), (1000 + i, 1000 + i))
    assert not store.has(keys[0]) and store.has(keys[1]) and store.has(keys[2])
    # A new store on the same directory (a container starting cold) sees what is there.
    again = BlobStore(str(tmp_path), budget=250)
    assert again.total == 200 and again.has(keys[2])


def test_service_reports_cold_start_on_its_first_responses(tmp_path):
    """Every response says how long boot took and how old the container is; the first few after
    boot are marked cold, so the browser's timeline can tell a cold GPU from a slow one."""
    import time

    from fury_render.api import COLD_RESPONSES, Service, Settings

    service = Service(Settings(blob_dir=str(tmp_path / "b"), frame_dir=str(tmp_path / "f")))
    # Not started yet: no boot time to report, but the first responses still count as cold.
    assert service.timing_headers() == {"X-Cold": "1"}
    service.boot_ready = time.perf_counter()
    headers = [service.timing_headers() for _ in range(COLD_RESPONSES + 1)]
    assert all("X-Cold" in h for h in headers[: COLD_RESPONSES - 1])
    assert "X-Cold" not in headers[-1]
    assert int(headers[-1]["X-Boot-Ms"]) >= 0 and int(headers[-1]["X-Container-Age-Ms"]) >= 0
