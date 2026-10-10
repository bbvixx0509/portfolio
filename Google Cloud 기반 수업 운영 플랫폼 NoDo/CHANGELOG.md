# 변경 기록

## 02

### 02-15 비공개 추출 자료 기반 Gemini 수업 흐름 초안

- EXTRACTED PDF/PPTX의 비공개 `extraction.json`을 FastAPI 임시 파일에서만
  정규화·길이 제한해 Vertex AI `gemini-2.5-flash` global endpoint에 전달하는
  서버 전용 초안 생성 경로를 추가
- `materialCourseDrafts`에는 검증된 제목·개요·목표·챕터·항목·참조 번호와
  최소 메타데이터만 저장하고, 원문·프롬프트·원시 모델 응답·Storage 경로·토큰은
  Firestore와 브라우저 응답에서 제외
- Pydantic JSON 구조 검증, Transaction 기반 단일 active draft, 실패 후 명시적
  재생성, owner STAFF 권한과 읽기 전용 초안 미리보기를 추가
- 실제 Vertex API 활성화·Gemini 호출·Firestore 초안 저장과 GitHub 반영은 별도
  명시 승인 전까지 수행하지 않음

### 02-14 비공개 PPTX·PDF 텍스트·슬라이드 구조 추출

- FastAPI만 NoDo 전용 비공개 Storage 원본을 임시 파일로 읽어 PDF 페이지·PPTX 슬라이드 순서와 텍스트 구조를 추출하도록 추가
- 추출 원문은 비공개 `extraction.json`에만 저장하고, Firestore·브라우저 응답에는 상태·개수·문자 수·안전한 실패 코드만 유지
- source 재검증, OOXML ZIP 제한, 페이지/슬라이드·문자 수 상한, owner STAFF 권한, Transaction claim 기반 중복 방지를 추가
- Gemini·OCR·이미지/슬라이드 미리보기·학생 자료 공개는 구현하지 않으며 실제 Storage 추출은 별도 승인 단계로 분리

### 02-13 PPTX·PDF 비공개 자료 업로드

- `/create/material`에서 PPTX/PDF 한 개와 30MB 상한만 허용하고, 브라우저는
  원시 파일 스트림을 FastAPI에만 전송하도록 변경
- FastAPI가 파일명·크기·PDF 시그니처·PPTX OOXML ZIP 구조·내부 파일 수와
  압축 비율을 검증하고, 서버 생성 Storage 경로와 최소 업로드 메타데이터를 사용
- Storage는 cloud-auth의 고정 NoDo 버킷·동일 프로젝트 설정에서만 명시적으로
  활성화하며 Emulator와 미설정 환경은 fail-closed 처리
- AI 분석·미리보기·수업 흐름 생성, 실제 Storage 버킷/파일/Firestore 변경과
  GitHub 반영은 실제 승인·검증 단계로 분리

### 02-12A 강의방 보조 강사·권한·주 강사 넘기기

- cloud-auth 강의방의 조직 역할과 방별 LEAD/ASSISTANT 역할을 분리하고 `roomInstructors`를 단일 권한 원천으로 추가
- 보조 강사 기본 질문 운영, 체크리스트·정원 추가 위임, 고정된 현재 범위의 전체 권한 부여·회수 및 LEAD 이전 API/드로어를 추가
- 모든 역할 변경을 expected revision 기반 Transaction과 최소 `ROOM_*` 감사 이벤트로 묶고, 질문·체크리스트·정원 명령도 서버의 방별 권한을 다시 검사하도록 변경
- 로컬 Emulator·자동 테스트만 사용하며 실제 Firestore 방·조직·권한·Firebase/GCP 및 GitHub는 변경하지 않음

### 02-10A v2 통합 강의 화면: 학생 체크리스트·채팅 패널

- v2 `checklist.pdf`, `chat.pdf`, `Start.pdf`의 민트 배경·남색 탭·흰 카드·얕은 그림자 언어를 cloud-auth 강사/학생 강의 화면에 적용
- Anonymous 참가자 전용 읽기 API가 제목·상태·정렬된 flowItems·완료 여부·서버 계산 현재 항목·PUBLIC 질문 전체/항목 수만 반환하도록 추가
- 학생은 `/join/{orgId}/{roomCode}/checklist`에서 읽기 전용 전체 체크리스트·현재 항목·항목 질문 배지를, `/chat`에서 문맥 칩·질문/답변 말풍선·하단 입력창을 사용
- 기존 `/questions`는 `/chat`으로 안전하게 redirect하며, 학생 API 응답에서 강사 표시명과 STAFF_ONLY·숨김·읽음 상태를 제외
- 자료가 없는 실습형 방은 가짜 슬라이드 없이 한 개의 체크리스트/채팅 확대 상태만 제공하고, 보이는 탭에서만 FastAPI polling을 사용
- 로컬 Emulator·mock API·자동 테스트만 사용하며 실제 Firestore/Firebase/GCP 변경과 Git commit/push는 수행하지 않음

### 02-9A 항목별·일반 질문과 강사 답변

- cloud-auth 전용 질문·비공개 작성자·강사용 읽음 문서 계약과 FastAPI Transaction 기반 생성, 답변/취소, 숨김/복구, 문맥별 읽음 API를 추가
- Anonymous 참가자는 LIVE 방에서 일반 또는 전체 flowItem 항목 질문을 만들고, 서버가 별명·챕터/항목 스냅샷·가시성·검토 상태·멱등성·규칙 기반 도배/금칙어 판단을 결정하도록 고정
- 주 강사 통합 질문 화면, 학생 공개 질문 화면, 체크리스트 전체·항목별 질문 배지와 FastAPI polling을 추가하고 cloud-auth에서 Firestore 직접 접근·`onSnapshot`을 사용하지 않음
- 공개 질문에서 UID·이메일·토큰·작성자 내부 식별자를 배제하고, 검토 필요·숨김 질문은 학생 응답에서 제외
- 실제 Firestore 질문·답변·읽음·감사 로그 생성, Firebase/GCP 변경, Git commit·push는 하지 않으며 실제 검증은 02-9B로 분리

### 02-6A 강의방 생성·목록·공유 링크

- 재사용 수업 흐름과 분리된 `organizations/{orgId}/rooms/{roomId}` READY 강의방과 `flowItems` 스냅샷, `roomCodes/{roomCode}` 조직 코드 인덱스 계약을 추가
- ADMIN·INSTRUCTOR가 ACTIVE 수업 흐름에서만 방을 만들고, 생성자를 최초 주 강사·참여 강사로 기록하도록 FastAPI Transaction을 구성
- 방 코드는 서버가 `secrets` 기반의 혼동 문자 제외 8자리 대문자·숫자로 생성하고 충돌 시 재시도하며, 브라우저 요청은 `sourceCourseId`, `title`만 strict 입력으로 허용
- `/courses/:courseId/rooms/new`, `/rooms`, `/rooms/:roomId/prepare` 화면에서 방 생성·목록·코드/공유 링크 복사를 제공하고 Anonymous 학생은 강사 보호 경로에서 차단
- 실제 Firestore 강의방·코드·감사 로그 생성, Rules·Firebase/GCP 변경, Git commit·push는 수행하지 않으며 실제 검증은 02-6B로 분리

### NoDo 전용 자원 경계·운영 권한·배포 설정 분리

- NoDo `(default)` Firestore 전용 `firebase.nodo.json`, `firestore.nodo.rules`, `firestore.nodo.indexes.json`을 분리하고 database ID를 명시
- cloud-auth FastAPI의 `NODO_FIRESTORE_DATABASE_ID=(default)` fail-closed 계약과 서버 전용 Firestore 접근을 유지
- NoDo 앱 역할과 GCP 배포·서비스 계정·공용 프로젝트 운영 권한을 문서와 표로 분리하고, 미래 자원에는 `nodo-*` 최소 권한 원칙을 기록
- 다른 서비스 Firestore·Storage·Cloud Run 자원명은 NoDo 실행 코드·환경 예시·배포 설정에서 사용하지 않도록 정적 검증 추가
- 실제 Firestore 데이터, Rules·Indexes 배포, Storage·IAM·Cloud Run·Firebase Auth·결제 설정은 변경하지 않음

### 02-5 재사용 가능한 수업 흐름

- 02-5A: 화면·응답의 `position`은 유지하되 생성·수정 FastAPI 요청에서는 제거하는 명시적 입력 변환을 추가하고, 서버가 배열 순서로 `position`을 재계산하도록 계약을 고정
- 02-5A: cloud course 입력 스키마의 `extra="forbid"`를 유지하는 422 회귀와 요청 body·순서·`expectedRevision` 테스트를 추가했으며 실제 Firestore 저장 검증은 02-5B로 분리
- cloud-auth 보호 경로 `/create/manual`, `/courses/import`, `/courses/:courseId/prepare`를 FastAPI 기반의 수업 흐름 작성·목록·읽기 전용/편집 화면으로 연결
- `GET/POST/PUT /api/cloud/courses`, 조회·복사·보관 삭제 API를 추가하고 브라우저 Firestore 직접 읽기·쓰기를 사용하지 않음
- STAFF의 ADMIN·INSTRUCTOR 모두 목록 조회·생성·다른 작성자 흐름 열람·복사를 허용하되 수정과 보관 삭제는 작성자 UID만 허용
- 챕터·항목 ID, 순서, 길이 제한, revision 충돌(409), `ACTIVE → ARCHIVED` 보관 삭제와 `COURSE_*` 감사 이벤트를 서버 Transaction으로 처리
- 실제 Firestore 테스트 문서 생성·삭제는 별도 승인 전까지 실행하지 않고 단위·API 계약·Emulator 회귀만 검증

### Google 로그인 진단 및 복구 흐름

- cloud-auth 개발 서버에서만 `?authDebug=1`로 활성화되는 안전한 로그인 진단 패널을 추가하고, 일반·배포 build에는 표시하지 않도록 분리
- Firebase 초기화, 로컬 주소, 프로젝트·authDomain 확인, 팝업·리디렉션 결과, Firebase 사용자, 토큰, `/api/auth/me`, 조직 역할과 최종 결과를 계정 식별자 없이 단계별로 표시
- 팝업 시간 초과·취소·차단·승인 도메인·토큰·401·403·409 오류를 사용자에게 바로 실행할 수 있는 한국어 복구 안내로 통일
- 처음부터 `리디렉션으로 로그인`을 제공하고, 팝업 실패 뒤에는 `다시 시도`를 추가해 같은 로그인 시도를 동시에 시작하지 않도록 유지
- Firebase Console, Firestore 문서·Rules, Authentication 제공업체, Storage, GCP·IAM 및 패키지 버전은 변경하지 않음

### Google 로그인 팝업 시간 제한 및 리디렉션 대체

- cloud-auth의 Google 팝업 로그인에 45초 시간 제한을 추가해 결과가 돌아오지 않아도 무한 대기하지 않도록 수정
- `리디렉션으로 로그인`은 초기 화면부터 제공하고, 시간 초과 또는 팝업 실패 뒤에는 `다시 시도`를 함께 표시하며 리디렉션은 사용자가 명시적으로 선택할 때만 시작
- 로그인 시도 ID로 늦은 팝업 결과와 새 로그인·로그아웃 상태의 경합을 차단하고, redirect 복귀 credential을 기존 FastAPI 권한 검증 흐름에 한 번만 연결
- Firebase Console, Firestore 문서·권한, Rules, Storage, GCP와 패키지 버전은 변경하지 않음

### 02-3 회사 직원 초대와 조직 가입

- 조직 소유자 전용 `/organization/members`에서 가입 구성원과 PENDING·REVOKED 초대를 조회하고 정확한 `@nodo-company.test` Google 이메일을 등록·취소하는 흐름 추가
- 초대받은 Google 사용자가 `409 ORGANIZATION_INVITATION_ACCEPTANCE_REQUIRED` 상태에서 로그아웃되지 않고 `/join-organization`으로 이동해 직접 가입을 수락하는 흐름 추가
- 초대 ID를 조직 ID와 정규화 이메일의 SHA-256으로 결정하고 PENDING 멱등 반환, REVOKED·만료 재발급의 revision 증가, 동시 중복 방지를 Firestore Transaction으로 처리
- 조직 가입 수락 시 일반 STAFF 사용자 생성, 초대 ACCEPTED 전환과 감사 로그를 하나의 Transaction으로 기록하고 부분 저장 방지
- 초대 생성·재발급·취소·수락을 결정적 감사 event ID와 `STAFF_INVITATION_*` 이벤트로 기록하되 이메일·토큰·비밀번호·쿠키는 감사 로그에서 제외
- 일반 STAFF를 `isOrgAdmin: false`, `isOrgOwner: false`로 영구 인증하고 조직 소유자 전용 구성원 관리 화면 접근은 차단
- 전역 계정 유형은 `STAFF | STUDENT`만 유지하고 주 강사·보조 강사는 방별 담당 관계로 남김
- `NODO_STAFF_EMAIL_DOMAINS`, `NODO_STAFF_INVITATION_TTL_HOURS` 서버 설정과 회사 도메인·자기 초대·기존 직원 검증 추가
- Production Rules 기존 기본 거부가 `staffInvitations`, `auditLogs`, `users` 목록과 모든 브라우저 쓰기를 차단함을 Emulator에서 확인해 Rules/config 변경·재배포 없음
- 이메일 발송, Gmail·Outlook API, 직원 제거, 관리자 승격과 소유권 이전은 구현하지 않고 02-4 관리자 권한 계약으로 이월

### 02-2 실제 Firestore 조직 Bootstrap

- 승인된 Firebase 프로젝트에 `(default)` Firestore를 Standard·Native·`asia-northeast3`·삭제 보호 활성화 기준으로 연결하고, 다른 데이터베이스를 자동 삭제·재생성하지 않는 경계 확정
- 기존 `firebase.json`·`.firebaserc`·`firestore.rules`를 Emulator 전용으로 보존하고 Production 전용 `firebase.cloud.json`·`firestore.cloud.rules` 분리
- Production Rules에서 본인 사용자 문서와 STAFF의 동일 조직 문서 단건 읽기만 허용하고 모든 브라우저 쓰기·목록·감사·진단·미구현 경로 접근 차단
- Firebase ID Token 검증용 named app과 실제 Firestore용 named app을 분리하고, 로컬은 ADC·향후 Cloud Run은 최소 권한 서비스 계정을 사용하며 서비스 계정 JSON을 금지
- `GET /api/auth/me`를 조회 전용으로 유지하고 `ORGANIZATION_BOOTSTRAP_REQUIRED`일 때만 `POST /api/auth/bootstrap-organization`을 호출하는 인증 흐름 정의
- 조직, 사용자와 Bootstrap 감사 로그 세 문서를 하나의 Firestore Transaction으로 생성하고 같은 UID 재호출의 멱등 성공·감사 중복 방지·다른 UID와 동시 요청 충돌 처리 추가
- Bootstrap 이메일을 최초 후보 확인에만 사용하고, 생성 뒤에는 `ownerUid`와 사용자 문서로 영구 소유자를 판정하며 Bootstrap 비활성화·빈 이메일 목록 재시작 절차 추가
- React의 실제 Firestore 직접 구독·쓰기는 금지하고 실제 조직 프로필은 FastAPI를 통해서만 읽도록 유지
- 02-3 회사 직원 가입과 02-4 관리자 권한 확장에서도 조직 소유권과 방별 주·보조 강사 권한을 분리하고 서버 Transaction·감사 로그를 사용하도록 후속 원칙 기록

### 02-8 통합 강의 자료 선택 및 로컬 파일 검증

- cloud-auth의 Google 강사 보호 경로 `/create/material`에 PPTX·PDF·DOCX·PNG·JPG/JPEG 단일 파일 선택 화면 추가
- 버튼과 드래그 앤 드롭, 키보드 접근, 검증 상태, 선택 파일 정보, 제거와 안전한 교체 동작 구현
- 문서 30MB·이미지 10MB, 0바이트·255자 파일명·확장자·MIME·최소 시작 시그니처 검사 추가
- Office 문서는 ZIP `PK` 시작만 확인하고 내부 구조 검사는 02-9 FastAPI 안전 검사로 이월
- 구형 PPT·HWP 변환 안내와 코드·데이터 후속 지원 안내 추가
- 파일 전송·영구 저장·전체 읽기·미리보기·내용 추출 없이 React 화면 메모리에서만 파일 객체 관리
- 02-8 구현 시점에는 새 npm 패키지, Gemini·Document AI·Google API, Firestore·Storage를 사용하지 않고 당시 02-2 중단 상태와 익명 테스트 계정을 유지

### 02-7 학생 참여 화면과 Anonymous Authentication

- 02-7 구현 시점에는 Firestore 데이터베이스 생성 권한이 없어 중단된 02-2를 완료 처리하지 않고 학생 인증을 독립 기능으로 구현
- 기존 Firebase 프로젝트의 Google 제공업체를 유지하고 실제 설정 변경은 Anonymous Authentication 제공업체 활성화 하나로 제한
- `/join/:roomCode`에 자동 생성한 한글 `형용사 + 명사` 별명을 표시하고 학생이 입장 전에 직접 수정하도록 구성
- 학생 화면에서 Firebase·Anonymous·익명 인증·회원가입·ID Token·UID 같은 기술 용어를 숨기고 주요 입장 버튼을 `참여하기` 하나로 제한
- `참여하기` 전에는 사용자를 만들지 않고, 클릭 뒤 `browserSessionPersistence`와 Anonymous 로그인 및 FastAPI 학생 세션 검증을 순서대로 수행
- 별명은 참여 전 React 상태, 성공 후 현재 탭의 `sessionStorage`에만 저장하고 UID·ID Token·OAuth 토큰·이메일·역할은 직접 저장하지 않음
- 학생 세션 API가 토큰 provider, 별명과 참여 코드 형식을 검증하고 `scope: AUTH_ONLY`, `roomAuthorized: false`만 반환하도록 제한
- Google 강사와 Anonymous 학생 세션을 자동 교체하지 않고 강사 로그아웃 또는 학생 참여 종료를 먼저 요구하며 Anonymous 사용자의 강사 보호 경로 접근을 차단
- 02-7 학생 경로에서는 Firestore·Storage 초기화·읽기·쓰기와 실제 강의방·참여자 저장을 수행하지 않고, 익명 UID와 실제 강의방 참여자 연결을 별도 후속 기능으로 이월
- Identity Platform 업그레이드와 익명 계정 자동 삭제 정책은 사용하지 않고 버전과 기존 패키지 버전을 그대로 유지

### 02-1 실제 Google 인증 경계

- NoDo_01을 수정하지 않고 NoDo_02로 복사해 기존 Emulator 화면·데이터·권한·테스트 기준을 보존
- 기본 `emulator`와 명시적 `cloud-auth` 실행 모드를 분리하고 루트에 `npm run dev:emulator`, `npm run dev:cloud-auth` 명령 제공
- 02-1 cloud-auth 모드에서는 기존 Firebase 프로젝트의 Google Authentication만 초기화하고 Firestore·Storage 초기화와 접근을 코드 경계에서 차단
- Google 팝업 로그인을 우선 사용하고 팝업을 사용할 수 없을 때 리디렉션으로 전환하며, 취소·차단·네트워크·미승인 계정 오류를 안전하게 구분
- 브라우저 인증 지속, 새로고침 복원, 로그아웃과 보호 경로 가드를 추가하고 FastAPI 승인 전 권한 화면 노출 차단
- `GET /api/auth/me`에서 Firebase ID Token의 서명·만료·발급자·대상 프로젝트·UID·이메일·Google provider·이메일 인증 여부를 서버에서 재검증
- 서버 전용 bootstrap 이메일의 정확 일치로 02-1 임시 조직 소유자 후보를 제한하고, 실제 이메일·UID·API 키·Firebase 설정값을 코드·테스트·문서·로그에서 제외
- 02-1에서는 서비스 계정 JSON 없이 Google 공개 인증서 기반 토큰 검증을 사용하고 Firestore·Storage·Analytics·App Check·Cloud Run·Gemini·Google API를 연결하지 않음
- Firebase 설정 계정, NoDo 조직 소유자와 GCP IAM 주체가 서로 다른 권한 체계임을 문서화
- 후속 02-2에서 `organization.ownerUid` 생성과 bootstrap 비활성화를 수행하고 02-3 이후 관리자·강사 확장으로 이어갈 계약과 롤백 원칙 추가
- 최종 보안 점검에서 cloud-auth의 Emulator 어댑터 지연 로드, 고정 Emulator endpoint 검사, 보호된 `/join` 경로 로그아웃 표시와 모든 모드 환경 파일 Git 제외 규칙을 보강
- 02-7 실제 브라우저 검증을 위해 cloud-auth 개발 서버의 `/api`를 고정된 로컬 FastAPI로 전달하고 외부 API 주소 차단은 유지

## 01

### 01-3A 계정 유형·강의방 담당 관계와 질문 채널 정리

- 직원 사용자 문서를 `accountType: STAFF`, `isOrgAdmin` 구조로 전환하고 전역 `LEAD_INSTRUCTOR`·`ASSISTANT_INSTRUCTOR` 역할 판정을 제거
- 기존 `ORG_ADMIN`은 관리자 직원, 기존 주·보조 강사는 일반 직원으로 변환하되 기존 room의 `leadInstructorId`, `staff` 문서와 보조 강사 권한은 보존
- 같은 조직의 모든 직원이 강의를 만들 수 있게 하고 생성자를 course·room의 `leadInstructorId`로 서버에서 고정
- 직원 로그인에서 역할별 테스트 계정 선택·기본값을 제거하고 이메일·비밀번호·로그인 버튼·수강생 참여 링크만 제공
- 강의 목록과 강의 화면이 `leadInstructorId` 또는 본인 `staff` 문서로 방별 `LEAD | ASSISTANT | null` 관계를 판정하고, 직원 초대·제거를 실시간 반영
- 보조 강사 초대 API를 `userId` 전용 요청으로 제한하고 서버가 `canAnswerQuestions: true`, 나머지 11개 권한 `false`인 기본값만 저장
- 초대 화면에 기본 조회·질문 답변 권한을 안내하고, 초대 후 `추가 권한 설정`에서 저장 전·저장 중·완료와 회수를 처리
- 챕터·항목 `(order, id)` 순서로 `1.1`, `1.2` 번호를 계산해 체크리스트·질문 선택·필터·그룹·문맥·종료 통계에 표시
- 질문 작성 시 서버가 `itemNumberSnapshot`을 저장해 이후 수업 흐름 순서가 바뀌어도 기존 질문 번호를 보존
- `contextId: GENERAL`, `itemId: null`인 논리 채널을 `일반 질문방`으로 분리하고 일반·체크리스트 질문 모드를 먼저 선택하도록 변경
- 질문을 `createdAt + questionId`로 안정 정렬하고 단일 답변을 해당 질문 바로 아래에 표시하며, 답변 당시 방 관계를 `roomRole`로 저장
- 담당 관계가 없는 직원의 질문 읽음 구독을 막고 방 전환 시 이전 방 역할·권한·항목 필터가 잠깐 남지 않도록 상태 경계를 보강
- 답변 저장 후 서버 답변을 수정 입력창에 다시 표시하고 질문 선택·필터 순서를 `1.1`, `1.2` 번호 순서와 일치시킴
- 실제 Google 로그인, Firebase 클라우드, GCP, Gemini와 Google API는 연결하지 않고 NoDo_02 후속 범위로 유지

### 01-3 익명 질문·참여자 관리·강의 종료 실제 Emulator 전환

- 로그인한 실제 강의방의 항목 질문·일반 질문, 답변·답변 취소, 승인·숨김·복구를 Firestore Emulator와 FastAPI로 전환
- 공개 질문 `questions`와 작성 UID·`clientRequestId`를 가진 서버 전용 `questionAuthors`를 분리하고 공개 응답에서 UID·이메일 제거
- 프론트 UUID와 결정적 질문 ID로 동일 요청을 멱등 처리하고, 질문·작성자 연결·속도 제한 기록을 하나의 Firestore 트랜잭션으로 저장
- 프로세스 Lock 없이 `ABORTED`만 최대 3회 새 트랜잭션으로 재시도하고 커밋 응답 유실 시 권위 문서를 재조회해 결과 복원
- 질문 1~500자, 제어 문자 정리, 금칙어 작성 거부, 검토어 `NEEDS_REVIEW/STAFF_ONLY`, 10초 최대 3개와 30초 동일·유사 질문 제한 적용
- 공개·검토 질문 구분 없이 생성 응답을 동일한 `{ id, roomId, accepted: true }` 영수증으로 제한해 내용·스냅샷·내부 검토 상태 비노출
- 답변 1~2,000자와 질문 상태 변경을 감사 로그와 함께 원자적으로 기록하고 감사 문서에서 질문·답변 원문 제외
- 강사별·문맥별 `questionReads`를 추가하고 실제 관찰 질문의 서버 시각·ID를 검증한 watermark만 저장
- 참여자 목록에 불투명 `participantId`만 반환하고 Firebase UID·이메일·실명 없이 질문 작성 제한·해제 연결
- 12개 보조 강사 권한 중 질문 답변·검토, 참여자 관리, 종료, 리포트를 추가 연결해 총 10개 연결; `canAnnotate`, `canExportResults`만 미연결 유지
- 종료 전 서버 `end-preview`로 미답변·미완료 수를 확인하고 `ACTIVE → ENDING → ENDED` 2단계 종료와 멱등적 `summary/current` 생성 구현
- 최초 종료 실행자 UID·표시명을 `ENDING` 전환에서 원자 보존해 재시도 후에도 summary와 감사 로그가 같은 실행자를 가리키도록 구성
- 종료 요약에 참여자·질문 상태별·항목별 질문·체크 완료 집계를 저장하고 외부 내보내기는 `exportStatus: NOT_CONFIGURED`로 명시
- Firestore Rules에 질문 공개 범위, 검토 권한, 강사 본인 읽음 상태, 종료 요약 읽기와 작성자·속도·감사 문서 전체 차단 경계 추가
- 질문 동시 멱등, 동일 참여자 동시 속도 제한, 질문과 종료 경합, 권한 회수, UID 비노출, 요약 불변성과 고아 문서 부재 테스트 추가
- Firebase 인증을 탭별 `browserSessionPersistence`로 유지하고 새로고침 시 익명 프로필을 다시 불러와 실제 강의 화면이 mock 화면으로 바뀌지 않도록 보완
- 390×844에서 질문·답변·별명 입력 컨트롤을 16px로 유지해 모바일 브라우저 자동 확대와 가로 넘침 방지
- 실제 Firebase, GCP, Gemini, Google API, 파일 업로드, 판서와 결과 내보내기 없이 로컬 Emulator에서만 구현

### 01-2A 동시 강의방 생성 안정화

- Firestore Emulator에서 같은 course·join code 트랜잭션이 동시에 읽기 잠금을 잡고 쓰기 잠금으로 승격하다 두 요청 모두 `Transaction lock timeout`에 빠지는 문제 수정
- 강의 스냅샷의 갱신 시각 조건과 `room`·`roomJoinCodes` 생성 쓰기를 하나의 원자적 Firestore 트랜잭션으로 묶어 한 요청만 커밋하도록 변경
- `google.api_core.exceptions.Aborted`, gRPC `StatusCode.ABORTED`와 실제 원인이 예외 체인에 있는 경우만 재시도하고 일반 `ValueError`는 그대로 유지
- SDK 내부 동일 트랜잭션 반복 대신 매번 새 트랜잭션으로 외부 재시도 최대 3회, 50/100/200ms 백오프와 최대 50% 무작위 지연 적용
- 오류 뒤 course·join-code·requested room을 단일 batch-get으로 다시 읽어 현재 요청의 완전한 연결은 `201`, 다른 요청 선점과 불일치는 `409`로 판정
- 재시도 소진 시 원본 Firestore 오류를 노출하지 않는 `503 temporarily_unavailable`과 `Retry-After: 1` 응답 추가
- 카탈로그와 수업 흐름 편집 화면의 생성 버튼을 공통 single-flight 훅으로 통합해 연속 클릭 시 POST 1회만 전송하고 실패 뒤 재시도와 언마운트 보호 제공
- 동시 같은 강의·코드 10개 격리 사례, 공유 코드 경쟁, 독립 생성과 고아 문서 부재 테스트를 추가하고 전체 Emulator 묶음을 새 환경에서 3회 연속 검증
- 개발 검증 중 읽기 잠금 기반의 초기 두 설계에서 `[503, 503]` 간헐 실패가 각각 1회 발생했으며, 조건부 원자 쓰기로 교체한 최종 구현에서는 격리 10회와 전체 3회 반복 모두 실패 0회 확인
- 프론트엔드 121개, 백엔드 단위 52개, Rules 22개, FastAPI·Emulator 26개 테스트 통과
- Cloud Run 다중 인스턴스에서 작동하지 않는 Python 전역 Lock과 프로세스 내부 Mutex는 사용하지 않음

### 01-2 사용자·역할·강의방·수업 흐름·체크리스트 실제 Emulator 전환

- Authentication Emulator에 회사 관리자·주 강사·권한 없는 보조 강사·일부 권한 보조 강사·다른 조직 강사 고정 계정과 익명 수강생 입장 구현
- `firebase-admin` `7.5.0`을 정확히 고정하고, `demo-nodo`와 loopback Emulator만 허용하는 FastAPI Admin 연결 추가
- Firebase ID Token Bearer 인증 뒤 `users/{uid}`의 조직·역할과 강의·강의방·담당자 문서를 매 요청마다 검사하는 서버 권한 경계 구현
- 보조 강사 위임 권한 12개를 강의방별 `staff` 문서에 저장하고, 01-2 기능 5개만 API·화면에 연결
- `/rooms/:roomId/staff`에서 보조 강사 초대, 개별·전체 권한 선택/해제, 저장 상태, 제거와 변경 로그 제공
- 참여 코드를 일반 강의방 문서에서 제거하고 서버 전용 `roomJoinCodes` 인덱스로 분리해 `canShareRoom` 없는 사용자의 우회 읽기 차단
- 자료 메타데이터를 `courses/{courseId}/materials/current`로 분리하고 수강생은 `isShared: true` 자료만 읽도록 Rules 적용
- 강의방 생성, 수업 흐름 교체, 자료·권한 변경과 순차 체크를 Firestore 트랜잭션으로 처리하고 강의–강의방 연결 무결성 검사
- 기존 항목 ID의 완료 상태를 보존하면서 흐름 순서 변경 뒤 `itemOrder`와 `currentItemId`를 같은 트랜잭션에서 재계산
- React가 강의방·강의·챕터·항목·담당자 권한을 `onSnapshot`으로 구독하고, 체크·편집·권한 변경은 FastAPI로만 요청하도록 전환
- 로그인 사용자에게 실제 강의 목록·생성·수업 흐름 편집·강의방·공유·권한 화면을 제공하고 익명 수강생에게 실시간 읽기 전용 체크리스트 제공
- Firestore Rules 기본 거부와 모든 중요 클라이언트 쓰기 차단을 유지하고 역할·조직·초대·참여 상태별 읽기 규칙 확대
- 질문과 채팅은 답변 완료·숨김·복구·단순 욕설·반복 차단을 포함한 브라우저 mock으로 유지하고 Firestore 전환은 01-3으로 이월
- `react-qr-code` `2.2.0`을 정확히 고정해 권한 있는 공유 화면에서 참여 링크의 스캔 가능한 SVG QR 생성
- 인증된 강의 목록에서 실제 수업 흐름 편집 화면으로 이동할 때 lazy 화면이 정상 로드되는 브라우저 회귀를 수정하고 전용 라우팅 테스트 추가
- 프론트엔드 일반 119개, Firestore·Storage Rules 22개, 백엔드 단위 34개, FastAPI·Emulator 15개 테스트 통과
- 실제 Firebase·GCP 프로젝트, 서비스 계정, Google API와 외부 AI는 사용하지 않음

### 01-1 로컬 Firebase Emulator 실제 연결 기반

- 완성된 NoDo_00의 의미 있는 파일을 해시로 기준선화하고, 의존성·빌드·가상환경·캐시·Emulator 데이터·실제 `.env`를 제외해 NoDo_01 생성
- 프로젝트 표시 버전을 `01`로 변경하고 NoDo_00 사용자 화면·mock 상태·80개 회귀 테스트 보존
- Firebase Web SDK `12.16.0`과 `@firebase/rules-unit-testing` `5.0.1`을 정확한 버전으로 고정하고 TypeScript `6.0.3` 유지
- named Firebase app과 전역 서비스별 연결 레지스트리로 React Strict Mode·HMR에서도 Auth·Firestore·Storage Emulator 중복 연결 방지
- 개발 모드, 프로젝트 ID `demo-nodo`, Emulator 활성화와 고정 `127.0.0.1` 포트를 초기화 전에 검사해 실제 클라우드 연결 차단
- 사용자 메뉴에 노출되지 않는 개발 전용 `/dev/emulator` 경로에서 익명 인증과 `emulatorChecks/{uid}` 작성·읽기·삭제 진단 제공
- Firestore는 인증 사용자의 본인 진단 문서와 허용된 `ownerUid`, `source`, `checkedAt` 필드만 허용하고 나머지는 기본 거부 유지
- Storage 전체 거부를 유지하고 비인증·다른 UID·추가 필드·다른 컬렉션·Storage 읽기와 쓰기 차단 통합 테스트 추가
- 일반 프론트엔드 89개, Emulator 통합 7개와 백엔드 5개 테스트 통과 확인
- `npm run test:emulator` 하나로 Emulator 시작·검증·종료 및 NoDo_01 소유의 잔여 Java 프로세스만 정리하도록 구성
- 강의·질문·역할·패널 상태의 기존 mock 데이터는 Firestore로 전환하지 않음

## 00

### 00-7B 패널 보기 기능 통합

- 별도로 존재하던 자료 영역 표시·숨김과 체크리스트·채팅 패널 전체 화면 버튼을 통합 토글 버튼 하나로 변경
- 일반 상태에서 `체크리스트 크게 보기` 또는 `채팅 크게 보기`, 확대 상태에서 `자료와 함께 보기` 문구 제공
- 실제 브라우저 Fullscreen API 없이 왼쪽 자료를 숨기고 오른쪽 패널이 작업 영역 전체 너비를 사용하는 방식 채택
- `isPanelExpanded` 단일 Context 상태와 `TOGGLE_PANEL_EXPANDED` 액션으로 중복 상태 제거
- 체크리스트와 채팅이 확대 상태를 공유하고 탭 이동 중 체크·질문·선택 항목을 유지하도록 구성
- PC·모바일 반응형 배치, 네이티브 버튼 키보드 조작, 포커스 표시와 `aria-pressed` 적용
- 통합 버튼과 상태 보존 회귀 테스트를 추가해 프론트엔드 전체 80개 테스트 통과 확인
- Firebase, Google Cloud, Gemini 또는 Google API 연결 없이 React mock 상태에서만 구현

### 00-7A 수업 흐름 순차 완료 체크 방식

- 수업 흐름 항목의 `UPCOMING`, `IN_PROGRESS`, `COMPLETED` 3단계 상태와 상태 선택 드롭다운 제거
- 항목 데이터는 `isCompleted` 불리언 값만 저장하고, 화면 표시 순서의 첫 번째 미완료 항목을 현재 진행 항목으로 자동 계산
- 현재 항목만 새로 완료할 수 있고 미래 항목의 체크박스는 비활성화하는 순차 체크 규칙 적용
- 완료 항목을 체크 해제하면 해당 항목과 이후 항목을 모두 미완료로 되돌리고 해당 항목을 새 현재 진행 항목으로 계산
- 완료·현재·미완료 카드와 자료 미리보기 상태를 구분하고, 전체 완료 시 진행률 100%와 완료 안내 표시
- 자료 선택 상태와 실제 현재 진행 상태를 분리하면서 질문 배지·채팅 연결과 강의 목록의 진행 중·완료 필터 유지
- selector·reducer·화면 통합 테스트를 보강하여 프론트엔드 전체 77개 테스트 통과 확인
- NoDo_01 이전용 기존 상태 변환 기준과 Firestore에서 지켜야 할 순차 완료 규칙을 문서화
- Firebase, Google Cloud, Gemini 또는 Google API 연결 없이 React mock 상태에서만 구현

### 00-7 v2 수업 흐름·체크리스트·채팅 화면 구현

- v2 `make Roadmap.pdf`를 기준으로 자료 기반·직접 제작·기존 목록 불러오기 수업 흐름 화면 구현
- 선택 파일의 이름과 형식만 브라우저 상태에 보관하고, 파일 내용 읽기·업로드 없이 mock AI 항목 생성 제공
- 챕터와 수업 흐름 항목의 추가, 항목 이름 수정·삭제·위아래 이동, 상태 변경과 강의 시작 동작 추가
- v2 `checklist.pdf`를 기준으로 현재 공유 자료, 미리보기, 챕터별 체크리스트, 질문 수와 자료·패널 표시 전환 구현
- v2 `chat.pdf`를 기준으로 항목 질문·일반 질문 작성, 강사 답변 완료, 검토 표시, 질문 숨김·복구 구현
- 단순 금칙어와 마지막 질문 반복 전송을 차단하는 개발용 mock 규칙 추가
- 강의·챕터·수업 흐름·질문·선택 상태를 화면 사이에서 공유하는 React Context 기반 mock 상태 구성
- PC 1440×900과 모바일 390×844에 맞춘 반응형 배치와 체크리스트·채팅 탭 이동 적용
- 기존 34개 회귀 테스트를 유지하고 24개 제작·강의 진행 테스트를 추가하여 전체 58개 통과 확인
- Firebase, Google Cloud, Google API, Gemini와 실제 서버 저장 없이 프론트엔드 브라우저 상태만 사용

### 00-6 v2 기존 목록 불러오기 화면 구현

- v2 `import.pdf`를 기준으로 `/courses/import` 기존 목록 불러오기 화면 구현
- 실제 저장 데이터 대신 별도 파일에 5개의 mock 강의 데이터 구성
- 공백을 정리하고 영문 대소문자를 구분하지 않는 검색, 진행 상태 필터와 최근·오래된·이름순 정렬 추가
- 전체 mock 데이터에서 계산한 전체·진행 중·완료 필터 개수 표시
- 접근 가능한 단일 목록 선택과 선택 전 비활성화되는 불러오기 버튼 적용
- 선택한 강의명과 ID를 표시하는 `/courses/:courseId/prepare` 다음 단계 안내 화면 추가
- 실제 준비 화면은 구현하지 않고 00-7 단계 대상으로 유지
- 데스크톱과 모바일 반응형 배치 및 키보드 조작 지원
- Firebase, Google Cloud와 실제 API 연결 없이 프론트엔드 mock 데이터만 사용

### 00-5 v2 시작 화면 구현

- v2 `Start.pdf`를 기준으로 `/` 시작 화면 구현
- 자료로 만들기, 직접 만들기, 기존 목록 불러오기 세 가지 시작 방식 추가
- 실제 개인정보와 저장 데이터 대신 별도 mock 사용자·최근 목록 데이터 사용
- `/create/material`, `/create/manual`, `/courses/import` 임시 경로와 시작 화면 복귀 동작 추가
- 데스크톱 3열, 태블릿 2열, 모바일 1열 반응형 카드 배치 적용
- PDF의 선형 아이콘과 가까운 아이콘을 사용하기 위해 `lucide-react` 1.24.0을 정확히 고정

### 00-4 Firebase Emulator 기본 골격

- Firebase CLI를 루트 개발 의존성으로 고정하고 로컬 실행 명령 추가
- 로컬 전용 프로젝트 ID `demo-nodo` 사용
- Authentication 9099, Firestore 8081, Storage 9199, Emulator UI 4000 포트 설정
- Firestore와 Storage의 모든 읽기·쓰기를 기본 거부하는 Rules 추가

### 00-3 코드 품질 검사 및 자동 테스트 환경

- ESLint와 TypeScript ESLint 기반 프론트엔드 lint 추가
- Vitest, React Testing Library, jest-dom과 jsdom 기반 프론트엔드 테스트 추가
- 홈 화면 상태 6개, 404 화면 3개와 라우팅 2개 시나리오 검증
- Ruff 기반 백엔드 lint와 pytest/httpx 기반 자동 테스트 추가
- 상태, 준비 상태, 버전 API와 허용·비허용 Origin CORS 동작 검증
- FastAPI, Uvicorn과 Python 개발 도구를 정확한 버전으로 고정
- 전이 의존성을 `requirements.lock`에 고정
- TypeScript ESLint의 공식 호환 범위를 지키기 위해 TypeScript를 7.0.2에서 6.0.3으로 변경
- TypeScript 버전 변경 후 프론트엔드 lint, test, build 통과 확인

### 00-2 프로젝트 기본 구조

- NoDo_00 최초 구조 생성
- React, Vite, TypeScript 기본 실행 구조 추가
- React Router 기반 루트 화면과 404 화면 추가
- FastAPI와 Uvicorn 기본 실행 구조 추가
- 상태, 준비 상태와 버전 확인 API 추가
- 실제 서비스 기능과 v2 디자인은 아직 구현하지 않음

### 02-7A 익명 수강생 입장과 별명 설정

- `/join/{orgId}/{roomCode}` 공개 최소 메타데이터, Firebase Anonymous Auth 기반 참가·재입장, 학생 대기 화면 추가
- 참가자 문서는 별명·정규화 키·서버 시각·`JOINED`·익명 여부만 기록하고, 최초 입장 때만 `PARTICIPANT_JOINED` 감사를 남김
- 공개 API는 방 제목·상태·입장 가능 여부와 학생 세션의 최소 정보만 반환하며 UID·이메일·원본 수업·강사 정보는 노출하지 않음
- 실제 Firestore 쓰기·Firebase/GCP 설정 변경·Git commit/push는 수행하지 않음

### 02-8A 실제 강의방 수업 시작과 진행 체크리스트

- cloud-auth `/rooms/{roomId}/checklist`와 FastAPI revision 기반 체크리스트 조회·시작·완료·되돌리기 API 추가
- `READY → LIVE` 시작, 첫 미완료 항목 계산, 현재 항목 순차 완료와 완료 항목 이후 일괄 되돌리기를 Firestore Transaction 계약으로 구현
- 주 강사만 진행을 변경하고 ADMIN은 운영 읽기만 허용하며, Anonymous 학생·다른 조직은 차단
- LIVE·가시 탭에서만 FastAPI revision polling을 수행하고 중복 요청·unmount timer·네트워크 오류의 마지막 정상 화면을 처리
- 로컬 Emulator·자동 테스트만 사용하며 실제 Firestore 진행 변경·Firebase/GCP 설정 변경·Git commit/push는 수행하지 않음

### 02-4A 조직 역할 단순화

- STAFF 조직 역할을 `ADMIN`/`INSTRUCTOR`로 통일하고, 관리자 변경 API를 revision 기반 Transaction으로 교체
- 최소 관리자 한 명을 보호하고 `ORGANIZATION_ADMIN_GRANTED`/`ORGANIZATION_ADMIN_REVOKED` 감사 이벤트 추가
- Emulator 전환 도구와 실제 Firestore 전환 전 수동 승인 절차 추가

### 02-11A 현재 접속 인원·방 정원·나가기

- 강의방별 `maxActiveParticipants` 기본 50명(1~300)과 생성 화면의 빠른 선택/직접 입력 추가
- private presence capacity 문서, ACTIVE/LEFT/EXPIRED lease, visible heartbeat, 즉시 나가기 및 재입장 정원 Transaction 추가
- 강사용 현재 접속/정원 표시와 PENDING 정원 초과 알림의 유지·상향 제어 추가
- 실제 Firestore·Firebase/GCP 변경 및 Git 반영 없이 로컬 계약·자동 테스트 범위로 한정

### 02-11D 현재 접속 인원·정원 운영 감사 로그

- 새 PENDING 정원 초과, 정원 유지·상향, ACTIVE→LEFT 나가기, LEFT/EXPIRED→ACTIVE 재입장, ACTIVE→EXPIRED lease 만료에만 최소 운영 감사 이벤트 추가
- heartbeat·중복 명령·동일 정원·이미 처리된 초과/만료 및 GET 정원 조회는 감사 이벤트를 남기지 않고, GET은 capacity/presence/alert 문서를 변경하지 않음
- 감사 문서에는 방·조직·시각·필요한 staff 내부 식별자·정원/상태 전환만 기록하며 익명 UID·이메일·토큰·질문 본문을 기록하지 않음
- operation ID 기반 고정 문서 경로로 Firestore Transaction 재시도에서도 동일 이벤트 중복 생성을 방지
