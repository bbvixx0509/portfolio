# NoDo 02

NoDo_02의 02-1은 강사·관리자용 실제 Google 회원가입·로그인 경계를, 02-7은 학생 참여 화면과 실제 Firebase Anonymous Authentication을 연결했습니다. 02-8은 Google 강사 보호 경로에서 강의 자료 한 개를 선택하고 브라우저에서 기본 형식만 검사합니다. 02-2는 실제 Firestore에 최초 조직 소유자를 원자적으로 등록하고 이후 권한을 영구 UID로 판정하는 서버 경계를 추가했습니다. 02-3은 조직 소유자가 회사 직원을 이메일로 초대 목록에 등록하고, 해당 Google 사용자가 직접 가입을 수락해 일반 STAFF가 되는 흐름을 추가합니다. NoDo_01의 화면, Emulator 데이터, 권한·질문·체크·종료 기능과 테스트는 보존합니다.

02-5는 cloud-auth 강사가 재사용 가능한 수업 흐름을 저장·목록 조회·열기·복사·보관 삭제하는 독립 기능입니다. 브라우저는 FastAPI API만 호출하고 실제 Firestore에는 직접 접근하지 않습니다. `organizations/{orgId}/courses/{courseId}` 문서는 작성자 UID, 표시명 스냅샷, revision, 상태와 챕터·항목 순서를 포함하며 삭제는 문서를 지우지 않고 `ARCHIVED` 상태로 바꿉니다. 실제 프로젝트에서 첫 테스트 문서를 쓰는 작업은 별도 사용자 승인 전까지 수행하지 않습니다.

02-5A에서 화면·응답용 챕터·항목 `position`과 FastAPI 입력 계약을 분리했습니다. React는 편집 순서를 위해 `position`을 유지하지만 생성·수정 요청에는 보내지 않으며, 서버가 받은 배열 순서만으로 `position`을 0부터 다시 계산합니다. 입력 스키마의 `extra="forbid"`는 유지하고, 실제 Firestore 저장·불러오기·`ARCHIVED` 검증은 02-5B에서 별도로 재개합니다.

02-6A는 활성 수업 흐름에서 실제 수업 회차인 강의방을 준비합니다. `organizations/{orgId}/rooms/{roomId}`에는 원본 수업 ID·revision·제목, 생성자·최초 주 강사, 서버 생성 8자리 방 코드와 READY 상태를 기록하고, `flowItems` 하위 컬렉션에는 원본 순서를 서버가 계산한 스냅샷을 둡니다. React는 FastAPI만 호출하며 생성 요청에는 `sourceCourseId`와 `title`만 보냅니다. 공유 링크는 현재 웹 origin과 `/join/{orgId}/{roomCode}` 경로로 표시·복사합니다. 학생 실제 입장, QR, 참여 강사 초대와 실제 Firestore 검증은 02-6B 이후 별도 범위입니다.

공유 Firebase/GCP 프로젝트에서는 NoDo의 `(default)` Firestore 데이터베이스와 `organizations/{orgId}` 경로만 서비스 범위로 사용합니다. 배포 준비용 `firebase.nodo.json`은 Database ID `(default)`, `firestore.nodo.rules`, `firestore.nodo.indexes.json`을 함께 고정합니다. 실제 Rules·Indexes 배포, Storage·IAM·Cloud Run 변경은 별도 승인 전에는 실행하지 않습니다. 역할과 운영 경계는 [자원 경계](RESOURCE_BOUNDARIES.md), [운영 권한](RESOURCE_OPERATIONS.md)을 참고하세요.

두 실행 모드는 의도적으로 분리합니다. 기본 `emulator` 모드는 NoDo_01의 Authentication·Firestore·Storage Emulator 기능을 그대로 사용합니다. 명시적으로 선택하는 `cloud-auth` 모드는 기존 Firebase 프로젝트의 Google·Anonymous Authentication을 사용하고, 실제 Firestore는 FastAPI의 서버 전용 어댑터만 접근합니다. React는 Firestore를 초기화·구독·쓰기하지 않으며 Storage도 연결하지 않습니다. Identity Platform 업그레이드, 익명 계정 자동 삭제 정책, Analytics, App Check, Cloud Run 배포, Gemini, Google Drive·Slides·Sheets API는 이번 범위에 포함하지 않습니다.

## 02-13 비공개 자료 업로드

`/create/material`은 PPTX 또는 PDF 한 개(최대 30MB)를 먼저 브라우저에서
사전 검사한 뒤 `React → FastAPI → NoDo 전용 비공개 Storage` 경로로만
전송합니다. 파일 본문은 base64·Firestore·브라우저 Storage에 저장하지
않으며, 서버가 생성한 `organizations/{orgId}/material-uploads/{uploadId}/source.{extension}`
객체 경로와 최소 메타데이터만 사용합니다. PDF 시그니처와 PPTX OOXML/ZIP
구조를 서버에서 다시 검사하고, Emulator에서는 실제 Cloud Storage를 절대
초기화하지 않습니다. AI 분석·자료 미리보기·수업 흐름 생성은 이 단계에
포함되지 않습니다.

cloud-auth의 실제 업로드는 명시적으로 `NODO_STORAGE_MODE=cloud`, 고정된
NoDo 버킷 이름 및 같은 GCP 프로젝트를 모두 설정한 경우에만 열립니다.
버킷 생성·공개 차단·IAM 설정·실제 파일 업로드는 별도 사용자 승인 단계에서만
수행합니다.

## 02-15 Gemini 수업 흐름 초안

추출이 완료된 자료의 owner STAFF는 `/create/material`에서만 AI 수업 흐름
초안을 요청할 수 있습니다. 경로는 `React → FastAPI → Vertex AI Gemini →
FastAPI → Firestore`이며, 브라우저는 Firestore·Storage·Vertex AI에 직접
접근하지 않습니다. 서버는 비공개 `extraction.json`의 제한된 정규화 텍스트만
`gemini-2.5-flash`의 global Vertex endpoint에 보내고, 원본 파일·Storage
경로·공개 URL·토큰·학생/질문/참가자 정보를 보내거나 응답에 포함하지 않습니다.

결과는 `organizations/{orgId}/materialCourseDrafts/{draftId}`의 `GENERATING`,
`GENERATED`, `FAILED` 초안으로만 저장됩니다. Course·강의방·체크리스트는
자동 생성하지 않으며, 02-16에서 강사가 편집 후 명시적으로 저장합니다. 실제
Vertex API 활성화와 Gemini 호출은 별도 사용자 승인 전까지 비활성화합니다.

## 요구 환경

- Node.js 22 이상
- npm 10 이상
- Python 3.12.13
- Java JDK 11 이상

Java는 로컬 Firestore와 Storage Emulator 프로세스를 실행하는 데 필요합니다. 실제 Firebase 프로젝트는 `cloud-auth` 모드의 강사 Google 인증·학생 Anonymous 인증과 FastAPI의 제한된 조직 Bootstrap에 사용하며, 기본 Emulator 개발에는 필요하지 않습니다.

## 실행 모드

NoDo_02 루트에서 목적에 맞는 명령 하나를 선택합니다. 모드 값을 생략하면 안전한 기본값인 `emulator`로 실행합니다. Cloud-auth 필수 환경 변수가 하나라도 누락되거나 대상 프로젝트가 다르면 실제 Firebase로 추측 연결하지 않고 시작을 중단합니다.

| 모드 | 실행 명령 | 프론트 주소 | 데이터 경계 |
|---|---|---|---|
| Emulator(기본) | `npm run dev:emulator` | `http://127.0.0.1:5174` | 로컬 Auth·Firestore·Storage Emulator |
| 실제 Authentication·조직 Bootstrap | `npm run dev:cloud-auth` | `http://localhost:5175` | 브라우저는 Auth·FastAPI만 사용, Firestore는 서버 전용, Storage 차단 |

`cloud-auth`에서는 Google 인증의 승인된 도메인과 일치하도록 반드시 `localhost` 주소를 사용합니다. `127.0.0.1`로 바꾸거나 두 모드의 환경 파일을 섞지 않습니다. Emulator 백엔드는 `http://127.0.0.1:8080`, cloud-auth 백엔드는 `http://127.0.0.1:8082`를 사용합니다. cloud-auth 프론트의 `/api` 요청은 개발 서버가 이 고정 백엔드로 전달하므로 브라우저에는 `http://localhost:5175` 단일 출처만 노출합니다.

cloud-auth의 공식 로컬 실행 명령은 `npm run dev:cloud-auth:local`입니다. 이 명령은 NoDo_02의 `backend\.venv`와 `.env.cloud-auth.local`만 사용해 8082 FastAPI와 5175 Vite를 시작하며, 이미 사용 중인 포트는 종료하거나 재사용하지 않고 중단합니다.

### Google 로그인 진단과 복구

문제가 있을 때만 cloud-auth 개발 주소 뒤에 `?authDebug=1`을 붙이면 안전한 진단 패널을 볼 수 있습니다. 예: `http://localhost:5175/login?authDebug=1`. 이 패널은 Firebase 초기화, 로컬 주소, 프로젝트·authDomain 설정, 팝업·리디렉션 결과, Firebase 사용자, 토큰, `/api/auth/me`, 조직 역할과 최종 결과만 표시합니다. 이메일·UID·ID Token·OAuth Token·API key·비밀번호·쿠키·Firestore 문서는 표시하거나 저장하지 않습니다.

기본 `Google로 시작하기`는 팝업을 최대 45초 기다립니다. 창이 열리지 않거나 끝나지 않으면 같은 화면에서 `다시 시도`하거나 처음부터 제공되는 `리디렉션으로 로그인`을 선택할 수 있습니다. 진단 UI는 개발 cloud-auth에서만 작동하며 일반 화면과 production build에는 포함되지 않습니다.

실제 Firebase 웹 설정과 bootstrap 이메일은 Git에 포함하지 않는 로컬 전용 환경 파일에만 둡니다. 예시 파일에는 변수 이름과 설명만 기록하며 실제 이메일, UID, API 키 또는 프로젝트 설정값을 넣지 않습니다.

## Firebase Emulator 실행

루트 `package.json`은 Firebase 로컬 개발 도구 전용이며, 프론트엔드용 `web/package.json`과 별개입니다. Firebase CLI는 `15.23.0`, Web SDK는 `12.16.0`, Rules 테스트 도구는 `5.0.1`, SVG QR 컴포넌트는 `react-qr-code` `2.2.0`으로 정확히 고정했습니다. 프로젝트 루트와 `web`에서 각각 잠금 파일대로 설치합니다.

```powershell
npm ci
cd web
npm ci
cd ..
```

Authentication, Firestore와 Storage Emulator 및 Emulator UI를 시작합니다.

```powershell
npm run emulators:start
```

상세 로그가 필요할 때는 다음 명령을 사용합니다.

```powershell
npm run emulators:start:debug
```

Emulator UI는 `http://127.0.0.1:4000`에서 확인합니다. 실행 중인 터미널에서 `Ctrl+C`를 누르면 Emulator가 정상 종료됩니다.

Emulator를 시작한 뒤 백엔드 고정 로컬 계정과 데모 강의를 반복 생성할 수 있습니다. 같은 명령을 다시 실행해도 계정이나 필수 문서가 중복되지 않습니다.

```powershell
cd backend
.venv\Scripts\python -m app.scripts.seed_emulator
```

위 Emulator 명령은 모두 로컬 전용 프로젝트 ID `demo-nodo`를 명시합니다. React 초기화 코드는 개발 모드, `demo-nodo`, Emulator 활성화와 아래 고정 루프백 주소를 모두 확인한 뒤에만 실행됩니다. 조건이 다르면 실제 클라우드 요청 전에 오류를 발생시킵니다. 실제 Firestore 확인·Rules 배포는 아래 02-2 절의 별도 설정과 명시적 프로젝트 옵션을 사용하며 Emulator 명령과 섞지 않습니다.

| 구성 요소 | 로컬 주소 |
|---|---|
| Emulator UI | `127.0.0.1:4000` |
| Authentication | `127.0.0.1:9099` |
| Firestore | `127.0.0.1:8081` |
| Storage | `127.0.0.1:9199` |

## 프론트엔드 실행

루트의 `npm run dev:emulator`와 `npm run dev:cloud-auth`는 **프론트엔드 실행 명령**입니다. 백엔드는 아래 모드별 명령으로 별도 실행합니다. 프론트엔드만 직접 실행해야 할 때도 모드별 스크립트를 사용하고, 환경 변수를 손으로 섞어 실행하지 않습니다. NoDo_00과 NoDo_01이 사용 중인 서버는 종료하지 않습니다.

## 02-1 실제 Google 로그인

`cloud-auth` 로그인은 다음 경계를 따릅니다.

1. Firebase Authentication의 Google 팝업을 먼저 사용하고, 팝업을 사용할 수 없을 때 리디렉션 방식으로 전환합니다.
2. 브라우저가 받은 Firebase ID Token을 `Authorization: Bearer <token>`으로 `GET /api/auth/me`에 전달합니다.
3. FastAPI는 토큰 서명·만료·발급자·대상 프로젝트·UID·이메일·Google provider·이메일 인증 여부를 모두 확인합니다.
4. 02-1에서는 서버 전용 bootstrap 이메일 허용 목록과 정확히 일치하는 계정만 승인합니다.
5. 승인 전에는 보호 화면을 표시하지 않으며 로그아웃하면 Firebase 세션과 NoDo 인증 상태를 함께 정리합니다.

팝업 취소, 팝업 차단, 네트워크 오류, Google이 아닌 provider, 미인증 이메일, 잘못된 프로젝트 토큰과 bootstrap 불일치는 서로 구분 가능한 안전한 오류로 처리합니다. 오류 메시지나 로그에 ID Token, 전체 이메일, UID 또는 Firebase 설정값을 기록하지 않습니다.

`cloud-auth` 모드에서 Google 또는 Anonymous 인증 성공만으로 조직·강의 권한을 얻지는 않습니다. Google 직원은 FastAPI가 실제 Firestore의 사용자·조직 문서를 확인해야 보호 경로를 사용할 수 있습니다. NoDo_01의 강의·질문·체크리스트 데이터는 계속 Emulator 전용이며 실제 Firestore로 이전하지 않습니다.

### 팝업 시간 초과와 리디렉션 대체

Google 팝업 로그인은 45초 안에 성공·취소·오류 중 하나로 끝나지 않으면 대기를 중단합니다. 이때 화면은 다시 사용할 수 있고, `다시 시도` 또는 사용자가 명시적으로 누르는 `리디렉션으로 로그인`을 제공합니다. 자동 리디렉션은 하지 않습니다.

리디렉션 복귀 결과는 Firebase 사용자를 받은 뒤 기존 `GET /api/auth/me` 검증으로 한 번만 연결합니다. 늦게 돌아온 이전 팝업 결과는 더 새로운 로그인 시도, 로그인 완료 상태 또는 로그아웃 상태를 덮어쓰지 않으며 ID Token·OAuth 정보는 화면과 로그에 표시하지 않습니다.

## 02-2 실제 Firestore 조직 Bootstrap

02-2의 실제 데이터베이스는 승인된 Firebase 프로젝트의 `(default)` 데이터베이스이며 Standard 에디션, Firestore Native 모드, `asia-northeast3`, 삭제 보호 활성화를 기준으로 합니다. 위치·모드·에디션이 다른 기존 데이터베이스를 자동 삭제하거나 다시 만들지 않습니다.

브라우저와 서버의 Firestore 책임은 분리합니다.

- 기존 `firebase.json`, `.firebaserc`, `firestore.rules`는 `demo-nodo` Emulator 전용으로 유지합니다. 이 Rules에는 개발 진단용 `emulatorChecks` 예외가 있으므로 실제 프로젝트에 배포하지 않습니다.
- 실제 환경은 `firebase.cloud.json`과 `firestore.cloud.rules`를 사용합니다. Production Rules는 본인 `users/{uid}` 단건 읽기와 STAFF 사용자의 동일 조직 `organizations/{orgId}` 단건 읽기만 허용하고, 모든 브라우저 쓰기·목록·감사 로그·진단·미구현 데이터 접근을 거부합니다.
- Rules를 배포할 때는 대상과 범위를 모두 명시합니다. 다음 명령 외의 암묵적 기본 프로젝트나 기존 `firebase.json`을 사용하지 않습니다.

```powershell
firebase deploy --config firebase.nodo.json --project example-gcp-project --only firestore:rules,firestore:indexes
```

FastAPI는 기존 ID Token 검증용 named Firebase Admin app을 유지하고, 실제 Firestore용 named app을 별도로 초기화합니다. 로컬은 Application Default Credentials를 사용하고, 배포 시에는 Cloud Run 서비스 계정의 최소 권한을 사용할 예정입니다. 서비스 계정 JSON, OAuth Client Secret과 코드에 입력한 인증 정보는 사용하지 않습니다. `cloud-auth`에서 프로젝트가 다르거나 데이터베이스 ID가 `(default)`가 아니거나 `FIRESTORE_EMULATOR_HOST`가 감지되면 서버를 즉시 중단합니다.

`GET /api/auth/me`는 조회만 수행합니다. 조직이 없고 일회성 조건을 만족할 때만 `ORGANIZATION_BOOTSTRAP_REQUIRED`를 반환하며, 프론트는 이 경우에만 `POST /api/auth/bootstrap-organization`을 호출합니다. 조직 ID·이름·역할은 서버 설정에서 읽고 요청 본문 값은 권위 값으로 사용하지 않습니다.

Bootstrap은 다음 세 문서를 한 Firestore Transaction에서 생성합니다.

- `organizations/demo`: 조직 ID·이름, `ownerUid`, `bootstrapState: COMPLETED`, schema와 서버 시각. 소유자 이메일은 저장하지 않습니다.
- `users/{uid}`: `accountType: STAFF`, 조직 관리자·소유자 상태, 정규화된 본인 프로필과 schema·서버 시각. ID Token과 OAuth Access Token은 저장하지 않습니다.
- `organizations/demo/auditLogs/bootstrap-owner-created`: 실행자·대상 UID와 최소 역할 전후 상태·서버 시각. 이메일과 토큰은 저장하지 않습니다.

같은 UID의 재호출은 기존 성공 결과를 반환하고 감사 로그를 중복 생성하지 않습니다. 다른 UID는 기존 소유자를 덮어쓰지 못하며, 동시 요청도 Transaction 충돌 판정으로 한 명만 소유자가 됩니다. 일부 문서만 생성된 상태를 성공으로 보정하거나 잘못된 운영 문서를 자동 삭제하지 않습니다.

세 문서와 재로그인 판정을 확인한 뒤 `NODO_BOOTSTRAP_ENABLED=false`로 바꾸고 Bootstrap 이메일 목록을 비웁니다. 이후 `GET /api/auth/me`는 이메일이 아니라 조직의 `ownerUid`와 `users/{uid}`를 기준으로 권한을 판정하며 `bootstrapOwner: false`를 반환합니다. 이메일은 최초 후보를 한 번 제한하는 장치일 뿐 영구 권한 키가 아닙니다.

다음 세 주체는 같은 개념이 아닙니다.

- **Firebase 설정 계정**: Firebase Console과 데이터베이스 설정을 관리하는 계정
- **NoDo 조직 소유자**: Firestore의 `ownerUid`로 판정하는 애플리케이션 사용자
- **GCP IAM 주체**: Google Cloud 리소스 역할을 가진 사용자 또는 서비스 계정

02-3 회사 직원 가입과 02-4 관리자 권한 확장에서도 `ownerUid`, 사용자 조직 관계, 방별 `leadInstructorId`·`staff/{uid}`를 서로 대체하지 않습니다. 모든 중요 쓰기는 FastAPI Transaction과 서버 전용 감사 로그를 사용하고 React의 직접 Firestore 쓰기는 계속 금지합니다.

## 02-3 회사 직원 초대와 조직 가입

02-3의 초대 메일은 브라우저가 아니라 FastAPI의 서버 전용 Resend adapter가 발송합니다. React는 `/api/cloud/organization/invitations`만 호출하고 Resend API key를 받거나 알 수 없습니다. 이메일 provider가 `disabled`이거나 key·발신 주소가 없으면 서버는 계속 시작되지만 초대 생성·재발송은 `503`과 안전한 안내로 fail-closed 됩니다.

전역 계정 유형은 계속 `STAFF | STUDENT` 두 개뿐입니다. 초대를 수락한 사용자는 `accountType: STAFF`, `organizationRole: INSTRUCTOR`, `membershipStatus: ACTIVE`, `isAnonymous: false`, `orgId: demo`로 생성되거나 복구됩니다. 조직 `ADMIN`만 초대 생성·재발송·취소와 구성원 관리를 할 수 있습니다. 주 강사·보조 강사는 전역 계정 역할이 아니라 방의 `roomInstructors`로 판정합니다.

관리자는 `/organization/members`에서 가입 구성원과 초대 상태 `PENDING | ACCEPTED | DECLINED | EXPIRED | REVOKED`를 FastAPI로 조회합니다. 이메일은 앞뒤 공백을 제거하고 소문자로 정규화한 최대 254자이며, 제어 문자·줄바꿈을 거부합니다. 허용 도메인은 서버 설정 `NODO_STAFF_EMAIL_DOMAINS=nodo-company.test`의 정확한 `@nodo-company.test`만 사용합니다. 본인, 이미 가입한 이메일, 개인 Gmail과 다른 회사 도메인은 거부합니다. 초대는 생성 후 7일 동안 유효합니다.

초대 문서는 `organizations/demo/staffInvitations/{invitationId}`에 저장합니다. 원문 토큰은 생성 직후 수락·거절 이메일 링크에만 사용하고 Firestore, API 응답, 감사 로그에는 저장하지 않습니다. Firestore에는 scoped SHA-256 `tokenHash`, 정규화 이메일, 기본 역할, 상태, revision, 만료·생성·변경·수락·거절·취소 시각과 내부 실행자 식별자만 저장합니다.

- 유효한 PENDING 이메일을 다시 생성하지 않으며 관리 화면의 명시적 **재발송**을 사용합니다.
- 재발송은 token hash와 만료 시각을 교체하고 revision을 증가시킵니다.
- 취소는 문서를 삭제하지 않고 PENDING을 REVOKED로 바꿉니다.
- 생성·재발송·취소·수락·거절은 관리자/이메일/최신 상태를 Firestore Transaction에서 다시 검증합니다.

수신자는 이메일의 `/organization/invitations/{rawToken}/accept` 또는 `/decline` 화면에서 Firebase Google 로그인 후 명시적으로 처리합니다. 서버는 검증된 Google 이메일이 `invitedEmail`과 정확히 일치하고, token hash가 일치하며, PENDING·만료 전인 경우에만 처리합니다. 수락은 STAFF 멤버십을 ACTIVE/INSTRUCTOR로 만들고, 거절은 멤버십을 만들지 않습니다. 기존 `/api/auth/accept-organization-invitation`은 token hash가 없는 구형 초대의 읽기 호환용이며 신규 token 초대를 처리할 수 없습니다.

감사 이벤트는 `ORGANIZATION_INVITATION_CREATED`, `ORGANIZATION_INVITATION_RESENT`, `ORGANIZATION_INVITATION_REVOKED`, `ORGANIZATION_INVITATION_ACCEPTED`, `ORGANIZATION_INVITATION_DECLINED`입니다. event ID는 초대 ID·revision·동작으로 결정해 Transaction 재시도에도 중복되지 않으며, 감사 로그에는 이메일·원문 토큰·token hash·비밀번호·쿠키를 저장하지 않습니다.

가입 뒤 `GET /api/auth/me`는 Firestore의 활성 STAFF 멤버십을 기준으로 승인합니다. 로그아웃·재로그인 후에도 이메일 목록이 아니라 사용자 UID와 조직 멤버십으로 판정합니다. 일반 INSTRUCTOR는 STAFF 보호 경로를 사용할 수 있지만 `/organization/members`에는 접근할 수 없습니다.

Production Rules는 이미 `staffInvitations`, `auditLogs`, `users` 목록과 모든 브라우저 쓰기를 기본 거부합니다. 조직 소유자 화면도 이 컬렉션을 직접 읽지 않고 FastAPI API만 사용하므로 02-3에서는 `firestore.cloud.rules`와 `firebase.cloud.json`을 변경하거나 재배포하지 않습니다. 02-4에서 조직 관리자 지정·해제를 추가하더라도 초대받은 직원을 자동 관리자로 승격하지 않고 별도 소유자 승인 Transaction과 감사 로그를 설계해야 합니다.

## 02-7 학생 참여 인증

02-7은 당시 Firestore 조직 Bootstrap과 분리해 학생 인증만 먼저 구현한 독립 기능입니다. 이후 02-2가 실제 Firestore를 연결해도 학생의 `AUTH_ONLY`, `roomAuthorized: false` 계약과 기존 Anonymous 테스트 사용자는 변경하지 않습니다.

학생은 `/join/:roomCode`에서 자동 생성된 `형용사 + 명사` 형식의 한글 별명을 확인하고 직접 수정한 뒤 `참여하기` 버튼 하나로 진행합니다. 화면에는 Firebase, Anonymous, 익명 인증, 회원가입, 계정 생성, ID Token이나 UID 같은 구현 용어를 표시하지 않습니다. 별명은 2~16자의 일반 문자열로 검사하고 앞뒤 공백, 제어 문자, 줄바꿈, 기본 금칙어와 강사·관리자 사칭 표현을 서버와 브라우저에서 함께 검증합니다.

`참여하기`를 누르기 전에는 사용자를 만들지 않습니다. 유효한 별명일 때 Firebase Auth에 `browserSessionPersistence`를 설정하고 내부적으로 Anonymous 로그인을 수행한 뒤 `POST /api/auth/student-session`에서 토큰과 별명·참여 코드 형식을 다시 검증합니다. 성공 응답은 인증 범위를 `AUTH_ONLY`로 제한하고 `roomAuthorized`를 항상 `false`로 반환합니다. 이는 학생 인증만 확인한 결과이며 실제 강의방 존재, 참가 권한, 출석이나 질문 기능을 뜻하지 않습니다.

별명은 참여 전 React 상태, 성공 후 현재 탭의 `sessionStorage`에만 둡니다. UID, ID Token, OAuth 토큰, 이메일과 역할은 직접 저장하지 않고 Firebase Auth SDK의 세션에 맡깁니다. 참여 종료는 Firebase `signOut`과 별명·학생 상태 삭제를 함께 수행합니다. Firestore에는 별명·학생·참여자 문서를 쓰지 않으며 Storage도 초기화하지 않습니다.

같은 origin의 Firebase Auth 세션은 한 사용자만 유지하므로 Google 강사 세션을 Anonymous 학생 세션으로, Anonymous 학생 세션을 Google 강사 세션으로 자동 교체하지 않습니다. 전환하려면 현재 강사 로그아웃 또는 학생 참여 종료를 먼저 명시적으로 완료해야 합니다. Anonymous 사용자는 강사 보호 경로에 접근할 수 없습니다.

Identity Platform은 업그레이드하지 않고 익명 계정 자동 삭제 정책도 사용하지 않습니다. 실제 강의방 참여자를 연결하는 후속 기능에서는 검증된 익명 UID와 방 참여 문서를 별도 Transaction·Rules로 설계하되, 02-7의 `roomAuthorized: false`와 학생 Firestore 무쓰기 경계를 먼저 제거하지 않습니다.

## 02-8 통합 강의 자료 선택과 로컬 검증

cloud-auth의 `/create/material`은 `StaffCloudAuthGuard`를 통과한 Google 강사만 사용합니다. 한 번에 파일 하나만 선택하거나 드롭할 수 있으며, 파일 객체는 현재 React 화면 메모리에만 둡니다. 페이지를 새로고침하면 선택 상태가 사라지는 것이 정상입니다.

- 지원 형식은 PPTX·PDF·DOCX·PNG·JPG/JPEG다.
- PPTX·PDF·DOCX는 각 30MB, PNG·JPG/JPEG는 각 10MB까지 허용한다. 0바이트와 255자를 넘는 파일명은 거부한다.
- 확장자와 MIME을 비교하고 파일 시작 부분만 `File.slice()`로 읽어 PDF `%PDF-`, PNG, JPEG, Office ZIP `PK` 시그니처를 확인한다.
- PPTX와 DOCX는 ZIP 시작 시그니처까지만 확인한다. ZIP 내부 구조와 실제 Office 문서 구성 검사는 02-9 FastAPI 안전 검사 전까지 구현하지 않는다.
- 구형 PPT는 PPTX 또는 PDF 변환, HWP는 PDF 변환을 안내한다. 코드·데이터 파일은 별도 자료 유형으로 이월한다.
- 새 파일 검증이 실패하면 이미 검증된 정상 파일을 유지한다. 파일 제거는 브라우저 선택 상태만 해제한다.
- 파일을 FastAPI, Firebase, Cloud Storage나 외부 서비스로 전송하지 않는다. `sessionStorage`, `localStorage`, IndexedDB에도 저장하지 않는다.
- 파일 전체 읽기, base64, object URL, 미리보기, 텍스트 추출, OCR, PDF.js, ZIP 분석 라이브러리를 사용하지 않는다.
- 02-8 파일 선택 경로 자체는 Gemini·Document AI·Drive·Slides·Sheets API, Firestore와 Storage를 사용하지 않는다. 02-2의 서버 전용 Firestore 연결과 분리하며 기존 익명 테스트 계정도 그대로 유지한다.

## 개발용 Emulator 진단

개발 모드에서만 `http://127.0.0.1:5174/dev/emulator`에 접근할 수 있습니다. 사용자 메뉴에는 이 경로를 추가하지 않았습니다. 페이지 진입 시 다음 순서로 진단합니다.

1. Firebase 앱과 Auth·Firestore·Storage Emulator 연결 설정
2. Authentication Emulator 익명 인증
3. `emulatorChecks/{uid}` 본인 문서 작성과 다시 읽기
4. 값 확인 후 진단 문서 삭제와 익명 세션 로그아웃

진단 화면은 프로젝트 ID, 로컬 전용 연결과 실제 클라우드 차단 상태를 함께 표시합니다. React Strict Mode나 모듈 재실행에서도 named app과 전역 서비스 레지스트리를 재사용해 Emulator 연결 함수를 중복 호출하지 않습니다.

Emulator용 `firestore.rules`는 진단 컬렉션 예외와 기존 강의 기능에 필요한 읽기를 허용합니다. Production용 `firestore.cloud.rules`는 조직 Bootstrap 범위만 허용하는 별도 기본 거부 정책입니다. 두 파일의 허용 범위를 합치거나 Emulator Rules를 실제 프로젝트에 배포하지 않습니다.

## 개발자용 로컬 테스트 계정

모든 계정은 예약된 `.test` 주소와 공통 로컬 비밀번호 `NoDo01!LocalOnly`를 사용합니다. 이 표는 Emulator 개발·검증용이며 로그인 화면에는 노출하지 않습니다. 직원 로그인 화면에는 이메일, 비밀번호, 로그인 버튼과 수강생 참여 링크만 표시합니다.

| 계정·방 관계 | 이메일 | UID | 초기 상태 |
|---|---|---|---|
| 조직 관리자 직원 | `admin@nodo.test` | `org-admin` | `accountType: STAFF`, `isOrgAdmin: true` |
| 데모 방 생성 직원 | `lead@nodo.test` | `lead-instructor` | `demo-room.leadInstructorId`와 일치하여 이 방의 주 강사 |
| 같은 조직 미초대 직원 | `assistant.none@nodo.test` | `assistant-none` | 직원이지만 데모 방 담당 관계 없음 |
| 데모 방 초대 직원 | `assistant.limited@nodo.test` | `assistant-limited` | 데모 방 `staff` 문서와 추가 진행 권한 보유 |
| 다른 조직 직원 | `outsider@nodo.test` | `outsider-instructor` | `org-other`, 데모 강의 접근 차단 |

수강생은 `/join/NODO01`에서 Authentication Emulator 익명 인증으로 입장하고 랜덤 별명을 수정할 수 있습니다.

## 01-3A 계정과 강의방 담당 관계

- 사용자 문서는 `accountType: STAFF | STUDENT`, `isOrgAdmin`, `orgId`, 표시명과 이메일을 저장합니다. `LEAD_INSTRUCTOR`, `ASSISTANT_INSTRUCTOR`를 전역 계정 역할로 저장하거나 권한 판정에 사용하지 않습니다.
- 같은 조직의 모든 `STAFF`는 강의를 만들 수 있고 생성자의 UID가 course와 room의 `leadInstructorId`가 됩니다. 회사 관리자도 직접 만든 방에서는 주 강사입니다.
- 주 강사는 같은 조직의 다른 `STAFF`를 보조 강사로 초대합니다. 초대 요청은 `userId`만 받고 서버가 12개 권한 중 `canAnswerQuestions`만 `true`인 기본값을 저장합니다. 추가 권한은 초대 후 별도로 저장합니다.
- 초대된 직원의 `staff/{uid}` 문서를 실시간으로 관찰해 열린 강의 목록과 권한 화면에 초대·회수 결과를 반영합니다. 같은 직원은 방마다 주 강사, 보조 강사 또는 담당자 아님이 될 수 있습니다.
- 이 절의 이메일·비밀번호 직원 로그인과 익명 수강생 로그인은 `emulator` 모드에서 그대로 유지합니다. `cloud-auth` 모드는 02-1 Google 직원 인증과 02-7 Anonymous 학생 인증만 검증하며 이 Emulator 계정·강의 데이터와 섞지 않습니다.

## 01-3A 실제 데이터 화면

로그인 세션에서는 다음 경로가 FastAPI와 Firestore Emulator 실제 데이터를 사용합니다.

인증은 탭별 세션으로 유지합니다. 익명 수강생이 새로고침하면 Authentication Emulator 세션과 `/api/me` 프로필을 복원한 뒤 실제 강의 화면을 표시하며, 복원 중 비로그인 mock 화면으로 전환하지 않습니다. 모바일 질문·답변·별명 입력은 16px 이상으로 유지해 입력 포커스 자동 확대와 가로 넘침을 막습니다.

| 화면 | 경로 | 데이터·권한 |
|---|---|---|
| 로그인 | `/login` | 역할 선택 없는 직원 이메일·비밀번호 로그인 |
| 실제 강의 목록 | `/`, `/courses/import` | 조직 관리자 범위 또는 방별 담당 관계에 따른 `GET /api/courses` 결과 |
| 실제 새 강의 | `/create/material`, `/create/manual` | 같은 조직의 직원이 생성하고 해당 방의 주 강사가 됨 |
| 수업 흐름 제작·수정 | `/courses/:courseId/prepare` | 실시간 읽기, 권한별 서버 쓰기 |
| 실시간 체크리스트 | `/rooms/:roomId/checklist` | room·chapter·item·staff 구독, 서버 체크 |
| 실시간 질문·채팅 | `/rooms/:roomId/chat` | Firestore 질문 구독 + FastAPI 질문·답변·검토 쓰기 |
| 보조 강사 권한 | `/rooms/:roomId/staff` | 해당 주 강사만 추가·저장·회수 |
| 익명 참여 | `/join/:roomCode` | 활성 강의방 참여와 별명 |
| 종료 리포트 | `/rooms/:roomId/report` | 종료 후 서버 고정 요약, 조회 권한 검사 |

강의방 기본 seed는 `demo-room`, 참여 코드는 `NODO01`입니다. 일반 room 문서에는 코드가 없으며, 주 강사 또는 `canShareRoom` 권한 사용자가 `/share` API를 호출할 때만 코드·링크를 받습니다.

주 강사는 현재 방의 `leadInstructorId`와 본인 UID가 일치할 때 담당 강의의 12개 위임 가능 기능을 항상 사용할 수 있습니다. 보조 강사는 현재 방의 `rooms/{roomId}/staff/{uid}`에서 부여된 값만 사용하며, 열린 화면이 본인 문서를 구독하므로 권한 회수가 즉시 버튼·편집·체크 상태에 반영됩니다. 회사 관리자 여부는 `isOrgAdmin`으로 별도 판정하며 방별 주·보조 강사 관계를 대신하지 않습니다. 수강생은 참여한 활성 방의 공개 체크리스트를 읽을 수 있지만 체크·편집할 수 없습니다.

12개 위임 권한 중 `canEditCourse`, `canEditCourseFlow`, `canManageMaterials`, `canShareRoom`, `canControlProgress`, `canAnswerQuestions`, `canModerateQuestions`, `canManageParticipants`, `canEndRoom`, `canViewReports`의 10개가 실제 API·화면에 연결됩니다. `canAnnotate`, `canExportResults`만 저장 전용이며 판서와 외부 내보내기는 구현하지 않았습니다.

## 01-3 익명 질문·참여자 관리·강의 종료

수강생은 먼저 `일반 질문` 또는 `체크리스트 질문`을 선택합니다. 일반 질문은 읽음 문맥 `GENERAL`을 사용하는 독립 논리 채널인 `일반 질문방`에 들어가며 별도 Firestore 방 문서를 만들지 않습니다. 작성 API에서는 `itemId: null`을 사용하고 저장 문서에서는 항목 관련 필드를 생략합니다. 체크리스트 질문은 챕터·항목 순서로 계산한 `1.1`, `1.2` 형식 번호가 선택 메뉴·필터·그룹·문맥·종료 통계에 표시되고, 서버가 작성 당시 번호를 `itemNumberSnapshot`으로 저장합니다. 이후 항목 순서가 바뀌어도 기존 질문 번호는 바뀌지 않습니다.

프론트엔드는 요청마다 UUID `clientRequestId`를 만들고 같은 전송의 네트워크 재시도에는 같은 값을 사용합니다. 서버는 room·작성 UID·요청 ID로 결정적 질문 ID를 만들며, 공개 질문·서버 전용 작성자 연결·속도 제한 기록을 한 Firestore 트랜잭션으로 저장합니다. `ABORTED`만 새 트랜잭션으로 제한적으로 재시도하고 프로세스 Lock은 사용하지 않습니다. 질문은 `createdAt + questionId`로 고정 정렬되고 단일 강사 답변은 해당 질문 바로 아래에 표시되므로, 답변 생성·수정 시 다른 질문의 상대 순서가 바뀌지 않습니다.

`rooms/{roomId}/questions`에는 별명과 수업 문맥·항목 번호 스냅샷, 공개 범위, 답변·숨김 상태만 저장합니다. 답변의 강사 구분은 계정의 과거 전역 역할이 아니라 답변 당시 방 관계인 `roomRole: LEAD | ASSISTANT`입니다. 작성 UID, `clientRequestId`와 비교용 digest는 `questionAuthors`, 속도 기록은 `questionRateLimits`에 분리하고 Firestore Rules로 모든 클라이언트 접근을 거부합니다. 질문·답변 공개 응답에는 UID·이메일·실명이 없습니다. 참여자 관리 API도 무작위 `participantId`만 반환합니다.

cloud-auth 강의방 운영 권한은 조직 ADMIN/INSTRUCTOR와 별개입니다. room 문서의 `roomInstructors`가 LEAD/ASSISTANT와 질문·체크리스트·정원 위임 권한의 단일 원천이며, 새 보조 강사는 질문 운영만 기본으로 받습니다. 주 강사만 보조 강사 관리와 주 강사 넘기기를 할 수 있고, 모든 변경은 revision 검증 Firestore Transaction과 최소 감사 기록으로 처리합니다.

질문은 제어 문자를 정리한 1~500자 일반 텍스트입니다. 10초에 최대 3개를 허용하고 30초 내 동일·유사 질문을 막습니다. 금칙어는 작성 거부, 검토어는 `NEEDS_REVIEW/STAFF_ONLY`로 저장합니다. 모든 질문 작성 성공 응답은 `{ id, roomId, accepted: true }` 접수 영수증만 반환하며, 공개 범위·검토 상태·내용은 Firestore 권한별 구독으로 받습니다. 검토 질문은 주 강사 또는 `canModerateQuestions` 보조 강사가 승인하기 전 학생에게 공개되지 않습니다. 이 규칙은 로컬 고정 목록이며 AI·Gemini 필터가 아닙니다.

강사별 미확인 상태는 `questionReads/{staffUid}/contexts`에 분리합니다. 읽음 API는 브라우저의 현재 시각을 그대로 믿지 않고 실제로 관찰한 질문의 서버 시각과 ID를 확인한 watermark만 기록합니다. 답변·승인·숨김·복구와 참여자 질문 제한은 FastAPI가 최신 권한과 `ACTIVE` 상태를 확인하고 서버 전용 감사 로그를 함께 기록합니다.

강의 종료 전 화면은 `GET /api/rooms/{roomId}/end-preview`로 최신 미답변 질문과 미완료 항목 수를 받습니다. 종료는 `ACTIVE → ENDING → ENDED` 2단계이며 최초 실행자 정보를 원자적으로 보존합니다. `ENDING`부터 새 질문·답변·검토·체크·참여자 변경을 막고, `summary/current`와 room·course의 종료 상태를 확정합니다. 종료 요약은 재호출해도 바뀌지 않으며 `exportStatus`는 `NOT_CONFIGURED`입니다.

## 비로그인 회귀 화면과 mock

로그인하지 않은 `/`는 v2 `Start.pdf`를 기준으로 구현한 NoDo_00 회귀 화면을 유지합니다. 로그인하면 같은 경로가 실제 강의 목록으로 전환됩니다.

세 가지 시작 방식은 다음 경로로 이동합니다.

| 시작 방식 | 현재 경로 |
|---|---|
| 자료로 만들기 | `/create/material` |
| 직접 만들기 | `/create/manual` |
| 기존 목록 불러오기 | `/courses/import` |

`/courses/import`는 v2 `import.pdf`를 기준으로 구현했습니다. 별도 파일에 있는 5개의 mock 강의만 사용하며, 검색, 진행 상태 필터, 정렬, 단일 선택과 선택한 목록 불러오기 동작을 제공합니다. 실제 Firestore 데이터는 읽거나 쓰지 않습니다.

수업 흐름 제작 화면은 v2 `make Roadmap.pdf`를 기준으로 구현했습니다.

| 제작 방식 | 경로 | 시작 상태 |
|---|---|---|
| 자료로 만들기 | `/create/material` | 파일 메타데이터 등록 후 mock AI 항목 생성 |
| 직접 만들기 | `/create/manual` | 빈 챕터에서 항목을 직접 추가 |
| 기존 목록 불러오기 | `/courses/:courseId/prepare` | 선택한 mock 강의의 수업 흐름 표시 |

파일 선택 시 브라우저 상태에 파일명과 형식만 저장합니다. 파일 내용을 읽거나 서버로 보내지 않습니다. 항목·챕터 추가, 항목 이름 수정·삭제·순서 이동과 강의 시작을 mock 동작으로 제공합니다. 제작 화면의 항목 완료 표시는 읽기 전용이며, 강의 중 체크리스트에서만 완료 여부를 변경합니다.

강의 진행 화면은 v2 `checklist.pdf`와 `chat.pdf`를 기준으로 구현했습니다.

| 화면 | 경로 |
|---|---|
| 강의 체크리스트 | `/rooms/demo-room/checklist` |
| 강의 채팅 | `/rooms/demo-room/chat` |

비로그인 회귀용 두 화면은 하나의 React Context 상태를 공유합니다. 패널 확대 여부, 선택 항목, 항목별 완료 여부와 질문은 화면 이동 중 유지되지만 브라우저를 새로고침하면 초기 mock 값으로 돌아갑니다. 로그인한 실제 강의방의 Firestore 질문·체크 상태와는 별개입니다. 수업 흐름 항목은 `isCompleted` 체크값만 저장하며, 챕터와 항목의 화면 순서에서 첫 번째 미완료 항목을 현재 진행 항목으로 자동 계산합니다.

강의 화면의 `체크리스트 크게 보기` 또는 `채팅 크게 보기` 버튼은 하나의 `isPanelExpanded` 상태를 사용합니다. 확대하면 왼쪽 자료를 숨기고 현재 패널이 작업 영역 전체 너비를 사용하며, `자료와 함께 보기`를 누르면 두 영역을 복원합니다. 이 상태는 체크리스트와 채팅이 공유하고 실제 브라우저 Fullscreen API는 사용하지 않습니다.

비로그인 회귀 화면에서는 항목 질문·일반 질문, 답변 완료, 숨김·복구와 단순 mock 필터를 계속 시험할 수 있습니다. 로그인한 실제 강의방에서는 같은 UI 결과를 FastAPI와 Firestore Emulator가 처리합니다. 강의 목록 화면의 `진행 중`·`완료` 필터는 수업 흐름 항목의 체크 방식과 별개입니다.

모든 mock 수업 상태의 기준 데이터는 `web/src/data/demoCourseMocks.ts`, 상태 변경은 `web/src/features/demo-course/DemoCourseContext.tsx`에서 관리합니다.

## 백엔드 설치와 실행

### 개발 설치

`pyproject.toml`에 기록한 애플리케이션 및 개발 도구를 설치합니다.

```powershell
cd backend
python -m venv .venv
.venv\Scripts\python -m pip install -e ".[dev]"
.venv\Scripts\python -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8080
```

### 재현 설치

`requirements.lock`에 기록된 애플리케이션 및 개발 도구의 정확한 버전을 설치합니다. 잠금 파일에는 로컬 NoDo 패키지나 컴퓨터별 경로를 넣지 않았으므로, `backend` 폴더에서 다음 명령을 실행합니다.

```powershell
cd backend
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.lock
.venv\Scripts\python -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8080
```

두 설치 방식의 명령은 Emulator 백엔드를 `http://127.0.0.1:8080`에서 실행합니다. 기존 API 요청은 Authentication Emulator ID Token을 전달하고, Admin SDK는 `demo-nodo`와 고정 loopback 조건을 벗어나면 실패합니다.

### Cloud-auth 백엔드

실제 Google 인증을 확인할 때는 로컬 전용 환경 파일을 명시적으로 읽고 별도 포트에서 실행합니다.

```powershell
cd backend
.venv\Scripts\python.exe -m uvicorn app.main:app --env-file .env.cloud-auth.local --host 127.0.0.1 --port 8082
```

`backend/.env.cloud-auth.local`이 없거나 필수 값이 불완전하면 실행하지 않습니다. Cloud-auth의 `GET /api/auth/me`는 실제 Google ID Token을 검증한 뒤 별도 named Admin app의 Firestore 클라이언트로 영구 사용자·조직·초대 상태를 조회하며 쓰기 작업은 하지 않습니다. 조직 Bootstrap, 직원 초대·취소와 가입 수락 쓰기는 각각의 명시적 POST·DELETE API만 수행합니다. 모든 실제 Firestore 경로는 ADC를 사용하고 서비스 계정 JSON은 사용하지 않습니다.

## 01-2A 동시 강의방 생성 정책

같은 강의 또는 참여 코드를 여러 요청이 동시에 선점할 때 Python 전역 Lock이나 프로세스 내부 Mutex를 사용하지 않습니다. Cloud Run은 여러 인스턴스에서 요청을 처리할 수 있으므로 한 프로세스에만 존재하는 잠금으로는 데이터 경합을 막을 수 없기 때문입니다.

강의방 생성은 강의 스냅샷의 Firestore 갱신 시각을 조건으로 사용해 `room`, `roomJoinCodes`, `course.activeRoomId`를 하나의 원자적 트랜잭션으로 기록합니다. 같은 스냅샷을 읽은 두 요청 중 하나만 커밋할 수 있고, 패배한 요청은 강의·코드·강의방을 다시 읽어 `409`로 판정합니다. `ABORTED`만 외부 재시도 대상으로 삼으며, 매번 새 트랜잭션으로 최대 3회 재시도하고 50/100/200ms 지수 백오프와 최대 50%의 작은 무작위 지연을 적용합니다. 현재 요청의 세 문서가 모두 연결되어 있으면 응답만 실패한 커밋으로 보고 `201`을 복원하고, 재시도 소진 시 안전한 `503 temporarily_unavailable`과 `Retry-After: 1`을 반환합니다.

카탈로그와 수업 흐름 편집 화면의 생성 버튼은 공통 single-flight 상태를 사용합니다. 요청을 시작하는 즉시 버튼을 비활성화하고 `강의방 생성 중`을 표시하며, 연속 클릭은 같은 API 요청을 추가로 만들지 않습니다. 실패 뒤에는 다시 시도할 수 있고 화면이 사라진 뒤에는 상태나 이동을 갱신하지 않습니다.

## 코드 품질 검사와 자동 테스트

프론트엔드는 `web` 폴더에서 실행합니다.

```powershell
npm run lint
npm run test
npm run test:run
npm run build
```

- `lint`: ESLint로 코드를 검사합니다.
- `test`: Vitest 감시 모드로 변경된 테스트를 반복 실행합니다.
- `test:run`: 프론트엔드 테스트를 한 번 실행하고 종료합니다.
- `build`: TypeScript 오류를 검사한 뒤 Vite 배포 파일을 만듭니다.

NoDo_00 회귀와 01-1 진단을 유지하면서 인증·역할·권한, 질문 실시간 구독, 작성·답변·검토, 강사별 읽음 watermark, 참여자 제한, 종료 확인·리포트와 강의방 생성 single-flight를 검증합니다. 테스트 개수는 기능 추가에 따라 달라질 수 있으므로 완료 보고에는 실행 시점의 실제 결과를 사용합니다.

프로젝트 루트에서 다음 명령 하나로 Emulator를 시작하고 Auth·Firestore·Storage Rules, seed 재실행과 FastAPI·Firestore 통합 테스트를 실행한 뒤 NoDo_02가 시작한 프로세스만 정리합니다.

```powershell
npm run test:emulator
```

동시 생성 10개 격리 사례만 선택하거나 전체 묶음을 3회 연속 실행할 때는 다음 명령을 사용합니다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\run-emulator-tests.ps1 -Mode Concurrency -Repeat 1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\run-emulator-tests.ps1 -Mode All -Repeat 3
```

통합 테스트는 익명 인증, 역할·조직별 읽기, 서버 전용 쓰기, 참여 코드·UID 비노출, 권한 회수, 순차 체크, 공개/작성자 질문 분리, 멱등 질문·속도·유사도 제한, 읽음 watermark, 답변·검토 감사, 참여자 제한과 종료 요약을 확인합니다. 동시성 묶음은 강의방 선점뿐 아니라 같은 질문 ID 동시 전송, 동일 참여자의 동시 속도 제한, 질문 작성과 종료 경합 및 고아 문서 부재를 반복 검증합니다. Windows에서는 NoDo_02가 시작한 Emulator 프로세스만 정리하며 다른 프로젝트 프로세스는 건드리지 않습니다.

백엔드는 `backend` 폴더에서 실행합니다.

```powershell
.venv\Scripts\python -m ruff check .
.venv\Scripts\python -m pytest
.venv\Scripts\python -m compileall -q app
```

기본 백엔드 단위 테스트는 실제 서버를 띄우지 않고 FastAPI 애플리케이션을 메모리 안에서 호출합니다. `tests/emulator`는 루트 통합 명령에서만 활성화되며 실제 Auth·Firestore 경계와 동시성을 검증합니다.

## 환경 변수

실제 `.env`와 로컬 인증 설정은 저장소에 포함하지 않습니다. Emulator 예시와 cloud-auth 예시를 분리하고, 실제 값은 각각의 무시된 `*.local` 파일에만 둡니다. 모드별 실행 명령은 대응하는 파일만 읽어야 합니다.

### 백엔드

- `APP_ENV`, `APP_NAME`, `APP_VERSION`: 실행 환경, 서비스 이름과 표시 버전입니다.
- `NODO_RUNTIME_MODE`: `emulator` 또는 `cloud-auth`이며, 생략 시 `emulator`입니다.
- `CORS_ORIGINS`: 모드별 프론트 주소만 허용합니다. 실제 Google 인증은 `http://localhost:5175`입니다.
- `NODO_FIREBASE_PROJECT_ID`: Emulator에서는 `demo-nodo`, cloud-auth에서는 승인된 기존 프로젝트 ID와 정확히 일치해야 합니다.
- `FIREBASE_AUTH_EMULATOR_HOST`, `FIRESTORE_EMULATOR_HOST`: Emulator 모드에서만 사용하는 프로토콜 없는 고정 loopback 주소입니다.
- `NODO_FIRESTORE_DATABASE_ID`: cloud-auth 실제 Firestore 데이터베이스 ID이며 02-2에서는 `(default)`만 허용합니다.
- `NODO_BOOTSTRAP_ORG_ID`, `NODO_BOOTSTRAP_ORG_NAME`: 최초 조직의 서버 전용 고정 ID와 표시 이름입니다. 브라우저 요청값으로 대체하지 않습니다.
- `NODO_BOOTSTRAP_ENABLED`: 최초 조직 생성 중에만 `true`입니다. 영구 소유자 확인 뒤 `false`로 바꾸고 재시작합니다.
- `NODO_BOOTSTRAP_ORG_OWNER_EMAILS`: cloud-auth 서버 전용 일회성 후보 목록입니다. 실제 값은 `backend/.env.cloud-auth.local`에만 저장하고 응답·로그·문서·프론트 환경에 노출하지 않습니다. Bootstrap 비활성화 뒤에는 비어 있어도 서버가 정상 시작해야 합니다.
- `NODO_STAFF_EMAIL_DOMAINS`: 직원 초대를 허용할 정확한 회사 도메인 목록입니다. 02-3에서는 `nodo-company.test`만 허용하고 suffix 부분 일치로 넓히지 않습니다.
- `NODO_STAFF_INVITATION_TTL_HOURS`: token hash가 없는 구형 초대 호환 흐름의 유효 시간입니다. 신규 이메일 링크 초대는 정책상 7일로 고정됩니다.
- `NODO_EMAIL_PROVIDER`: 로컬 기본값은 `disabled`, 실제 메일 발송 환경은 `resend`입니다.
- `RESEND_API_KEY`: FastAPI 서버 전용 비밀값입니다. 운영 Cloud Run에서는 Secret Manager로 주입하고 Git, `.env` 예시, 프런트 `VITE_*`, 로그에 넣지 않습니다.
- `NODO_EMAIL_FROM`: Resend에서 검증된 도메인의 발신 주소입니다. 예: `NoDo <noreply@example.com>`.
- `NODO_PUBLIC_APP_URL`: 이메일 수락·거절 링크에 사용할 NoDo 공개 origin입니다. 로컬은 `http://localhost:5175`, 운영은 승인된 Firebase Hosting origin을 사용합니다.
- 로컬 실제 Firestore 인증은 ADC를 사용합니다. `GOOGLE_APPLICATION_CREDENTIALS`로 서비스 계정 JSON을 가리키거나 OAuth Client Secret을 환경 파일에 저장하지 않습니다.

### 프론트엔드 Firebase

- `VITE_NODO_RUNTIME_MODE`: `emulator` 또는 `cloud-auth`이며, 생략 시 `emulator`입니다.
- `VITE_API_BASE_URL`: 모드와 관계없이 검증할 FastAPI 주소입니다.
- `VITE_USE_FIREBASE_EMULATORS`, `VITE_FIREBASE_*_HOST`, `VITE_FIREBASE_*_PORT`: Emulator 모드 전용입니다.
- `VITE_FIREBASE_PROJECT_ID`와 Firebase 웹 설정: cloud-auth의 실제 값은 `web/.env.cloud-auth.local`에만 저장합니다. 웹 설정은 비밀번호가 아니더라도 허용 도메인·API 제한·App Check와 함께 관리하며 문서나 로그에 복사하지 않습니다.
- bootstrap 이메일은 어떤 `VITE_*` 변수에도 두지 않습니다. `VITE_*` 값은 빌드 결과에서 사용자가 볼 수 있기 때문입니다.
- React에는 Firestore 데이터베이스 ID나 ADC 설정을 전달하지 않습니다. 사용자·조직 조회와 Bootstrap은 FastAPI만 호출합니다.

## API와 데이터 계약

- `docs/ROLES_AND_PERMISSIONS.md`: 계정 유형·조직 관리자와 방별 담당 관계, 위임 가능·불가능 권한
- `docs/API_CONTRACT.md`: Google 인증, 기존 Emulator 업무 API, 조직 Bootstrap과 02-3 직원 초대·가입 계약
- `docs/FIRESTORE_SCHEMA.md`: 공개/서버 전용 분리, 조직 초대·감사 문서, Rules 경계와 트랜잭션 불변식
- `docs/QUESTION_CONTRACT.md`: cloud-auth 일반/항목 질문, 답변, 공개·검토·숨김, 비공개 작성자·읽음 문서 계약

## 문서

- `docs/STRUCTURE.md`: 폴더별 책임
- `docs/DECISIONS.md`: 현재 확정된 기술 결정
- `docs/ROLES_AND_PERMISSIONS.md`: 역할과 세부 권한 기준
- `docs/API_CONTRACT.md`: Google 인증과 FastAPI 요청·응답·오류 및 조직 Bootstrap·직원 가입 계약
- `docs/FIRESTORE_SCHEMA.md`: Firestore 조직·직원 초대·강의 문서와 환경별 읽기·쓰기 계약
- `docs/QUESTION_CONTRACT.md`: cloud-auth 질문·답변의 공개/비공개 경계와 가시성·보존 원칙
- `MIGRATION.md`: 다음 버전으로 복사할 때의 원칙
- `CHANGELOG.md`: 버전별 변경 사항

## NoDo_01로 되돌리기

NoDo_00과 NoDo_01은 각각 `개발/NoDo_00`, `개발/NoDo_01`에 그대로 보존합니다. 되돌릴 때 이전 폴더에 NoDo_02 파일을 덮어쓰지 말고 NoDo_02가 시작한 서버만 종료한 뒤 NoDo_01을 자체 명령으로 실행합니다. 이전 버전의 `VERSION.txt`, 잠금 파일, 소스·테스트·문서와 Firebase Rules 해시는 NoDo_02 작업 전후 동일해야 합니다.

## 02-7A 익명 수강생 입장

공유 링크 `/join/{orgId}/{roomCode}`는 공개 방 제목·상태·입장 가능 여부만 먼저 읽습니다. 수강생은 일반 단어 조합의 별명을 2~16자 한글·영문·숫자·공백으로 수정한 뒤 Firebase Anonymous Auth와 FastAPI를 통해서만 참여합니다. React는 Firestore를 직접 읽거나 쓰지 않으며, 참가자 문서는 별명·정규화 키·서버 시각·`JOINED`·익명 여부만 유지합니다. 같은 익명 세션의 재입장은 문서를 재사용하고, 동일 방의 별명 중복은 거부합니다. Google 강사 세션은 로그아웃·계정 전환하지 않고 별도 브라우저 또는 기기를 안내합니다.

## 02-8A 강의방 수업 시작·진행 체크리스트

cloud-auth 강의방은 `READY → LIVE → ENDED` 상태 계약을 사용합니다. 02-8A는 주 강사만 `READY` 방을 `LIVE`로 시작하고, `flowItems`의 `isCompleted: boolean`만으로 진행을 관리합니다. 현재 항목은 chapter/item 정렬 순서에서 첫 미완료 항목으로 서버가 계산하며, 별도 `IN_PROGRESS` 상태나 current item 문서는 저장하지 않습니다. 완료는 현재 항목만 가능하고, 완료 항목을 해제하면 그 항목과 뒤의 완료 항목이 함께 미완료가 됩니다.

`/rooms/{roomId}/checklist`는 React → FastAPI → Firestore 경로만 사용합니다. 모든 변경에는 `expectedRevision`을 보내며, FastAPI Transaction이 순서·방 소속·권한·revision을 확인하고 감사 이벤트를 준비합니다. LIVE 화면은 보이는 탭에서만 짧은 revision polling을 사용하고, 이후 SSE 또는 서버 구독으로 교체할 수 있습니다. 실제 수업 시작·체크·감사 로그 검증은 02-8B에서 별도 승인 후 수행합니다.

## 02-9A 항목별·일반 질문과 강사 답변

cloud-auth 질문은 `organizations/{orgId}/rooms/{roomId}/questions/{questionId}`에 공개 질문·문맥 스냅샷·공식 답변만 기록하고, 익명 작성자 UID·요청 멱등 키·도배 판정 정보는 React에 반환하지 않는 `questionAuthors/{questionId}`에 분리합니다. 일반 질문은 `itemId: null`이고, 항목 질문은 전체 `flowItems` 중 선택한 항목의 챕터·번호·제목을 질문 시점 스냅샷으로 남깁니다.

학생은 LIVE 방에 실제 익명 참가자 문서가 있을 때만 FastAPI를 거쳐 질문할 수 있습니다. 공개 질문과 공식 답변만 보며, 검토 필요(`STAFF_ONLY`)·숨김 질문과 내부 읽음 상태는 보지 못합니다. 주 강사만 답변·답변 취소·숨김·복구를 수행하고, ADMIN은 통합 목록을 읽을 수 있습니다. 체크리스트의 전체·항목별 질문 배지는 FastAPI 집계이며 `/rooms/{roomId}/chat`의 해당 문맥 필터로 이동합니다.

현재 금칙어·검토 필요·짧은 시간 반복/유사 질문 판단은 규칙 기반이며 Gemini나 외부 AI 판단을 호출하지 않습니다. cloud-auth 화면은 Firestore SDK나 `onSnapshot` 대신 보이는 탭에서만 짧은 FastAPI polling을 사용합니다. Sheets 내보내기와 수업 종료 후 삭제·보존 기간은 후속 기능이며, 실제 Firestore 질문·답변 검증은 02-9B에서 별도로 승인받아 재개합니다. 자세한 계약은 `docs/QUESTION_CONTRACT.md`를 참조하세요.

## 02-4A 조직 역할 단순화

회사의 STAFF 역할은 `ADMIN`과 `INSTRUCTOR`만 사용합니다. `ADMIN`은 초대·구성원 역할 변경을 포함해 일반 강사 기능을 모두 가지며, 최소 한 명은 항상 유지됩니다. `/organization/members`와 `/api/cloud/organization/members`는 관리자 전용이고, 역할 변경은 revision과 Firestore Transaction으로 처리합니다. 브라우저는 Firestore를 직접 읽거나 쓰지 않습니다.

## 02-10A v2 통합 강의 화면

v2 `checklist.pdf`, `chat.pdf`, `Start.pdf`를 화면 기준으로 삼아 강사와 학생의 체크리스트/채팅 탭을 같은 민트·남색·흰 카드 언어로 통합합니다. 학생은 `/join/{orgId}/{roomCode}/checklist`에서 읽기 전용 전체 flowItems, 서버 계산 현재 항목, 완료·미래 상태와 PUBLIC 질문 수만 보고, 항목 배지로 `/chat?context=ITEM:{itemId}` 문맥을 엽니다. `/join/{orgId}/{roomCode}/questions`는 호환을 위해 `/chat`으로 이동합니다.

학생 체크리스트·채팅은 React → FastAPI → Firestore만 사용하며, 보이는 화면에서만 2.5초 polling합니다. 체크리스트 조회는 Firestore 쓰기·읽음 위치·감사 로그를 만들지 않습니다. 학생 응답에는 강사 이름·이메일·UID·원본 수업·질문 작성자·STAFF_ONLY·숨김 질문·새 질문 수를 포함하지 않습니다. 자료가 없는 실습형 방은 가짜 슬라이드 영역 없이 체크리스트 또는 채팅이 전체 작업 영역을 사용하고, 단일 확대/복원 버튼만 제공합니다. 실제 UI 검증과 GitHub 반영은 02-10B에서 별도 승인 후 진행합니다.

## 02-11A 현재 접속 인원·정원·나가기

강의방 생성 요청은 `maxActiveParticipants`(기본 50, 1~300)를 함께 보내며, 기존 방에 값이 없으면 서버가 50명으로 해석합니다. 누적 `participants` 문서 수와 현재 접속 인원은 분리합니다. 현재 인원은 private `presence/capacity` 문서의 카운터와 `ACTIVE`·90초 lease를 기준으로 하고, 학생 화면은 FastAPI의 약 30초 visible heartbeat와 나가기 명령만 사용합니다.

정원 초과 시 새 ACTIVE 참여자는 만들지 않고 “현재 참여 인원이 가득 찼습니다.”와 재시도를 제공합니다. 강사는 현재 접속/정원만 보며, lead·배정 보조 강사만 PENDING 정원 알림을 유지하거나 상향할 수 있습니다.

## 02-11D 정원 운영 감사 로그

새 PENDING 정원 초과 알림, 정원 유지, 정원 상향, ACTIVE→LEFT 나가기, LEFT/EXPIRED→ACTIVE 재입장, ACTIVE→EXPIRED lease 만료는 상태 전환이 실제로 발생한 경우에만 서버 운영 감사 이벤트를 남깁니다. heartbeat·같은 정원 유지/상향 재시도·이미 처리된 초과/나가기/만료·정원 조회 GET은 감사 이벤트를 만들지 않습니다. 조회 GET은 capacity 문서 생성, 카운터·presence·alert 변경도 하지 않는 완전 읽기 전용입니다. 감사에는 방·조직·이벤트·시각과 필요한 staff 내부 식별자 또는 정원/상태 전환만 남기며 익명 UID·이메일·토큰을 저장하거나 화면에 표시하지 않습니다.

## 02-14 비공개 자료 텍스트·슬라이드 구조 추출

`/create/material`에서 저장 완료된 PPTX/PDF는 업로드 소유 STAFF만 FastAPI에 추출을 요청할 수 있습니다. React는 자료 내용·Storage 경로·공개 URL을 받지 않으며, 서버가 고정된 NoDo 전용 비공개 버킷에서 임시 파일로만 원본을 읽어 PDF 페이지 또는 PPTX 슬라이드 순서·텍스트·제목 후보를 구조화합니다.

추출 원문은 같은 비공개 버킷의 `extraction.json`에만 저장하고 Firestore에는 상태, 형식, 페이지/슬라이드 수, 문자 수, 원본 generation, 완료 시각, 안전한 실패 코드만 남깁니다. `STORED → EXTRACTING → EXTRACTED | EXTRACTION_FAILED` 상태와 Transaction claim으로 중복 실행을 막으며, PDF/PPTX 형식 재검사·ZIP 제한·페이지/슬라이드·문자 수 상한을 서버에서 다시 적용합니다. Gemini, OCR, 미리보기, 학생 공개, AI 수업 흐름 생성은 다음 단계 전까지 시작하지 않습니다.
