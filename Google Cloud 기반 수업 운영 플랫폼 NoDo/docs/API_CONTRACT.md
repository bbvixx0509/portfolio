# NoDo 02 FastAPI 계약

## 공통 규칙

Emulator 모드의 중요 쓰기는 기존 `React → Firebase ID Token → FastAPI → Firestore Emulator` 경로만 사용한다. 브라우저는 강의·권한·질문·읽음·참여자 제한·종료 데이터를 Firestore에 직접 쓰지 않는다.

Cloud-auth 모드는 `React → 실제 Google 로그인 Firebase ID Token → FastAPI → 실제 Firestore` 경계를 사용한다. 브라우저는 Firebase App과 Authentication 외의 클라이언트 SDK를 초기화하지 않으며, 실제 사용자·조직·초대 조회와 모든 쓰기는 ADC로 인증한 FastAPI의 별도 named Admin app만 수행한다. Storage는 사용하지 않는다.

```http
Authorization: Bearer <Firebase ID Token>
Content-Type: application/json
```

Emulator 업무 API에서 FastAPI는 매 요청마다 서버 프로필의 `accountType`·`isOrgAdmin`·조직, 현재 강의방의 `leadInstructorId` 또는 staff 관계, 최신 보조 강사 권한과 방 상태를 확인한다. Cloud-auth 조직 API는 실제 `users/{uid}`·`organizations/{orgId}`의 최신 소유자 상태를 매 요청 다시 확인한다. 전역 주·보조 강사 역할은 판정에 사용하지 않는다. JSON 필드는 camelCase이며 선언하지 않은 추가 필드는 거부한다.

주요 입력 제한은 다음과 같다.

- 강의명 1~120자, 설명 최대 1,000자
- 챕터·항목 ID 1~80자, 챕터명 1~120자, 항목명 1~200자
- 참여 코드 4~12자, 별명 2~20자
- 질문 1~500자, 답변 1~2,000자
- 직원 초대 이메일 최대 254자, 제어 문자·줄바꿈 금지, trim·소문자 정규화 뒤 정확한 허용 회사 도메인
- `itemId`, `contextId`: 영문·숫자·`_`·`-`, 최대 80자
- `clientRequestId`: UI가 요청마다 생성한 UUID. 같은 전송의 재시도에서는 같은 값을 재사용한다. 서버 형식 제한은 영문·숫자·`_`·`-` 8~128자다.

## 오류 계약

```json
{ "code": "access_denied", "detail": "오류 설명" }
```

| 상태 | `code` | 의미 |
| --- | --- | --- |
| `401` | `authentication_required` | 토큰 누락·형식 오류·서명 오류·만료·발급자/대상 프로젝트 불일치·필수 claim 누락 또는 Emulator 서버 프로필 누락 |
| `403` | `access_denied` | Google provider 아님, 이메일 미인증, bootstrap 불일치 또는 계정 유형·조직·방별 담당 관계·권한·참여·강의 상태 위반 |
| `404` | `not_found` | 강의, 방, 항목, 질문, 참여자 또는 요약 없음 |
| `409` | `conflict` | 선점·중복 또는 문서 연결/멱등 문서 불일치 |
| `409` | `ORGANIZATION_BOOTSTRAP_REQUIRED` | 허용된 최초 소유자가 조직 Bootstrap을 명시적으로 완료해야 함 |
| `409` | `ORGANIZATION_INVITATION_ACCEPTANCE_REQUIRED` | 유효한 회사 직원 초대를 로그인 사용자가 직접 수락해야 함 |
| `422` | `invalid_operation` | 순차 체크 등 현재 상태에서 허용되지 않는 작업 |
| `422` | `question_rejected` | 빈 질문, 정리 후 내용 없음, 길이 초과 또는 금칙어 차단 |
| `429` | `question_rate_limited` | 10초에 3개 초과 또는 30초 안의 동일·유사 질문. `Retry-After: 10` |
| `503` | `temporarily_unavailable` | 제한된 `ABORTED` 재시도 소진. `Retry-After: 1` |

Pydantic 형식 오류도 `422`이며 FastAPI 기본 `detail` 배열을 반환할 수 있다. 서버는 Firestore 예외, 내부 문서 경로나 트랜잭션 ID를 응답에 노출하지 않는다.

## 시스템 API

| 메서드와 경로 | 인증 | 성공 |
| --- | --- | --- |
| `GET /health` | 없음 | `{ "status": "ok", "version": "02" }` |
| `GET /readyz` | 없음 | `{ "status": "ready" }` |
| `GET /api/version` | 없음 | `{ "name": "NoDo", "version": "02" }` |

운영 Cloud Run 상태 확인은 `/health`를 사용한다. 기존 로컬 호출 호환을 위한
`/healthz` 별칭은 제공하지만, Cloud Run의 예약 경로 제약 때문에 운영 점검 경로로
사용하지 않는다.

## Google 인증과 `GET /api/auth/me`

`GET /api/auth/me`는 요청 본문 없이 `Authorization` 헤더의 Bearer ID Token만 사용한다. 서비스 계정 JSON, 클라이언트가 보낸 이메일·UID·역할 값 또는 Firebase Console 로그인 세션을 인증 근거로 사용하지 않는다. 이 GET은 실제 Firestore를 조회하지만 조직·사용자·초대 문서를 생성하거나 변경하지 않는다.

서버는 다음을 모두 검증한다.

- Google 공개 인증서로 확인한 토큰 서명과 유효 기간
- 승인된 기존 Firebase 프로젝트와 일치하는 `aud`와 `iss`
- 비어 있지 않고 서로 모순되지 않는 UID와 subject
- 정규화 가능한 이메일과 `email_verified: true`
- `firebase.sign_in_provider: google.com`
- Firestore 사용자 문서와 조직 `ownerUid`의 일관성
- 사용자 문서가 없을 때 정규화 이메일과 유효한 PENDING 직원 초대의 정확 일치
- 초대도 없을 때만 Bootstrap 활성화와 서버 전용 최초 소유자 후보의 정확 일치

성공 응답은 다음 필드만 반환한다. `email`과 프로필 필드는 인증된 본인 화면에만 사용하고 로그·분석·오류 응답에 복제하지 않는다.

| 필드 | 의미 |
|---|---|
| `uid` | 검증된 Firebase UID |
| `displayName` | 검증된 Google 표시명 또는 `null` |
| `email` | 검증된 본인 이메일 |
| `photoURL` | 검증된 프로필 사진 URL 또는 `null` |
| `accountType` | Firestore 사용자 문서의 `STAFF` |
| `isOrgAdmin` | 영구 사용자 문서의 조직 관리자 여부 |
| `isOrgOwner` | 조직 `ownerUid`와 사용자 문서가 일치하는 소유자 여부 |
| `bootstrapOwner` | 영구 가입 뒤 항상 `false` |
| `provider` | 검증된 `google.com` provider |
| `emailVerified` | 검증된 이메일 인증 여부 |
| `authorized` | 보호 화면 접근 승인 여부 |

판정 순서는 영구 조직 소유자, 영구 일반 STAFF, 유효한 PENDING 직원 초대, 일회성 Bootstrap 후보, 거부다. 영구 STAFF 성공은 `authorized: true`, `bootstrapOwner: false`다. 초대 수락이 필요하면 HTTP 409와 다음 안전 필드만 반환한다.

```json
{
  "code": "ORGANIZATION_INVITATION_ACCEPTANCE_REQUIRED",
  "detail": "조직 가입 수락이 필요합니다.",
  "organizationName": "DEMO",
  "expiresAt": "2026-07-23T00:00:00Z"
}
```

`invitationId`, 초대 이메일, 초대자·소유자 UID, 내부 Firestore 경로와 감사 로그는 반환하지 않는다. 토큰 누락·잘못된 Bearer 형식·서명/만료/프로젝트 오류는 `401 authentication_required`, Google이 아닌 provider·미인증 이메일·초대 없음·취소·만료는 `403 access_denied`다. 응답은 허용 목록, 전체 설정값, 토큰 claim 덤프 또는 내부 검증 예외를 노출하지 않는다.

Firebase 인증 지속성은 브라우저 재시작 전후 사용자 경험을 위한 것이며 서버 승인을 대체하지 않는다. 보호 경로에 들어갈 때와 새로고침 복원 때마다 유효한 토큰으로 이 API를 통과해야 한다. 로그아웃한 토큰을 애플리케이션 세션처럼 재사용하지 않는다.

## 02-2 조직 Bootstrap API

`POST /api/auth/bootstrap-organization`은 `ORGANIZATION_BOOTSTRAP_REQUIRED` 상태의 검증된 Google 사용자만 호출한다. 요청 본문에서 이메일·조직 ID·이름·역할을 받지 않으며 서버 설정과 ID Token만 사용한다. 조직, 소유자 사용자와 감사 로그를 한 Firestore Transaction으로 생성하고 같은 UID 재호출은 기존 성공을 반환한다. Bootstrap 비활성화 뒤 신규 호출은 거부하지만 기존 영구 소유자의 `GET /api/auth/me`는 계속 성공한다.

## 02-3 조직 구성원·직원 초대 API

모든 조직 관리 API는 실제 Firestore의 최신 `users/{uid}`, `organizations/demo.ownerUid`와 `isOrgOwner: true`를 다시 확인한다. 02-3에서는 조직 관리자와 일반 STAFF가 소유자를 대신할 수 없다.

| 메서드와 경로 | 본문 | 권한과 결과 |
| --- | --- | --- |
| `GET /api/organization/members` | 없음 | 조직 소유자. 가입한 STAFF 표시 목록과 현재 구성원 수 |
| `GET /api/organization/staff-invitations` | 없음 | 조직 소유자. PENDING·ACCEPTED·REVOKED 초대 상태 목록 |
| `POST /api/organization/staff-invitations` | `{ "email": string }` | 조직 소유자. 새 초대 생성, PENDING 멱등 반환 또는 REVOKED·만료 재발급 |
| `DELETE /api/organization/staff-invitations/{invitationId}` | 없음 | 조직 소유자. PENDING만 REVOKED로 전환 |
| `POST /api/auth/accept-organization-invitation` | 없음 | 초대받은 Google 사용자. 일반 STAFF 가입·초대 수락·감사를 원자 처리 |

`GET /api/organization/members`는 `organization: { id, name }`, `count`, `members[]`를 반환한다. 각 구성원은 소유자에게 필요한 `email`, `displayName`, `photoURL`, `isOrgAdmin`, `isOrgOwner`, `createdAt`만 포함하고 UID는 목록 응답에 노출하지 않는다.

초대 목록과 생성·취소 응답의 공개 초대는 `id`, `emailNormalized`, `status`, `revision`, `createdAt`, `updatedAt`, `expiresAt`, `acceptedAt`, `revokedAt`만 포함한다. 시각 값은 ISO 8601 문자열이며 아직 발생하지 않은 수락·취소 시각은 `null`이다. `invitedByUid`, `acceptedByUid`, `revokedByUid`와 감사 로그는 반환하지 않는다. 이 정보는 최신 조직 소유자에게만 보이며 초대받은 로그인 사용자의 409 응답에는 포함하지 않는다.

초대 생성 본문은 이메일 하나만 허용하며 추가 `orgId`, `accountType`, `isOrgAdmin`, `isOrgOwner`, 역할 필드는 `extra: forbid`로 거부한다.

```json
{
  "email": "employee@nodo-company.test"
}
```

실제 허용 주소는 서버 설정의 정확한 `@nodo-company.test` 도메인이어야 한다. 위 주소는 형식 설명용 가상 예시다. 서버는 trim·소문자 정규화, 최대 254자, 제어 문자·줄바꿈 금지, 소유자 본인과 기존 직원 여부를 검사한다.

초대 생성·재발급은 다음 계약을 따른다.

- 초대 ID는 `SHA-256("demo" + NUL + emailNormalized)`이며 이메일 원문을 ID로 사용하지 않는다.
- 유효한 PENDING이면 문서·revision·감사를 바꾸지 않고 기존 결과를 반환한다.
- REVOKED 또는 만료 상태면 같은 문서 ID에서 revision을 증가시키고 새 PENDING·만료 시각으로 재발급한다.
- 같은 이메일 동시 요청도 결정적 문서 ID와 Transaction으로 유효한 PENDING 하나만 만든다.
- ACCEPTED 또는 이미 가입한 이메일은 새 초대로 만들지 않는다.

취소는 PENDING만 허용하며 문서를 삭제하지 않는다. ACCEPTED·REVOKED·다른 조직·없는 초대와 일반 STAFF 요청은 거부한다. 재시도로 이미 같은 revision이 취소된 경우 새 감사 로그를 만들지 않는다.

`POST /api/auth/accept-organization-invitation`은 본문에서 이메일, `invitationId`, 조직, 계정 유형과 역할을 받지 않는다. 서버는 인증된 Google 이메일로 초대를 결정하고 조직 정상 상태·소유자 존재·PENDING·만료 전·사용자 부재·비익명 provider를 Transaction 안에서 다시 검사한다.

성공 Transaction은 다음 세 상태를 함께 기록한다.

1. `users/{authenticatedUid}`: `accountType: STAFF`, `isOrgAdmin: false`, `isOrgOwner: false`, `isAnonymous: false`, `joinedByInvitationId`
2. 초대: `status: ACCEPTED`, `acceptedAt`, `acceptedByUid`, `updatedAt`
3. 결정적 `STAFF_INVITATION_ACCEPTED` 감사 로그

취소·만료·다른 이메일·Anonymous·이미 가입된 다른 상태에서는 권한을 부여하지 않는다. Transaction 실패 시 세 상태 중 일부만 저장하지 않는다. 가입 성공 뒤 재로그인은 초대 상태가 아니라 영구 `users/{uid}` 문서로 승인한다.

가입 수락 성공 응답은 일반 STAFF의 `uid`, `orgId`, `accountType`, `isOrgAdmin: false`, `isOrgOwner: false`, `isAnonymous: false`, `bootstrapOwner: false`, provider·이메일 인증·승인 상태와 본인 Google 프로필이다.

초대·구성원 응답은 조직 소유자 화면과 로그인한 본인 가입 화면에 필요한 최소 정보만 반환한다. 감사 로그, ID/OAuth/Refresh Token, 인증 쿠키, 비밀번호, 내부 Firestore 경로와 다른 사용자의 인증 claim은 반환하지 않는다.

## 사용자·강의 API

| 메서드와 경로 | 본문 | 권한과 결과 |
| --- | --- | --- |
| `GET /api/me` | 없음 | Emulator 모드의 `uid`, `accountType`, `isOrgAdmin`, `orgId`, 표시명 등 인증 사용자 프로필. 전역 강사 역할 없음 |
| `GET /api/courses` | 없음 | 조직 관리 범위 또는 방별 `LEAD | ASSISTANT | null` 관계에 맞는 강의 목록 |
| `POST /api/courses` | `title`, `description?` | 같은 조직 `STAFF`; 생성자를 `leadInstructorId`로 저장, `201` |
| `PUT /api/courses/{courseId}` | `title`, `description?` | 주 강사 또는 `canEditCourse` |
| `PUT /api/courses/{courseId}/flow` | `chapters[]`, `items[]` | 주 강사 또는 `canEditCourseFlow` |
| `PUT /api/courses/{courseId}/materials` | `fileName`, `fileType`, `isShared` | 주 강사 또는 `canManageMaterials` |

수업 흐름 요청은 ID·제목·`chapterId`·`order`만 받는다. `isCompleted`, `currentItemId`는 서버가 보존·재계산한다.

## 강의방·담당자·체크 API

| 메서드와 경로 | 본문 | 권한과 결과 |
| --- | --- | --- |
| `POST /api/courses/{courseId}/rooms` | `joinCode?` | 생성 직원인 현재 주 강사, 생성자를 room `leadInstructorId`로 저장하고 방·코드·course 연결 원자 생성, `201` |
| `POST /api/rooms/join` | `roomCode`, `nickname?` | 익명 수강생, `ACTIVE` 방 참여 |
| `GET /api/rooms/{roomId}` | 없음 | 접근 가능한 방과 흐름 데이터 |
| `GET /api/rooms/{roomId}/share` | 없음 | 주 강사 또는 `canShareRoom`, 코드·링크 반환 |
| `PATCH /api/rooms/{roomId}/items/{itemId}/completion` | `isCompleted` | 주 강사 또는 `canControlProgress`, 순차 체크 트랜잭션 |
| `GET /api/rooms/{roomId}/staff` | 없음 | 현재 주 강사 전용 담당자·권한 화면 데이터 |
| `POST /api/rooms/{roomId}/staff` | `userId` | 현재 주 강사, 같은 조직 `STAFF` 초대. 서버 기본 권한만 저장, `201` |
| `PUT /api/rooms/{roomId}/staff/{uid}/permissions` | `permissions` | 현재 주 강사, 12개 권한 갱신 |
| `DELETE /api/rooms/{roomId}/staff/{uid}` | 없음 | 현재 주 강사, `204` |
| `PUT /api/rooms/{roomId}/lead` | `leadInstructorId` | 같은 조직 회사 관리자 |
| `PUT /api/rooms/{roomId}/participants/me` | `nickname` | 참여 수강생 본인 별명 변경 |

강의방 생성과 질문 생성은 Python 전역 Lock을 사용하지 않는다. `ABORTED`만 새 트랜잭션으로 최대 3회 외부 재시도하고 짧은 지수 백오프를 적용한다. 성공 응답이 유실될 수 있는 경우 권위 문서를 다시 읽어 현재 요청이 이미 커밋되었는지 확인한다.

보조 강사 초대 본문에 `permissions`나 다른 추가 필드를 보내면 Pydantic의 `extra: forbid` 계약으로 `422`다. 서버가 `canAnswerQuestions: true`, 나머지 11개 권한 `false`인 완전한 map을 생성한다. 추가 권한은 초대가 끝난 뒤 `PUT .../permissions`에서만 변경한다. 다른 조직 직원, `STUDENT`, 현재 주 강사와 중복 staff는 초대할 수 없다.

## 질문 API

### 질문 작성

`POST /api/rooms/{roomId}/questions`

성공 상태는 `201 Created`다.

```json
{
  "content": "이 항목을 다시 설명해 주세요.",
  "itemId": "flow-1",
  "clientRequestId": "6be80e08-93dd-4f1b-9be0-4fe1baa94977"
}
```

`itemId: null`이면 `contextId: GENERAL`인 논리 채널 `일반 질문방`의 질문이다. 실제 별도 room 문서는 만들지 않으며 저장 질문에서는 `itemId`, `itemNumberSnapshot`과 항목·챕터 스냅샷을 생략한다. 체크리스트 질문이면 서버가 챕터와 항목을 각각 `(order, id)`로 안정 정렬한 현재 순서에서 `1.1` 형식 번호를 계산해 `itemNumberSnapshot`으로 저장한다. 클라이언트가 번호를 보내거나 정할 수 없다.

활성 방에 참여한 익명 수강생만 질문을 작성할 수 있다. 질문 문서 ID는 room ID·작성 UID·`clientRequestId`로 결정되어 동일 요청 재전송은 같은 질문을 반환한다. 같은 키에 다른 내용이 연결되거나 공개 문서와 작성자 문서가 일부만 있으면 `409`다.

질문, 서버 전용 작성자 연결, 속도 제한 기록을 한 Firestore 트랜잭션으로 기록한다. 공개·검토 질문 구분 없이 최초 성공과 멱등 복구 응답은 모두 `{ "id", "roomId", "accepted": true }`다. 질문 내용, 별명·항목·챕터·자료 스냅샷, 공개 범위, 검토 상태, UID, 이메일, `clientRequestId`, 비교용 해시와 fingerprint는 생성 응답에 포함하지 않는다. 저장된 질문은 각 역할의 Firestore 읽기 권한에 맞는 실시간 구독으로 표시한다.

### 답변·검토·읽음

| 메서드와 경로 | 본문 | 필요한 권한 |
| --- | --- | --- |
| `PUT /api/rooms/{roomId}/questions/{questionId}/answer` | `{ "answer": string }` | `canAnswerQuestions` |
| `DELETE /api/rooms/{roomId}/questions/{questionId}/answer` | 없음 | `canAnswerQuestions` |
| `POST /api/rooms/{roomId}/questions/{questionId}/hide` | 없음 | `canModerateQuestions` |
| `POST /api/rooms/{roomId}/questions/{questionId}/restore` | 없음 | `canModerateQuestions` |
| `POST /api/rooms/{roomId}/questions/{questionId}/approve` | 없음 | `canModerateQuestions`; `NEEDS_REVIEW`를 `APPROVED/PUBLIC`으로 전환 |
| `POST /api/rooms/{roomId}/questions/read` | `contextId`, `observedAt`, `observedQuestionId` | 주 강사 또는 초대 보조 강사 |

`contextId`는 `ALL`, 독립 일반 질문방의 `GENERAL` 또는 방의 수업 항목 ID다. `observedAt`은 실제 화면에서 마지막으로 본 질문의 서버 `createdAt`, `observedQuestionId`는 그 질문 ID다. 서버는 질문 ID·밀리초 정밀도 시각·문맥·현재 강사 가시성을 검증하고 `(createdAt, id)` 사전식 순서가 기존 값보다 큰 경우에만 watermark를 전진시킨다. 응답은 `contextId`, `lastReadAt`, `lastReadQuestionId`다. 읽음은 강사별로 분리되며 뒤로 이동하지 않는다.

질문 목록의 표시 순서도 `(createdAt, questionId)`로 고정한다. 답변·검토 변경은 질문 상태와 감사 로그를 같은 트랜잭션에서 기록하되 질문 정렬 키를 바꾸지 않는다. 답변은 질문 문서의 단일 map으로 연결되고 해당 질문 바로 아래에 표시된다. 공개 답변에는 표시명과 답변 당시 방 관계 `roomRole: LEAD | ASSISTANT`만 포함하며 UID·이메일과 과거 전역 역할은 공개하지 않는다.

```json
{
  "contextId": "ALL",
  "observedAt": "2026-07-15T03:00:00.000Z",
  "observedQuestionId": "0123456789abcdef0123456789abcdef01234567"
}
```

## 참여자 API

| 메서드와 경로 | 본문 | 필요한 권한 |
| --- | --- | --- |
| `GET /api/rooms/{roomId}/participants` | 없음 | 주 강사 또는 `canManageParticipants` |
| `PATCH /api/rooms/{roomId}/participants/{participantId}` | `isQuestionRestricted` | 주 강사 또는 `canManageParticipants`, `ACTIVE`에서만 변경 |

목록과 변경 응답은 불투명한 `participantId`, 별명, 상태, 질문 제한 여부와 시각만 반환한다. Firestore 문서 ID, Authentication UID, 이메일과 실명은 반환하지 않는다. 제한은 새 질문 작성을 막고 해제 시 다시 허용한다.

## 종료·리포트 API

| 메서드와 경로 | 본문 | 필요한 권한 |
| --- | --- | --- |
| `GET /api/rooms/{roomId}/end-preview` | 없음 | 주 강사 또는 `canEndRoom` |
| `POST /api/rooms/{roomId}/end` | 없음 | 주 강사 또는 `canEndRoom` |
| `GET /api/rooms/{roomId}/report` | 없음 | 같은 조직 회사 관리자, 주 강사 또는 `canViewReports` |

종료 미리보기는 `{ roomId, status, totalQuestionCount, unansweredQuestionCount, checklistTotalCount, incompleteChecklistCount }`를 서버 권위 문서에서 집계한다. `canEndRoom`은 있지만 검토 권한이 없는 보조 강사도 정확한 전체 개수를 받으며 질문 본문이나 비공개 질문 목록은 받지 않는다.

종료는 `ACTIVE → ENDING → ENDED` 2단계다. 첫 단계가 새 쓰기를 차단하고 최초 실행자 UID·표시명·요청 시각을 서버 전용 termination 문서에 원자적으로 보존한다. 서버가 참여자 수·질문 상태별 수·항목별 질문 수·체크 완료 수를 계산한 뒤 `summary/current`, room과 course 상태, 종료 감사 로그를 원자적으로 확정한다. 재시도나 다른 권한자의 후속 요청도 최초 실행자를 사용한다. 같은 종료 요청은 기존 결과를 반환하며 요약을 다시 계산하지 않는다.

리포트는 종료 요약이 없으면 `404`다. `exportStatus`는 항상 `NOT_CONFIGURED`이며 실제 Google Sheets·외부 API 내보내기를 실행하지 않는다.

## 질문 검토 규칙

- Unicode NFKC 정규화 후 허용된 줄바꿈·탭을 제외한 제어 문자를 제거하고 일반 텍스트로 저장한다. HTML을 렌더링용 마크업으로 저장하지 않는다.
- 질문은 1~500자다. 금칙어는 `question_rejected`, 검토어는 `moderationStatus: NEEDS_REVIEW`, `visibility: STAFF_ONLY`다.
- 10초 창에서 최대 3개를 허용한다. 30초 안의 정규화 결과가 같거나 해시된 3-gram Jaccard 유사도가 0.8 이상이면 차단한다.
- 현재 작성 차단어는 `씨발`, `병신`, `개새끼`, `욕설`, 검토어는 `바보`, `멍청`, `꺼져`, `죽어`, `짜증`이다. 비교 전 영문 대소문자와 구분 문자를 정규화한다.
- 이 목록은 01-3 로컬 고정 규칙이며 AI·Gemini 분류가 아니다. 사용자 오류 응답에는 어떤 단어가 일치했는지 노출하지 않는다.

## 강의 상태별 쓰기

| 작업 | `ACTIVE` | `ENDING` / `ENDED` |
| --- | --- | --- |
| 참여·질문·체크 | 허용(방별 담당 관계·권한 충족 시) | 차단 |
| 답변·승인·숨김·복구·참여자 제한 | 허용(권한 충족 시) | 차단 |
| 질문 읽음 시각 | 허용 | 허용 |
| 공개 질문·체크리스트·리포트 조회 | 권한에 따라 허용 | 권한에 따라 허용 |

## 02-4 조직 관리자 권한 후속 계약

02-3에서 가입한 일반 STAFF는 자동 조직 관리자가 아니다. 02-4에서 관리자 지정·해제를 추가할 때는 다음 기준을 별도 API와 Transaction으로 확정해야 한다.

| 작업 | 요청자 | 서버에서 다시 확인할 조건 |
|---|---|---|
| 조직 관리자 지정 | 현재 조직 소유자 | 같은 조직의 영구 일반 STAFF, 대상이 소유자가 아님, 요청자 최신 `ownerUid` |
| 조직 관리자 해제 | 현재 조직 소유자 | 같은 조직 관리자, 대상이 소유자가 아님, 요청자 최신 `ownerUid` |
| 본인 관리자·소유자 변경 | 누구나 | 항상 거부 |

02-4 전에는 일반 STAFF의 `isOrgAdmin`을 변경하는 API·버튼·요청 필드를 제공하지 않는다. 관리자 권한은 방별 `leadInstructorId`·`staff/{uid}`와 독립이며, 조직 관리자로 지정되었다고 특정 강의방의 주 강사·보조 강사 권한을 자동 획득하지 않는다.

관리자 지정·해제는 사용자 문서 변경과 결정적 서버 전용 감사 로그를 한 Transaction으로 처리해야 한다. 프론트가 보낸 역할·조직·관리자 boolean을 권위 값으로 사용하지 않고 최신 조직 소유자와 대상 사용자 관계를 다시 읽는다. 조직 소유권 이전, 직원 제거와 이메일 발송은 02-4 관리자 기능에 포함한다고 가정하지 않는다.

### `PATCH /api/organization/members/admin-role`

요청 본문은 `{ "email": "employee@nodo-company.test", "isOrgAdmin": true }`만 허용한다. FastAPI는 Google ID Token, 최신 조직 소유자 문서와 같은 조직의 STAFF 대상 문서를 다시 확인한다. 응답은 최신 공개 구성원 정보다. 소유자 외 요청은 `403`, 존재하지 않거나 불완전한 대상은 `404` 또는 `409`, 소유자 자신 변경은 `409`, 추가 요청 필드는 `422`다.
