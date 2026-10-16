"""Finished frames kept for good, and shared: a local store in front of an S3-compatible bucket.

A showroom still (angles.ts) is named by everything that determines it (api.frame_digest), so once
rendered for one visitor it is the right image for everyone who looks at the same design from the
same angle. The renderer's volume keeps recent frames; the bucket keeps all of them, across
containers and deploys, and the gateway answers a hit from it without waking a GPU.

Configured by environment (all optional; with no bucket, only the local store is used):

    FURY_FRAME_BUCKET    bucket name
    FURY_FRAME_ENDPOINT  endpoint URL for an S3-compatible store (Cloudflare R2, MinIO, …)
    FURY_FRAME_PREFIX    key prefix, default "frames/"
    FURY_FRAME_REGION    region, default "auto"
    AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY  credentials (boto3's usual sources work too)
"""

from __future__ import annotations

import logging
import os
from concurrent.futures import ThreadPoolExecutor
from typing import Protocol

log = logging.getLogger(__name__)


class LocalFrames(Protocol):
    def read(self, key: str) -> bytes | None: ...

    def put(self, key: str, data: bytes) -> None: ...


class RemoteFrames(Protocol):
    """A durable store; failures are logged, never raised to the request."""

    def get(self, key: str) -> bytes | None: ...

    def put(self, key: str, data: bytes) -> None: ...


class S3Frames:
    """Frames in an S3-compatible bucket. boto3 is imported on first use."""

    def __init__(
        self,
        bucket: str,
        prefix: str = "frames/",
        endpoint: str | None = None,
        region: str = "auto",
    ):
        self.bucket = bucket
        self.prefix = prefix
        self.endpoint = endpoint
        self.region = region
        self._client = None

    @property
    def client(self):
        if self._client is None:
            import boto3  # noqa: PLC0415 - optional dependency

            self._client = boto3.client(
                "s3", endpoint_url=self.endpoint or None, region_name=self.region
            )
        return self._client

    def _key(self, key: str) -> str:
        return f"{self.prefix}{key}"

    def get(self, key: str) -> bytes | None:
        try:
            answer = self.client.get_object(Bucket=self.bucket, Key=self._key(key))
            return answer["Body"].read()
        except Exception as error:  # noqa: BLE001 - a miss or an outage both mean "render"
            code = getattr(error, "response", {}).get("Error", {}).get("Code", "")
            if code not in ("NoSuchKey", "404", "NotFound"):
                log.warning("Frame bucket read failed for %s: %r", key, error)
            return None

    def put(self, key: str, data: bytes) -> None:
        try:
            self.client.put_object(
                Bucket=self.bucket,
                Key=self._key(key),
                Body=data,
                ContentType="application/octet-stream",
                CacheControl="public, max-age=31536000, immutable",
            )
        except Exception as error:  # noqa: BLE001
            log.warning("Frame bucket write failed for %s: %r", key, error)


def remote_frames_from_env() -> S3Frames | None:
    bucket = os.environ.get("FURY_FRAME_BUCKET")
    if not bucket:
        return None
    return S3Frames(
        bucket,
        prefix=os.environ.get("FURY_FRAME_PREFIX", "frames/"),
        endpoint=os.environ.get("FURY_FRAME_ENDPOINT") or None,
        region=os.environ.get("FURY_FRAME_REGION", "auto"),
    )


class FrameCache:
    """The local store first; on a miss, the bucket, back-filling the local store. Writes go to
    both, the bucket's in the background so a render's response never waits on it."""

    def __init__(self, local: LocalFrames, remote: RemoteFrames | None = None):
        self.local = local
        self.remote = remote
        self.writer = ThreadPoolExecutor(2) if remote else None
        self.hits = {"local": 0, "remote": 0, "miss": 0}

    def read(self, key: str) -> bytes | None:
        data = self.local.read(key)
        if data is not None:
            self.hits["local"] += 1
            return data
        if self.remote is not None:
            data = self.remote.get(key)
            if data is not None:
                self.hits["remote"] += 1
                self.local.put(key, data)
                return data
        self.hits["miss"] += 1
        return None

    def put(self, key: str, data: bytes) -> None:
        self.local.put(key, data)
        if self.remote is not None and self.writer is not None:
            self.writer.submit(self.remote.put, key, data)

    def flush(self):
        """Waits for background writes (tests, shutdown)."""
        if self.writer is not None:
            self.writer.shutdown(wait=True)
            self.writer = ThreadPoolExecutor(2)
