from typing import Any, BinaryIO

from google.cloud import storage

from app.core.config import Settings
from app.services.cloud_material_extraction_service import SourceObjectInfo


class GoogleCloudPrivateStorage:
    """ADC-only adapter for the single private NoDo Storage bucket."""

    def __init__(self, bucket: Any) -> None:
        self.bucket = bucket

    @classmethod
    def from_settings(cls, runtime_settings: Settings) -> "GoogleCloudPrivateStorage":
        runtime_settings.ensure_private_storage_uploads_enabled()
        client = storage.Client(project=runtime_settings.google_cloud_project)
        return cls(client.bucket(runtime_settings.storage_bucket))

    def upload_source(
        self, *, object_path: str, content_type: str, source: BinaryIO
    ) -> None:
        # The server generates a unique object path and prevents overwrites even
        # if an unexpected retry reaches the provider.
        blob = self.bucket.blob(object_path)
        source.seek(0)
        blob.upload_from_file(
            source,
            content_type=content_type,
            if_generation_match=0,
            rewind=False,
        )

    def download_source(
        self, *, object_path: str, destination: BinaryIO
    ) -> SourceObjectInfo:
        """Download only a server-derived source object to a temporary file."""

        blob = self.bucket.blob(object_path)
        blob.reload()
        # ``download_to_file`` does not accept ``rewind`` (unlike
        # ``upload_from_file``).  Keep the file-position handling on the
        # server side so extraction always starts at byte zero.
        blob.download_to_file(destination)
        destination.seek(0)
        return SourceObjectInfo(
            generation=str(blob.generation) if blob.generation is not None else None,
            size_bytes=int(blob.size) if blob.size is not None else None,
        )

    def upload_extraction(self, *, object_path: str, source: BinaryIO) -> None:
        """Store structured extraction output without public ACLs or URLs."""

        blob = self.bucket.blob(object_path)
        source.seek(0)
        blob.upload_from_file(
            source,
            content_type="application/json; charset=utf-8",
            if_generation_match=0,
            rewind=False,
        )

    def download_extraction(self, *, object_path: str, destination: BinaryIO) -> None:
        """Download a server-derived extraction result into a temporary file."""

        blob = self.bucket.blob(object_path)
        blob.download_to_file(destination)
        destination.seek(0)
