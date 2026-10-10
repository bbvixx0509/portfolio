# NoDo 계정 및 권한 기준

## 문서 범위

이 문서는 NoDo_01의 01-3A에서 Authentication·Firestore Emulator와 FastAPI에 적용한 계정 유형, 조직 관리자와 강의방별 담당 관계의 기준이다. 실제 Firebase·GCP 운영 환경에는 배포하지 않았다.

권한은 화면에서 버튼을 숨기는 것으로 끝나지 않는다. FastAPI는 매 요청마다 서버 관리 프로필, 조직, 현재 강의방의 주 강사·staff 관계, 최신 보조 강사 권한과 방 상태를 다시 검사한다. Firestore Rules는 브라우저의 직접 쓰기와 허용되지 않은 읽기를 별도로 차단한다.

## 계정 유형과 조직 관리자

| 필드 | 값 | 의미 |
| --- | --- | --- |
| `accountType` | `STAFF` | 회사 소속 직원. 같은 조직에서 강의를 만들 수 있지만 계정 자체가 주·보조 강사를 뜻하지 않는다. |
| `accountType` | `STUDENT` | 익명 인증 수강생. 참여한 활성 방의 공개 자료·체크리스트·질문을 읽고 질문을 작성한다. |
| `isOrgAdmin` | `true` | `STAFF` 중 조직 관리 범위를 가진 회사 관리자. 방별 강사 관계와는 별개다. |

`LEAD_INSTRUCTOR`와 `ASSISTANT_INSTRUCTOR`는 새 사용자 문서의 전역 역할이 아니다. 로그인할 때 역할을 선택하지 않으며, 같은 직원이 방 A의 주 강사, 방 B의 보조 강사, 방 C의 담당자 아님일 수 있다.

## 강의방별 담당 관계

| 관계 | 판정 | 기본 범위 |
| --- | --- | --- |
| 주 강사 `LEAD` | 인증된 같은 조직 `STAFF`이고 `rooms/{roomId}.leadInstructorId == uid` | 해당 방의 12개 위임 가능 기능 전체, 보조 강사 초대·권한 변경·제거 |
| 보조 강사 `ASSISTANT` | 인증된 같은 조직 `STAFF`이고 `rooms/{roomId}/staff/{uid}` 존재 | 공개 강의·자료·체크리스트·질문 조회와 staff 문서에서 `true`인 기능 |
| 담당자 아님 | 위 두 조건 모두 불충족 | 직원 계정만으로 해당 방의 강사 권한을 얻지 못함 |

같은 조직의 `STAFF`가 강의를 만들면 서버가 생성자의 UID를 course와 room의 `leadInstructorId`로 저장한다. 클라이언트가 다른 UID를 주 강사로 지정할 수 없다. 회사 관리자도 자신이 만든 방에서는 주 강사지만, `isOrgAdmin`만으로 진행 중 방의 주 강사 권한을 자동 획득하지 않는다.

주 강사용 staff 문서는 만들지 않는다. 전역 계정 유형과 방 관계를 Auth custom claim에 복제하지 않는다.

## 보조 강사 초대와 기본 권한

현재 방의 주 강사만 같은 조직의 다른 `STAFF`를 초대할 수 있다. 학생, 다른 조직 직원, 현재 주 강사와 이미 초대된 직원은 대상이 될 수 없다. 초대 요청은 `userId`만 허용하며 `permissions` 등 추가 입력은 `422`로 거부한다.

서버가 만드는 기본 권한은 다음과 같다.

| 권한 | 초대 직후 값 |
| --- | --- |
| 강의방·공개 자료·전체 체크리스트·현재 항목·공개 질문 조회 | staff 관계의 기본 읽기 범위 |
| `canAnswerQuestions` | `true` |
| 나머지 11개 boolean 권한 | `false` |

화면에는 `기본 권한: 강의 조회 및 질문 답변`, `추가 권한은 초대 후 설정할 수 있습니다`를 안내한다. 초대가 완료된 뒤에만 `추가 권한 설정`을 열어 별도 갱신 API로 변경한다.

## 위임 가능한 권한 12개

| 필드 | 화면 명칭 | 01-3A 연결 상태 |
| --- | --- | --- |
| `canEditCourse` | 강의 정보 수정 | 연결됨 — 강의명·설명 변경 |
| `canEditCourseFlow` | 수업 흐름 편집 | 연결됨 — 챕터·항목 편집과 순서 변경 |
| `canManageMaterials` | 자료 관리 | 연결됨 — 자료 메타데이터와 공유 상태 변경 |
| `canShareRoom` | 참여 링크 공유 | 연결됨 — 서버 전용 참여 코드·링크 조회 |
| `canControlProgress` | 체크리스트 진행 제어 | 연결됨 — 순차 완료·완료 해제 |
| `canAnswerQuestions` | 질문 답변 | 연결됨 — 답변 작성·수정·취소, 초대 기본값 `true` |
| `canModerateQuestions` | 질문 검토·숨김 | 연결됨 — 검토 질문 열람·승인, 숨김·복구 |
| `canAnnotate` | 판서 | 미연결 — 권한 값만 저장하며 판서 기능 없음 |
| `canManageParticipants` | 참여자 관리 | 연결됨 — 익명 참여자 목록과 질문 제한·해제 |
| `canEndRoom` | 강의 종료 | 연결됨 — `ACTIVE → ENDING → ENDED` |
| `canViewReports` | 리포트 조회 | 연결됨 — 종료 후 고정 요약 조회 |
| `canExportResults` | 결과 내보내기 | 미연결 — `exportStatus: NOT_CONFIGURED` |

12개 중 10개가 API와 화면에 연결되어 있다. `canAnnotate`, `canExportResults` 값은 판서나 Google Sheets 내보내기가 구현됐다는 뜻이 아니다.

## 요청별 판정 원칙

1. ID Token에서는 인증 UID와 익명 여부를 확인하고 `accountType`, `isOrgAdmin`, `orgId`는 서버 관리 `users/{uid}`에서 가져온다.
2. 주 강사는 `STAFF`, 같은 조직, 현재 room의 `leadInstructorId` 일치를 모두 만족해야 한다.
3. 보조 강사는 `STAFF`, 같은 조직, 현재 room의 staff 문서와 요청 기능에 필요한 boolean 권한을 모두 만족해야 한다.
4. 프론트엔드는 본인의 staff 문서를 실시간 구독한다. 권한 회수는 열린 화면에 반영되며 늦게 도착한 쓰기도 FastAPI가 최신 권한으로 `403` 처리한다.
5. 회사 관리자 검사는 `STAFF`, `isOrgAdmin: true`, 같은 조직을 모두 확인한다. 이 판정은 방별 주·보조 강사 판정을 대신하지 않는다.
6. 수강생은 참여한 방의 본인 참여 문서만 직접 읽는다. 참여자 목록은 UID가 제거된 FastAPI 응답으로만 제공한다.
7. `ACTIVE`에서만 질문 작성, 답변·검토, 참여자 질문 제한과 체크 진행을 변경한다. `ENDING`과 `ENDED`에서는 읽음 표기와 허용된 조회 외의 강의 쓰기를 막는다.

## 질문·답변 권한

- 초대된 보조 강사는 공개·미숨김 질문을 읽는다. `canModerateQuestions`가 있어야 `STAFF_ONLY` 검토 질문과 숨김 질문을 읽고 승인·숨김·복구할 수 있다.
- 기본 `canAnswerQuestions` 권한으로 질문에 답변하고 기존 답변을 수정하거나 취소할 수 있다. 답변 공개 map에는 표시명과 답변 당시 `roomRole: LEAD | ASSISTANT`만 저장하고 UID·이메일·전역 역할은 넣지 않는다.
- 각 강사의 읽음 상태는 본인 전용 `questionReads/{staffUid}/contexts/{contextId}`에 저장한다. 한 강사의 읽음 처리로 다른 강사의 미확인 배지가 사라지지 않는다.
- 질문은 `(createdAt, questionId)`로 정렬하고 답변은 해당 질문 바로 아래에 표시한다. 답변 변경은 질문의 상대 순서를 바꾸지 않는다.

## 위임할 수 없는 작업

보조 강사는 다음 작업을 할 수 없다.

- 자신에게 권한 추가·변경
- 다른 보조 강사 초대, 권한 변경·회수
- 주 강사 변경 또는 강의 소유권 이전
- 회사 조직 설정과 소속 직원 관리
- 다른 조직 데이터 접근

보조 강사 초대·권한 변경·제거는 해당 방의 현재 주 강사만 수행한다. 권한 변경과 회수는 `permissionLogs`, 질문 답변·검토·참여자 제한·강의 종료는 서버 전용 `moderationLogs`에 기록한다. 질문·답변 본문은 감사 로그에 복제하지 않는다.

## 종료 후 권한

강의 종료는 주 강사 또는 `canEndRoom` 보조 강사가 실행한다. `ENDED`가 되면 허용된 공개 질문·체크리스트·종료 요약 읽기는 유지하지만 새 참여, 새 질문, 체크 변경, 답변·검토와 참여자 제한 변경은 차단한다. 회사 관리자, 주 강사와 `canViewReports` 보조 강사는 종료 요약을 읽을 수 있다.
