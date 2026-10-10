# NoDo 02 Firestore 스키마

## 범위와 공통 원칙

- 모든 새 업무 문서는 `schemaVersion: 1`, 조직 경계용 `orgId`와 서버 시각을 사용한다.
- `demo-nodo` Emulator의 강의 데이터와 실제 `(default)` Firestore의 조직·직원 데이터는 서로 자동 복사하지 않는다.
- 브라우저는 환경별 Rules가 허용한 문서만 읽는다. 실제 Firestore의 조직 초대·감사·사용자 목록과 모든 클라이언트 쓰기는 거부하며 FastAPI Admin SDK만 처리한다.
- 질문 공개 상태와 작성자 신원을 분리한다. 공개 질문 문서에는 UID·이메일·실명이 없고, 작성자·속도 제한·감사 문서는 서버 전용이다.
- 실제 Storage 파일은 저장하지 않으며 Storage Rules는 전체 읽기·쓰기를 거부한다.

## 경로 개요

```text
organizations/{orgId}
  staffInvitations/{invitationId}             # 02-3 서버 전용 직원 초대
  auditLogs/{eventId}                         # Bootstrap·직원 초대 서버 전용 감사
users/{uid}
courses/{courseId}
  chapters/{chapterId}
  items/{itemId}
  materials/current
rooms/{roomId}
  staff/{uid}
  participants/{uid}                         # 내부 문서 ID는 인증용, 목록 API에는 비노출
  permissionLogs/{logId}
  questions/{questionId}                     # 공개 가능한 질문 상태
  questionAuthors/{questionId}               # 서버 전용 작성자·멱등 연결
  questionRateLimits/{participantUid}         # 서버 전용 속도·유사 질문 창
  questionReads/{staffUid}
    contexts/{ALL|GENERAL|itemId}
  moderationLogs/{logId}                     # 서버 전용 감사
  serverState/termination                    # 서버 전용 최초 종료 실행자·상태
  summary/current                            # 종료 시 확정되는 불변 요약
roomJoinCodes/{UPPER_CODE}                   # 서버 전용
```

## 기존 핵심 문서

### `organizations/{orgId}`와 `users/{uid}`

실제 조직 문서는 `id`, `orgId`, `name`, `ownerUid`, `bootstrapState`, 시각과 `schemaVersion`을 가진다. 소유자 이메일은 조직 문서에 복제하지 않는다.

사용자 문서는 `uid`, `orgId`, `accountType: STAFF | STUDENT`, `isOrgAdmin`, `isOrgOwner`, `isAnonymous`, 정규화 이메일, `displayName`, `photoURL`, 시각과 버전을 가진다. 02-3 초대 가입 STAFF는 `joinedByInvitationId`를 추가하고 `isOrgAdmin: false`, `isOrgOwner: false`로 생성한다. ID Token, OAuth·Refresh Token, 비밀번호와 인증 쿠키는 저장하지 않는다.

실제 Production Rules는 사용자가 본인 `users/{uid}` 문서를 단건 읽는 것만 허용하고 사용자 목록은 조직 소유자에게도 허용하지 않는다. 구성원 목록은 FastAPI가 권한을 다시 확인하고 필요한 필드만 반환한다. 브라우저는 사용자 문서를 수정할 수 없다.

`LEAD_INSTRUCTOR`와 `ASSISTANT_INSTRUCTOR`는 새 사용자 문서에 저장하지 않는다. 주 강사는 현재 room의 `leadInstructorId`, 보조 강사는 현재 room의 staff 문서로 판정한다. 과거 `role`을 읽는 호환 코드는 계정 유형 변환에만 사용할 수 있고 방 권한을 부여하지 않는다.

### `organizations/{orgId}/staffInvitations/{invitationId}`

초대 ID는 `SHA-256(orgId + NUL + emailNormalized)` 결정값이다. 원본 이메일을 문서 ID로 사용하지 않으며 이 ID 자체는 가입 권한 증명이 아니다. 서버는 수락할 때 인증된 Google 이메일과 `emailNormalized`를 정확히 다시 비교한다.

| 필드 | 형식·설명 |
| --- | --- |
| `id`, `orgId` | 결정적 초대 ID와 조직 경계 |
| `emailNormalized` | trim·소문자 정규화된 허용 회사 이메일. API 목록은 소유자에게만 반환 |
| `status` | `PENDING` · `ACCEPTED` · `REVOKED` |
| `revision` | 최초 1, REVOKED·만료 재발급마다 증가 |
| `invitedByUid` | 현재 revision을 등록한 조직 소유자 |
| `createdAt`, `updatedAt`, `expiresAt` | 서버 생성·변경·만료 시각 |
| `acceptedAt`, `acceptedByUid` | 수락 뒤 기록, 그 전에는 null |
| `revokedAt`, `revokedByUid` | 취소 뒤 기록, 재발급 시 정리 |
| `schemaVersion` | 현재 1 |

유효한 PENDING 재등록은 문서를 바꾸지 않는다. REVOKED 또는 만료 초대는 같은 ID에서 revision을 증가시키고 PENDING으로 되돌리며 새 만료 시각과 초대자를 기록한다. 취소는 삭제가 아니라 PENDING→REVOKED 전환이다. 어떤 브라우저 역할도 문서 단건·목록 읽기나 쓰기를 할 수 없다.

### `organizations/{orgId}/auditLogs/{eventId}`

02-2 Bootstrap과 02-3 직원 초대의 서버 전용 감사다. 02-3 이벤트는 `STAFF_INVITATION_CREATED`, `STAFF_INVITATION_REISSUED`, `STAFF_INVITATION_REVOKED`, `STAFF_INVITATION_ACCEPTED`다.

`eventType`, `orgId`, `actorUid`, `targetUid | null`, `invitationId`, `revision`, 최소 `before/after`, `createdAt`, `schemaVersion: 1`을 저장한다. event ID는 동작·초대 ID·revision으로 결정해 재시도 중복을 막는다. 이메일·토큰·비밀번호·쿠키는 저장하지 않으며 모든 브라우저 읽기·쓰기를 거부한다.

### `courses/{courseId}`와 하위 문서

| 경로 | 핵심 필드 |
| --- | --- |
| course | `id`, `orgId`, `title`, `description`, `leadInstructorId`, `activeRoomId`, `status`, 생성·변경 정보 |
| `chapters/{chapterId}` | `id`, `courseId`, `orgId`, `title`, `order`, 시각 |
| `items/{itemId}` | `id`, `courseId`, `orgId`, `chapterId`, `title`, `order`, `isCompleted`, `updatedBy`, 시각 |
| `materials/current` | `id`, `courseId`, `orgId`, `fileName`, `fileType`, `isShared`, `updatedBy`, 시각 |

항목은 `isCompleted`만 저장하고 예정·진행 중 상태 문자열은 저장하지 않는다. 방의 `itemOrder`에서 첫 번째 미완료 항목을 `currentItemId`로 계산한다. 실제 파일 내용은 저장하지 않는다.

### `rooms/{roomId}`

기본 필드는 `id`, `orgId`, `courseId`, `leadInstructorId`, `status`, `itemOrder`, `currentItemId`, 생성·변경 정보다. 상태는 `PREPARING`, `ACTIVE`, `ENDING`, `ENDED`를 사용할 수 있다.

종료 중에는 `endingAt`, `endingByDisplayName`, 종료 완료에는 `endedAt`, `endedByDisplayName`을 추가한다. 참여 코드는 실시간 구독되는 room 문서에 넣지 않는다.

### `roomJoinCodes/{UPPER_CODE}`

`id`, `roomId`, `orgId`, 시각과 버전을 가진 서버 전용 인덱스다. 방 생성 시 room과 `course.activeRoomId`와 함께 원자적으로 생성된다. 어떤 클라이언트 역할도 직접 읽거나 쓰지 못한다.

### `rooms/{roomId}/staff/{uid}`

`userId`, `orgId`, `roomId`, 12개 boolean `permissions`, `grantedBy/At`, `updatedBy/At`, 버전을 가진다. 전역 role 필드는 저장하지 않는다. 보조 강사는 본인 문서를 실시간 구독하고, 주 강사는 목록을 읽는다. 모든 쓰기는 FastAPI가 처리한다.

새 초대는 `canAnswerQuestions`만 `true`, 나머지 11개 권한을 `false`로 저장한다. 클라이언트가 초대 요청에 권한을 함께 보낼 수 없고, 추가 권한은 초대 후 별도 FastAPI 갱신으로만 바꾼다. 기존 staff 문서의 권한은 마이그레이션에서 보존한다.

### `rooms/{roomId}/participants/{uid}`

| 필드 | 설명 |
| --- | --- |
| `userId` | 내부 인증 연결용 익명 Firebase UID. API 비노출 |
| `participantId` | 참여자 관리 API가 사용하는 무작위 불투명 ID |
| `orgId`, `roomId`, `accountType` | 조직·방 연결, 계정 유형은 `STUDENT` |
| `nickname` | 익명 표시 별명 |
| `status` | 현재 `ACTIVE` |
| `isQuestionRestricted` | 새 질문 작성 제한 여부 |
| `joinedAt`, `updatedAt`, `schemaVersion` | 서버 시각과 버전 |

수강생은 본인 문서만 직접 읽는다. 참여자 collection list는 주 강사에게도 Rules로 허용하지 않으며, 주 강사 또는 `canManageParticipants` 사용자는 UID가 제거된 FastAPI 목록만 받는다. 과거 문서에 `participantId`가 없으면 서버가 방·UID에서 만든 `legacy-...` 불투명 ID로 호환한다.

## 질문 공개·비공개 분리

### `rooms/{roomId}/questions/{questionId}`

| 필드 | 형식·설명 |
| --- | --- |
| `id`, `roomId`, `courseId`, `orgId` | 공개 질문과 방·강의·조직 연결 |
| `content` | 제어 문자를 정리한 1~500자 일반 텍스트 |
| `nicknameSnapshot` | 작성 당시 익명 별명 |
| `isGeneral`, `itemId` | 일반 질문 여부와 선택 항목. 일반 질문 문서에는 `itemId`를 저장하지 않음 |
| `itemNumberSnapshot` | 체크리스트 질문 작성 당시 `1.1` 형식 번호. 일반 질문 문서에는 저장하지 않음 |
| `itemTitleSnapshot`, `chapterTitleSnapshot`, `materialLabelSnapshot` | 질문 작성 당시 문맥 표시값 |
| `visibility` | `PUBLIC` 또는 `STAFF_ONLY` |
| `moderationStatus` | `APPROVED` 또는 `NEEDS_REVIEW` |
| `isAnswered`, `answer` | 답변 상태. 답변 map은 `content`, `staffDisplayName`, 답변 당시 방 관계 `roomRole: LEAD | ASSISTANT`, `answeredAt`만 공개 |
| `isHidden` | 검토 권한 강사의 숨김 상태 |
| `createdAt`, `updatedAt`, `schemaVersion` | 서버 시각과 버전 |

이 문서에는 작성 UID, 이메일, `clientRequestId`, 원문 비교 해시, fingerprint나 답변자 UID를 넣지 않는다. 학생과 일반 보조 강사는 `PUBLIC && !isHidden`만 읽는다. 주 강사와 `canModerateQuestions` 보조 강사는 검토·숨김 문서까지 읽을 수 있다.

### `rooms/{roomId}/questionAuthors/{questionId}`

`id`, `roomId`, `orgId`, `participantUid`, `clientRequestId`, `contentDigest`, `createdAt`, 버전을 저장한다. 공개 질문과 1:1로 생성되며 클라이언트 읽기·쓰기를 모두 거부한다.

질문 ID는 `roomId + participantUid + clientRequestId`의 SHA-256 앞 40자로 결정한다. 동일 작성자가 같은 UUID로 같은 내용을 다시 보내면 기존 질문을 반환하고, 연결이 일부만 존재하거나 내용 digest가 다르면 무결성 `409`로 처리한다.

### `rooms/{roomId}/questionRateLimits/{participantUid}`

`roomId`, `orgId`, `participantUid`, `recent[]`, `updatedAt`, 버전을 저장한다. 각 `recent` 항목은 `questionId`, `createdAt`, `normalizedDigest`, 해시된 3-gram `fingerprint`를 가진다. 질문·작성자 문서와 한 트랜잭션에서 갱신되며 클라이언트 접근은 전부 거부한다.

서버는 10초에 3개, 30초 안의 동일 digest 또는 Jaccard 0.8 이상 유사 질문을 차단한다. 30초 밖의 항목은 다음 작성 트랜잭션에서 제거할 수 있다.

## 강사별 읽음 상태

### `rooms/{roomId}/questionReads/{staffUid}`

부모 문서는 `roomId`, `orgId`, 버전을 가진다. `contexts/{contextId}`는 `contextId`, `roomId`, `orgId`, `lastReadAt`, `lastReadQuestionId`, 버전을 가진다. 문맥은 `ALL`, `GENERAL` 또는 실제 `itemId`다.

주 강사와 초대 보조 강사는 본인 UID 아래의 읽음 문서만 읽을 수 있다. 다른 강사의 읽음 문서는 읽을 수 없고, 갱신은 FastAPI만 수행한다. 서버는 관찰 질문의 실제 `createdAt`·ID, 문맥과 현재 강사 가시성을 검증하고 `(lastReadAt, lastReadQuestionId)`가 사전식으로 증가할 때만 watermark를 전진시킨다.

## 감사 로그

### `rooms/{roomId}/permissionLogs/{logId}`

보조 강사 추가·권한 변경·회수와 주 강사 변경을 기록한다. 대상·실행자 UID, 변경 종류, 권한 또는 담당자 전후 상태와 서버 시각을 포함하며 현재 주 강사만 읽을 수 있다. 새 staff 문서와 로그에 전역 강사 역할을 복제하지 않는다.

### `rooms/{roomId}/moderationLogs/{logId}`

질문 답변 생성·수정·취소, 질문 승인·숨김·복구, 참여자 질문 제한·해제, 강의 종료를 기록한다. `id`, `roomId`, `orgId`, `action`, `targetId`, `actorUid`, 상태 `before/after`, `createdAt`, 버전을 사용한다. 질문·답변 본문과 작성자 UID는 감사 사본에 넣지 않는다. 모든 클라이언트 읽기·쓰기를 거부한다.

## 종료 요약

### `rooms/{roomId}/serverState/termination`

`id: termination`, `roomId`, `orgId`, `status`, `actorUid`, `actorDisplayName`, `requestedAt`, 버전을 가진 서버 전용 상태다. `ACTIVE → ENDING` 전환과 함께 생성되어 최초 종료 실행자를 고정한다. 완료 시 `status: ENDED`, `endedAt`, `updatedAt`을 추가한다. 모든 클라이언트 읽기·쓰기를 거부하며 공개 room에는 실행자 UID를 복제하지 않는다.

### `rooms/{roomId}/summary/current`

| 필드 | 설명 |
| --- | --- |
| `id: current`, `roomId`, `courseId`, `orgId`, `roomTitle` | 요약 연결과 표시명 |
| `participantCount` | 참여 문서 수 |
| `totalQuestionCount` | 전체 질문 수 |
| `publicQuestionCount` | 현재 공개·미숨김 질문 수 |
| `reviewQuestionCount`, `hiddenQuestionCount` | 검토 필요·숨김 질문 수 |
| `answeredQuestionCount`, `unansweredQuestionCount` | 답변 상태별 수 |
| `itemQuestionCounts[]` | `itemId`, `itemNumber`, `itemTitle`, `questionCount` |
| `checklistTotalCount`, `checklistCompletedCount`, `incompleteChecklistCount` | 체크리스트 전체·완료·미완료 수 |
| `endedAt`, `endedByDisplayName` | 종료 시각과 표시명 |
| `exportStatus` | 01-3 고정값 `NOT_CONFIGURED` |
| `createdAt`, `updatedAt`, `schemaVersion` | 최초 종료 시각과 버전 |

종료는 먼저 room을 `ENDING`으로 만들어 새 쓰기를 차단한 뒤, 이 요약과 room·course의 `ENDED` 상태 및 `ROOM_ENDED` 로그를 원자적으로 기록한다. 이미 `ENDED`면 기존 요약을 반환하며 재계산하거나 수정하지 않는다. 요약은 주 강사, `canViewReports` 보조 강사와 같은 조직 회사 관리자가 읽는다.

## Rules 읽기·쓰기 경계

Rules는 환경별 파일을 합치지 않는다.

- `firestore.rules`: `demo-nodo` Emulator의 기존 강의·질문 기능과 개발 진단용 `emulatorChecks`
- `firestore.cloud.rules`: 실제 `(default)` Firestore의 최소 조직 읽기. 본인 user 단건과 STAFF의 동일 조직 단건만 허용

Production에서는 `users` 목록, `staffInvitations`, 조직 `auditLogs`, `emulatorChecks`, 강의·방·질문·자료와 모든 브라우저 create·update·delete를 거부한다. 02-3 구성원 화면은 이 Rules를 넓히지 않고 FastAPI Admin SDK를 사용한다. Storage는 두 환경 모두 현재 전체 접근 거부이며 직원 초대에 파일을 연결하지 않는다.

아래 표는 기존 Emulator 강의 기능의 읽기 경계다.

| 경로 | 허용된 클라이언트 읽기 | 쓰기 |
| --- | --- | --- |
| 조직·사용자 | 본인 또는 정해진 같은 조직 관리자/현재 방 주 강사 | 거부 |
| 강의·챕터·항목 | 같은 조직 관리자, 담당 주 강사, 초대 보조 강사, 참여한 방 수강생 | 거부 |
| 자료 | 위 읽기 권한, 수강생은 `isShared: true`만 | 거부 |
| room | 같은 조직 관리자, 담당 주 강사, 초대 보조 강사, 참여자 | 거부 |
| staff | 담당 주 강사 목록, 보조 강사 본인 문서와 본인 `userId` + 같은 `orgId` equality collection-group query | 거부 |
| participants | 수강생 본인 문서만; 목록은 API 전용 | 거부 |
| questions | 역할·공개 범위·숨김·검토 권한에 따른 읽기 | 거부 |
| questionReads | 강사 본인 경로만 | 거부 |
| summary/current | 관리자, 담당 주 강사, `canViewReports` | 거부 |
| join codes, authors, rate limits, moderation logs, serverState | 없음, 서버 전용 | 거부 |

현재 질문 구독은 단순 동등 조건과 클라이언트 정렬을 사용하므로 별도 복합 인덱스를 추가하지 않았고 `firestore.indexes.json`은 비어 있다. 쿼리 조건을 바꿀 때는 운영 이전에 Emulator와 실제 Firestore 인덱스 요구를 다시 확인한다.

## 트랜잭션 불변식

1. 질문 공개 문서, 작성자 연결과 속도 제한 갱신은 전부 성공하거나 전부 실패한다.
2. 답변·검토·참여자 제한은 대상 상태와 감사 로그를 함께 기록한다.
3. `ACTIVE`가 아니면 질문·답변·검토·참여자 제한과 체크 변경을 거부한다.
4. 체크 완료는 앞에서부터 연속되며 `currentItemId`는 첫 미완료 항목 또는 `null`이다.
5. 종료 요약이 생성되면 room과 course가 `ENDED`이고, 이후 요약은 불변이다.
6. 새 course·room의 `leadInstructorId`는 생성 직원 UID이며, 사용자 계정의 전역 역할로 대체하거나 추론하지 않는다.
7. 체크리스트 질문의 `itemNumberSnapshot`은 서버가 작성 시점의 `(chapter.order, chapter.id)`와 `(item.order, item.id)` 순서에서 계산하며 이후 흐름 변경으로 수정하지 않는다.
8. 일반 질문은 `isGeneral: true`이며 `itemId`, `itemNumberSnapshot`과 항목·챕터 스냅샷을 저장하지 않고 논리 읽음 문맥 `GENERAL`을 사용한다.
9. 초대 생성·재발급은 초대 문서와 결정적 감사 로그가 함께 성공하거나 함께 실패한다. 같은 PENDING 재호출은 둘 다 새로 쓰지 않는다.
10. 초대 취소는 PENDING→REVOKED와 감사 로그를 함께 기록하고 문서를 삭제하지 않는다.
11. 조직 가입 수락은 일반 STAFF 사용자 생성, 초대 ACCEPTED·수락 UID·시각과 감사 로그가 모두 성공하거나 모두 실패한다.
12. 같은 이메일의 유효 초대는 결정적 ID 문서 하나뿐이며 동시 생성·재발급·수락은 Transaction의 revision과 현재 상태로 한 번만 커밋한다.
13. 조직 관리자 변경은 대상 `users/{uid}`의 `isOrgAdmin`, `updatedAt`과 `auditLogs/{eventId}`를 함께 기록한다. 감사 로그는 `ORG_ADMIN_GRANTED` 또는 `ORG_ADMIN_REVOKED`, actor·target UID와 `{ isOrgAdmin }` 전후 값만 보관하며 이메일·토큰을 보관하지 않는다.
