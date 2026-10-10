import secrets
from datetime import datetime
from typing import Any

from app.domain.authorization import (
    AccountType,
    OrganizationRole,
    Permission,
    Principal,
    RoomStatus,
    account_profile,
    default_assistant_permissions,
    has_room_permission,
    is_room_lead,
    normalize_permissions,
)
from app.domain.errors import (
    AccessDenied,
    InvalidOperation,
    ResourceConflict,
    ResourceNotFound,
)
from app.domain.questions import moderate_question, sanitize_answer


class NoDoService:
    def __init__(self, repository: Any) -> None:
        self.repository = repository

    def me(self, principal: Principal) -> dict[str, Any]:
        return {
            "uid": principal.uid,
            "accountType": principal.account_type.value,
            "organizationRole": (
                principal.organization_role.value
                if principal.organization_role is not None
                else None
            ),
            "orgId": principal.org_id,
            "email": principal.email,
            "displayName": principal.display_name,
            "isAnonymous": principal.is_anonymous,
        }

    def list_courses(self, principal: Principal) -> list[dict[str, Any]]:
        if principal.org_id is None:
            return []
        courses = self.repository.list_courses(principal.org_id)
        for course in courses:
            self._validate_active_room_link(course)

        def with_room_role(course: dict[str, Any]) -> dict[str, Any]:
            room_role: str | None = None
            if (
                principal.account_type is AccountType.STAFF
                and course.get("leadInstructorId") == principal.uid
            ):
                room_role = "LEAD"
            elif principal.account_type is AccountType.STAFF:
                room_id = course.get("activeRoomId")
                if room_id and self.repository.get_staff(room_id, principal.uid):
                    room_role = "ASSISTANT"
            return {**course, "roomRole": room_role}

        if (
            principal.account_type is AccountType.STAFF
            and principal.organization_role is OrganizationRole.ADMIN
        ):
            return [with_room_role(course) for course in courses]
        if principal.account_type is AccountType.STAFF:
            visible = []
            for course in courses:
                if course.get("leadInstructorId") == principal.uid:
                    visible.append(with_room_role(course))
                    continue
                room_id = course.get("activeRoomId")
                if not room_id:
                    continue
                staff = self.repository.get_staff(room_id, principal.uid)
                if staff and staff.get("orgId") == course.get("orgId"):
                    visible.append(with_room_role(course))
            return visible
        if principal.account_type is AccountType.STUDENT:
            visible = []
            for course in courses:
                room_id = course.get("activeRoomId")
                if not room_id:
                    continue
                room = self.repository.get_room(room_id)
                participant = self.repository.get_participant(room_id, principal.uid)
                if (
                    room
                    and room.get("status")
                    in {
                        RoomStatus.ACTIVE.value,
                        RoomStatus.ENDING.value,
                        RoomStatus.ENDED.value,
                    }
                    and participant
                    and participant.get("orgId") == course.get("orgId")
                    and participant.get("roomId") == room_id
                ):
                    visible.append(with_room_role(course))
            return visible
        return []

    def create_course(
        self,
        principal: Principal,
        *,
        title: str,
        description: str,
    ) -> dict[str, Any]:
        self._require_organization(principal)
        if principal.account_type is not AccountType.STAFF:
            raise AccessDenied("Only staff can create a course")
        return self.repository.create_course(
            org_id=principal.org_id,
            title=title,
            description=description,
            lead_instructor_id=principal.uid,
            created_by=principal.uid,
        )

    def update_course(
        self,
        principal: Principal,
        course_id: str,
        *,
        title: str,
        description: str,
    ) -> dict[str, Any]:
        self._require_course_permission(
            principal, course_id, Permission.CAN_EDIT_COURSE
        )
        return self.repository.update_course(
            course_id,
            title=title,
            description=description,
            principal=principal,
        )

    def update_course_flow(
        self,
        principal: Principal,
        course_id: str,
        *,
        chapters: list[dict[str, Any]],
        items: list[dict[str, Any]],
    ) -> dict[str, Any]:
        self._require_course_permission(
            principal, course_id, Permission.CAN_EDIT_COURSE_FLOW
        )
        chapter_ids = {chapter["id"] for chapter in chapters}
        if any(item["chapterId"] not in chapter_ids for item in items):
            raise InvalidOperation("Each flow item must belong to a submitted chapter")
        return self.repository.replace_course_flow(
            course_id,
            chapters=chapters,
            items=items,
            principal=principal,
        )

    def update_material(
        self,
        principal: Principal,
        course_id: str,
        material: dict[str, Any],
    ) -> dict[str, Any]:
        self._require_course_permission(
            principal, course_id, Permission.CAN_MANAGE_MATERIALS
        )
        return self.repository.update_material(course_id, material, principal)

    def create_room(
        self, principal: Principal, course_id: str, join_code: str | None
    ) -> dict[str, Any]:
        return self.repository.create_room(
            course_id, join_code=join_code, principal=principal
        )

    def get_room(self, principal: Principal, room_id: str) -> dict[str, Any]:
        room = self._get_room(room_id)
        self._require_room_read(principal, room)
        flow = self.repository.get_course_flow(room["courseId"])
        public_room = {key: value for key, value in room.items() if key != "joinCode"}
        return {**public_room, **flow}

    def get_room_share(self, principal: Principal, room_id: str) -> dict[str, Any]:
        room, _ = self._require_room_permission(
            principal, room_id, Permission.CAN_SHARE_ROOM
        )
        join_code = self.repository.get_room_join_code(room_id)
        return {
            "roomId": room["id"],
            "joinCode": join_code,
            "joinPath": f"/join/{join_code}",
        }

    def update_completion(
        self,
        principal: Principal,
        room_id: str,
        item_id: str,
        is_completed: bool,
    ) -> dict[str, Any]:
        self._require_room_permission(
            principal, room_id, Permission.CAN_CONTROL_PROGRESS
        )
        return self.repository.update_completion(
            room_id=room_id,
            item_id=item_id,
            is_completed=is_completed,
            principal=principal,
        )

    def staff_overview(self, principal: Principal, room_id: str) -> dict[str, Any]:
        room = self._get_room(room_id)
        self._require_lead(principal, room)
        users = [
            profile
            for user in self.repository.list_users(room["orgId"])
            if (profile := self._public_staff_profile(user)) is not None
        ]
        staff = self.repository.list_staff(room_id)
        users_by_id = {user["uid"]: user for user in users if user.get("uid")}
        staff = [
            {
                **member,
                "displayName": users_by_id.get(member["userId"], {}).get("displayName"),
                "email": users_by_id.get(member["userId"], {}).get("email"),
                "changerDisplayName": users_by_id.get(
                    member.get("updatedBy", ""), {}
                ).get("displayName"),
            }
            for member in staff
        ]
        staff_ids = {member["userId"] for member in staff}
        available = [
            user
            for user in users
            if self._profile_is_staff(user)
            and user.get("uid") not in staff_ids
            and user.get("uid") != room.get("leadInstructorId")
        ]
        lead_document = self.repository.get_user(room["leadInstructorId"])
        lead = (
            self._public_staff_profile(lead_document)
            if lead_document is not None
            else None
        )
        return {
            "roomId": room_id,
            "lead": lead,
            "staff": staff,
            "availableInstructors": available,
        }

    def add_staff(
        self,
        principal: Principal,
        room_id: str,
        target_uid: str,
    ) -> dict[str, Any]:
        room = self._get_room(room_id)
        self._require_lead(principal, room)
        self._require_mutable_room(room)
        self._require_same_org_staff(principal, target_uid)
        if target_uid == room.get("leadInstructorId"):
            raise InvalidOperation("The room lead cannot be invited as an assistant")
        return self.repository.upsert_staff(
            room_id=room_id,
            target_uid=target_uid,
            permissions=default_assistant_permissions(),
            principal=principal,
            change_type="ADDED",
        )

    def update_staff_permissions(
        self,
        principal: Principal,
        room_id: str,
        target_uid: str,
        permissions: dict[str, bool],
    ) -> dict[str, Any]:
        room = self._get_room(room_id)
        self._require_lead(principal, room)
        self._require_mutable_room(room)
        self._require_same_org_staff(principal, target_uid)
        if self.repository.get_staff(room_id, target_uid) is None:
            raise ResourceNotFound("The assistant is not assigned to this room")
        return self.repository.upsert_staff(
            room_id=room_id,
            target_uid=target_uid,
            permissions=normalize_permissions(permissions),
            principal=principal,
            change_type="PERMISSIONS_UPDATED",
        )

    def remove_staff(self, principal: Principal, room_id: str, target_uid: str) -> None:
        room = self._get_room(room_id)
        self._require_lead(principal, room)
        self._require_mutable_room(room)
        self.repository.remove_staff(
            room_id=room_id, uid=target_uid, principal=principal
        )

    def update_room_lead(
        self, principal: Principal, room_id: str, lead_instructor_id: str
    ) -> dict[str, Any]:
        room = self._get_room(room_id)
        self._require_same_org(principal, room)
        if (
            principal.account_type is not AccountType.STAFF
            or principal.organization_role is not OrganizationRole.ADMIN
        ):
            raise AccessDenied("Only an organization admin can assign a room lead")
        self._require_same_org_staff(principal, lead_instructor_id)
        return self.repository.update_room_lead(
            room_id=room_id,
            lead_instructor_id=lead_instructor_id,
            principal=principal,
        )

    def join_room(
        self,
        principal: Principal,
        room_code: str,
        nickname: str | None,
    ) -> dict[str, Any]:
        if (
            principal.account_type is not AccountType.STUDENT
            or not principal.is_anonymous
        ):
            raise AccessDenied("Room join is limited to anonymous students")
        safe_nickname = nickname or f"수강생-{secrets.token_hex(2).upper()}"
        return self.repository.join_room(
            principal=principal,
            room_code=room_code,
            nickname=safe_nickname,
        )

    def update_nickname(
        self,
        principal: Principal,
        room_id: str,
        nickname: str,
    ) -> dict[str, Any]:
        if principal.account_type is not AccountType.STUDENT:
            raise AccessDenied("Only a student can update a participant nickname")
        return self.repository.update_nickname(
            principal=principal, room_id=room_id, nickname=nickname
        )

    def create_question(
        self,
        principal: Principal,
        room_id: str,
        *,
        content: str,
        item_id: str | None,
        client_request_id: str,
    ) -> dict[str, Any]:
        room = self._get_room(room_id)
        if (
            principal.account_type is not AccountType.STUDENT
            or not principal.is_anonymous
        ):
            raise AccessDenied("수강생만 질문을 작성할 수 있습니다.")
        participant = self.repository.get_participant(room_id, principal.uid)
        if (
            principal.org_id != room.get("orgId")
            or participant is None
            or participant.get("roomId") != room_id
            or participant.get("orgId") != room.get("orgId")
        ):
            raise AccessDenied("강의에 참여한 수강생만 질문을 작성할 수 있습니다.")
        decision = moderate_question(content)
        return self.repository.create_question(
            room_id=room_id,
            principal=principal,
            item_id=item_id,
            client_request_id=client_request_id,
            moderation=decision,
        )

    def answer_question(
        self,
        principal: Principal,
        room_id: str,
        question_id: str,
        answer: str,
    ) -> dict[str, Any]:
        self._require_room_permission(
            principal, room_id, Permission.CAN_ANSWER_QUESTIONS
        )
        return self.repository.answer_question(
            room_id=room_id,
            question_id=question_id,
            answer=sanitize_answer(answer),
            principal=principal,
        )

    def cancel_question_answer(
        self, principal: Principal, room_id: str, question_id: str
    ) -> dict[str, Any]:
        self._require_room_permission(
            principal, room_id, Permission.CAN_ANSWER_QUESTIONS
        )
        return self.repository.cancel_question_answer(
            room_id=room_id, question_id=question_id, principal=principal
        )

    def moderate_question(
        self,
        principal: Principal,
        room_id: str,
        question_id: str,
        action: str,
    ) -> dict[str, Any]:
        self._require_room_permission(
            principal, room_id, Permission.CAN_MODERATE_QUESTIONS
        )
        return self.repository.moderate_question(
            room_id=room_id,
            question_id=question_id,
            action=action,
            principal=principal,
        )

    def mark_questions_read(
        self,
        principal: Principal,
        room_id: str,
        context_id: str,
        observed_at: datetime,
        observed_question_id: str,
    ) -> dict[str, Any]:
        room = self._get_room(room_id)
        self._require_staff_read(principal, room)
        if context_id not in {"ALL", "GENERAL", *room.get("itemOrder", [])}:
            raise ResourceNotFound("질문 문맥을 찾을 수 없습니다.")
        return self.repository.mark_questions_read(
            room_id=room_id,
            context_id=context_id,
            observed_at=observed_at,
            observed_question_id=observed_question_id,
            principal=principal,
        )

    def participants(self, principal: Principal, room_id: str) -> dict[str, Any]:
        room = self._get_room(room_id)
        self._require_permission_without_mutation(
            principal, room, Permission.CAN_MANAGE_PARTICIPANTS
        )
        return {
            "roomId": room_id,
            "participants": self.repository.list_participants(room_id),
        }

    def update_participant_restriction(
        self,
        principal: Principal,
        room_id: str,
        participant_id: str,
        is_question_restricted: bool,
    ) -> dict[str, Any]:
        self._require_room_permission(
            principal, room_id, Permission.CAN_MANAGE_PARTICIPANTS
        )
        return self.repository.update_participant_restriction(
            room_id=room_id,
            participant_id=participant_id,
            is_question_restricted=is_question_restricted,
            principal=principal,
        )

    def end_room(self, principal: Principal, room_id: str) -> dict[str, Any]:
        room = self._get_room(room_id)
        self._require_permission_without_mutation(
            principal, room, Permission.CAN_END_ROOM
        )
        return self.repository.end_room(room_id=room_id, principal=principal)

    def end_room_preview(self, principal: Principal, room_id: str) -> dict[str, Any]:
        room = self._get_room(room_id)
        self._require_permission_without_mutation(
            principal, room, Permission.CAN_END_ROOM
        )
        return self.repository.get_end_room_preview(room_id)

    def room_report(self, principal: Principal, room_id: str) -> dict[str, Any]:
        room = self._get_room(room_id)
        self._require_same_org(principal, room)
        if (
            principal.account_type is AccountType.STAFF
            and principal.organization_role is OrganizationRole.ADMIN
        ):
            pass
        else:
            self._require_permission_without_mutation(
                principal, room, Permission.CAN_VIEW_REPORTS
            )
        report = self.repository.get_room_summary(room_id)
        if report is None:
            raise ResourceNotFound("강의 요약이 아직 생성되지 않았습니다.")
        return report

    def _get_course(self, course_id: str) -> dict[str, Any]:
        course = self.repository.get_course(course_id)
        if course is None:
            raise ResourceNotFound("Course not found")
        return course

    def _get_room(self, room_id: str) -> dict[str, Any]:
        room = self.repository.get_room(room_id)
        if room is None:
            raise ResourceNotFound("Room not found")
        course = self.repository.get_course(room.get("courseId", ""))
        if course is None:
            raise ResourceConflict("The room course does not exist")
        self._assert_room_course_integrity(room, course)
        return room

    def _validate_active_room_link(self, course: dict[str, Any]) -> None:
        room_id = course.get("activeRoomId")
        if not room_id:
            return
        room = self.repository.get_room(room_id)
        if room is None:
            raise ResourceConflict("The active room does not exist")
        self._assert_room_course_integrity(room, course)

    @staticmethod
    def _assert_room_course_integrity(
        room: dict[str, Any], course: dict[str, Any]
    ) -> None:
        if (
            room.get("courseId") != course.get("id")
            or room.get("orgId") != course.get("orgId")
            or course.get("activeRoomId") != room.get("id")
        ):
            raise ResourceConflict("Room and course links are inconsistent")

    @staticmethod
    def _require_organization(principal: Principal) -> None:
        if principal.org_id is None:
            raise AccessDenied("An organization is required")

    @staticmethod
    def _require_same_org(principal: Principal, resource: dict[str, Any]) -> None:
        if principal.org_id is None or principal.org_id != resource.get("orgId"):
            raise AccessDenied("Cross-organization access is not allowed")

    def _require_same_org_staff(
        self, principal: Principal, target_uid: str
    ) -> dict[str, Any]:
        target = self.repository.get_user(target_uid)
        if (
            target is None
            or target.get("orgId") != principal.org_id
            or not self._profile_is_staff(target)
        ):
            raise AccessDenied(
                "The selected assistant must be staff in this organization"
            )
        return target

    @staticmethod
    def _profile_is_staff(profile: dict[str, Any]) -> bool:
        try:
            return account_profile(profile)[0] is AccountType.STAFF
        except ValueError:
            return False

    @staticmethod
    def _public_staff_profile(profile: dict[str, Any]) -> dict[str, Any] | None:
        try:
            account_type, organization_role = account_profile(profile)
        except ValueError:
            return None
        if account_type is not AccountType.STAFF:
            return None
        return {
            "uid": profile.get("uid") or profile.get("userId") or profile.get("id"),
            "accountType": AccountType.STAFF.value,
            "organizationRole": organization_role.value if organization_role else None,
            "orgId": profile.get("orgId"),
            "displayName": profile.get("displayName"),
            "email": profile.get("email"),
        }

    def _require_lead(self, principal: Principal, room: dict[str, Any]) -> None:
        self._require_same_org(principal, room)
        if not is_room_lead(principal, room):
            raise AccessDenied(
                "Only the assigned lead instructor can manage room staff"
            )

    @staticmethod
    def _require_mutable_room(room: dict[str, Any]) -> None:
        if room.get("status") != RoomStatus.ACTIVE.value:
            raise AccessDenied("An ending or ended room is read-only")

    def _require_room_permission(
        self,
        principal: Principal,
        room_id: str,
        permission: Permission,
    ) -> tuple[dict[str, Any], dict[str, Any] | None]:
        room = self._get_room(room_id)
        self._require_same_org(principal, room)
        self._require_mutable_room(room)
        staff = self.repository.get_staff(room_id, principal.uid)
        if not has_room_permission(principal, room, staff, permission):
            raise AccessDenied(f"The {permission.value} room permission is required")
        return room, staff

    def _require_permission_without_mutation(
        self,
        principal: Principal,
        room: dict[str, Any],
        permission: Permission,
    ) -> dict[str, Any] | None:
        self._require_same_org(principal, room)
        staff = self.repository.get_staff(room["id"], principal.uid)
        if not has_room_permission(principal, room, staff, permission):
            raise AccessDenied(f"The {permission.value} room permission is required")
        return staff

    def _require_staff_read(self, principal: Principal, room: dict[str, Any]) -> None:
        self._require_same_org(principal, room)
        if is_room_lead(principal, room):
            return
        if (
            principal.account_type is AccountType.STAFF
            and self.repository.get_staff(room["id"], principal.uid) is not None
        ):
            return
        raise AccessDenied("강의 담당 강사만 질문 읽음 상태를 변경할 수 있습니다.")

    def _require_course_permission(
        self,
        principal: Principal,
        course_id: str,
        permission: Permission,
    ) -> dict[str, Any]:
        course = self._get_course(course_id)
        self._require_same_org(principal, course)
        self._validate_active_room_link(course)
        if (
            principal.account_type is AccountType.STAFF
            and course.get("leadInstructorId") == principal.uid
        ):
            return course
        room_id = course.get("activeRoomId")
        if not room_id:
            raise AccessDenied(
                "Only the assigned lead can change a course before room creation"
            )
        self._require_room_permission(principal, room_id, permission)
        return course

    def _require_room_read(self, principal: Principal, room: dict[str, Any]) -> None:
        self._require_same_org(principal, room)
        if (
            principal.account_type is AccountType.STAFF
            and principal.organization_role is OrganizationRole.ADMIN
        ):
            return
        if is_room_lead(principal, room):
            return
        if principal.account_type is AccountType.STAFF:
            if self.repository.get_staff(room["id"], principal.uid):
                return
        if principal.account_type is AccountType.STUDENT:
            participant = self.repository.get_participant(room["id"], principal.uid)
            if (
                room.get("status")
                in {
                    RoomStatus.ACTIVE.value,
                    RoomStatus.ENDING.value,
                    RoomStatus.ENDED.value,
                }
                and participant
                and participant.get("orgId") == room.get("orgId")
                and participant.get("roomId") == room.get("id")
            ):
                return
        raise AccessDenied("This account cannot access the room")
