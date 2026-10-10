# 현재 결정 사항

## 프로젝트와 기술 기준

- 현재 버전은 NoDo_02, 앱 표시 버전은 `02`다. NoDo_00과 NoDo_01은 수정하지 않는 복귀 기준이다.
- 공식 이름은 NoDo이며 기존 경로의 TodoQ는 이전 이름이다.
- 프론트엔드는 React, TypeScript 6.0.3, Vite, React Router, CSS Modules, Vitest와 ESLint를 사용한다.
- 백엔드는 Python 3.12, FastAPI, Uvicorn, pytest와 Ruff를 사용한다.
- TypeScript ESLint가 공식 지원하는 범위를 유지하며 TypeScript 7 지원 확인 전 임의 업그레이드하지 않는다.
- 기본 `emulator` 모드는 `demo-nodo`와 고정 loopback의 Authentication·Firestore·Storage Emulator만 사용하며 NoDo_01의 기능과 회귀 테스트를 유지한다.
- 명시적 `cloud-auth` 모드는 승인된 기존 Firebase 프로젝트의 Google·Anonymous Authentication을 초기화한다. React는 Firestore를 초기화하지 않고, 실제 Firestore는 FastAPI의 별도 named Admin app만 사용한다. Storage·Analytics·App Check·Cloud Run 배포·Gemini와 Google API는 연결하지 않는다.
- 루트 사용자 명령은 `npm run dev:emulator`, `npm run dev:cloud-auth`로 분리하고 모드 생략 시 `emulator`를 사용한다. cloud-auth 필수 값 누락·불일치는 실제 프로젝트를 추측하지 않고 시작을 중단한다. 브라우저 주소는 Google 승인 도메인과 일치하는 `http://localhost:5175`다.
- 서비스 계정 JSON은 사용하지 않는다. Emulator Admin SDK는 로컬 조건을 통과하지 않으면 초기화를 거부한다. Cloud-auth 백엔드는 ID Token 검증용 named app과 Firestore용 named app을 분리하고, 로컬은 ADC·향후 Cloud Run은 런타임 서비스 계정을 사용한다.
- cloud-auth 로컬 개발에서는 브라우저가 `localhost:5175`의 `/api`만 호출하고 Vite가 고정된 `127.0.0.1:8082` FastAPI로 전달한다. 외부 주소나 다른 포트는 API 클라이언트 경계에서 계속 거부한다.

## 02-1 Google 인증과 bootstrap 결정

### 개발 전용 로그인 진단 및 복구

- 로그인 진단은 `import.meta.env.DEV`, `cloud-auth` 모드, `?authDebug=1` 세 조건이 모두 맞을 때만 표시한다. production build와 일반 로그인 화면에는 진단 UI를 노출하지 않는다.
- 진단 화면에는 Firebase 초기화·로컬 주소·프로젝트 ID 일치·authDomain 존재·팝업/리디렉션 결과·Firebase 사용자 확인·토큰 획득·`/api/auth/me` 요청/HTTP 상태·`ADMIN`/`INSTRUCTOR`와 최종 결과만 표시한다. 이메일, UID, ID Token, OAuth Token, API key, 비밀번호, 쿠키와 Firestore 문서는 표시·저장·로그하지 않는다.
- 팝업 로그인과 리디렉션 로그인은 기존 단조 증가 시도 ID를 공유한다. 진행 중에는 두 번째 시작 동작을 허용하지 않으며, 늦은 팝업 결과는 현재 시도를 덮어쓰지 못한다.
- 리디렉션 로그인은 처음부터 사용자가 선택할 수 있는 대체 경로다. 팝업은 45초 동안만 기다리고, 취소·차단·승인 도메인·토큰·서버 401/403/409은 원문 오류 대신 안전한 복구 문구로 변환한다.

- Google 로그인은 팝업을 먼저 사용하고 팝업 차단 등 사용할 수 없는 경우에만 리디렉션으로 전환한다. 브라우저 로컬 지속성을 사용하되 보호 화면은 FastAPI 승인이 끝난 뒤에만 표시한다.
- 팝업 결과가 45초 안에 끝나지 않으면 해당 시도를 만료 처리하고 사용자에게 재시도와 이미 제공 중인 명시적 리디렉션 대체를 안내한다. 자동 리디렉션으로 사용자 흐름을 바꾸지 않는다.
- 각 Google 로그인 시도는 단조 증가 ID로 구분한다. 만료된 팝업의 늦은 성공·실패는 새 시도, 이미 승인된 STAFF 프로필 또는 로그아웃 상태를 덮어쓰지 않는다.
- redirect 복귀의 Firebase credential은 기존 FastAPI `GET /api/auth/me` 검증에 한 번만 전달하며, `null` 결과는 오류가 아니다. ID Token·OAuth 결과는 상태·로그·화면에 보관하지 않는다.
- `GET /api/auth/me`는 Firebase ID Token의 서명, 만료, 발급자, 대상 프로젝트, UID, 이메일, `google.com` provider와 이메일 인증 여부를 모두 다시 검사한다. 프론트가 보낸 역할·소유자 값은 신뢰하지 않는다.
- 02-1의 조직 소유자 승인은 서버 전용 bootstrap 이메일 허용 목록의 정규화된 정확 일치만 사용한다. 허용 목록은 임시 진입 장치이며 프론트 코드·환경, 문서, 테스트 fixture, 로그와 오류 응답에 넣지 않는다.
- 실제 Firebase 웹 설정도 무시된 로컬 환경 파일에만 둔다. 토큰, 전체 이메일, UID, API 키와 프로젝트 설정값은 애플리케이션 로그나 테스트 snapshot에 기록하지 않는다.
- 로그아웃은 브라우저의 Firebase 지속 세션과 NoDo 화면 접근을 즉시 제거한다. 02-1은 서비스 계정이나 별도 세션 저장소 없이 서명·만료를 검증하므로 이미 외부로 복사된 ID Token을 서버에서 즉시 폐기하지는 않는다. 토큰을 저장·로그·전달하지 않고, 운영 전환 시 강제 로그아웃과 토큰 탈취 대응 정책을 별도로 확정한다.
- Firebase Console을 설정한 계정, NoDo의 조직 소유자와 GCP IAM 주체는 독립된 권한 체계다. 어느 한 권한도 다른 두 권한을 자동으로 부여하지 않는다.
- 02-1 시점에는 cloud-auth에서 Firestore·Storage를 초기화하지 않았다. 02-2 이후 Google 직원의 조직 권한은 FastAPI가 실제 Firestore에서 확인하지만, 인증 성공만으로 권한을 얻지는 않으며 기존 강의 기능은 계속 Emulator 모드에만 남는다.

## 02-7 학생 참여 인증 결정

- 02-7 구현 당시 02-2는 Firestore 데이터베이스 생성 권한 부족으로 중단되어 있었다. 학생 인증은 이 상태와 독립적으로 구현했으며 이후 02-2 실제 조직 Bootstrap이 학생 계약을 소급 변경하지 않는다.
- 실제 Firebase 설정 변경은 기존 프로젝트의 Anonymous Authentication 제공업체 활성화 하나로 제한한다. Google 제공업체는 유지하며 Identity Platform 업그레이드와 익명 계정 자동 삭제 정책은 사용하지 않는다.
- 학생에게는 자동 생성된 한글 `형용사 + 명사` 별명을 제시하고 참여 전에 직접 수정하게 한다. 화면의 주요 동작은 `참여하기` 하나이며 Firebase·Anonymous·회원가입·ID Token·UID 같은 기술 용어를 노출하지 않는다.
- `참여하기` 전에는 익명 사용자를 생성하지 않는다. 별명 검증 뒤 `browserSessionPersistence`, Anonymous 로그인과 FastAPI 학생 세션 검증을 실행한다.
- 별명은 참여 전 React 상태, 성공 후 현재 탭의 `sessionStorage`에만 저장한다. UID·ID Token·OAuth 토큰·이메일·역할은 직접 저장하지 않고 Firebase Auth SDK에 인증 지속을 맡긴다.
- 학생 인증 성공은 `scope: AUTH_ONLY`, `roomAuthorized: false`다. Firestore 강의방 존재·참여 권한·출석을 확인하거나 참여자 문서, 질문, 체크 상태를 만들지 않는다. Firestore와 Storage 초기화·읽기·쓰기는 계속 차단한다.
- 같은 Firebase Auth origin에서 `google.com` 강사 세션과 `anonymous` 학생 세션을 자동 교체하지 않는다. 다른 provider로 전환하려면 강사 로그아웃 또는 학생 참여 종료를 먼저 명시적으로 완료해야 한다.
- Anonymous 사용자는 강사 보호 경로에 접근할 수 없고 기존 `/api/auth/me`도 Anonymous 토큰을 계속 거부한다. 학생 세션 API는 Google·password·custom 등 Anonymous가 아닌 provider를 거부한다.
- 참여 종료는 Firebase `signOut`, `sessionStorage` 별명 제거와 학생 상태 초기화를 함께 수행한다. 재참여 시 같은 UID가 유지된다고 가정하지 않는다.
- 실제 강의방 참여자를 연결하는 후속 기능은 검증된 익명 UID를 별도 서버 Transaction으로 연결해야 한다. 02-2 조직 소유자 문서만으로 별명 영구 저장, 참여자 권한과 질문·체크 기능을 활성화하지 않는다.

## 02-8 강의 자료 로컬 검증 결정

- cloud-auth의 `/create/material`은 기존 `StaffCloudAuthGuard` 안에 두고 Google 강사만 접근시킨다. Emulator의 기존 mock 자료 제작 경로는 변경하지 않는다.
- 지원 형식은 PPTX·PDF·DOCX·PNG·JPG/JPEG이며 한 번에 파일 하나만 React 로컬 상태로 관리한다. 새 후보 검증이 실패하면 기존 정상 파일을 교체하지 않는다.
- 크기 제한은 문서 30MB, 이미지 10MB다. 확장자와 MIME을 먼저 비교하고 시작 8바이트 이하만 읽어 PDF·PNG·JPEG·ZIP 기본 시그니처를 확인한다.
- PPTX와 DOCX는 모두 ZIP 기반이므로 `PK` 시작만 확인한다. ZIP 내부 경로, 압축 폭탄, 실제 Office 구조 검사는 구현하지 않고 02-9 FastAPI 안전 검사 계약으로 남긴다.
- 구형 PPT와 HWP는 변환 안내만 제공하고 코드·데이터는 별도 자료 유형으로 이월한다.
- 파일을 API, Firebase, Storage, Firestore 또는 외부 분석 서비스로 보내지 않는다. 브라우저 저장소, base64, object URL, 전체 파일 읽기, 미리보기와 내용 추출도 사용하지 않는다.
- PDF·OCR·ZIP·Office 분석 패키지를 추가하지 않고 기존 React·TypeScript·lucide-react와 브라우저 기본 API만 사용한다. Gemini·Document AI와 Google API는 연결하지 않는다.
- 02-8 자료 선택은 Firestore를 사용하지 않는 독립 경계다. 이후 02-2의 서버 전용 Firestore 연결과 섞지 않으며 기존 Anonymous 테스트 계정도 변경하지 않는다.

## 02-2 실제 Firestore와 조직 소유자 결정

- 실제 데이터베이스는 승인된 프로젝트의 `(default)`, Standard, Firestore Native, `asia-northeast3`, 삭제 보호 활성화로 고정한다. 설정이 다른 기존 데이터베이스를 자동 삭제·재생성·이동하지 않는다.
- 기존 `firebase.json`, `.firebaserc`, `firestore.rules`는 `demo-nodo` Emulator 전용이다. Production은 `firebase.cloud.json`과 `firestore.cloud.rules`로 분리하고 config·project·`firestore:rules` 범위를 명시한 명령만 사용한다.
- Production Rules는 인증된 본인의 `users/{uid}` 단건 읽기와 STAFF의 동일 조직 `organizations/{orgId}` 단건 읽기만 허용한다. 브라우저의 모든 목록·create·update·delete와 auditLogs·emulatorChecks·미구현 강의 데이터 접근은 거부한다.
- 실제 Firestore용 Firebase Admin app은 기존 ID Token 검증용 named app과 별개다. 프로젝트·`(default)` 데이터베이스·Emulator 환경 부재를 확인한 뒤 ADC로 초기화하며 서비스 계정 JSON과 OAuth Client Secret을 사용하지 않는다.
- React는 Firestore를 직접 구독하거나 쓰지 않는다. `GET /api/auth/me`는 검증된 토큰으로 실제 사용자·조직을 조회만 하고, 조건을 만족하는 미등록 후보에게만 `ORGANIZATION_BOOTSTRAP_REQUIRED`를 반환한다.
- `POST /api/auth/bootstrap-organization`은 조직 ID·이름·역할을 요청에서 받지 않는다. Google provider, 이메일 인증, 프로젝트, Bootstrap 활성화, 서버 후보 이메일과 고정 조직 설정을 다시 검증한다.
- `organizations/demo`, `users/{uid}`, `organizations/demo/auditLogs/bootstrap-owner-created` 세 문서를 하나의 Firestore Transaction으로 만든다. 조직 문서와 감사 로그에 이메일·토큰을 저장하지 않고 사용자 이메일은 정규화한다.
- 같은 UID의 재호출은 기존 성공을 반환하고 감사 로그를 중복 생성하지 않는다. 다른 UID와 동시 요청은 기존 `ownerUid`를 덮어쓰지 못하며 Transaction 실패 시 일부 문서만 남지 않아야 한다. 모순된 운영 문서는 자동 삭제하지 않고 중단한다.
- 세 문서와 영구 로그인을 확인한 뒤 `NODO_BOOTSTRAP_ENABLED=false`로 바꾸고 이메일 목록을 비운다. 이후 최고 권한은 이메일이 아니라 조직 `ownerUid`와 사용자 문서의 UID 일치로 판정하고 `bootstrapOwner: false`를 반환한다.
- Cloud Run 배포 시에는 JSON 키 대신 런타임 서비스 계정과 최소 Firestore IAM을 사용할 예정이다.
- 02-3 회사 직원 가입과 02-4 관리자 권한 확장에 Bootstrap endpoint를 일반 승격 API로 재사용하지 않는다. 조직 권한과 방별 `leadInstructorId`·`staff/{uid}`를 분리하고 Transaction·대상 수락·감사·최소 소유자 1명 불변식을 별도 설계한다.

## 02-3 직원 초대와 조직 가입 결정

- 02-3 초대 권한은 Firestore의 `isOrgOwner: true`와 조직 `ownerUid`가 일치하는 소유자에게만 있다. 일반 STAFF와 아직 구현하지 않은 조직 관리자는 초대·취소할 수 없다.
- 초대는 이메일 발송이 아니라 NoDo 서버의 가입 허용 목록이다. Gmail·Outlook·Firebase 이메일 링크와 메일 발송 API를 연결하지 않는다.
- 직원 이메일은 trim·소문자 정규화, 254자, 제어 문자·줄바꿈 금지와 정확한 `@nodo-company.test` 도메인을 적용한다. 소유자 본인, 기존 가입 직원, Gmail과 다른 도메인은 거부한다.
- 허용 도메인과 PENDING 만료 시간은 서버 전용 `NODO_STAFF_EMAIL_DOMAINS`, `NODO_STAFF_INVITATION_TTL_HOURS`로 관리하며 브라우저 입력으로 바꾸지 않는다.
- 초대 ID는 `SHA-256("demo" + NUL + emailNormalized)` 결정값이며 URL이나 권한 증명으로 사용하지 않는다. PENDING·ACCEPTED·REVOKED 상태와 revision·만료·수락·취소 서버 시각을 같은 문서에 보존한다.
- 유효한 PENDING 재등록은 멱등 조회다. REVOKED·만료 초대 재발급은 같은 문서에서 revision을 증가시키고 새 만료 시각을 기록한다. PENDING만 REVOKED로 취소하며 문서를 삭제하지 않는다.
- 초대 생성·재발급·취소는 최신 조직 소유자와 초대 상태를 다시 읽는 Firestore Transaction이다. 감사 event ID는 동작·초대 ID·revision에서 결정해 같은 재시도 로그를 중복 생성하지 않는다.
- `GET /api/auth/me`는 영구 사용자 문서가 없는 Google 사용자에게만 PENDING 초대를 확인한다. 수락이 필요하면 `409 ORGANIZATION_INVITATION_ACCEPTANCE_REQUIRED`와 조직 표시명·만료 시각만 반환하고 Firebase 세션을 유지한다.
- `POST /api/auth/accept-organization-invitation`은 요청 본문을 권위 값으로 사용하지 않는다. 조직·초대·사용자 부재를 검증하고 일반 STAFF 생성, 초대 ACCEPTED와 감사를 한 Transaction으로 기록한다.
- 초대 가입 STAFF는 `isOrgAdmin: false`, `isOrgOwner: false`, `isAnonymous: false`다. 가입 뒤 UID 기반 사용자 문서로 재로그인하며 구성원 관리 화면은 사용할 수 없다.
- `staffInvitations`, 조직 `auditLogs`, `users` 목록과 모든 브라우저 쓰기는 기존 Production Rules의 기본 거부로 차단된다. 구성원 화면도 FastAPI만 사용하므로 02-3에서 Rules/config를 변경·재배포하지 않는다.
- 02-4 관리자 지정·해제는 같은 조직 일반 STAFF를 대상으로 하는 별도 소유자 Transaction과 감사 로그로 설계한다. 직원 초대·수락만으로 관리자·주 강사·보조 강사 권한을 만들지 않는다.

## 데이터와 보안 경계

- 계정 유형·조직·조직 관리자 여부는 토큰의 임의 입력이 아니라 서버 관리 `users/{uid}`에서 확인한다. 방별 주·보조 강사 관계는 사용자 문서가 아니라 room과 staff 문서에서 확인한다.
- 중요 쓰기는 ID Token을 첨부한 FastAPI 요청으로만 수행한다. Firestore Rules는 업무 데이터의 모든 클라이언트 쓰기를 거부한다.
- 브라우저가 직접 읽는 실시간 문서는 최소 공개 필드만 갖는다. 서버 인증·속도 제한·감사 문서는 별도 서버 전용 경로로 분리한다.
- 참여 코드는 `roomJoinCodes`, 작성자 연결은 `questionAuthors`, 질문 속도 상태는 `questionRateLimits`, 질문·종료 감사는 `moderationLogs`에 둔다.
- 참여자 관리 API는 무작위 불투명 `participantId`만 사용한다. Authentication UID, 이메일과 실명을 목록에 노출하지 않는다.
- 감사 로그에는 상태 전후와 실행자·대상 식별자만 저장하고 질문·답변 본문을 복제하지 않는다.

## 계정·강의방 담당 관계·권한

- 사용자 계정은 `STAFF | STUDENT`로만 구분하고 회사 관리자는 `isOrgAdmin: true`인 직원이다. `LEAD_INSTRUCTOR`·`ASSISTANT_INSTRUCTOR`를 전역 역할로 저장하거나 권한 판정에 사용하지 않는다.
- 같은 조직의 `STAFF`가 강의와 방을 만들면 서버가 생성자를 `leadInstructorId`로 저장한다. 주 강사는 현재 방의 이 값과 본인 UID가 일치할 때만 성립하고, 담당 방에서 12개 위임 기능을 모두 가진다.
- 보조 강사는 현재 방의 `staff/{uid}`가 존재할 때 성립하며 그 문서의 최신 `permissions`만 사용한다. 같은 직원의 방별 관계는 서로 독립적이다.
- 강의방 보조 강사 초대 요청은 `userId`만 허용하고 서버가 `canAnswerQuestions`만 활성화한 기본 권한을 저장한다. 이 방별 초대는 02-3 조직 직원 이메일 초대와 다른 기능이다.
- 01-3에서 10개 권한을 실제 기능에 연결한다. `canAnnotate`, `canExportResults`만 저장 전용이다.
- 초대된 보조 강사는 공개·미숨김 질문을 읽을 수 있다. `canModerateQuestions`가 있어야 `STAFF_ONLY`와 숨김 질문을 읽고 처리한다.
- 각 강사의 질문 읽음 상태는 `questionReads/{staffUid}/contexts`에 분리한다. 다른 강사의 읽음 값은 읽거나 덮어쓸 수 없다.
- 회사 관리자는 같은 조직 종료 요약을 읽을 수 있지만 진행 중 강의를 자동 조작하지 않는다.

## 01-3A 질문 번호와 채널 결정

- 챕터와 항목을 각각 `(order, id)`로 안정 정렬한 화면 순서에서 1부터 번호를 계산해 `1.1`, `1.2`로 표시한다.
- 체크리스트 질문 생성 시 클라이언트는 `itemId`만 보내고 서버가 현재 권위 순서로 `itemNumberSnapshot`을 저장한다. 항목 순서 변경은 과거 질문 번호를 소급 변경하지 않는다.
- 일반 질문방은 별도 room 문서가 아니라 같은 방의 `isGeneral: true`, 읽음 `contextId: GENERAL`인 논리 채널이다. API 요청의 `itemId`는 `null`이고 저장 질문에서는 항목 관련 필드를 생략한다.
- 질문 목록은 `(createdAt, questionId)`로 고정 정렬하며 답변은 질문 스레드 안에 바로 렌더링한다. 답변 생성·수정·취소가 질문 순서를 바꾸지 않는다.

## 01-3 질문 저장 결정

- 로그인한 실제 강의방의 질문·답변은 Firestore Emulator 실제 데이터다. 비로그인 NoDo_00 회귀 화면의 `DemoCourseProvider` mock과 섞지 않는다.
- 공개 질문은 `questions/{questionId}`, 작성 UID와 `clientRequestId`는 `questionAuthors/{questionId}`에 분리한다. 공개 질문과 API 응답에는 UID·이메일이 없다.
- 프론트엔드는 질문 전송마다 UUID `clientRequestId`를 만들고 네트워크 재시도에는 같은 값을 재사용한다. 서버는 room·작성 UID·요청 ID로 결정적 질문 ID를 만들어 영구 멱등성을 보장한다.
- 질문, 작성자 연결과 속도 제한 기록은 하나의 트랜잭션이다. 프로세스 전역 Lock을 사용하지 않고 `ABORTED`만 새 트랜잭션으로 최대 3회 외부 재시도한다.
- 질문은 Unicode NFKC로 정규화하고 제어 문자를 제거한 1~500자 일반 텍스트다. HTML을 신뢰하거나 렌더링용 마크업으로 저장하지 않는다.
- 10초에 3개, 30초 내 동일·유사 질문을 제한한다. 유사도는 해시된 3-gram Jaccard 0.8 기준이다.
- 확정 금칙어는 작성 자체를 `422 question_rejected`로 막는다. 검토어는 `NEEDS_REVIEW/STAFF_ONLY`로 저장하며 검토 권한 강사가 승인하기 전 학생에게 공개하지 않는다.
- 검토 규칙은 소규모 로컬 고정 목록이며 AI 분류가 아니다. 실제 운영 정책과 이의 제기·신고 절차는 별도 승인이 필요하다.
- 공개·검토 분류와 관계없이 질문 작성 성공 응답은 `{ id, roomId, accepted: true }` 영수증만 반환한다. 내용·문맥 스냅샷·공개 범위·검토 상태는 API 응답에 넣지 않고 권한에 맞는 Firestore 구독으로만 전달한다.

## 답변·검토·읽음 결정

- `canAnswerQuestions`는 답변 작성·수정·취소를 허용한다. 답변 공개 데이터에는 담당자 표시명과 답변 당시 방 관계 `roomRole: LEAD | ASSISTANT`만 저장하고 UID·이메일이나 전역 역할은 넣지 않는다.
- `canModerateQuestions`는 승인·숨김·복구를 허용한다. 각 변경은 질문 상태와 서버 전용 감사 로그를 한 트랜잭션에서 기록한다.
- 미확인 수는 브라우저가 임의의 현재 시각을 보내 줄이는 방식이 아니다. 읽음 API는 실제 화면에서 관찰한 질문의 서버 시각과 ID를 watermark로 제출하고, 서버가 해당 문서와 접근 범위를 검증한 값만 저장한다.
- `ALL`, `GENERAL`, 항목별 문맥은 각기 watermark를 가져 한 화면의 읽음 처리가 다른 문맥이나 다른 강사의 배지를 임의로 지우지 않는다.

## 참여자 관리 결정

- 참여 문서는 Rules 인증을 위해 내부 `userId`를 유지하지만 FastAPI 직렬화에서 항상 제거한다.
- 참여자 목록과 제한 변경은 `participantId`로만 수행한다. `canManageParticipants`가 필요하고 제한 변경은 `ACTIVE`에서만 가능하다.
- 질문 제한은 새 질문 작성만 막으며 기존 공개 질문·답변은 정책에 따른 읽기를 유지한다.

## 종료와 요약 결정

- 종료는 `ACTIVE → ENDING → ENDED` 2단계다. `ENDING`이 먼저 새 질문·답변·검토·체크·참여자 변경을 차단해 요약 계산 중 데이터가 바뀌지 않게 한다.
- 종료 확인 화면의 미답변 질문 수와 미완료 항목 수는 프론트 계산이 아니라 `GET /api/rooms/{roomId}/end-preview` 서버 집계를 사용한다.
- 최초 종료 실행자의 UID와 표시명을 `ACTIVE → ENDING` 전환에서 원자적으로 보존한다. 재시도나 다른 강사의 후속 요청도 최초 실행자를 summary와 감사 로그에 일관되게 사용한다.
- `summary/current`는 참여자, 질문 상태, 항목별 질문과 체크 완료 집계를 가진다. `ENDED` 이후 기존 요약을 반환하며 재계산·수정하지 않는다.
- 내보내기는 구현하지 않고 `exportStatus: NOT_CONFIGURED`를 명시한다. `canExportResults`가 있어도 실제 Sheets API를 호출하지 않는다.

## Rules 결정

- Emulator `firestore.rules`와 Production `firestore.cloud.rules`는 서로 다른 허용 범위다. Emulator 진단 예외를 Production에 복사하지 않고, 실제 배포에는 `firebase.cloud.json`과 명시적 프로젝트·`firestore:rules` 범위를 사용한다.
- 02-2 Production Rules의 모든 브라우저 쓰기와 목록은 거부한다. 조직·사용자·감사 생성은 ADC로 인증한 FastAPI Admin SDK만 수행하며 React는 실제 Firestore 클라이언트를 만들지 않는다.
- 참여 수강생은 `PUBLIC && !isHidden` 질문만 읽는다.
- 일반 초대 보조 강사는 공개·미숨김 질문, 검토 권한 보조 강사와 주 강사는 정책상 전체 질문을 읽는다.
- `questionAuthors`, `questionRateLimits`, `moderationLogs`, `roomJoinCodes`는 모든 클라이언트 읽기·쓰기를 거부한다.
- `questionReads`는 해당 강사 본인만 읽고 쓰기는 FastAPI만 한다. `summary/current`는 주 강사, `canViewReports` 보조 강사와 같은 조직 회사 관리자만 읽는다.
- 현재 쿼리는 동등 조건과 클라이언트 정렬로 충분해 복합 인덱스를 추가하지 않았다. 쿼리 변경 시 운영 인덱스를 재검토한다.
- 열린 강의 목록은 본인 `userId`와 서버 프로필의 `orgId`를 함께 제한한 staff collection-group equality 구독으로 초대·회수를 감지한다. Rules는 두 조건이 맞는 본인 staff 문서만 이 쿼리로 읽도록 허용한다.

## 01-2A에서 유지한 동시성 결정

- 강의방 생성은 room, 참여 코드와 `course.activeRoomId`를 원자적으로 기록한다.
- 재시도 대상은 Firestore/gRPC `ABORTED` 예외 체인으로 제한하고 50/100/200ms 백오프와 제한된 jitter를 사용한다.
- 커밋 응답 유실 가능성은 권위 문서를 재조회해 현재 요청의 완전한 연결이면 성공을 복원하고, 다른 요청 선점은 `409`, 재시도 소진은 `503`으로 처리한다.
- 프론트 single-flight는 중복 클릭을 줄이는 보조 장치이며 서버 원자성을 대신하지 않는다.

## UI와 회귀 화면

- v2 PDF 디자인 우선순위와 NoDo_00의 시작·불러오기·제작 mock 회귀 화면은 유지한다.
- 로그인한 `/rooms/:roomId/checklist`, `/rooms/:roomId/chat`은 실제 Emulator 상태를 사용한다. 질문 필터, 답변, 검토, 참여자 제한과 종료도 서버 기능이다.
- Firebase 인증은 여러 계정·방 관계를 별도 탭에서 검증할 수 있도록 `browserSessionPersistence`를 사용한다. 세션 복원 중에는 mock 화면으로 분기하지 않고, 익명 사용자도 `/api/me`를 다시 조회해 프로필을 복원한다.
- Emulator 직원 로그인은 이메일·비밀번호만 입력하며 테스트 계정이나 역할 선택을 사용자 화면에 표시하지 않는다. Cloud-auth는 Google 로그인만 제공하고 FastAPI의 bootstrap 승인을 통과하기 전 보호 화면을 표시하지 않는다.
- 560px 이하의 질문 필터·질문/답변·별명 입력은 16px 이상으로 표시해 모바일 브라우저의 포커스 자동 확대와 가로 넘침을 방지한다.
- 패널 확대는 `isPanelExpanded` 단일 UI 상태로 관리하며 실제 Fullscreen API가 아니다.
- 파일 선택은 메타데이터만 다루고 파일 내용 업로드·분석은 하지 않는다. AI 생성 표시는 준비된 mock 항목이며 Gemini를 호출하지 않는다.

## 02-4A 조직 역할 결정

- 회사 직원 역할은 `ADMIN`과 `INSTRUCTOR` 두 가지뿐이며 ADMIN은 INSTRUCTOR 기능을 포함한다.
- `organizationRole`만 새 권한 판단에 사용하고, 최소 ADMIN 한 명을 Transaction의 `adminCount`로 보호한다.
- 주 강사·참여 강사는 회사 역할이 아니라 향후 강의방 안의 임시 역할이다. 모든 강사는 수업 운영 권한이 같고, 주 강사만 사람 관리·공유·종료 권한을 가진다.
- 실제 Firestore 전환은 사용자의 명시적 승인 전까지 금지한다.

## 02-5 재사용 가능한 수업 흐름 결정

- cloud-auth 수업 흐름은 `organizations/{orgId}/courses/{courseId}`에만 저장하며 React는 FastAPI를 거쳐서만 접근한다. 브라우저의 Firestore 직접 구독·쓰기와 Storage 사용은 허용하지 않는다.
- 새 문서는 `schemaVersion: 1`, `status: ACTIVE`, `revision: 1`, 작성자 UID와 표시명 스냅샷, 서버 시각 및 정규화한 챕터·항목 배열을 가진다. 제목은 필수이고 빈 흐름은 허용한다.
- ADMIN과 INSTRUCTOR는 같은 강의 흐름 권한을 가진다. 누구나 ACTIVE 흐름을 읽고 복사할 수 있지만, 수정과 보관 삭제는 `createdByUid`가 본인 UID와 일치할 때만 허용한다.
- 변경과 보관 삭제는 `expectedRevision`을 Transaction에서 확인하고 충돌이면 409를 반환한다. 보관 삭제는 문서를 지우지 않고 `ARCHIVED`, `archivedAt`, `archivedByUid`를 기록한다.
- 생성·수정·복사·보관 삭제는 최소 필드만 포함한 `COURSE_CREATED`, `COURSE_UPDATED`, `COURSE_DUPLICATED`, `COURSE_ARCHIVED` 감사 이벤트를 남기며 이메일·토큰·본문은 복제하지 않는다.
- 실제 Firestore에 테스트 수업 흐름을 만들거나 보관하는 검증은 정확한 테스트 제목과 보관 방식에 관한 명시 승인 전에는 실행하지 않는다.
- 02-5A에서 브라우저 편집·응답 모델의 `position`과 FastAPI 입력을 분리한다. 생성·수정 body는 ID·제목·설명·배열 순서와 수정 시 최상위 `expectedRevision`만 보내며, 챕터·항목 `position` 및 조직·작성자·권한·감사 필드는 보내지 않는다. `extra="forbid"`를 유지하고 서버가 배열 순서로 position을 다시 계산한다. 실제 Firestore 저장·불러오기·`ARCHIVED` 검증은 02-5B에서 재개한다.

## 02-6A 강의방 스냅샷·권한 결정

- 재사용 가능한 course와 특정 회차 room은 별도 문서다. room 생성은 ACTIVE course의 현재 revision·제목과 챕터/항목 배열만 서버에서 읽고, `flowItems` 스냅샷의 chapter/item position을 배열 순서로 다시 계산한다. 브라우저 position이나 서버 전용 ID·역할·상태·시각을 신뢰하지 않는다.
- room 생성 요청은 `sourceCourseId`, `title`만 `extra="forbid"`로 허용한다. 생성 Transaction은 STAFF 조직 역할, 같은 조직 ACTIVE source, item 수 200 이하, room code 인덱스 미존재를 함께 확인하고 room·code·flowItems·`ROOM_CREATED` 감사 로그를 원자적으로 만든다.
- `roomCreatorUid`는 최초 생성자 기록이고 `leadInstructorUid`는 현재 주 강사 관계다. 02-6A에서는 둘을 동일한 인증 사용자로 고정하고 해당 사용자를 `instructorMemberUids`에 넣는다. 역할 이전·초대·세부 위임은 만들지 않는다.
- ADMIN은 같은 조직 room을 운영 조회하고 INSTRUCTOR는 `instructorMemberUids`에 포함된 방만 조회한다. Anonymous 학생과 다른 조직은 생성·목록·상세·공유 API를 사용할 수 없다.
- roomCode는 `secrets` 기반 8자리 대문자·숫자이며 `I`, `O`, `0`, `1`을 쓰지 않는다. API는 `roomCode`와 `/join/{orgId}/{roomCode}`만 반환하고, UI는 현재 origin을 붙여 복사한다. QR·학생 실제 입장과 Anonymous 참여 연결은 다음 기능이다.
- 실제 Firestore에는 02-6A에서 room, roomCodes, flowItems, 감사 로그를 만들지 않는다. 실제 검증은 02-6B에서 별도 승인·로그인·권한 확인 뒤 진행한다.

## NoDo 전용 자원 경계·운영 권한 결정

- NoDo의 Firestore 경계는 공유 프로젝트 안의 `(default)` Database ID와 그 안의 `organizations/{orgId}` 경로다. 다른 Firestore DB·컬렉션·Storage·서버 자원은 NoDo 코드와 배포 설정에서 참조하지 않는다.
- cloud-auth는 `NODO_FIRESTORE_DATABASE_ID=(default)`를 FastAPI 설정·Firestore Client에 명시하고, 다른 값이면 Firestore 초기화 전에 fail-closed 한다. React cloud-auth는 계속 Firestore를 직접 읽거나 쓰지 않는다.
- 실제 배포 준비에는 `firebase.nodo.json`만 사용하고 Rules·Indexes와 `(default)`를 함께 명시한다. Emulator용 `firebase.json` 및 기존 cloud 설정을 실제 배포 기본값으로 사용하지 않는다.
- NoDo ADMIN/INSTRUCTOR는 앱 업무 역할이며 GCP IAM 권한이 아니다. 배포 운영 계정과 미래 Cloud Run 서비스 계정은 별도 주체로 두고, Cloud Run에는 프로젝트 Editor가 아니라 NoDo 문서·버킷 최소 권한만 준다.
- Firebase Auth 제공업체·승인 도메인, 프로젝트·결제, Rules·Indexes 실제 배포, Storage/IAM/Cloud Run 변경은 공유 또는 파괴적 작업으로 분류해 명시 승인 전에는 실행하지 않는다.

## 02-9A 강의방 질문 결정

- cloud-auth 질문은 React → FastAPI → Firestore 경로만 사용한다. 기존 Emulator live-course 질문 코드와 컬렉션은 재사용 가능한 규칙만 참고하며, `getLocalFirebaseFirestore`, `onSnapshot`, `demo-nodo`, 최상위 legacy room 경로를 cloud-auth 화면에 연결하지 않는다.
- 공개 질문 문서는 일반/항목 구분과 질문 시점 chapter/item 번호·제목 스냅샷을 가진다. 작성자 내부 식별·멱등 키·도배 판정은 같은 questionId의 비공개 작성자 문서로 분리하며 React 응답에는 포함하지 않는다.
- 명확한 금칙어는 차단하고, 검토 필요 표현은 `STAFF_ONLY`로 저장한다. 숨김은 추가 가시성 필터이며 학생은 PUBLIC·미숨김 질문과 공식 답변만 볼 수 있다. 이 판단은 작고 문서화된 규칙 기반이며 Gemini·외부 AI가 아니다.
- 주 강사만 공식 답변 하나를 작성·취소하고 질문을 숨김·복구한다. ADMIN은 읽기 전용이며, 읽음 위치는 서버가 유효 문맥의 최신 질문을 계산해 개인별 비공개 문서에 기록한다.
- 질문·답변 성공 뒤 즉시 FastAPI 목록을 다시 읽고, 화면이 보일 때만 짧은 polling을 수행한다. SSE 또는 읽기 전용 구독으로 교체할 수 있도록 조회 모델과 쓰기 명령을 분리한다.
- 02-9A는 local Emulator·자동 테스트만 수행한다. 실제 Firestore 질문·답변·읽음·감사 로그와 Firebase/GCP 설정 변경은 02-9B의 명시 승인 전까지 금지한다.

## 02-7A 익명 수강생 입장 결정

- React는 공개 방 메타데이터, 참가 생성·재입장, 학생 세션 조회를 모두 FastAPI로 요청하고 Firestore 클라이언트를 직접 사용하지 않는다.
- Anonymous ID Token만 참가 API에서 허용한다. Google STAFF 토큰은 백엔드에서 거부하며, 강사 브라우저는 로그아웃이나 계정 변경을 유도하지 않고 별도 브라우저 또는 기기를 안내한다.
- 공개 응답은 제목·방 상태·입장 가능 여부와 학생 자신의 별명·입장 상태로 한정한다. 조직 내부 ID, 강사, 원본 수업, flowItems, UID, 이메일, 감사 기록은 반환하지 않는다.
- 별명은 2~16자의 한글·영문·숫자·공백 일반 텍스트다. 02-7A에는 욕설 필터를 넣지 않고, 동일 방의 `nicknameNormalized` 중복만 서버 트랜잭션에서 막는다.

## 02-8A 강의방 진행 결정

- cloud-auth React는 체크리스트에서도 Firestore SDK·`onSnapshot`을 사용하지 않고 FastAPI만 호출한다. Emulator의 기존 live-course 표시 코드·데이터와 실제 조직 강의방을 연결하지 않는다.
- room status는 `READY`, `LIVE`, `ENDED`로 제한한다. 주 강사만 `READY → LIVE`를 변경하며 ADMIN은 같은 조직 방의 운영 읽기만 가능하다.
- flow item에는 `isCompleted`만 저장한다. 현재 진행 항목은 chapterPosition/itemPosition 순서의 첫 미완료 항목으로 계산하고, `currentItemId`는 API 응답에서만 제공한다.
- 변경 요청 body는 `expectedRevision`만 허용한다. Transaction이 방·flowItems·주 강사·현재 항목·revision을 함께 읽어 미래 항목 완료와 충돌을 거부하고, 되돌리면 선택 항목 이후를 초기화한다.
- LIVE 화면은 보이는 탭에서만 2.5초 revision polling을 사용한다. 같은 revision은 React 상태를 바꾸지 않고, 요청 중복·unmount timer·네트워크 실패는 마지막 정상 화면을 보존한다. 이후 SSE 또는 서버 구독으로 교체할 수 있다.
- 02-8A는 local Emulator·자동 테스트만 수행한다. 실제 Firestore의 status, flowItems, 감사 로그 및 Firebase/GCP 설정은 02-8B의 별도 승인 전까지 변경하지 않는다.

## 02-10A v2 통합 강의 화면 결정

- `checklist.pdf`, `chat.pdf`, `Start.pdf`는 React/CSS 레이아웃의 기준이며 PDF 이미지를 서비스 화면에 삽입하지 않는다. 강사·학생 모두 상단 채팅/체크리스트 탭과 넓은 카드 작업 영역을 쓴다.
- 학생 체크리스트는 별도 FastAPI 읽기 모델이다. 학생 자신의 Anonymous 참가 문서를 먼저 검증한 뒤 자기 방의 PUBLIC 질문 수와 flowItems만 조합하며, 이 조회는 읽음 위치·감사 로그·강의 진행을 변경하지 않는다.
- 항목 질문 수 배지는 `ITEM:{flowItemId}` 채팅 문맥으로 연결한다. 학생에게는 전체 수만, 강사에게는 전체/새 수를 보여 준다.
- 자료 없는 방은 체크리스트 또는 채팅 패널이 전체 작업 영역을 사용한다. `isPanelExpanded` 하나로 확대/복원 문구만 전환하며 가짜 슬라이드·별도 전체 화면·자료 숨김 상태를 만들지 않는다.
- polling은 화면이 보일 때만 2.5초 간격으로 FastAPI를 호출한다. onSnapshot은 cloud-auth 통합 화면에서 사용하지 않으며, in-flight 중복·unmount 요청은 정리한다. 실제 v2 UI 검증은 02-10B로 분리한다.

## 02-11A presence·capacity 결정

- 누적 익명 참가자와 현재 접속 인원은 서로 다른 모델이다. 참여자는 `ACTIVE`, `LEFT`, `EXPIRED` presence와 90초 서버 lease를 가지며, 현재 인원은 ACTIVE면서 lease가 남은 익명 수강생만 포함한다.
- 정원 확인·만료·ACTIVE 전환·카운터 변경은 하나의 Firestore Transaction에서 수행한다. 일반 heartbeat는 participant `lastSeenAt`/lease만 갱신하고 room revision·감사 로그를 만들지 않지만, 다른 참가자의 lease 만료를 실제 전환하면 capacity·`PARTICIPANT_EXPIRED` 감사도 같은 Transaction에서 기록한다.
- 정원 초과는 private capacity 문서의 PENDING/cooldown 상태로만 강사에게 알린다. lead instructor와 `instructorMemberUids`의 보조 강사만 현재 정원 유지 또는 상향할 수 있고, 하향·큐·참여자 식별 표시를 제공하지 않는다.
- 학생 화면은 React → FastAPI → Firestore 경로만 사용한다. 화면이 보일 때만 약 30초 jitter heartbeat를 보내고, 나가기는 ACTIVE→LEFT를 한 번만 처리한다.

## 02-11D 정원 운영 감사 결정

- 정원 운영 감사는 상태 전환 명령에서만 생성한다. 새 PENDING 초과 알림, 정원 유지·상향, ACTIVE→LEFT, LEFT/EXPIRED→ACTIVE, ACTIVE→EXPIRED가 대상이며, 일반 heartbeat와 정원 GET은 대상이 아니다. 단 heartbeat가 다른 참가자를 실제 만료 처리하면 `PARTICIPANT_EXPIRED`를 기록한다.
- 감사 문서 ID에는 요청마다 생성한 불투명 operation ID를 사용한다. 이 ID는 한 Firestore Transaction의 재시도에서 유지되므로 재시도가 같은 이벤트를 중복 기록하지 않는다.
- 정원 GET은 현재 유효 lease를 계산한 응답만 만들고, participant 만료·capacity 문서 생성·카운터/alert 갱신·감사 기록을 하지 않는다. 운영 감사에는 최소 상태/정원과 허용된 staff 내부 식별자만 남기며 익명 참가자 식별자·이메일·토큰은 남기지 않는다.

## 02-11F 정원 감사 원자성 결정

- 정원 초과 PENDING alert와 private capacity 상태, `CAPACITY_ALERT_RAISED` 감사 문서는 같은 Firestore Transaction callback 안에서 함께 기록한다. 감사 문서 생성이 실패하면 Transaction 전체가 실패하므로 alert·카운터 상태도 성공으로 남지 않는다.
- 같은 원칙은 `CAPACITY_KEPT`, `CAPACITY_INCREASED`, `PARTICIPANT_LEFT`, `PARTICIPANT_REJOINED`, `PARTICIPANT_EXPIRED`에도 적용한다. operation ID는 callback 재시도에도 안정적이어서 동일 감사 이벤트가 중복되지 않는다.
- 정원 GET은 계속 완전 읽기 전용이다. 실제 02-11E-2 방의 PENDING 상태는 중간 검증 기록으로 보존하며, 코드가 뒤늦게 감사 기록을 보정하지 않는다.

## 02-11H lease 만료 카운터 결정

- `activeParticipantCount`는 유효 lease를 가진 `ACTIVE` 참가자 수와 동일해야 한다. heartbeat가 다른 참가자를 `ACTIVE → EXPIRED`로 바꾸는 경우 participant 상태·`PARTICIPANT_EXPIRED` 감사 문서·capacity 카운터를 같은 Transaction에서 기록한다.
- 일반 heartbeat와 GET 정원 조회는 카운터를 보정하지 않는다. GET은 어떠한 presence/capacity/audit 문서도 쓰지 않으며, 실제 02-11G-2의 stale count는 중간 검증 기록으로 보존하고 소급 보정하지 않는다.

## 02-13 자료 파일 경계

- React는 Firebase Storage SDK를 사용하지 않고 FastAPI의 업로드 API만 호출한다.
- PPTX/PDF는 브라우저의 간단한 형식 확인 뒤에도 FastAPI가 파일명·크기·시그니처와
  PPTX OOXML ZIP 구조를 다시 검증한다. MIME은 힌트일 뿐 권한 판단 근거가 아니다.
- private Storage와 metadata write는 cloud-auth의 고정 NoDo 프로젝트·버킷 설정에서만
  허용한다. 실제 저장소 실패 시 메타데이터는 `FAILED`로 남기되 공급자 오류나 비밀값은
  저장하지 않는다.
- 실제 파일·버킷·IAM·Firebase/GCP 변경은 코드 단계와 분리된 명시 승인 작업이다.

## 02-12A 방별 강사 위임 결정

- 조직 ADMIN/INSTRUCTOR와 방별 LEAD/ASSISTANT를 분리한다. 조직 ADMIN은 배정되지 않은 방의 운영 명령을 얻지 않으며, `roomInstructors` 한 배열을 방 역할·권한의 단일 진실 원천으로 사용한다.
- ASSISTANT는 질문 운영만 기본으로 받고 체크리스트·정원 운영은 명시적인 세 boolean 권한으로 위임한다. 전체 권한은 이 고정된 현재 권한 목록만 활성화하며 미래 기능을 자동 위임하지 않는다.
- 강사 추가·제거·권한 변경·주 강사 넘기기는 LEAD 전용 revisioned Transaction이다. 넘기기는 대상 ASSISTANT를 LEAD로, 기존 LEAD를 전체 권한 ASSISTANT로 한 번에 바꾸며 `roomCreatorUid`는 그대로 둔다.
- 질문·체크리스트·정원 API는 각각 방별 권한을 서버에서 다시 확인한다. cloud-auth React는 Firestore를 직접 읽거나 쓰지 않는다.

## 02-14 비공개 자료 추출 결정

- `STORED` 자료의 추출은 FastAPI → NoDo 전용 비공개 Storage 경로만 사용한다. 원본은 서버 생성 경로·업로드 owner·조직·형식·크기를 다시 확인한 뒤 임시 디스크에서만 처리하며, 브라우저는 object path·원문·공개 URL을 받지 않는다.
- PDF 페이지와 PPTX 슬라이드의 텍스트 구조는 같은 비공개 버킷의 `extraction.json`으로 저장한다. Firestore 메타데이터는 `EXTRACTING`, `EXTRACTED`, `EXTRACTION_FAILED`와 버전·개수·문자 수·원본 generation·안전한 오류 코드로 제한한다.
- Firestore Transaction claim은 동시 요청과 재시도에서 한 추출만 시작하게 한다. 완료 자료 재요청은 저장소를 다시 읽거나 결과를 다시 쓰지 않는다. 실패한 원본은 삭제하지 않고 안전한 코드로 재시도만 안내한다.
- 추출은 텍스트·순서만 다루며 Gemini, OCR, PDF/PPTX 이미지 렌더링, 발표자 노트, 외부 링크, 매크로, 학생 공개, AI 체크리스트 생성을 포함하지 않는다.

## 02-15 비공개 Gemini 초안 결정

- Gemini 초안은 EXTRACTED 자료를 만든 owner STAFF만 요청하며, `organizations/{orgId}/materialCourseDrafts/{draftId}`의 독립된 `GENERATING | GENERATED | FAILED` 문서로만 보관한다. Course, 강의방, flowItems, 질문, 참가자 데이터는 이 작업이 자동으로 만들거나 변경하지 않는다.
- FastAPI는 private `extraction.json`을 임시 파일에서 페이지·슬라이드 순서와 글자 수 상한으로 정규화한다. 자료 제목·형식·번호·제한된 추출 제목/본문만 Gemini에 전달하고 원본 바이트, Storage 경로·URL, ID Token, 사용자·학생·질문·참가자 정보와 감사 로그는 전달하지 않는다.
- Vertex AI는 API 키나 브라우저 SDK가 아닌 ADC 전용 server adapter로 사용한다. `gemini-2.5-flash`는 global endpoint로 고정하고, 향후 Cloud Run에는 별도 NoDo 서비스 계정의 최소 Vertex 호출 권한만 부여한다.
- Gemini 응답은 strict Pydantic JSON으로 챕터 1~8, 챕터별 항목 1~10, 전체 40, 빈 문자열 금지와 자료 범위 참조 번호를 검증한다. 원문·프롬프트·원시 모델 응답·비밀값은 Firestore와 API 응답에 저장하지 않는다.
- 같은 자료의 active 초안은 Firestore Transaction claim으로 한 번만 시작한다. 실패는 안전한 코드로만 `FAILED`로 기록하고, 자동 재시도 없이 강사의 명시 요청에서만 새 초안을 만든다. 실제 Vertex API 활성화·호출은 별도 승인을 받아야 한다.
