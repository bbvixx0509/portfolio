import json
from copy import deepcopy
from datetime import UTC, datetime, timedelta
from io import BytesIO

import pytest
from test_cloud_organization import cloud_settings
from test_cloud_rooms import (
    ADMIN,
    INSTRUCTOR,
    InMemoryRoomRepository,
    create_payload,
    create_service,
)

from app.domain.errors import AccessDenied, InvalidOperation, ResourceConflict
from app.services.cloud_room_material_service import CloudRoomMaterialService
from app.services.student_auth_service import VerifiedStudentIdentity


class MemoryPrivateMaterialStorage:
    def download_source(self, *, object_path: str, destination: BytesIO) -> object:
        assert object_path.endswith("/source.pdf")
        destination.write(b"%PDF-private")
        return object()

    def download_extraction(self, *, object_path: str, destination: BytesIO) -> None:
        assert object_path.endswith("/extraction.json")
        destination.write(
            json.dumps(
                {
                    "kind": "PPTX",
                    "slides": [
                        {
                            "slideNumber": 1,
                            "titleCandidate": "첫 슬라이드",
                            "text": "비공개 본문",
                        },
                        {
                            "slideNumber": 2,
                            "titleCandidate": "둘째 슬라이드",
                            "text": "두 번째 본문",
                        },
                    ],
                }
            ).encode()
        )


def material_room(
    *, file_type: str = "pdf"
) -> tuple[CloudRoomMaterialService, InMemoryRoomRepository, str]:
    room_service, repository = create_service(room_code_factory=lambda: "ABCDEFGH")
    source = repository.documents["organizations/demo/courses/source-course"]
    source.update(
        {
            "sourceMaterialId": "material-1",
            "sourceDraftId": "draft-1",
            "sourceFileType": file_type,
        }
    )
    repository.documents["organizations/demo/materialUploads/material-1"] = {
        "id": "material-1",
        "orgId": "demo",
        "normalizedExtension": file_type,
        "status": "EXTRACTED",
        "extractionStatus": "EXTRACTED",
        "sourceObjectGeneration": "11",
        "extractionVersion": 1,
        "pageCount": 2,
        "slideCount": 2,
        "originalFilename": "private-source." + file_type,
    }
    created = room_service.create_room(ADMIN, create_payload())
    room_id = created["id"]
    room = repository.documents[f"organizations/demo/rooms/{room_id}"]
    room["status"] = "LIVE"
    repository.documents[f"organizations/demo/roomCodes/{room['roomCode']}"] = {
        "roomId": room_id,
        "status": "LIVE",
    }
    repository.documents[
        f"organizations/demo/rooms/{room_id}/participants/student-anon"
    ] = {
        "participantStatus": "JOINED",
        "presenceStatus": "ACTIVE",
        "isAnonymous": True,
    }
    return (
        CloudRoomMaterialService(
            repository, MemoryPrivateMaterialStorage(), cloud_settings()
        ),
        repository,
        room_id,
    )


def test_lead_alone_can_move_material_and_noop_keeps_revision() -> None:
    service, repository, room_id = material_room()

    assert service.staff_material(ADMIN, room_id)["material"] == {
        "displayTitle": "private-source.pdf",
        "fileType": "pdf",
        "totalUnits": 2,
        "currentUnitNumber": 1,
        "materialRevision": 1,
        "canControl": True,
    }
    assert (
        service.update_position(ADMIN, room_id, 1, 1)["material"]["materialRevision"]
        == 1
    )
    moved = service.update_position(ADMIN, room_id, 2, 1)
    assert moved["material"]["currentUnitNumber"] == 2
    assert moved["material"]["materialRevision"] == 2
    with pytest.raises(ResourceConflict):
        service.update_position(ADMIN, room_id, 1, 1)
    with pytest.raises(InvalidOperation):
        service.update_position(ADMIN, room_id, 3, 2)
    with pytest.raises(AccessDenied):
        service.update_position(INSTRUCTOR, room_id, 1, 2)
    stored = repository.documents[f"organizations/demo/rooms/{room_id}"]
    assert not any(
        document.get("eventType", "").startswith("MATERIAL")
        for document in repository.documents.values()
    )
    assert stored["materialSnapshot"]["currentUnitNumber"] == 2


def test_ended_room_rejects_material_position_changes() -> None:
    service, repository, room_id = material_room()
    repository.documents[f"organizations/demo/rooms/{room_id}"]["status"] = "ENDED"

    with pytest.raises(ResourceConflict, match="after the room ends"):
        service.update_position(ADMIN, room_id, 2, 1)


def test_ended_room_locks_policy_but_keeps_existing_student_material_access() -> None:
    service, repository, room_id = material_room()
    room_path = f"organizations/demo/rooms/{room_id}"
    expiry = (datetime.now(UTC) + timedelta(days=1)).isoformat()
    service.update_download_policy(
        ADMIN,
        room_id,
        {
            "downloadEnabled": True,
            "downloadAvailableUntil": expiry,
            "expectedDownloadPolicyRevision": 1,
        },
    )
    repository.documents[room_path]["status"] = "ENDED"
    access = service.staff_access(ADMIN, room_id)["material"]
    assert access is not None
    assert access["canManageDownloadPolicy"] is False
    assert access["canViewDownloadPolicy"] is True
    assert access["downloadPolicyLocked"] is True
    before = deepcopy(repository.documents)

    with pytest.raises(ResourceConflict, match="after the room ends"):
        service.update_download_policy(
            ADMIN,
            room_id,
            {
                "downloadEnabled": False,
                "downloadAvailableUntil": None,
                "expectedDownloadPolicyRevision": 2,
            },
        )

    assert repository.documents == before
    student = VerifiedStudentIdentity(uid="student-anon")
    assert service.student_material(student, "demo", "ABCDEFGH")["material"] is not None
    assert service.student_content(student, "demo", "ABCDEFGH").kind == "pdf"
    assert (
        service.student_download(student, "demo", "ABCDEFGH").content
        == b"%PDF-private"
    )


def test_active_anonymous_student_only_gets_minimal_content() -> None:
    service, repository, room_id = material_room(file_type="pptx")
    room = repository.documents[f"organizations/demo/rooms/{room_id}"]
    student = VerifiedStudentIdentity(uid="student-anon")

    metadata = service.student_material(student, "demo", room["roomCode"])
    assert metadata["material"] == {
        "displayTitle": "private-source.pptx",
        "fileType": "pptx",
        "totalUnits": 2,
        "currentUnitNumber": 1,
        "materialRevision": 1,
        "canControl": False,
    }
    content = service.student_content(student, "demo", room["roomCode"])
    assert content.kind == "pptx"
    assert content.data == {
        "unitNumber": 1,
        "title": "첫 슬라이드",
        "text": "비공개 본문",
    }
    assert "sourceMaterialId" not in metadata["material"]
    repository.documents[
        f"organizations/demo/rooms/{room_id}/participants/student-anon"
    ]["presenceStatus"] = "LEFT"
    with pytest.raises(AccessDenied):
        service.student_material(student, "demo", room["roomCode"])


def test_pdf_delivery_uses_server_storage_and_source_revision_must_match() -> None:
    service, repository, room_id = material_room()
    content = service.staff_content(ADMIN, room_id)
    assert content.kind == "pdf"
    assert content.data == b"%PDF-private"
    repository.documents["organizations/demo/materialUploads/material-1"][
        "sourceObjectGeneration"
    ] = "changed"
    with pytest.raises(InvalidOperation):
        service.staff_content(ADMIN, room_id)


def test_only_lead_can_set_a_future_download_policy() -> None:
    service, repository, room_id = material_room()
    future = (datetime.now(UTC) + timedelta(days=7)).isoformat()
    result = service.update_download_policy(
        ADMIN,
        room_id,
        {
            "downloadEnabled": True,
            "downloadAvailableUntil": future,
            "expectedDownloadPolicyRevision": 1,
        },
    )
    assert result["material"]["downloadEnabled"] is True
    assert result["material"]["downloadPolicyRevision"] == 2
    audit_count = sum(
        document.get("eventType") == "ROOM_MATERIAL_DOWNLOAD_POLICY_UPDATED"
        for document in repository.documents.values()
    )
    unchanged = service.update_download_policy(
        ADMIN,
        room_id,
        {
            "downloadEnabled": True,
            "downloadAvailableUntil": future,
            "expectedDownloadPolicyRevision": 2,
        },
    )
    assert unchanged["material"]["downloadPolicyRevision"] == 2
    assert sum(
        document.get("eventType") == "ROOM_MATERIAL_DOWNLOAD_POLICY_UPDATED"
        for document in repository.documents.values()
    ) == audit_count
    with pytest.raises(AccessDenied):
        service.update_download_policy(
            INSTRUCTOR,
            room_id,
            {
                "downloadEnabled": False,
                "downloadAvailableUntil": None,
                "expectedDownloadPolicyRevision": 2,
            },
        )
    with pytest.raises(InvalidOperation):
        service.update_download_policy(
            ADMIN,
            room_id,
            {
                "downloadEnabled": True,
                "downloadAvailableUntil": (
                    datetime.now(UTC) - timedelta(minutes=1)
                ).isoformat(),
                "expectedDownloadPolicyRevision": 2,
            },
        )
    with pytest.raises(InvalidOperation):
        service.update_download_policy(
            ADMIN,
            room_id,
            {
                "downloadEnabled": True,
                "downloadAvailableUntil": (
                    datetime.now(UTC) + timedelta(days=366)
                ).isoformat(),
                "expectedDownloadPolicyRevision": 2,
            },
        )
    assert any(
        document.get("eventType") == "ROOM_MATERIAL_DOWNLOAD_POLICY_UPDATED"
        for document in repository.documents.values()
    )


def test_staff_access_returns_server_default_for_an_unset_policy() -> None:
    service, _repository, room_id = material_room()

    access = service.staff_access(ADMIN, room_id)["material"]

    assert access is not None
    assert access["canControl"] is True
    assert access["canManageDownloadPolicy"] is True
    assert access["canViewDownloadPolicy"] is True
    assert access["downloadPolicyLocked"] is False
    assert access["downloadEnabled"] is False
    assert access["downloadAvailableFrom"] is None
    assert access["downloadAvailableUntil"] is None
    assert access["downloadPolicyRevision"] == 1
