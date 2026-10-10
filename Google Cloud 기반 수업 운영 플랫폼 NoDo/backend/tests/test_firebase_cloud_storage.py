from __future__ import annotations

from io import BytesIO
from typing import Any

from app.adapters.firebase_cloud_storage import GoogleCloudPrivateStorage


class SourceBlob:
    def __init__(self) -> None:
        self.generation = 17
        self.size = 11
        self.reloaded = False

    def reload(self) -> None:
        self.reloaded = True

    def download_to_file(self, destination: BytesIO) -> None:
        destination.write(b"private-pdf")


class Bucket:
    def __init__(self, blob: SourceBlob) -> None:
        self.source_blob = blob
        self.requested_paths: list[str] = []

    def blob(self, object_path: str) -> Any:
        self.requested_paths.append(object_path)
        return self.source_blob


def test_download_source_rewinds_server_temporary_file() -> None:
    source_blob = SourceBlob()
    bucket = Bucket(source_blob)
    destination = BytesIO()

    result = GoogleCloudPrivateStorage(bucket).download_source(
        object_path="private/source.pdf", destination=destination
    )

    assert source_blob.reloaded is True
    assert bucket.requested_paths == ["private/source.pdf"]
    assert destination.read() == b"private-pdf"
    assert result.generation == "17"
    assert result.size_bytes == 11
