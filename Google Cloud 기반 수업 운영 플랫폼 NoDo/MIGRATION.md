# 마이그레이션 원칙

NoDo_02는 NoDo_01의 로컬 Firebase Emulator 기능을 보존하면서 실제 Google·Anonymous 인증과 제한된 조직 Bootstrap을 분리해 이전한다. 실제 Firestore에는 02-2의 조직·소유자·감사 문서만 만들고 NoDo_01 강의·방·질문·체크·자료 데이터는 자동 이전하지 않는다.

## 02-1 인증 모드와 비밀값 이전

### Google 로그인 진단 이전 원칙

- `authDebug=1` 진단은 로컬 cloud-auth 개발 전용 도구다. 배포 build, Emulator 모드, 일반 사용자 화면으로 옮기거나 활성화하지 않는다.
- 진단 상태는 재현 가능한 단계와 안전한 결과 코드만 유지한다. 계정 이메일·UID·ID Token·OAuth Token·API key·쿠키·Firebase 설정 전문과 Firestore 문서를 state, localStorage, 로그, snapshot에 넣지 않는다.
- `/api/auth/me`의 401·403·409은 각각 토큰 재인증, 회사 구성원 등록 확인, 조직 가입 또는 역할 전환 확인으로 안내한다. 백엔드 원문 오류를 브라우저에 복사하지 않는다.
- Google 팝업과 리디렉션을 변경할 때는 45초 제한, 동시 시작 차단, 늦은 결과 격리, 새로고침 뒤 redirect 결과 처리, `/api/auth/me` 권한 확인을 함께 테스트한다.

- NoDo_02는 NoDo_01을 수정하지 않고 새 폴더로 복사한다. `node_modules`, `.venv`, `dist`, 캐시, 로그, Emulator 데이터와 실제 환경 파일은 복사하거나 이전 버전에 역복사하지 않는다.
- 런타임 모드는 `emulator | cloud-auth` 두 값만 허용하고 생략 시 `emulator`를 사용한다. 같은 프로세스에서 두 모드의 환경 변수나 Firebase 앱을 혼용하지 않는다.
- 02-1의 cloud-auth 브라우저는 Firebase App과 Authentication만 초기화한다. 02-2 이후에도 React는 Firestore·Storage 서비스 인스턴스를 만들지 않고 조직 데이터는 FastAPI로만 요청한다. 실제 Firestore Admin 클라이언트는 cloud-auth FastAPI의 별도 named app에만 존재하며 Emulator 전용 어댑터와 혼용하지 않는다.
- 실제 Firebase 웹 설정은 무시된 프론트 로컬 환경 파일, bootstrap 이메일은 무시된 백엔드 로컬 환경 파일에만 둔다. 실제 이메일·UID·토큰·API 키·프로젝트 설정값을 코드, fixture, snapshot, 문서, 로그 또는 오류 응답으로 옮기지 않는다.
- 서비스 계정 JSON을 만들거나 복사하지 않는다. FastAPI ID Token 검증은 기존 named app에서 토큰의 서명·만료·발급자·대상·UID·이메일·provider·이메일 인증 여부를 모두 검사한다. Firestore용 별도 named app은 로컬 ADC를 사용하고, Cloud Run 이전 시에는 런타임 서비스 계정의 최소 권한을 사용한다.
- Firebase 설정 계정, NoDo 조직 소유자와 GCP IAM 주체를 별개로 관리한다. 한 체계의 권한을 다른 체계의 권한으로 자동 변환하지 않는다.
- NoDo_01 회귀 확인은 Emulator 모드에서 수행하고, 실제 Google 강사·Anonymous 학생 인증과 조직 Bootstrap 확인은 cloud-auth 모드와 `localhost` 승인 도메인에서 수행한다. 02-2 승인 범위 밖의 Storage·Analytics·App Check·Cloud Run 배포 또는 다른 Google API를 활성화하지 않는다.
- cloud-auth 로컬 실행의 브라우저 API 기준 주소는 `http://localhost:5175`이며 개발 서버가 `/api`만 `http://127.0.0.1:8082`로 전달한다. 마이그레이션 시 임의 외부 API 주소를 허용하지 말고 동일 출처 또는 승인된 백엔드 경계를 별도로 검토한다.
- 02-1 로그아웃은 브라우저 지속 세션을 제거하지만 외부로 복사된 ID Token의 서버 측 즉시 폐기는 제공하지 않는다. 토큰을 애플리케이션 저장소·로그에 남기지 말고, 운영 전환 전에 강제 로그아웃·계정 비활성화·토큰 탈취 대응과 재인증 기준을 설계한다.
- Google 팝업 인증은 45초 제한을 적용한다. 시간이 지난 팝업의 늦은 결과는 시도 ID로 격리하며, 새 로그인·승인된 프로필·로그아웃 상태를 바꾸지 않는다.
- 리디렉션은 초기 화면부터 사용자가 명시적으로 선택할 수 있는 대체 경로다. 리디렉션 복귀 credential은 `GET /api/auth/me`의 기존 서버 토큰 검증으로 한 번만 연결하고, `getRedirectResult()`의 `null`은 정상적인 비로그인 초기 상태로 취급한다.

## 02-7 학생 인증 독립 이전 원칙

- 02-7 구현 당시에는 Firestore 권한 부족으로 02-2가 중단되어 있었으며, 학생 인증은 조직 데이터와 독립적으로 완성했다. 이후 02-2가 실제 Firestore를 연결해도 이 학생 계약을 소급 변경하지 않는다.
- 02-7에서 수행한 실제 Firebase 설정 변경은 Anonymous Authentication 제공업체 활성화 하나였다. Google 제공업체는 유지하고 Identity Platform 업그레이드와 익명 계정 자동 삭제 정책은 계속 사용하지 않는다.
- 학생 화면은 자동 생성한 한글 `형용사 + 명사` 별명을 입력창에 제시하고 참여 전 수정을 허용한다. 화면의 주요 동작은 `참여하기` 하나이며 인증 기술 용어를 학생 문구에 노출하지 않는다.
- `참여하기` 전 별명은 React 상태에만 둔다. 유효성 검사를 통과한 클릭 뒤에만 `browserSessionPersistence`, Anonymous 로그인, ID Token 발급과 FastAPI 학생 세션 검증을 순서대로 수행한다.
- 참여 성공 후 별명과 참여 코드만 현재 탭의 `sessionStorage`에 저장한다. UID, ID Token, OAuth·Refresh Token, 인증 쿠키, 이메일, 역할·권한은 애플리케이션 저장소로 이전하지 않는다.
- Anonymous 인증은 신원 검증 범위 `AUTH_ONLY`일 뿐 실제 강의방 참여 승인이 아니다. `roomAuthorized`는 항상 `false`이고 Firestore 방 조회, 참여자 생성, 출석·체크·질문 쓰기를 수행하지 않는다.
- 같은 Firebase Auth origin에서 Google 강사와 Anonymous 학생을 자동 교체하지 않는다. Google 세션은 명시적 로그아웃 뒤, 학생 세션은 명시적 참여 종료 뒤에만 다른 provider로 전환한다.
- 참여 종료 시 Firebase `signOut`, `sessionStorage` 별명 제거와 학생 화면 상태 초기화를 함께 수행한다. 로그아웃 뒤 같은 UID가 다시 발급될 것으로 가정하지 않는다.
- 실제 강의방 기능을 연결할 때는 서버가 검증한 익명 UID와 참여자 문서를 위한 별도 트랜잭션·Rules·보존 정책을 설계한다. 02-2의 조직 소유자 문서만으로 별명 중복·영구 저장이나 참여 권한을 추론하지 않는다.

## 02-8 강의 자료 검사 이전 원칙

- `/create/material`의 선택 파일은 React 화면 메모리에만 존재하며 새로고침·탭 종료 뒤 복원하지 않는다. File 객체, 파일명 또는 검사 결과를 브라우저 저장소나 운영 데이터로 이전하지 않는다.
- 지원 형식과 초기 한도는 PPTX·PDF·DOCX 각 30MB, PNG·JPG/JPEG 각 10MB다. 확장자·MIME·시작 시그니처 검사 결과는 서버 검증이나 저장 완료를 의미하지 않는다.
- Office 파일은 ZIP `PK` 시작만 확인한다. 02-9를 시작하기 전 ZIP 내부 항목 수·압축률·경로 순회·OOXML 필수 엔트리·전체 비압축 크기·암호화 파일 정책을 별도 FastAPI 계약으로 승인받는다.
- 02-9에서도 브라우저 판정을 신뢰하지 않고 서버가 파일명, 크기, MIME, 매직 바이트와 컨테이너 안전성을 다시 검사해야 한다. 실패 파일은 영구 저장 전에 폐기하고 원본 파일명은 로그·분석 서비스로 보내지 않는다.
- PPT·HWP는 변환 안내, 코드·데이터는 후속 자료 유형으로 유지한다. 변환·추출·OCR·Gemini·Document AI·Google API를 02-8 상태에서 소급 활성화하지 않는다.
- 02-8 자료 선택 경로에는 FastAPI 업로드, multipart 전송, Firestore·Storage 쓰기와 실제 자료 마이그레이션이 없다. 이 경계는 02-2의 서버 전용 조직 Firestore 연결과 독립이며 기존 익명 테스트 계정을 유지한다.

## 02-2 실제 Firestore와 최초 조직 소유자 이전

실제 데이터베이스 계약은 승인된 프로젝트의 `(default)`, Standard, Firestore Native, `asia-northeast3`, 삭제 보호 활성화다. 기존 데이터베이스의 ID·에디션·모드·위치가 다르면 삭제·복제·재생성으로 보정하지 않고 이전을 중단한다.

- `firebase.json`, `.firebaserc`, `firestore.rules`는 `demo-nodo` Emulator 전용 상태로 보존한다. 진단용 `emulatorChecks` 쓰기 허용이 있는 이 Rules를 실제 프로젝트에 배포하지 않는다.
- 실제 환경은 `firebase.cloud.json`과 `firestore.cloud.rules`로 분리한다. Production Rules는 본인 `users/{uid}`와 STAFF의 동일 조직 `organizations/{orgId}` 단건 읽기만 허용하고, 모든 목록·브라우저 쓰기·감사 로그·진단·강의·방·질문·자료 접근을 기본 거부한다.
- 실제 Rules 배포는 `firebase deploy --config firebase.cloud.json --project example-gcp-project --only firestore:rules`처럼 config·project·서비스 범위를 모두 명시한다. Hosting, Storage, indexes와 Emulator Rules를 같은 배포에 포함하지 않는다.
- cloud-auth 서버는 프로젝트 ID가 다르거나 데이터베이스 ID가 `(default)`가 아니거나 `FIRESTORE_EMULATOR_HOST`가 존재하면 실제 Firestore 연결 전에 실패한다.
- ID Token 검증용 Firebase Admin named app을 재사용하거나 대체하지 않고, Firestore용 named app을 별도로 둔다. 로컬은 ADC, Cloud Run은 런타임 서비스 계정을 사용하며 서비스 계정 JSON과 OAuth Client Secret을 배포 자산으로 이전하지 않는다.
- React에는 Firestore 클라이언트, 데이터베이스 ID, ADC 또는 Bootstrap 이메일을 전달하지 않는다. 사용자·조직 조회와 모든 중요 쓰기는 FastAPI만 수행한다.

### 조직·사용자·감사 문서 계약

최초 Bootstrap은 다음 세 문서를 하나의 Firestore Transaction 일관성 경계로 다룬다.

1. `organizations/demo`: `id`, `orgId`, `name`, `ownerUid`, `bootstrapState: COMPLETED`, `schemaVersion: 1`, 서버 `createdAt`·`updatedAt`. 이메일은 저장하지 않는다.
2. `users/{uid}`: 검증된 `uid`, `orgId`, `accountType: STAFF`, `isOrgAdmin: true`, `isOrgOwner: true`, `isAnonymous: false`, 정규화된 이메일과 검증된 프로필, schema·서버 시각. ID Token과 OAuth Token은 저장하지 않는다.
3. `organizations/demo/auditLogs/bootstrap-owner-created`: 이벤트 유형, 조직·실행자·대상 UID, 최소 역할 전후 상태, schema·서버 시각. 이메일·토큰·전체 claim은 저장하지 않는다.

Transaction 전에 Google provider, 이메일 인증, 프로젝트, Bootstrap 활성화, 서버 후보 이메일과 고정 조직 설정을 모두 검증한다. 요청 본문에서 역할·조직 ID·조직 이름을 받지 않으며, 추가 필드가 오더라도 권위 값으로 사용하지 않는다.

같은 UID의 재호출은 기존 세 문서의 일관성을 확인한 뒤 같은 성공 결과를 반환하고 감사 로그를 다시 만들지 않는다. 다른 UID는 기존 `ownerUid`를 덮어쓸 수 없으며 동시 요청 중 한 명만 커밋해야 한다. Transaction 실패는 세 문서 모두 미생성 상태여야 하고, 일부 문서 또는 모순된 기존 문서를 발견하면 자동 삭제·초기화하지 않고 중단한다.

### Bootstrap 비활성화 순서

1. 세 문서와 `ownerUid == users/{uid}.uid` 관계를 실제 Firestore에서 확인한다.
2. `GET /api/auth/me`가 Firestore의 영구 소유자를 반환하고 `bootstrapOwner: false`인지 확인한다.
3. 로컬 환경의 `NODO_BOOTSTRAP_ENABLED=false`로 바꾸고 `NODO_BOOTSTRAP_ORG_OWNER_EMAILS`를 비우거나 제거한다.
4. 서버 재시작 뒤 같은 UID가 이메일 후보 목록 없이 다시 로그인되는지, 다른 UID가 같은 이메일을 주장해도 거부되는지 확인한다.

비활성화 실패를 이유로 이미 확정된 소유자·감사 문서를 삭제하지 않는다. 영구 권한은 이메일이 아니라 `organizations/{orgId}.ownerUid`와 `users/{uid}`의 일관성으로 판정한다.

02-3 회사 직원 가입과 02-4 관리자 권한 확장에서도 Bootstrap endpoint를 재사용해 임의 승격하지 않는다. 조직 권한과 방별 `leadInstructorId`·`staff/{uid}`를 분리하고, 활성 조직의 소유자 최소 1명 불변식·대상 수락·서버 Transaction·감사 로그·복구 절차를 별도로 설계한다.

## 02-3 회사 직원 초대 이전 원칙

- 직원 초대는 이메일 전송 기록이 아니라 조직 가입 허용 상태다. Gmail·Outlook·Firebase 이메일 링크와 메일 발송 API를 새 버전에 암묵적으로 연결하지 않는다.
- 허용 이메일은 Unicode 제어 문자와 줄바꿈이 없는 최대 254자의 정확한 주소로 제한하고 앞뒤 공백 제거·소문자 정규화 뒤 `@nodo-company.test` 전체 도메인을 비교한다. suffix·부분 일치, 개인 Gmail, 다른 회사 도메인, 소유자 본인과 기존 직원은 거부한다.
- 허용 도메인과 만료 시간은 `NODO_STAFF_EMAIL_DOMAINS`, `NODO_STAFF_INVITATION_TTL_HOURS` 서버 설정으로 이전한다. 이 값을 `VITE_*` 환경이나 요청 본문에서 권위 값으로 받지 않는다.
- 초대 ID는 `SHA-256(orgId + NUL + emailNormalized)` 결정값이다. 원본 이메일을 문서 ID·URL·감사 event ID에 넣지 않으며, ID를 소유 증명이나 bearer token으로 취급하지 않는다.
- `organizations/{orgId}/staffInvitations/{invitationId}`의 `PENDING | ACCEPTED | REVOKED`, `revision`, 생성·변경·만료·수락·취소 상태를 보존한다. 초대를 삭제해 상태 이력을 잃거나 REVOKED를 새 문서 ID로 복제하지 않는다.
- 유효한 PENDING 재등록은 새 쓰기·감사 없이 기존 결과를 반환한다. REVOKED·만료 재발급은 같은 문서에서 revision을 증가시키고 새 만료 시각을 기록하며 과거 accepted/revoked 필드를 정리한다.
- 초대 생성·재발급은 초대 문서와 감사 로그를, 취소는 PENDING→REVOKED 전환과 감사를 하나의 Transaction으로 기록한다. ACCEPTED·REVOKED·다른 조직·없는 초대를 삭제나 자동 초기화로 보정하지 않는다.
- 감사 event ID는 동작·초대 ID·revision에서 결정해 재시도 중복을 막는다. 감사에는 이메일, ID/OAuth/Refresh Token, 비밀번호와 인증 쿠키를 저장하지 않는다.

## 02-3 조직 가입 이전 원칙

- `GET /api/auth/me`는 기존 owner/STAFF 사용자 문서를 먼저 판정한다. 사용자 문서가 없을 때만 검증된 Google 이메일로 유효한 PENDING 초대를 찾아 `ORGANIZATION_INVITATION_ACCEPTANCE_REQUIRED`를 반환한다.
- 409 응답은 조직 표시명과 만료 시각만 포함한다. 초대 ID, 이메일 목록, 초대자·소유자 UID, 내부 경로와 감사 로그를 클라이언트에 이전하지 않는다.
- 가입 수락 요청은 이메일·초대 ID·조직 ID·계정 유형·관리자·소유자 값을 받지 않는다. ID Token, 서버 설정과 초대 문서에서 모든 권위 값을 다시 계산한다.
- 수락 Transaction은 조직과 소유자 상태, 초대 이메일·PENDING·만료, `users/{uid}` 부재를 확인한 뒤 일반 STAFF 사용자 생성, 초대 ACCEPTED 전환과 감사를 함께 기록한다. 일부 문서만 존재하면 성공으로 복구하지 않는다.
- 가입 사용자는 `accountType: STAFF`, `isOrgAdmin: false`, `isOrgOwner: false`, `isAnonymous: false`다. `joinedByInvitationId`는 초대 연결용이며 이메일 권한을 영구 역할 키로 사용하지 않는다.
- 가입 후 인증은 `users/{uid}`를 기준으로 복원한다. 초대 문서가 만료·취소되거나 이메일이 바뀌어도 이미 가입한 사용자를 자동 삭제·강등하지 않으며, 직원 제거·조직 탈퇴 정책은 별도 승인 전 구현하지 않는다.
- `staffInvitations`, 조직 `auditLogs`와 `users` 목록은 브라우저에 이전하지 않는다. React 구성원 화면은 FastAPI의 최소 응답만 사용하고 실제 Firestore Rules의 기본 거부를 유지한다.
- 02-4 관리자 기능은 소유자가 같은 조직 일반 STAFF를 명시적으로 지정·해제하는 별도 Transaction으로 설계한다. 02-3 수락만으로 관리자·주 강사·보조 강사 권한을 만들지 않는다.

## 01-3A 사용자·강의방 담당 관계 변환

- 사용자 문서 변환은 `ORG_ADMIN → accountType: STAFF, isOrgAdmin: true`, `LEAD_INSTRUCTOR | ASSISTANT_INSTRUCTOR → accountType: STAFF, isOrgAdmin: false`, `STUDENT → accountType: STUDENT, isOrgAdmin: false`로 수행한다.
- 변환이 끝난 새 사용자 문서에서는 과거 `role` 필드를 제거한다. 읽기 호환 계층이 과거 role을 계정 유형으로 해석하더라도 주·보조 강사 권한을 부여하는 근거로 사용하지 않는다.
- 기존 room과 course의 `leadInstructorId`를 유지한다. 기존 `rooms/{roomId}/staff/{uid}` 문서와 12개 권한도 유지하되 새 staff 문서에는 전역 역할을 복제하지 않는다.
- 같은 직원이 방 A에서는 `leadInstructorId` 일치, 방 B에서는 staff 문서 존재, 방 C에서는 둘 다 없음으로 서로 다른 관계를 가질 수 있어야 한다.
- 새 course·room은 요청자가 같은 조직의 `STAFF`인지 서버에서 확인하고 생성자의 UID를 `leadInstructorId`로 저장한다. 클라이언트가 다른 주 강사 UID를 지정하지 못하게 요청 스키마의 추가 필드를 거부한다.
- 새 보조 강사 초대 요청은 `userId`만 허용한다. 서버는 `canAnswerQuestions`만 `true`, 나머지 11개를 `false`로 저장하고 추가 권한은 별도 갱신 API에서만 변경한다.
- migration dry-run은 다른 조직 직원·수강생·현재 주 강사가 staff로 들어간 잘못된 문서, 동일 방의 lead/staff 중복, 누락·알 수 없는 권한 키를 보고해야 한다.

## 01-3A 질문 번호·채널·답변 변환

- 챕터와 항목은 각각 `(order, id)`의 안정 순서로 정렬한 뒤 1부터 번호를 부여한다. 새 체크리스트 질문에는 서버가 계산한 `itemNumberSnapshot`을 저장하고 클라이언트 입력 번호는 신뢰하지 않는다.
- 과거 질문에 번호 스냅샷이 없으면 화면에서 현재 항목 번호를 호환 표시할 수 있지만 운영 backfill은 당시 순서를 입증할 수 있을 때만 수행한다. 순서를 알 수 없는 질문에 현재 번호를 영구 저장하지 않는다.
- 일반 질문 작성 요청은 `itemId: null`, 읽음 문맥은 `GENERAL`이다. 저장 질문에는 `itemId`, `itemNumberSnapshot`과 항목·챕터 스냅샷 필드를 넣지 않으며 별도 Firestore room 문서로 분할하지 않는다.
- 질문의 기본 정렬 키는 `(createdAt, questionId)`다. 답변 생성·수정·취소가 질문의 `createdAt`이나 상대 순서를 바꾸면 안 된다.
- 새 공개 답변은 답변 당시 방 관계인 `roomRole: LEAD | ASSISTANT`를 저장한다. 과거 `staffRole`·`instructorRole`은 화면 읽기 호환만 제공하고 신규 쓰기에는 사용하지 않는다.

## 01-3 질문 데이터 이전 기준

- 공개 질문과 작성자 신원을 합치지 않는다. `questions/{questionId}`에는 화면에 필요한 공개 상태만, `questionAuthors/{questionId}`에는 Firebase UID·`clientRequestId`·내용 digest를 둔다.
- 과거 mock 질문의 `nickname`, `content`, `answer`만 보고 작성 UID를 추정하지 않는다. 근거가 없는 mock은 운영 질문으로 자동 변환하지 않는다.
- 질문 ID는 room·작성 UID·`clientRequestId`에서 결정된다. 운영 이전에도 같은 요청 ID 재시도가 새 질문을 만들지 않는 멱등 계약을 유지한다.
- 질문, 작성자 연결과 `questionRateLimits` 갱신은 한 트랜잭션이어야 한다. 일부 문서만 존재하는 레코드는 성공으로 보정하지 말고 무결성 오류로 격리한다.
- `NEEDS_REVIEW/STAFF_ONLY` 질문은 승인 전 공개 질문으로 변환하지 않는다. 공개·검토 구분 없이 작성 성공 응답은 `{ id, roomId, accepted: true }`만 반환하고 내용·문맥·공개 범위·검토 상태는 권한별 구독에서만 전달한다.
- 답변 공개 map에는 내용, 강사 표시명·답변 당시 방 관계와 서버 시각만 둔다. 답변자 UID·이메일은 공개 문서에 추가하지 않는다.
- 항목 번호·항목·챕터·자료 제목은 질문 당시 스냅샷이다. 이후 강의 편집으로 소급 변경하지 않으며, 원본 항목이 삭제되어도 질문 문맥을 표시할 수 있게 보존한다.

## 멱등성과 동시성

- Python 전역 Lock, 프로세스 Mutex나 Cloud Run 단일 인스턴스를 가정하지 않는다.
- Firestore `ABORTED`만 새 트랜잭션으로 최대 3회 외부 재시도한다. 일반 도메인 오류와 형식 오류를 재시도하지 않는다.
- 커밋 응답이 유실될 수 있으므로 질문·작성자 연결을 다시 읽어 현재 요청이 이미 완료되었으면 같은 응답을 복원한다. rate 창에서 오래된 entry가 정리되어도 영구 멱등성은 질문·작성자 문서로 판정한다.
- `clientRequestId`는 UI가 UUID로 생성하고 같은 사용자 동작의 네트워크 재시도에서는 재사용한다. 사용자가 새 질문을 명시적으로 보내면 새 UUID를 만든다.
- 운영 전에 같은 participant의 동시 5개 질문, 같은 request ID 동시 전송, 종료와 질문의 경합을 여러 인스턴스에 준하는 부하로 반복 검증한다.

## 검토·속도 제한 이전 기준

- 1~500자, Unicode NFKC, 제어 문자 정리와 일반 텍스트 저장 원칙을 유지한다. HTML을 신뢰하거나 마크업으로 렌더링하지 않는다.
- 10초 최대 3개, 30초 동일·유사 질문 차단은 현재 로컬 기준이다. 운영 전 교육 정책, 오탐 처리, 접근성, 개인정보와 이의 제기 절차를 승인받는다.
- 금칙어·검토어 목록은 Gemini나 AI가 아닌 소규모 코드 내 정책이다. 실제 분류 서비스를 도입하더라도 서버의 길이·속도·권한 검사를 대체하지 않는다.
- `questionRateLimits`에는 원문 대신 digest와 해시 fingerprint만 저장한다. 운영에서는 30초 창을 지난 항목과 장기 미사용 문서의 삭제/TTL 정책을 정하고 비용·경합을 모니터링한다.

## 읽음 상태 이전 기준

- 읽음은 강사별·문맥별 `questionReads/{staffUid}/contexts/{contextHash}`로 유지한다. 공용 `unread` boolean이나 질문 문서의 강사별 map으로 합치지 않는다.
- 클라이언트는 실제로 본 `observedQuestionId`만 보내며 `observedAt`은 보내지 않는다. 서버가 해당 질문의 방·문맥·소속과 서버 저장 시각을 대조해 watermark를 정한다.
- `ALL` watermark는 그보다 이전의 일반·항목 질문까지 읽음으로 계산한다. `GENERAL` 또는 `ITEM:{flowItemId}` watermark는 해당 문맥에만 적용한다.
- 읽음 위치가 실제로 앞으로 갈 때만 최소 `QUESTION_READ` 감사 로그를 남긴다. 같은·과거 위치는 읽음 문서와 감사 로그를 중복 생성하지 않는다.
- 읽음 기록은 사용성 상태이므로 감사 로그와 보존 기간을 동일하게 취급하지 않는다. 운영 보존·삭제 정책을 별도로 정한다.

## 참여자 개인정보 이전 기준

- 참여 문서의 `userId`는 Rules 인증 연결용 내부 UID다. 참여자 목록·제한 API에서는 `participantId`, 별명, 상태, 제한 여부와 시각만 반환한다.
- 기존 participant 문서에 `participantId`가 없으면 안정적인 불투명 legacy ID를 계산해 호환하고, 운영 마이그레이션에서는 충돌 검사를 거쳐 무작위 ID를 일괄 backfill한다.
- 별명은 익명 표시값이지 신원 증명이 아니다. 이메일·실명·IP·기기 식별자를 질문 공개 문서나 리포트에 추가하지 않는다.
- 참여자 질문 제한은 새 질문만 막는다. 기존 질문 삭제나 과거 기록 재작성으로 변환하지 않는다.
- 별도 Chrome 프로필·기기에서 Anonymous 입장하면 새 UID와 참가자 문서가 생길 수 있다. 따라서 참가자 수 자체는 질문·읽음 기능의 성공 기준으로 삼지 않으며, 기존 참가자의 별명·제한 상태·문서는 수정하지 않는다.

## 종료와 요약 이전 기준

- 방 상태는 `ACTIVE → ENDING → ENDED`를 유지한다. `ENDING`은 중간 실패를 숨기는 값이 아니라 새 질문·답변·검토·체크·제한 변경을 차단하는 일관성 경계다.
- 종료 미리보기의 미답변·미완료 수는 서버가 최신 권위 문서에서 집계한다. 프론트 캐시 숫자를 종료 결정 근거로 저장하지 않는다.
- 최초 종료 실행자의 UID와 표시명을 `ACTIVE → ENDING` 전환에서 원자적으로 저장한다. 재시도 또는 다른 실행자의 후속 완료로 summary와 감사 로그의 실행자가 바뀌지 않아야 한다.
- `summary/current`, room·course의 `ENDED`와 `ROOM_ENDED` 감사 로그는 최종 트랜잭션에서 함께 확정한다.
- `ENDED`의 기존 요약은 불변이다. 재호출로 현재 질문 상태를 다시 집계하거나 `endedAt`을 바꾸지 않는다.
- `ENDING` 상태에서 장애가 난 방을 탐지·복구할 운영 작업과 알림 기준을 배포 전에 설계한다. 복구는 최초 실행자와 `endingAt`을 보존해야 한다.
- `exportStatus: NOT_CONFIGURED`는 내보내기 미연결 상태다. Sheets 내보내기를 추가할 때 권한, 재시도·멱등 키, 부분 성공, 파일 소유권과 삭제 정책을 별도로 정의한다.

## 감사와 보존

- `permissionLogs`와 `moderationLogs`는 클라이언트 쓰기를 허용하지 않는다. `moderationLogs`에는 상태 전후, 대상 ID, 실행자 UID와 시각만 저장하고 질문·답변 원문을 복제하지 않는다.
- 운영에서 감사 로그의 접근 주체, 보존 기간, 삭제 요청과 법적 요구를 확정한다. 현재 Rules가 로그를 숨긴다는 이유만으로 무기한 보존하지 않는다.
- Cloud Logging에 ID Token, 질문 원문, 참여 코드, 작성 UID가 평문으로 남지 않게 구조화 로그와 마스킹 정책을 적용한다.

## Rules·인덱스·운영 보안

- Emulator Rules를 실제 프로젝트에 그대로 배포하지 않는다. 02-2 Production Rules는 최소 조직 Bootstrap 읽기만 허용하며, 기존 강의 역할·참여·질문 Rules를 운영에 확장할 때는 별도 staging에서 쿼리와 인덱스를 다시 검증한다.
- `questionAuthors`, `questionRateLimits`, `moderationLogs`, `roomJoinCodes`는 모든 클라이언트 접근을 거부한다. 서버 Admin SDK 우회 권한은 최소 권한 서비스 계정과 FastAPI 검사를 통해 통제한다.
- `questionReads`는 본인 강사 경로만, `summary/current`는 주 강사·`canViewReports`·같은 조직 관리자만 읽도록 유지한다.
- 현재는 동등 조건과 클라이언트 정렬을 사용해 복합 인덱스가 없다. 운영 쿼리·정렬·페이지네이션을 바꾸면 `firestore.indexes.json`, 비용과 대량 collection scan을 다시 검토한다.
- Cloud Run 배포 시 서비스 계정 JSON 대신 런타임 서비스 계정과 ADC를 사용하고 Firestore 최소 IAM만 부여한다. App Check, Cloud Run 호출 IAM, CORS 운영 origin, Secret Manager, 키 회전, 감사 로그, 백업·복구, 예산 알림과 모니터링은 운영 전 필수로 설계한다.
- `.test` 계정, `demo-nodo`, 익명 seed UID, 참여 코드 `NODO01`, Emulator 로그와 local export를 운영으로 복사하지 않는다.

## 01-2 데이터에서 유지할 불변식

- `course.activeRoomId`, `room.courseId`와 `orgId`가 일치해야 한다.
- `roomJoinCodes`, room과 course 연결은 원자적으로 생성한다.
- 과거 보조 강사 12개 권한은 보존한다. 새 초대는 서버가 `canAnswerQuestions`만 `true`인 완전한 기본 map을 만들고, 권한 갱신에서 누락 필드는 `false`로 채우며 알 수 없는 키는 거부한다. 01-3A 연결 권한은 10개이며 `canAnnotate`, `canExportResults`만 미연결이다.
- 항목은 `isCompleted`만 저장하고 완료 값은 앞에서부터 연속되어야 한다. `currentItemId`는 첫 미완료 항목 또는 `null`이다.
- 자료는 `materials/current` 메타데이터만 저장한다. 실제 파일 연결 전 MIME, 크기, 악성 파일, 업로드 취소·실패 복구와 Storage Rules를 설계한다.

## 이전 버전 보존과 다음 단계

- NoDo_00과 NoDo_01을 수정하거나 NoDo_02 파일을 역복사하지 않는다. 새 버전은 소스·설정 예시·잠금 파일만 복사한다.
- `node_modules`, `.venv`, `dist`, 캐시, Emulator 데이터·로그와 실제 `.env`는 복사하지 않는다.
- 탭별 인증 세션과 익명 프로필 복원 계약을 유지한다. 운영 인증 정책을 바꿀 때 로그인 지속 시간, 공용 기기 로그아웃, 새로고침 중 권한 화면 노출을 함께 검증한다.
- 모바일 form control 글꼴을 16px 미만으로 낮출 때는 입력 포커스 전후 390×844 viewport와 가로 스크롤을 실제 브라우저에서 다시 검증한다.
- TypeScript 6.0.3과 TypeScript ESLint 호환성을 유지하며 버전 변경 시 lint·test·build와 이유를 기록한다.
- 잠금 파일, API 계약, Firestore schema/Rules/index, 환경 변수와 데이터 변환을 함께 버전 관리한다.
- 비로그인 회귀용 `DemoCourseProvider`의 질문 mock을 실제 question collection으로 변환하거나 섞지 않는다.
- 02-2에서 승인된 실제 Firestore와 Production Rules 외 Firebase·GCP 설정을 별도 승인과 staging 검증 없이 변경하지 않는다. Storage, Gemini, Google API와 실제 강의 데이터는 다음 독립 기능에서 다시 승인받는다.
- 다음 단계는 02-2의 세 문서 계약과 `ownerUid` 판정을 보존한다. Bootstrap endpoint를 일반 관리자·강사 생성 API로 확장하거나 비활성화된 이메일 목록을 다시 영구 권한 키로 사용하지 않는다.

## 검증 명령

```powershell
# 프론트엔드
cd web
npm run lint
npm run test:run
npm run build

# 백엔드
cd ..\backend
.venv\Scripts\python -m ruff check .
.venv\Scripts\python -m pytest
.venv\Scripts\python -m compileall -q app

# Rules + seed + FastAPI Emulator 통합·동시성
cd ..
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\run-emulator-tests.ps1 -Mode All -Repeat 3
```

검증에는 공개/서버 전용 분리, 권한 회수, 학생 UID 비노출, 질문 멱등·속도·유사도, 강사별 watermark, 답변·검토 감사, 참여자 제한, 종료 경합, 요약 불변성과 고아 문서 부재를 포함한다.

## 02-4A 이후 조직 역할 전환 원칙

새 권한 판단은 `organizationRole: ADMIN | INSTRUCTOR`만 사용합니다. 기존 Boolean 필드와 조직의 이전 식별 필드는 호환 기록으로 남기되 새 권한 판단에 사용하지 않습니다. Emulator 전환은 멱등으로 `adminCount`와 감사 로그를 맞추며, 실제 Firestore 전환은 별도 승인 전까지 실행하지 않습니다.

## 02-5 수업 흐름 데이터 이전·운영 원칙

- 기존 Emulator 수업과 NoDo_00 mock 수업 흐름은 실제 Firestore course 문서로 자동 복사하지 않는다. 운영자가 제목·작성자·조직·내용의 출처를 검토해 별도 이관 계획을 승인해야 한다.
- 새 course는 `organizations/{orgId}/courses/{courseId}`에 `schemaVersion`, `status`, 작성자 UID·표시명 스냅샷, `revision`, 서버 시각, 챕터와 항목의 ID·position을 함께 기록한다. 배열 position은 서버가 0부터 다시 계산한다.
- 02-5A 이후 React의 화면·응답 모델은 편집 순서용 `position`을 유지하지만 FastAPI 생성·수정 입력에는 이를 포함하지 않는다. 입력은 ID·제목·설명·중첩 배열과 수정 시 최상위 `expectedRevision`만 전달하고, `extra="forbid"`는 완화하지 않는다. 실제 Firestore 저장·불러오기·보관 검증은 02-5B에서 별도로 재개한다.
- 과거 문서에 작성자·조직·revision·상태·ID가 없거나 길이 제한을 넘으면 추측해 보정하지 말고 격리·검토한다. legacy 권한 Boolean만으로 course 접근 권한을 부여하지 않는다.
- 삭제 요청은 영구 삭제가 아니라 `ACTIVE → ARCHIVED` 보관 전환이다. 복구와 실제 영구 삭제·보존 기간은 별도 운영 승인 없이는 구현하거나 실행하지 않는다.
- TypeScript/React 계약과 FastAPI API 계약을 함께 배포하고, course 스키마를 바꿀 때는 create·list·get·update·duplicate·archive, revision 충돌, 작성자 제한과 감사 이벤트를 모두 회귀 검증한다.

## 02-9A 질문·답변 이관 기준

- 기존 Emulator `rooms/{roomId}/questions`와 cloud-auth `organizations/{orgId}/rooms/{roomId}/questions`를 자동 복사하거나 혼용하지 않는다. cloud-auth의 공개 질문은 작성자 UID 없이 content·별명 스냅샷·일반/항목 문맥 스냅샷·visibility·moderation·답변·숨김·서버 시각만 보존한다.
- 익명 작성자 UID, clientRequestId, 정규화 digest·fingerprint와 전송 시각은 동일 questionId의 비공개 `questionAuthors` 문서에만 저장한다. UI·공개 API·감사 본문에 UID, 이메일, 실명, ID/OAuth Token을 이관하지 않는다.
- 항목 질문의 번호·제목·챕터는 질문 시점 `flowItems` 스냅샷으로 기록한다. 원본 수업 또는 이후 checklist 변경으로 과거 질문 문맥을 추측해 갱신하지 않는다.
- 검토 필요 질문은 `STAFF_ONLY`, 주 강사 숨김은 학생 비공개다. 답변은 질문 문서의 공식 answer 하나로만 두며, 답변 취소·숨김·복구와 읽음 위치는 서버 Transaction으로 처리한다.
- 규칙 기반 금칙어·도배·유사도 정책은 Gemini, Perspective, Sheets를 호출하지 않는다. 실제 질문·답변·읽음·감사 로그 생성과 종료 후 삭제/보존·Sheets 내보내기는 02-9B 이후 별도 승인·설계 없이는 실행하지 않는다.

## 02-6A 강의방 데이터 이전·운영 원칙

- 기존 Emulator의 legacy room, 참여 코드와 NoDo_00 mock을 새 cloud-auth 강의방으로 자동 복사하지 않는다. 새 방은 명시적으로 선택한 ACTIVE `sourceCourseId`에서만 만든다.
- 새 방은 `organizations/{orgId}/rooms/{roomId}`에 source course ID·revision·제목 스냅샷, READY 상태, creator·lead·instructor members, 서버 시각·revision과 서버 생성 roomCode를 기록한다. 원본 흐름은 `flowItems/{itemId}`로 별도 저장하므로 원본 수정이 기존 방에 반영되지 않는다.
- `roomCode`는 클라이언트나 이관 데이터가 정하지 않는다. 서버가 조직 내부 `roomCodes/{roomCode}` 인덱스와 같은 Transaction에서 생성·선점하며, 코드 충돌과 flowItems 200개 초과는 명시적으로 실패시킨다.
- ADMIN은 조직 내 READY 방을 운영 조회하고, INSTRUCTOR는 자신의 방만 조회한다. 주 강사 이전·참여 강사 초대·학생 입장·QR은 별도 변경 계획과 권한 검토 없이 이관하거나 활성화하지 않는다.
- 실제 `(default)` Firestore로의 강의방 이관·생성·공유 링크 검증은 02-6B의 명시 승인 전까지 금지한다. 02-6A는 Emulator와 자동 테스트 계약만 검증한다.

## 02-7A 익명 참여 이관 기준

- 공개 링크는 `organizations/{orgId}/roomCodes/{roomCode}`로 서버에서 해석한 뒤 `READY` 또는 `LIVE` 방에만 연결한다. 잘못된 조직·코드·종료 방은 같은 공개 불가 메시지로 처리한다.
- 참가자는 `rooms/{roomId}/participants/{anonymousUid}`에 서버만 작성한다. 문서에는 별명, 정규화 키, `joinedAt`, `lastSeenAt`, `participantStatus: JOINED`, `isAnonymous: true` 외의 개인정보를 넣지 않는다.
- 원래 익명 UID가 같은 방에 돌아오면 문서를 재사용하고 `lastSeenAt` 및 변경된 별명만 갱신한다. 최초 생성만 감사 이벤트를 남긴다.
- 실제 `(default)` Firestore로의 수강생 참여 검증은 별도 사용자 승인 단계 전까지 금지한다.

## 02-8A 강의방 진행 체크리스트 이관 기준

- cloud-auth 방의 상태는 `READY`, `LIVE`, `ENDED`만 사용한다. `READY → LIVE` 시작은 주 강사와 `expectedRevision`을 확인하는 Transaction으로만 전환하며, 종료는 다음 단계까지 구현하지 않는다.
- 진행 문서는 `flowItems/{itemId}.isCompleted: boolean`만 변경한다. 현재 항목 ID·예정·진행 중 상태를 별도 문서나 필드로 이관하지 않고, 정렬 순서에서 첫 미완료 항목을 서버가 계산한다.
- 완료는 현재 항목만 가능하며, 완료 항목을 되돌리면 선택 항목과 이후 항목의 `isCompleted`를 false로 만든다. 모든 변경은 room revision 증가와 최소 감사 이벤트를 함께 기록한다.
- ADMIN은 같은 조직 방을 읽을 수 있지만 lead instructor가 아닌 경우 진행을 변경할 수 없다. 보조 강사 권한은 후속 계약으로 별도 추가한다.
- 실제 `(default)` Firestore의 수업 시작·진행 변경·감사 로그 검증은 02-8B의 명시 승인 전까지 금지한다.

## NoDo 자원 경계·배포 이전 원칙

- NoDo 데이터 이전은 `(default)` Database ID 안의 `organizations/{orgId}` 범위로 제한한다. 다른 Firestore Database, 다른 서비스 컬렉션·버킷·Cloud Run 자원으로 데이터를 복사하거나 조회하지 않는다.
- `firebase.nodo.json`은 `(default)` Database ID와 NoDo Rules·Indexes 파일을 함께 고정한다. 배포 시 config·project·서비스 범위를 모두 명시하고 Emulator config를 실제 배포에 사용하지 않는다.
- 실제 Rules·Indexes 배포 또는 Storage/IAM/Cloud Run 생성 전에 대상 자원, 최소 권한, 영향 범위, 롤백과 승인 기록을 검토한다. 기존 NoDo 조직·구성원·초대·감사·수업 흐름 문서는 자동 이동·삭제하지 않는다.
- 미래 Cloud Run 서비스 계정은 사람 계정이나 NoDo ADMIN과 연결하지 않고 NoDo 전용 경로·버킷의 최소 권한만 받는다. 프로젝트 전체 Editor와 다른 서비스 자원 권한은 이관 계획에 포함하지 않는다.

## 02-10A v2 학생 강의 화면 이관 기준

- 학생 체크리스트는 Anonymous 참가자가 자기 `orgId`·roomCode의 READY/LIVE 방에서만 FastAPI로 읽는다. 응답은 제목·상태·flowItems의 표시 정보/완료 여부·현재 항목·PUBLIC 질문 수만 가지며 강사·조직·원본 수업·감사·작성자 정보는 포함하지 않는다.
- 학생 체크리스트/채팅의 polling은 Firestore 직접 구독이나 읽음 갱신을 하지 않는다. 화면 unmount·숨김 시 timer와 진행 중 요청을 정리하고 마지막 정상 표시를 유지한다.
- 공개 질문 문서의 공식 답변에 저장된 강사 표시명은 강사용 응답에서만 사용한다. 학생 응답은 답변 본문·시각·역할만 전달하고 표시명은 제거한다.
- 자료 없는 실습형 방에는 가짜 자료/슬라이드 데이터를 이관하지 않는다. 미래 자료 연결은 별도 읽기 모델과 승인 범위에서만 추가한다.
- 02-10A는 local Emulator와 mock API만 검증한다. 실제 Firestore 질문·읽음·진행·참가자·감사 데이터, Firebase/GCP 설정과 Git commit/push는 02-10B 명시 승인 전까지 변경하지 않는다.

## 02-11A 현재 접속 인원·정원 이관 기준

- 기존 참가자 문서 수는 누적 참여 이력이며 현재 접속 인원이 아니다. `presenceStatus`, `lastSeenAt`, `leaseExpiresAt`, `leftAt`이 없는 기존 문서는 자동 ACTIVE로 이관하지 않고 다음 화면 heartbeat 때만 정원 확인 후 ACTIVE로 전환한다.
- room의 `maxActiveParticipants`가 없으면 읽기·정원 Transaction에서 50명으로 해석한다. 문서 일괄 backfill은 하지 않는다.
- 현재 카운터와 cooldown 알림은 `rooms/{roomId}/presence/capacity` private 문서에만 둔다. 공개 API/학생 UI에는 카운터, UID, 이메일, 다른 참여자 정보, alert 상태를 반환하지 않는다.
- 별도 Chrome 프로필/기기 재입장은 새 Anonymous UID와 누적 참가자 문서를 만들 수 있으므로, 참가자 총수는 정원 기능의 성공 조건으로 사용하지 않는다. 기존 참가자의 별명·제한·문서는 임의로 수정하거나 삭제하지 않는다.

## 02-11D 정원 운영 감사 이관 기준

- 정원 초과의 새 PENDING 알림, 유지, 상향, ACTIVE→LEFT, LEFT/EXPIRED→ACTIVE, ACTIVE→EXPIRED는 실제 상태 전환에서만 최소 감사 이벤트를 남긴다. 일반 heartbeat와 GET 조회는 감사 대상이 아니지만, heartbeat가 다른 참가자의 만료를 실제 전환하면 해당 `PARTICIPANT_EXPIRED` 감사는 남긴다.
- 정원 GET은 presence/capacity/alert/audit 문서를 만들거나 수정하지 않는 읽기 전용이며, 같은 명령·같은 정원·이미 처리된 상태와 Transaction 재시도는 새 감사 이벤트를 만들지 않는다.
- 누적 참가자 기록은 현재 ACTIVE presence와 별개다. 감사 문서에는 익명 UID·이메일·토큰·질문 본문을 저장하지 않는다.
- 기존 실제 테스트 방의 체크리스트 완료는 사용자가 직접 수행한 정상 검증 조작이며, 정원/presence 이관이나 감사 보완에서 롤백·삭제·수정 대상으로 취급하지 않는다.
- PENDING alert, capacity 상태, 해당 감사 문서는 하나의 Firestore Transaction에서 함께 성공하거나 함께 실패한다. 02-11E-2의 실제 PENDING 상태는 보정하지 않고, 다음 실제 재검증에서 새 방으로만 확인한다.

## 02-11H lease 만료 카운터 이관 기준

- `activeParticipantCount`는 유효 lease를 가진 `ACTIVE` 참가자 수와 같아야 한다. heartbeat는 보통 발신자의 lease만 연장하지만, 같은 Transaction에서 다른 참가자를 `EXPIRED`로 전환하면 변경된 capacity 문서도 함께 저장한다.
- capacity/participant/audit 상태는 Transaction 안에서 함께 성공하거나 실패하며, GET 정원 조회는 만료 처리·카운터 보정·감사 기록을 하지 않는 읽기 전용이다. 02-11G-2의 stale count는 실제 중간 검증 기록으로 보존하고 보정하지 않는다.

## 02-14 비공개 자료 추출 이관 기준

- 원본 PPTX/PDF는 React가 아니라 FastAPI만 고정된 NoDo 비공개 버킷에서 읽는다. public URL, signed URL, Storage SDK 직접 접근, 다른 서비스 버킷·DB는 이관 대상이 아니다.
- 원문·슬라이드 텍스트는 Firestore와 API 응답으로 복사하지 않고 같은 비공개 버킷의 `extraction.json`에만 둔다. Firestore에는 추출 상태·버전·원본 generation·개수·문자 수·완료 시각·안전한 실패 코드만 저장한다.
- 추출 시작은 owner STAFF만 할 수 있고, metadata 상태와 서버 생성 source 경로·형식·크기를 다시 확인한다. Transaction claim은 `STORED` 또는 재시도 가능한 실패 상태를 한 작업자로만 `EXTRACTING`으로 바꾼다.
- PDF JavaScript·외부 링크·매크로는 실행하지 않으며, PPTX는 OOXML 구조와 ZIP 파일 수·압축 해제 크기·비율을 재검사한다. 임시 원본·결과 파일은 처리 뒤 삭제한다.

## 02-15 Gemini 수업 흐름 초안 이관 기준

- AI 초안은 `organizations/{orgId}/materialCourseDrafts/{draftId}`에 실제 Course와 분리해 저장한다. `GENERATING | GENERATED | FAILED`와 검증된 결과·모델·프롬프트 버전·자료 revision·생성자·서버 시각만 유지하며 원문, 프롬프트, 원시 응답, URL, 토큰은 이전하지 않는다.
- 서버는 owner STAFF의 EXTRACTED 자료만 처리한다. private `extraction.json`을 임시 파일에서 순서 보존·글자 수 상한으로 정규화하고, 원본 PDF/PPTX 바이트·Storage 경로·학생·질문·참가자·사용자 식별자는 Gemini에 전달하지 않는다.
- Vertex AI는 API 키나 서비스 계정 JSON 없이 ADC로만 호출한다. Gemini `gemini-2.5-flash`는 global endpoint를 사용하며, Cloud Run 전환 시 NoDo 전용 런타임 서비스 계정에 필요한 최소 Vertex 호출 권한만 부여한다.
- 같은 자료의 `GENERATING` 또는 `GENERATED` 초안은 Firestore Transaction claim으로 재사용해 중복 모델 호출을 막는다. 실패는 안전한 코드로만 남기며 자동 재시도 없이 강사의 다음 요청에서만 새 초안을 시도한다.

## 02-13 비공개 자료 업로드 결정

- 자료 메타데이터는 `organizations/{orgId}/materialUploads/{uploadId}`에만
  독립 저장하며 원본 파일 본문·공개 URL·이메일·토큰을 포함하지 않는다.
- 객체 경로는 서버가 `organizations/{orgId}/material-uploads/{uploadId}/source.{extension}`로
  생성한다. 원본 파일명은 메타데이터 표시용일 뿐 객체 경로에 사용하지 않는다.
- `UPLOADING → STORED | FAILED` 상태는 Storage 저장 결과를 기준으로 기록한다.
  Emulator와 `NODO_STORAGE_MODE` 미설정 환경은 Cloud Storage를 초기화하지 않는다.
- 실제 NoDo 버킷 생성·비공개 설정·파일 업로드는 별도 명시 승인 전에는 수행하지 않는다.

## 02-12A 방별 강사 권한 이전 원칙

- `roomInstructors`가 LEAD/ASSISTANT와 세 개의 현재 위임 가능 권한을 함께 보관하는 유일한 권한 원천이다. 기존 `leadInstructorUid`, `instructorMemberUids`는 동일 Transaction에서 갱신하는 호환 투영값일 뿐 별도 권한 원천이 아니다.
- 새 ASSISTANT는 질문 운영만 기본으로 받고, 체크리스트·정원 운영은 LEAD가 별도로 위임한다. 전체 권한은 현재 명시된 세 위임 권한만 켜며 향후 권한을 자동으로 포함하지 않는다.
- 역할 변경은 expected revision을 Transaction에서 재검증하며, 역할·권한·호환 투영값과 최소 감사 로그를 원자적으로 바꾼다. `roomCreatorUid`와 실제 기존 방 데이터는 이전·보정하지 않는다.
