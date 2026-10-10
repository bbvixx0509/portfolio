import asyncio
import os
from typing import Any

import httpx
import pytest
from firebase_admin import auth
from httpx import ASGITransport, AsyncClient

from app.adapters.firebase_emulator import get_admin_app, get_firestore_client
from app.domain.authorization import (
    Permission,
    default_assistant_permissions,
    empty_permissions,
)
from app.main import app
from app.scripts.seed_emulator import (
    DEMO_COURSE_ID,
    DEMO_ORG_ID,
    DEMO_ROOM_ID,
    LOCAL_PASSWORD,
    SEED_ACCOUNTS,
    seed_emulator,
)

pytestmark = pytest.mark.skipif(
    os.getenv("NODO_RUN_EMULATOR_TESTS") != "1",
    reason="Set NODO_RUN_EMULATOR_TESTS=1 with Auth/Firestore Emulators running",
)


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


def sign_in(email: str) -> str:
    response = httpx.post(
        "http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/"
        "accounts:signInWithPassword?key=local-demo-api-key",
        json={
            "email": email,
            "password": LOCAL_PASSWORD,
            "returnSecureToken": True,
        },
        timeout=10,
    )
    response.raise_for_status()
    return response.json()["idToken"]


def sign_in_anonymously() -> tuple[str, str]:
    response = httpx.post(
        "http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/"
        "accounts:signUp?key=local-demo-api-key",
        json={"returnSecureToken": True},
        timeout=10,
    )
    response.raise_for_status()
    body = response.json()
    return body["idToken"], body["localId"]


def cleanup_anonymous_student(database: Any, student_uid: str) -> None:
    database.collection("rooms").document(DEMO_ROOM_ID).collection(
        "participants"
    ).document(student_uid).delete()
    database.collection("users").document(student_uid).delete()
    try:
        auth.delete_user(student_uid, app=get_admin_app())
    except auth.UserNotFoundError:
        pass


def question_document_ids(database: Any, collection_name: str) -> set[str]:
    return {
        snapshot.id
        for snapshot in database.collection("rooms")
        .document(DEMO_ROOM_ID)
        .collection(collection_name)
        .stream()
    }


def create_concurrency_course(database: Any, course_id: str) -> Any:
    course_ref = database.collection("courses").document(course_id)
    course_ref.set(
        {
            "id": course_id,
            "orgId": DEMO_ORG_ID,
            "title": f"Concurrency test {course_id}",
            "description": "",
            "leadInstructorId": "lead-instructor",
            "activeRoomId": None,
            "status": "DRAFT",
            "schemaVersion": 1,
        }
    )
    course_ref.collection("items").document(f"{course_id}-item").set(
        {
            "id": f"{course_id}-item",
            "courseId": course_id,
            "orgId": DEMO_ORG_ID,
            "chapterId": f"{course_id}-chapter",
            "title": "Concurrency item",
            "order": 0,
            "isCompleted": False,
            "schemaVersion": 1,
        }
    )
    return course_ref


def rooms_for_courses(database: Any, course_ids: set[str]) -> dict[str, Any]:
    return {
        snapshot.id: snapshot.to_dict() or {}
        for snapshot in database.collection("rooms").stream()
        if (snapshot.to_dict() or {}).get("courseId") in course_ids
    }


def assert_course_room_link(database: Any, *, course_id: str, join_code: str) -> str:
    course = database.collection("courses").document(course_id).get()
    assert course.exists
    room_id = course.get("activeRoomId")
    assert room_id

    room = database.collection("rooms").document(room_id).get()
    assert room.exists
    room_data = room.to_dict() or {}
    assert room_data.get("id") == room_id
    assert room_data.get("courseId") == course_id
    assert room_data.get("orgId") == DEMO_ORG_ID

    mapping = database.collection("roomJoinCodes").document(join_code).get()
    assert mapping.exists
    mapping_data = mapping.to_dict() or {}
    assert mapping_data.get("id") == join_code
    assert mapping_data.get("roomId") == room_id
    assert mapping_data.get("orgId") == room_data.get("orgId")
    return room_id


def cleanup_concurrency_documents(
    database: Any, *, course_ids: set[str], join_codes: set[str]
) -> None:
    for join_code in join_codes:
        database.collection("roomJoinCodes").document(join_code).delete()

    for snapshot in database.collection("rooms").stream():
        if (snapshot.to_dict() or {}).get("courseId") in course_ids:
            snapshot.reference.delete()

    for course_id in course_ids:
        course_ref = database.collection("courses").document(course_id)
        for item in course_ref.collection("items").stream():
            item.reference.delete()
        course_ref.delete()


@pytest.fixture(scope="module", autouse=True)
def seeded_emulator() -> Any:
    seed_emulator()
    yield
    seed_emulator()


def test_seed_is_idempotent_and_uses_fixed_local_accounts() -> None:
    first = seed_emulator()
    second = seed_emulator()
    application = get_admin_app()
    database = get_firestore_client()

    assert first == second
    assert all(auth.get_user(account.uid, app=application) for account in SEED_ACCOUNTS)
    assert database.collection("organizations").document(DEMO_ORG_ID).get().exists
    assert database.collection("courses").document(DEMO_COURSE_ID).get().exists
    room = database.collection("rooms").document(DEMO_ROOM_ID).get()
    assert room.exists
    assert "joinCode" not in (room.to_dict() or {})
    mapping = database.collection("roomJoinCodes").document("NODO01").get()
    assert mapping.get("roomId") == DEMO_ROOM_ID
    assistant = (
        database.collection("rooms")
        .document(DEMO_ROOM_ID)
        .collection("staff")
        .document("assistant-limited")
        .get()
    )
    assert assistant.get("permissions.canControlProgress") is True
    assert assistant.get("permissions.canAnswerQuestions") is True
    assert assistant.get("permissions.canModerateQuestions") is False
    assert assistant.get("roomId") == DEMO_ROOM_ID
    assert "role" not in (assistant.to_dict() or {})
    for account in SEED_ACCOUNTS:
        profile = database.collection("users").document(account.uid).get()
        assert profile.get("accountType") == "STAFF"
        assert "role" not in (profile.to_dict() or {})


@pytest.mark.parametrize(
    ("email", "organization_role"),
    [
        ("admin@nodo.test", "ADMIN"),
        ("lead@nodo.test", "INSTRUCTOR"),
        ("assistant.none@nodo.test", "INSTRUCTOR"),
        ("assistant.limited@nodo.test", "INSTRUCTOR"),
        ("outsider@nodo.test", "INSTRUCTOR"),
    ],
)
@pytest.mark.anyio
async def test_seeded_staff_authenticate_without_global_room_roles(
    email: str, organization_role: str
) -> None:
    token = sign_in(email)

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://testserver"
    ) as client:
        response = await client.get(
            "/api/me", headers={"Authorization": f"Bearer {token}"}
        )

    assert response.status_code == 200
    assert response.json()["accountType"] == "STAFF"
    assert response.json()["organizationRole"] == organization_role
    assert "role" not in response.json()


@pytest.mark.anyio
async def test_permission_is_checked_by_fastapi_for_each_completion_write() -> None:
    seed_emulator()
    no_permission = sign_in("assistant.none@nodo.test")
    limited = sign_in("assistant.limited@nodo.test")

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://testserver"
    ) as client:
        denied = await client.patch(
            f"/api/rooms/{DEMO_ROOM_ID}/items/flow-1/completion",
            headers={"Authorization": f"Bearer {no_permission}"},
            json={"isCompleted": True},
        )
        allowed = await client.patch(
            f"/api/rooms/{DEMO_ROOM_ID}/items/flow-1/completion",
            headers={"Authorization": f"Bearer {limited}"},
            json={"isCompleted": True},
        )

    assert denied.status_code == 403
    assert allowed.status_code == 200
    assert allowed.json()["currentItemId"] == "flow-2"


@pytest.mark.anyio
async def test_unchecking_completed_item_cascades_in_firestore_transaction() -> None:
    seed_emulator()
    lead = sign_in("lead@nodo.test")
    database = get_firestore_client()

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://testserver"
    ) as client:
        for item_id in ("flow-1", "flow-2"):
            response = await client.patch(
                f"/api/rooms/{DEMO_ROOM_ID}/items/{item_id}/completion",
                headers={"Authorization": f"Bearer {lead}"},
                json={"isCompleted": True},
            )
            assert response.status_code == 200
        reset = await client.patch(
            f"/api/rooms/{DEMO_ROOM_ID}/items/flow-1/completion",
            headers={"Authorization": f"Bearer {lead}"},
            json={"isCompleted": False},
        )

    assert reset.status_code == 200
    assert reset.json()["changedItemIds"] == ["flow-1", "flow-2", "flow-3"]
    items = database.collection("courses").document(DEMO_COURSE_ID).collection("items")
    assert all(
        not items.document(item_id).get().get("isCompleted")
        for item_id in (
            "flow-1",
            "flow-2",
            "flow-3",
        )
    )


@pytest.mark.anyio
async def test_staff_permissions_and_logs_are_persisted_then_revoked() -> None:
    seed_emulator()
    lead = sign_in("lead@nodo.test")
    assistant = sign_in("assistant.none@nodo.test")
    database = get_firestore_client()
    logs = (
        database.collection("rooms").document(DEMO_ROOM_ID).collection("permissionLogs")
    )
    before_log_count = len(list(logs.stream()))
    default_permissions = default_assistant_permissions()
    multiple_permissions = {
        **default_permissions,
        Permission.CAN_CONTROL_PROGRESS.value: True,
        Permission.CAN_EDIT_COURSE_FLOW.value: True,
        Permission.CAN_MANAGE_MATERIALS.value: True,
    }
    all_permissions = {permission.value: True for permission in Permission}

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://testserver"
    ) as client:
        rejected_custom_invite = await client.post(
            f"/api/rooms/{DEMO_ROOM_ID}/staff",
            headers={"Authorization": f"Bearer {lead}"},
            json={
                "userId": "assistant-none",
                "permissions": {
                    Permission.CAN_CONTROL_PROGRESS.value: True,
                },
            },
        )
        added = await client.post(
            f"/api/rooms/{DEMO_ROOM_ID}/staff",
            headers={"Authorization": f"Bearer {lead}"},
            json={"userId": "assistant-none"},
        )
        multiple = await client.put(
            f"/api/rooms/{DEMO_ROOM_ID}/staff/assistant-none/permissions",
            headers={"Authorization": f"Bearer {lead}"},
            json={"permissions": multiple_permissions},
        )
        granted_all = await client.put(
            f"/api/rooms/{DEMO_ROOM_ID}/staff/assistant-none/permissions",
            headers={"Authorization": f"Bearer {lead}"},
            json={"permissions": all_permissions},
        )
        revoked = await client.put(
            f"/api/rooms/{DEMO_ROOM_ID}/staff/assistant-none/permissions",
            headers={"Authorization": f"Bearer {lead}"},
            json={"permissions": empty_permissions()},
        )
        denied_after_revocation = await client.patch(
            f"/api/rooms/{DEMO_ROOM_ID}/items/flow-1/completion",
            headers={"Authorization": f"Bearer {assistant}"},
            json={"isCompleted": True},
        )

    assert rejected_custom_invite.status_code == 422
    assert added.status_code == 201
    assert added.json()["permissions"] == default_permissions
    assert multiple.json()["permissions"] == multiple_permissions
    assert all(granted_all.json()["permissions"].values())
    assert not any(revoked.json()["permissions"].values())
    assert denied_after_revocation.status_code == 403
    assert len(list(logs.stream())) == before_log_count + 4


@pytest.mark.anyio
async def test_staff_can_lead_own_room_and_assist_in_another_room() -> None:
    seed_emulator()
    assistant = sign_in("assistant.limited@nodo.test")
    database = get_firestore_client()
    course_id: str | None = None
    room_id: str | None = None
    join_code = "ROLEA1"

    try:
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://testserver"
        ) as client:
            rejected_owner_override = await client.post(
                "/api/courses",
                headers={"Authorization": f"Bearer {assistant}"},
                json={
                    "title": "소유자 덮어쓰기 금지",
                    "description": "",
                    "leadInstructorId": "lead-instructor",
                },
            )
            assert rejected_owner_override.status_code == 422
            created_course = await client.post(
                "/api/courses",
                headers={"Authorization": f"Bearer {assistant}"},
                json={"title": "방별 역할 검증", "description": ""},
            )
            assert created_course.status_code == 201
            course_id = created_course.json()["id"]
            assert created_course.json()["leadInstructorId"] == "assistant-limited"

            created_room = await client.post(
                f"/api/courses/{course_id}/rooms",
                headers={"Authorization": f"Bearer {assistant}"},
                json={"joinCode": join_code},
            )
            assert created_room.status_code == 201
            room_id = created_room.json()["id"]
            assert created_room.json()["leadInstructorId"] == "assistant-limited"

            courses = await client.get(
                "/api/courses",
                headers={"Authorization": f"Bearer {assistant}"},
            )
            roles = {course["id"]: course["roomRole"] for course in courses.json()}
            assert roles[DEMO_COURSE_ID] == "ASSISTANT"
            assert roles[course_id] == "LEAD"
    finally:
        database.collection("roomJoinCodes").document(join_code).delete()
        if room_id:
            database.collection("rooms").document(room_id).delete()
        if course_id:
            database.collection("courses").document(course_id).delete()
        seed_emulator()


@pytest.mark.anyio
async def test_invitation_rejects_student_and_other_organization_staff() -> None:
    seed_emulator()
    lead = sign_in("lead@nodo.test")
    database = get_firestore_client()
    candidate_ref = database.collection("users").document("student-candidate")
    candidate_ref.set(
        {
            "uid": "student-candidate",
            "orgId": DEMO_ORG_ID,
            "accountType": "STUDENT",
            "displayName": "학생 후보",
            "schemaVersion": 1,
        }
    )

    try:
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://testserver"
        ) as client:
            overview = await client.get(
                f"/api/rooms/{DEMO_ROOM_ID}/staff",
                headers={"Authorization": f"Bearer {lead}"},
            )
            student = await client.post(
                f"/api/rooms/{DEMO_ROOM_ID}/staff",
                headers={"Authorization": f"Bearer {lead}"},
                json={"userId": "student-candidate"},
            )
            outsider = await client.post(
                f"/api/rooms/{DEMO_ROOM_ID}/staff",
                headers={"Authorization": f"Bearer {lead}"},
                json={"userId": "outsider-instructor"},
            )

        assert overview.status_code == 200
        candidate_ids = {
            candidate["uid"]
            for candidate in overview.json()["availableInstructors"]
        }
        assert "assistant-none" in candidate_ids
        assert "student-candidate" not in candidate_ids
        assert "outsider-instructor" not in candidate_ids
        assert student.status_code == 403
        assert outsider.status_code == 403
        assert not (
            database.collection("rooms")
            .document(DEMO_ROOM_ID)
            .collection("staff")
            .document("student-candidate")
            .get()
            .exists
        )
    finally:
        candidate_ref.delete()
        seed_emulator()


@pytest.mark.anyio
async def test_student_and_other_organization_cannot_control_demo_room() -> None:
    seed_emulator()
    student_token, student_uid = sign_in_anonymously()
    outsider = sign_in("outsider@nodo.test")
    application = get_admin_app()
    database = get_firestore_client()

    try:
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://testserver"
        ) as client:
            joined = await client.post(
                "/api/rooms/join",
                headers={"Authorization": f"Bearer {student_token}"},
                json={"roomCode": "NODO01", "nickname": "익명 수강생"},
            )
            student_denied = await client.patch(
                f"/api/rooms/{DEMO_ROOM_ID}/items/flow-1/completion",
                headers={"Authorization": f"Bearer {student_token}"},
                json={"isCompleted": True},
            )
            outsider_denied = await client.get(
                f"/api/rooms/{DEMO_ROOM_ID}",
                headers={"Authorization": f"Bearer {outsider}"},
            )

        assert joined.status_code == 200
        assert student_denied.status_code == 403
        assert outsider_denied.status_code == 403
    finally:
        database.collection("rooms").document(DEMO_ROOM_ID).collection(
            "participants"
        ).document(student_uid).delete()
        database.collection("users").document(student_uid).delete()
        auth.delete_user(student_uid, app=application)


@pytest.mark.anyio
async def test_join_code_is_private_and_share_permission_is_enforced() -> None:
    seed_emulator()
    lead = sign_in("lead@nodo.test")
    assistant = sign_in("assistant.limited@nodo.test")
    share_permissions = {
        **empty_permissions(),
        Permission.CAN_SHARE_ROOM.value: True,
    }

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://testserver"
    ) as client:
        room = await client.get(
            f"/api/rooms/{DEMO_ROOM_ID}",
            headers={"Authorization": f"Bearer {lead}"},
        )
        denied = await client.get(
            f"/api/rooms/{DEMO_ROOM_ID}/share",
            headers={"Authorization": f"Bearer {assistant}"},
        )
        lead_share = await client.get(
            f"/api/rooms/{DEMO_ROOM_ID}/share",
            headers={"Authorization": f"Bearer {lead}"},
        )
        granted = await client.put(
            f"/api/rooms/{DEMO_ROOM_ID}/staff/assistant-limited/permissions",
            headers={"Authorization": f"Bearer {lead}"},
            json={"permissions": share_permissions},
        )
        assistant_share = await client.get(
            f"/api/rooms/{DEMO_ROOM_ID}/share",
            headers={"Authorization": f"Bearer {assistant}"},
        )

    assert room.status_code == 200
    assert "joinCode" not in room.json()
    assert denied.status_code == 403
    assert lead_share.json()["joinCode"] == "NODO01"
    assert granted.status_code == 200
    assert assistant_share.json()["joinCode"] == "NODO01"


@pytest.mark.emulator_concurrency
@pytest.mark.parametrize("iteration", range(10), ids=lambda value: f"race-{value + 1}")
@pytest.mark.anyio
async def test_room_creation_reserves_course_and_code_atomically(
    iteration: int,
) -> None:
    lead = sign_in("lead@nodo.test")
    database = get_firestore_client()
    course_id = f"concurrency-same-{iteration:02d}"
    join_code = f"R2A{iteration:03d}"
    course_ids = {course_id}
    join_codes = {join_code}
    cleanup_concurrency_documents(
        database, course_ids=course_ids, join_codes=join_codes
    )
    create_concurrency_course(database, course_id)

    try:
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://testserver"
        ) as client:

            async def create() -> httpx.Response:
                return await client.post(
                    f"/api/courses/{course_id}/rooms",
                    headers={"Authorization": f"Bearer {lead}"},
                    json={"joinCode": join_code},
                )

            responses = await asyncio.gather(create(), create())

        assert sorted(response.status_code for response in responses) == [201, 409]
        room_id = assert_course_room_link(
            database, course_id=course_id, join_code=join_code
        )
        assert {
            response.json()["id"]
            for response in responses
            if response.status_code == 201
        } == {room_id}
        assert set(rooms_for_courses(database, course_ids)) == {room_id}
    finally:
        cleanup_concurrency_documents(
            database, course_ids=course_ids, join_codes=join_codes
        )


@pytest.mark.emulator_concurrency
@pytest.mark.anyio
async def test_room_creation_reserves_shared_code_across_courses_atomically() -> None:
    lead = sign_in("lead@nodo.test")
    database = get_firestore_client()
    course_ids = {"concurrency-shared-left", "concurrency-shared-right"}
    join_code = "R2ASHARE"
    join_codes = {join_code}
    cleanup_concurrency_documents(
        database, course_ids=course_ids, join_codes=join_codes
    )
    for course_id in course_ids:
        create_concurrency_course(database, course_id)

    ordered_courses = sorted(course_ids)
    try:
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://testserver"
        ) as client:

            async def create(course_id: str) -> httpx.Response:
                return await client.post(
                    f"/api/courses/{course_id}/rooms",
                    headers={"Authorization": f"Bearer {lead}"},
                    json={"joinCode": join_code},
                )

            responses = await asyncio.gather(
                *(create(course_id) for course_id in ordered_courses)
            )

        assert sorted(response.status_code for response in responses) == [201, 409]
        winner_index = next(
            index
            for index, response in enumerate(responses)
            if response.status_code == 201
        )
        winner_course = ordered_courses[winner_index]
        loser_course = ordered_courses[1 - winner_index]
        room_id = assert_course_room_link(
            database, course_id=winner_course, join_code=join_code
        )
        assert responses[winner_index].json()["id"] == room_id
        assert (
            database.collection("courses")
            .document(loser_course)
            .get()
            .get("activeRoomId")
            is None
        )
        assert set(rooms_for_courses(database, course_ids)) == {room_id}
    finally:
        cleanup_concurrency_documents(
            database, course_ids=course_ids, join_codes=join_codes
        )


@pytest.mark.emulator_concurrency
@pytest.mark.anyio
async def test_room_creation_allows_independent_course_and_code_pairs() -> None:
    lead = sign_in("lead@nodo.test")
    database = get_firestore_client()
    pairs = {
        "concurrency-independent-left": "R2ALEFT",
        "concurrency-independent-right": "R2ARIGHT",
    }
    course_ids = set(pairs)
    join_codes = set(pairs.values())
    cleanup_concurrency_documents(
        database, course_ids=course_ids, join_codes=join_codes
    )
    for course_id in course_ids:
        create_concurrency_course(database, course_id)

    ordered_pairs = sorted(pairs.items())
    try:
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://testserver"
        ) as client:

            async def create(course_id: str, join_code: str) -> httpx.Response:
                return await client.post(
                    f"/api/courses/{course_id}/rooms",
                    headers={"Authorization": f"Bearer {lead}"},
                    json={"joinCode": join_code},
                )

            responses = await asyncio.gather(
                *(
                    create(course_id, join_code)
                    for course_id, join_code in ordered_pairs
                )
            )

        assert [response.status_code for response in responses] == [201, 201]
        linked_room_ids = {
            assert_course_room_link(database, course_id=course_id, join_code=join_code)
            for course_id, join_code in ordered_pairs
        }
        assert linked_room_ids == {response.json()["id"] for response in responses}
        assert set(rooms_for_courses(database, course_ids)) == linked_room_ids
    finally:
        cleanup_concurrency_documents(
            database, course_ids=course_ids, join_codes=join_codes
        )


@pytest.mark.anyio
async def test_invalid_room_course_link_is_rejected_by_api() -> None:
    seed_emulator()
    lead = sign_in("lead@nodo.test")
    database = get_firestore_client()
    room_ref = database.collection("rooms").document(DEMO_ROOM_ID)
    room_ref.update({"courseId": "missing-course"})

    try:
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://testserver"
        ) as client:
            response = await client.get(
                f"/api/rooms/{DEMO_ROOM_ID}",
                headers={"Authorization": f"Bearer {lead}"},
            )
        assert response.status_code == 409
    finally:
        seed_emulator()


@pytest.mark.anyio
async def test_active_flow_edit_syncs_room_and_preserves_completion_prefix() -> None:
    seed_emulator()
    lead = sign_in("lead@nodo.test")
    database = get_firestore_client()

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://testserver"
    ) as client:
        completed = await client.patch(
            f"/api/rooms/{DEMO_ROOM_ID}/items/flow-1/completion",
            headers={"Authorization": f"Bearer {lead}"},
            json={"isCompleted": True},
        )
        updated = await client.put(
            f"/api/courses/{DEMO_COURSE_ID}/flow",
            headers={"Authorization": f"Bearer {lead}"},
            json={
                "chapters": [{"id": "chapter-1", "title": "Updated", "order": 0}],
                "items": [
                    {
                        "id": "flow-1",
                        "title": "Preserved",
                        "chapterId": "chapter-1",
                        "order": 0,
                    },
                    {
                        "id": "flow-new",
                        "title": "New",
                        "chapterId": "chapter-1",
                        "order": 1,
                    },
                    {
                        "id": "flow-2",
                        "title": "Reset after new",
                        "chapterId": "chapter-1",
                        "order": 2,
                    },
                ],
            },
        )

    assert completed.status_code == 200
    assert updated.status_code == 200
    returned = {item["id"]: item["isCompleted"] for item in updated.json()["items"]}
    assert returned == {"flow-1": True, "flow-new": False, "flow-2": False}
    room = database.collection("rooms").document(DEMO_ROOM_ID).get()
    assert room.get("itemOrder") == ["flow-1", "flow-new", "flow-2"]
    assert room.get("currentItemId") == "flow-new"


@pytest.mark.anyio
async def test_adding_existing_staff_returns_409() -> None:
    seed_emulator()
    lead = sign_in("lead@nodo.test")

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://testserver"
    ) as client:
        response = await client.post(
            f"/api/rooms/{DEMO_ROOM_ID}/staff",
            headers={"Authorization": f"Bearer {lead}"},
            json={"userId": "assistant-limited"},
        )

    assert response.status_code == 409


@pytest.mark.emulator_concurrency
@pytest.mark.anyio
async def test_concurrent_idempotent_question_creates_one_pair() -> None:
    seed_emulator()
    student_token, student_uid = sign_in_anonymously()
    database = get_firestore_client()
    headers = {"Authorization": f"Bearer {student_token}"}
    body = {
        "content": "동시에 재전송되어도 하나만 저장되는 질문",
        "itemId": "flow-2",
        "clientRequestId": "emulator-idempotent-race-01",
    }

    try:
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://testserver"
        ) as client:
            joined = await client.post(
                "/api/rooms/join",
                headers=headers,
                json={"roomCode": "NODO01", "nickname": "멱등성 수강생"},
            )
            assert joined.status_code == 200

            async def submit() -> httpx.Response:
                return await client.post(
                    f"/api/rooms/{DEMO_ROOM_ID}/questions",
                    headers=headers,
                    json=body,
                )

            responses = await asyncio.gather(submit(), submit())

        assert [response.status_code for response in responses] == [201, 201]
        assert len({response.json()["id"] for response in responses}) == 1
        question_ids = question_document_ids(database, "questions")
        author_ids = question_document_ids(database, "questionAuthors")
        assert question_ids == author_ids == {responses[0].json()["id"]}
        public_question = (
            database.collection("rooms")
            .document(DEMO_ROOM_ID)
            .collection("questions")
            .document(responses[0].json()["id"])
            .get()
            .to_dict()
            or {}
        )
        author = (
            database.collection("rooms")
            .document(DEMO_ROOM_ID)
            .collection("questionAuthors")
            .document(responses[0].json()["id"])
            .get()
            .to_dict()
            or {}
        )
        assert "participantUid" not in public_question
        assert "clientRequestId" not in public_question
        assert author["participantUid"] == student_uid
        assert author["clientRequestId"] == body["clientRequestId"]
        rate_limit = (
            database.collection("rooms")
            .document(DEMO_ROOM_ID)
            .collection("questionRateLimits")
            .document(student_uid)
            .get()
            .to_dict()
            or {}
        )
        assert len(rate_limit["recent"]) == 1
    finally:
        cleanup_anonymous_student(database, student_uid)
        seed_emulator()


@pytest.mark.emulator_concurrency
@pytest.mark.anyio
async def test_concurrent_question_rate_limit_is_atomic_without_orphans() -> None:
    seed_emulator()
    student_token, student_uid = sign_in_anonymously()
    database = get_firestore_client()
    headers = {"Authorization": f"Bearer {student_token}"}
    contents = [
        "파이썬 변수 선언 방법이 궁금합니다",
        "리액트 상태 변경 흐름을 설명해 주세요",
        "파이어스토어 규칙은 어디에서 검사하나요",
        "클라우드 런 배포 순서를 알고 싶습니다",
        "수업 체크리스트 완료 기준은 무엇인가요",
    ]

    try:
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://testserver"
        ) as client:
            joined = await client.post(
                "/api/rooms/join",
                headers=headers,
                json={"roomCode": "NODO01", "nickname": "도배 제한 수강생"},
            )
            assert joined.status_code == 200

            async def submit(index: int, content: str) -> httpx.Response:
                return await client.post(
                    f"/api/rooms/{DEMO_ROOM_ID}/questions",
                    headers=headers,
                    json={
                        "content": content,
                        "itemId": None,
                        "clientRequestId": f"emulator-rate-race-{index:02d}",
                    },
                )

            responses = await asyncio.gather(
                *(submit(index, content) for index, content in enumerate(contents))
            )

        statuses = sorted(response.status_code for response in responses)
        assert statuses == [201, 201, 201, 429, 429]
        assert all(response.status_code < 500 for response in responses)
        question_ids = question_document_ids(database, "questions")
        author_ids = question_document_ids(database, "questionAuthors")
        assert question_ids == author_ids
        assert len(question_ids) == 3
        rate_limit = (
            database.collection("rooms")
            .document(DEMO_ROOM_ID)
            .collection("questionRateLimits")
            .document(student_uid)
            .get()
            .to_dict()
            or {}
        )
        assert len(rate_limit["recent"]) == 3
    finally:
        cleanup_anonymous_student(database, student_uid)
        seed_emulator()


@pytest.mark.emulator_concurrency
@pytest.mark.parametrize(
    "iteration", range(5), ids=lambda value: f"end-race-{value + 1}"
)
@pytest.mark.anyio
async def test_room_end_and_question_race_has_consistent_summary_and_no_orphans(
    iteration: int,
) -> None:
    seed_emulator()
    student_token, student_uid = sign_in_anonymously()
    lead = sign_in("lead@nodo.test")
    database = get_firestore_client()
    student_headers = {"Authorization": f"Bearer {student_token}"}
    lead_headers = {"Authorization": f"Bearer {lead}"}

    try:
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://testserver"
        ) as client:
            joined = await client.post(
                "/api/rooms/join",
                headers=student_headers,
                json={"roomCode": "NODO01", "nickname": "종료 경쟁 수강생"},
            )
            assert joined.status_code == 200

            question_response, end_response = await asyncio.gather(
                client.post(
                    f"/api/rooms/{DEMO_ROOM_ID}/questions",
                    headers=student_headers,
                    json={
                        "content": f"종료 경쟁 질문 {iteration + 1}",
                        "itemId": "flow-1",
                        "clientRequestId": f"emulator-end-race-{iteration:02d}",
                    },
                ),
                client.post(
                    f"/api/rooms/{DEMO_ROOM_ID}/end",
                    headers=lead_headers,
                ),
            )

        assert question_response.status_code in {201, 403}
        assert end_response.status_code == 200
        assert question_response.status_code < 500
        room = (
            database.collection("rooms")
            .document(DEMO_ROOM_ID)
            .get()
            .to_dict()
            or {}
        )
        summary = (
            database.collection("rooms")
            .document(DEMO_ROOM_ID)
            .collection("summary")
            .document("current")
            .get()
            .to_dict()
            or {}
        )
        question_ids = question_document_ids(database, "questions")
        author_ids = question_document_ids(database, "questionAuthors")
        assert room["status"] == "ENDED"
        assert question_ids == author_ids
        assert len(question_ids) == (1 if question_response.status_code == 201 else 0)
        assert summary["totalQuestionCount"] == len(question_ids)
        assert summary["unansweredQuestionCount"] == len(question_ids)
        assert summary["exportStatus"] == "NOT_CONFIGURED"
    finally:
        cleanup_anonymous_student(database, student_uid)
        seed_emulator()
