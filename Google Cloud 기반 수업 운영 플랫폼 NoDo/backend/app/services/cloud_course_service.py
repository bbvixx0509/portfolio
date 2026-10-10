from collections.abc import Callable, Mapping
from io import BytesIO
from typing import Any, Protocol, TypeVar
from uuid import uuid4

from app.core.config import Settings
from app.domain.errors import (
    AccessDenied,
    InvalidOperation,
    ResourceConflict,
    ResourceNotFound,
    ServiceTemporarilyUnavailable,
)
from app.domain.staff_membership import has_active_membership
from app.services.cloud_auth_service import VerifiedCloudIdentity
from app.services.cloud_organization_service import ORGANIZATION_ROLES, SCHEMA_VERSION

ACTIVE = "ACTIVE"
ARCHIVED = "ARCHIVED"
MAX_CHAPTERS = 60
MAX_ITEMS = 600
MAX_MATERIALS = 20
DISPLAYABLE_MATERIAL_STATUSES = frozenset({"STORED", "EXTRACTED"})
TransactionResult = TypeVar("TransactionResult")


class CloudCourseTransaction(Protocol):
    @property
    def server_timestamp(self) -> object: ...

    def read_document(self, path: str) -> Mapping[str, Any] | None: ...

    def create_document(self, path: str, document: Mapping[str, Any]) -> None: ...

    def update_document(self, path: str, changes: Mapping[str, Any]) -> None: ...


class CloudCourseRepository(Protocol):
    def read_document(self, path: str) -> Mapping[str, Any] | None: ...

    def list_courses(self, *, org_id: str) -> list[Mapping[str, Any]]: ...

    def run_transaction(
        self,
        callback: Callable[[CloudCourseTransaction], TransactionResult],
    ) -> TransactionResult: ...


class PrivateCourseMaterialStorage(Protocol):
    def download_source(self, *, object_path: str, destination: BytesIO) -> object: ...


class CloudCourseService:
    def __init__(
        self,
        repository: CloudCourseRepository,
        settings: Settings,
        *,
        storage: PrivateCourseMaterialStorage | None = None,
    ) -> None:
        self.repository = repository
        self.settings = settings
        self.storage = storage

    def list_courses(
        self, identity: VerifiedCloudIdentity, *, status: str = ACTIVE
    ) -> dict[str, Any]:
        self._require_staff(identity)
        self._require_list_status(status)
        summaries = []
        for course in self.repository.list_courses(
            org_id=self.settings.bootstrap_org_id
        ):
            if (
                self._is_readable_course(course, str(course.get("id", "")))
                and course.get("createdByUid") == identity.uid
                and course.get("status") == status
            ):
                summaries.append(self._summary(course, identity.uid))
        summaries.sort(key=lambda course: str(course["updatedAt"]), reverse=True)
        return {"courses": summaries}

    def get_course(
        self, identity: VerifiedCloudIdentity, course_id: str
    ) -> dict[str, Any]:
        self._require_staff(identity)
        return self._public_course(self._readable_course(course_id), identity.uid)

    def create_course(
        self, identity: VerifiedCloudIdentity, payload: Mapping[str, Any]
    ) -> dict[str, Any]:
        self._require_staff(identity)
        normalized = self._normalize_payload(payload)
        material_ids = self._requested_material_ids(payload)
        course_id = uuid4().hex

        def create(transaction: CloudCourseTransaction) -> None:
            self._require_transaction_staff(transaction, identity)
            for material_id in material_ids:
                self._require_owned_stored_material(
                    transaction.read_document(self._material_path(material_id)),
                    material_id,
                    identity.uid,
                )
            timestamp = transaction.server_timestamp
            transaction.create_document(
                self._path(course_id),
                self._new_document(
                    course_id=course_id,
                    identity=identity,
                    normalized={**normalized, "materialIds": material_ids},
                    timestamp=timestamp,
                ),
            )
            self._audit(
                transaction,
                event="COURSE_CREATED",
                course_id=course_id,
                identity=identity,
                revision=1,
                timestamp=timestamp,
            )

        self.repository.run_transaction(create)
        return self.get_course(identity, course_id)

    def update_course(
        self,
        identity: VerifiedCloudIdentity,
        course_id: str,
        payload: Mapping[str, Any],
    ) -> dict[str, Any]:
        self._require_staff(identity)
        normalized = self._normalize_payload(payload)
        expected_revision = self._expected_revision(payload)

        def update(transaction: CloudCourseTransaction) -> None:
            course = transaction.read_document(self._path(course_id))
            self._require_transaction_staff(transaction, identity)
            self._require_owner_active(
                course, identity.uid, course_id, expected_revision
            )
            revision = expected_revision + 1
            timestamp = transaction.server_timestamp
            transaction.update_document(
                self._path(course_id),
                {
                    **normalized,
                    "updatedByUid": identity.uid,
                    "updatedAt": timestamp,
                    "revision": revision,
                },
            )
            self._audit(
                transaction,
                event="COURSE_UPDATED",
                course_id=course_id,
                identity=identity,
                revision=revision,
                timestamp=timestamp,
            )

        self.repository.run_transaction(update)
        return self.get_course(identity, course_id)

    def duplicate_course(
        self, identity: VerifiedCloudIdentity, course_id: str
    ) -> dict[str, Any]:
        self._require_staff(identity)
        source = self._active_course(course_id)
        copied = self._normalize_payload(
            {
                "title": f"{source['title']} 복사본",
                "description": source.get("description", ""),
                "chapters": source.get("chapters", []),
            },
            regenerate_ids=True,
        )
        copied_id = uuid4().hex

        def duplicate(transaction: CloudCourseTransaction) -> None:
            self._require_transaction_staff(transaction, identity)
            if not self._is_active_course(
                transaction.read_document(self._path(course_id)), course_id
            ):
                raise ResourceNotFound("The course was not found")
            timestamp = transaction.server_timestamp
            transaction.create_document(
                self._path(copied_id),
                self._new_document(
                    course_id=copied_id,
                    identity=identity,
                    normalized=copied,
                    timestamp=timestamp,
                ),
            )
            self._audit(
                transaction,
                event="COURSE_DUPLICATED",
                course_id=copied_id,
                identity=identity,
                revision=1,
                timestamp=timestamp,
                source_course_id=course_id,
            )

        self.repository.run_transaction(duplicate)
        return self.get_course(identity, copied_id)

    def archive_course(
        self,
        identity: VerifiedCloudIdentity,
        course_id: str,
        expected_revision: int,
    ) -> None:
        self._require_staff(identity)

        def archive(transaction: CloudCourseTransaction) -> None:
            course = transaction.read_document(self._path(course_id))
            self._require_transaction_staff(transaction, identity)
            self._require_owner_active(
                course, identity.uid, course_id, expected_revision
            )
            revision = expected_revision + 1
            timestamp = transaction.server_timestamp
            transaction.update_document(
                self._path(course_id),
                {
                    "status": ARCHIVED,
                    "archivedAt": timestamp,
                    "archivedByUid": identity.uid,
                    "updatedByUid": identity.uid,
                    "updatedAt": timestamp,
                    "revision": revision,
                },
            )
            self._audit(
                transaction,
                event="COURSE_ARCHIVED",
                course_id=course_id,
                identity=identity,
                revision=revision,
                timestamp=timestamp,
            )

        self.repository.run_transaction(archive)

    def list_materials(
        self, identity: VerifiedCloudIdentity, course_id: str
    ) -> dict[str, Any]:
        self._require_staff(identity)
        course = self._readable_course(course_id)
        self._require_owner(course, identity.uid, course_id)
        materials, unavailable_material_count = self._material_summaries(
            course, identity.uid
        )
        return {
            "materials": materials,
            # This is intentionally only a count.  Historical links can point
            # to a removed or unreadable upload, but a read response must not
            # disclose the underlying material identifier or storage metadata.
            "unavailableMaterialCount": unavailable_material_count,
        }

    def attach_material(
        self, identity: VerifiedCloudIdentity, course_id: str, material_id: str
    ) -> dict[str, Any]:
        self._require_staff(identity)
        normalized_material_id = self._id(material_id)

        def attach(transaction: CloudCourseTransaction) -> None:
            course = transaction.read_document(self._path(course_id))
            self._require_transaction_staff(transaction, identity)
            self._require_owner_active_without_revision(course, identity.uid, course_id)
            material = transaction.read_document(
                self._material_path(normalized_material_id)
            )
            self._require_owned_stored_material(
                material, normalized_material_id, identity.uid
            )
            material_ids = self._material_ids(course)
            if normalized_material_id in material_ids:
                return
            if len(material_ids) >= MAX_MATERIALS:
                raise InvalidOperation("연결할 수 있는 자료 수를 확인해 주세요.")
            revision = int(course["revision"]) + 1
            timestamp = transaction.server_timestamp
            transaction.update_document(
                self._path(course_id),
                {
                    "materialIds": [*material_ids, normalized_material_id],
                    "updatedByUid": identity.uid,
                    "updatedAt": timestamp,
                    "revision": revision,
                },
            )
            self._audit(
                transaction,
                event="COURSE_MATERIAL_ATTACHED",
                course_id=course_id,
                identity=identity,
                revision=revision,
                timestamp=timestamp,
            )

        self.repository.run_transaction(attach)
        return self.list_materials(identity, course_id)

    def detach_material(
        self, identity: VerifiedCloudIdentity, course_id: str, material_id: str
    ) -> dict[str, Any]:
        self._require_staff(identity)
        normalized_material_id = self._id(material_id)

        def detach(transaction: CloudCourseTransaction) -> None:
            course = transaction.read_document(self._path(course_id))
            self._require_transaction_staff(transaction, identity)
            self._require_owner_active_without_revision(course, identity.uid, course_id)
            material_ids = self._material_ids(course)
            if normalized_material_id not in material_ids:
                raise ResourceNotFound("연결된 자료를 찾을 수 없습니다.")
            revision = int(course["revision"]) + 1
            timestamp = transaction.server_timestamp
            transaction.update_document(
                self._path(course_id),
                {
                    "materialIds": [
                        current_id
                        for current_id in material_ids
                        if current_id != normalized_material_id
                    ],
                    "updatedByUid": identity.uid,
                    "updatedAt": timestamp,
                    "revision": revision,
                },
            )
            self._audit(
                transaction,
                event="COURSE_MATERIAL_DETACHED",
                course_id=course_id,
                identity=identity,
                revision=revision,
                timestamp=timestamp,
            )

        self.repository.run_transaction(detach)
        return self.list_materials(identity, course_id)

    def material_content(
        self, identity: VerifiedCloudIdentity, course_id: str, material_id: str
    ) -> dict[str, Any]:
        self._require_staff(identity)
        normalized_material_id = self._id(material_id)
        course = self._readable_course(course_id)
        self._require_owner(course, identity.uid, course_id)
        if normalized_material_id not in self._material_ids(course):
            raise ResourceNotFound("연결된 자료를 찾을 수 없습니다.")
        material = self.repository.read_document(
            self._material_path(normalized_material_id)
        )
        summary = self._require_owned_displayable_material(
            material, normalized_material_id, identity.uid
        )
        if self.storage is None:
            raise ServiceTemporarilyUnavailable("자료 미리보기를 준비하지 못했습니다.")
        source = BytesIO()
        try:
            self.storage.download_source(
                object_path=self._source_path(
                    normalized_material_id, summary["normalizedExtension"]
                ),
                destination=source,
            )
        except Exception as error:
            raise ServiceTemporarilyUnavailable(
                "자료 미리보기를 준비하지 못했습니다."
            ) from error
        content = source.getvalue()
        if not content or len(content) > 30 * 1024 * 1024:
            raise InvalidOperation("자료 미리보기를 준비하지 못했습니다.")
        return {
            "content": content,
            "contentType": (
                "application/pdf"
                if summary["normalizedExtension"] == "pdf"
                else (
                    "application/vnd.openxmlformats-officedocument."
                    "presentationml.presentation"
                )
            ),
        }

    def _new_document(
        self,
        *,
        course_id: str,
        identity: VerifiedCloudIdentity,
        normalized: Mapping[str, Any],
        timestamp: object,
    ) -> dict[str, Any]:
        return {
            "id": course_id,
            "orgId": self.settings.bootstrap_org_id,
            "schemaVersion": SCHEMA_VERSION,
            "status": ACTIVE,
            **normalized,
            "createdByUid": identity.uid,
            "createdByDisplayNameSnapshot": identity.display_name,
            "updatedByUid": identity.uid,
            "revision": 1,
            "createdAt": timestamp,
            "updatedAt": timestamp,
        }

    def _normalize_payload(
        self, payload: Mapping[str, Any], *, regenerate_ids: bool = False
    ) -> dict[str, Any]:
        title = self._text(payload.get("title"), 100, required=True)
        description = self._text(payload.get("description", ""), 1000, required=False)
        raw_chapters = payload.get("chapters", [])
        if not isinstance(raw_chapters, list) or len(raw_chapters) > MAX_CHAPTERS:
            raise InvalidOperation("The chapter count is invalid")
        chapters: list[dict[str, Any]] = []
        total_items = 0
        for chapter_position, chapter in enumerate(raw_chapters):
            if not isinstance(chapter, Mapping):
                raise InvalidOperation("The chapter data is invalid")
            raw_items = chapter.get("items", [])
            if not isinstance(raw_items, list):
                raise InvalidOperation("The item data is invalid")
            total_items += len(raw_items)
            items = []
            for item_position, item in enumerate(raw_items):
                if not isinstance(item, Mapping):
                    raise InvalidOperation("The item data is invalid")
                source_references = self._source_references(
                    item.get("sourcePageOrSlideNumbers", [])
                )
                items.append(
                    {
                        "id": (
                            uuid4().hex
                            if regenerate_ids
                            else self._id(item.get("id"))
                        ),
                        "title": self._text(item.get("title"), 150, required=True),
                        "description": self._text(
                            item.get("description", ""), 1000, required=False
                        ),
                        "sourcePageOrSlideNumbers": source_references,
                        "position": item_position,
                    }
                )
            chapters.append(
                {
                    "id": (
                        uuid4().hex
                        if regenerate_ids
                        else self._id(chapter.get("id"))
                    ),
                    "title": self._text(chapter.get("title"), 100, required=True),
                    "position": chapter_position,
                    "items": items,
                }
            )
        if total_items > MAX_ITEMS:
            raise InvalidOperation("The total item count is invalid")
        return {"title": title, "description": description, "chapters": chapters}

    def _require_staff(self, identity: VerifiedCloudIdentity) -> None:
        user = self.repository.read_document(f"users/{identity.uid}")
        if not self._is_staff(user, identity.uid):
            raise AccessDenied("Only organization staff can use courses")

    def _require_transaction_staff(
        self, transaction: CloudCourseTransaction, identity: VerifiedCloudIdentity
    ) -> None:
        if not self._is_staff(
            transaction.read_document(f"users/{identity.uid}"), identity.uid
        ):
            raise AccessDenied("Only organization staff can use courses")

    def _is_staff(self, user: Mapping[str, Any] | None, uid: str) -> bool:
        return bool(
            user
            and user.get("uid") == uid
            and user.get("orgId") == self.settings.bootstrap_org_id
            and user.get("accountType") == "STAFF"
            and has_active_membership(user)
            and user.get("organizationRole") in ORGANIZATION_ROLES
            and isinstance(user.get("organizationRoleRevision"), int)
            and user["organizationRoleRevision"] >= 1
        )

    def _active_course(self, course_id: str) -> Mapping[str, Any]:
        course = self.repository.read_document(self._path(course_id))
        if not self._is_active_course(course, course_id):
            raise ResourceNotFound("The course was not found")
        return course

    def _readable_course(self, course_id: str) -> Mapping[str, Any]:
        course = self.repository.read_document(self._path(course_id))
        if not self._is_readable_course(course, course_id):
            raise ResourceNotFound("The course was not found")
        return course

    def _is_active_course(
        self, course: Mapping[str, Any] | None, course_id: str
    ) -> bool:
        return bool(
            self._is_readable_course(course, course_id)
            and course.get("status") == ACTIVE
        )

    def _is_readable_course(
        self, course: Mapping[str, Any] | None, course_id: str
    ) -> bool:
        return bool(
            course
            and course.get("id") == course_id
            and course.get("orgId") == self.settings.bootstrap_org_id
            and course.get("status") in {ACTIVE, ARCHIVED}
            and course.get("schemaVersion") == SCHEMA_VERSION
        )

    def _require_owner_active(
        self,
        course: Mapping[str, Any] | None,
        uid: str,
        course_id: str,
        expected_revision: int,
    ) -> None:
        if not self._is_readable_course(course, course_id):
            raise ResourceNotFound("The course was not found")
        if course.get("status") == ARCHIVED:
            raise ResourceConflict("Archived courses are read-only")
        if course.get("status") != ACTIVE:
            raise ResourceNotFound("The course was not found")
        if course.get("createdByUid") != uid:
            raise AccessDenied("Only the course creator can change this course")
        if course.get("revision") != expected_revision:
            raise ResourceConflict("The course was changed by another request")

    def _require_owner_active_without_revision(
        self,
        course: Mapping[str, Any] | None,
        uid: str,
        course_id: str,
    ) -> None:
        if not self._is_readable_course(course, course_id):
            raise ResourceNotFound("The course was not found")
        if course.get("status") == ARCHIVED:
            raise ResourceConflict("Archived courses are read-only")
        if course.get("status") != ACTIVE:
            raise ResourceNotFound("The course was not found")
        self._require_owner(course, uid, course_id)
        if not isinstance(course.get("revision"), int) or course["revision"] < 1:
            raise ResourceConflict("The course revision is invalid")

    @staticmethod
    def _require_owner(
        course: Mapping[str, Any], uid: str, course_id: str
    ) -> None:
        if course.get("id") != course_id:
            raise ResourceNotFound("The course was not found")
        if course.get("createdByUid") != uid:
            raise AccessDenied("Only the course creator can change this course")

    def _requested_material_ids(self, payload: Mapping[str, Any]) -> list[str]:
        value = payload.get("materialIds", [])
        if not isinstance(value, list) or len(value) > MAX_MATERIALS:
            raise InvalidOperation("연결할 자료를 확인해 주세요.")
        material_ids = [self._id(item) for item in value]
        if len(material_ids) != len(set(material_ids)):
            raise InvalidOperation("연결할 자료를 확인해 주세요.")
        return material_ids

    def _material_ids(self, course: Mapping[str, Any] | None) -> list[str]:
        if not course:
            return []
        value = course.get("materialIds")
        if isinstance(value, list):
            return [
                item
                for item in value
                if isinstance(item, str) and item and len(item) <= 100
            ]
        # Material-draft courses used a single sourceMaterialId before the
        # multi-material connection was introduced.  Treat it as the first
        # linked material without rewriting historical documents on read.
        for legacy_key in ("sourceMaterialId", "materialId"):
            legacy = course.get(legacy_key)
            if isinstance(legacy, str) and legacy and len(legacy) <= 100:
                return [legacy]
        return []

    def _material_summaries(
        self, course: Mapping[str, Any], owner_uid: str
    ) -> tuple[list[dict[str, Any]], int]:
        summaries: list[dict[str, Any]] = []
        unavailable_material_count = 0
        for material_id in self._material_ids(course):
            material = self.repository.read_document(self._material_path(material_id))
            try:
                summaries.append(
                    self._require_owned_displayable_material(
                        material, material_id, owner_uid
                    )
                )
            except (AccessDenied, InvalidOperation, ResourceNotFound):
                # A historical course may refer to a removed or failed upload.
                # Do not expose its storage metadata or make the editor fail.
                unavailable_material_count += 1
                continue
        return summaries, unavailable_material_count

    def _require_owned_stored_material(
        self,
        material: Mapping[str, Any] | None,
        material_id: str,
        owner_uid: str,
    ) -> dict[str, Any]:
        return self._require_owned_material(
            material, material_id, owner_uid, allowed_statuses=frozenset({"STORED"})
        )

    def _require_owned_displayable_material(
        self,
        material: Mapping[str, Any] | None,
        material_id: str,
        owner_uid: str,
    ) -> dict[str, Any]:
        return self._require_owned_material(
            material,
            material_id,
            owner_uid,
            allowed_statuses=DISPLAYABLE_MATERIAL_STATUSES,
        )

    def _require_owned_material(
        self,
        material: Mapping[str, Any] | None,
        material_id: str,
        owner_uid: str,
        *,
        allowed_statuses: frozenset[str],
    ) -> dict[str, Any]:
        if (
            material is None
            or material.get("id") != material_id
            or material.get("orgId") != self.settings.bootstrap_org_id
            or material.get("ownerStaffUid") != owner_uid
            or material.get("status") not in allowed_statuses
        ):
            raise ResourceNotFound("연결할 자료를 찾을 수 없습니다.")
        extension = material.get("normalizedExtension")
        filename = material.get("originalFilename")
        size_bytes = material.get("sizeBytes")
        if (
            extension not in {"pdf", "pptx"}
            or not isinstance(filename, str)
            or not filename
            or not isinstance(size_bytes, int)
            or size_bytes < 1
        ):
            raise InvalidOperation("연결할 자료를 확인할 수 없습니다.")
        return {
            "id": material_id,
            "filename": filename,
            "normalizedExtension": extension,
            "sizeBytes": size_bytes,
        }

    def _material_path(self, material_id: str) -> str:
        return (
            f"organizations/{self.settings.bootstrap_org_id}/materialUploads/"
            f"{material_id}"
        )

    def _source_path(self, material_id: str, extension: object) -> str:
        if extension not in {"pdf", "pptx"}:
            raise InvalidOperation("자료 미리보기를 준비하지 못했습니다.")
        return (
            f"organizations/{self.settings.bootstrap_org_id}/material-uploads/"
            f"{material_id}/source.{extension}"
        )

    def _summary(self, course: Mapping[str, Any], uid: str) -> dict[str, Any]:
        chapters = course.get("chapters", [])
        item_count = sum(
            len(chapter.get("items", []))
            for chapter in chapters
            if isinstance(chapter, Mapping)
        )
        return {
            "id": course.get("id"),
            "title": course.get("title"),
            "description": course.get("description", ""),
            "createdByDisplayNameSnapshot": course.get(
                "createdByDisplayNameSnapshot"
            ),
            "chapterCount": len(chapters),
            "itemCount": item_count,
            "updatedAt": course.get("updatedAt"),
            "archivedAt": course.get("archivedAt"),
            "status": course.get("status"),
            "isMine": course.get("createdByUid") == uid,
            "revision": course.get("revision"),
        }

    def _public_course(self, course: Mapping[str, Any], uid: str) -> dict[str, Any]:
        return {**self._summary(course, uid), "chapters": course.get("chapters", [])}

    def _audit(
        self,
        transaction: CloudCourseTransaction,
        *,
        event: str,
        course_id: str,
        identity: VerifiedCloudIdentity,
        revision: int,
        timestamp: object,
        source_course_id: str | None = None,
    ) -> None:
        document: dict[str, Any] = {
            "eventType": event,
            "orgId": self.settings.bootstrap_org_id,
            "actorUid": identity.uid,
            "courseId": course_id,
            "revision": revision,
            "schemaVersion": SCHEMA_VERSION,
            "createdAt": timestamp,
        }
        if source_course_id:
            document["sourceCourseId"] = source_course_id
        transaction.create_document(
            f"organizations/{self.settings.bootstrap_org_id}/auditLogs/"
            f"course-{event.lower()}-{course_id}-{revision}",
            document,
        )

    def _path(self, course_id: str) -> str:
        return f"organizations/{self.settings.bootstrap_org_id}/courses/{course_id}"

    def _require_list_status(self, status: str) -> None:
        if status not in {ACTIVE, ARCHIVED}:
            raise InvalidOperation("The course status is invalid")

    def _expected_revision(self, payload: Mapping[str, Any]) -> int:
        value = payload.get("expectedRevision")
        if not isinstance(value, int) or value < 1:
            raise InvalidOperation("The current revision is required")
        return value

    def _id(self, value: object) -> str:
        if not isinstance(value, str) or not value.strip() or len(value) > 100:
            raise InvalidOperation("The item identifier is invalid")
        return value.strip()

    @staticmethod
    def _source_references(value: object) -> list[int]:
        if not isinstance(value, list) or len(value) > 20:
            raise InvalidOperation("The source references are invalid")
        if any(isinstance(item, bool) or not isinstance(item, int) for item in value):
            raise InvalidOperation("The source references are invalid")
        references = sorted(set(value))
        if any(item < 1 for item in references):
            raise InvalidOperation("The source references are invalid")
        return references

    def _text(self, value: object, limit: int, *, required: bool) -> str:
        if not isinstance(value, str):
            raise InvalidOperation("The text is invalid")
        result = value.strip()
        if (required and not result) or len(result) > limit:
            raise InvalidOperation("The text is invalid")
        return result
