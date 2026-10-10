# NoDo_02 구조

## 루트

- `README.md`: Emulator, 실제 Google·Anonymous 인증, Firestore 조직 Bootstrap과 직원 가입 실행·보안 범위
- `VERSION.txt`: 앱 표시 버전 `02`
- `CHANGELOG.md`: 단계별 변경 기록
- `MIGRATION.md`: 다음 버전과 운영 환경으로 옮길 때의 데이터·보안 기준
- `package.json`, `package-lock.json`: Firebase CLI와 Emulator 명령
- `firebase.json`, `.firebaserc`: 로컬 Emulator와 `demo-nodo` 설정
- `firestore.rules`: 계정 유형·방별 담당 관계·참여·질문·읽음·요약 읽기 경계와 전체 클라이언트 쓰기 거부
- `firebase.cloud.json`, `firestore.cloud.rules`: 실제 `(default)` Firestore의 최소 조직 읽기와 브라우저 전체 쓰기·목록·초대·감사 접근 거부
- `firestore.indexes.json`: 필요한 명시적 Firestore 인덱스
- `storage.rules`: Storage 전체 접근 거부
- `scripts/run-emulator-tests.ps1`: Emulator 묶음 시작·반복·정리
- `scripts/run-emulator-suite.ps1`: Rules, 반복 seed, FastAPI 통합·동시성 검증 순서

루트 npm 프로젝트는 Firebase 로컬 도구 전용이다. React 의존성은 `web/package.json`에서 별도로 관리한다.

## web

React, TypeScript 6.0.3, Vite, React Router와 CSS Modules 기반 프론트엔드다.

- `src/app`: 앱 공급자와 라우팅
- `src/pages`: 로그인, 강의, 학생 참여, 체크리스트, 채팅, 종료 리포트, 자료 선택, `OrganizationMembersPage`와 `OrganizationJoinPage`
- `src/features/auth`: Emulator 계정과 cloud-auth Google 세션, 영구 STAFF·초대 수락 필요 상태, FastAPI 재검증, 일반 STAFF·조직 소유자 보호 경로
- `src/features/organization`: 소유자 구성원·초대 목록/등록/취소와 초대받은 직원 가입 수락용 FastAPI 클라이언트
- `src/features/live-course`: Emulator 실제 강의 기능
  - `courseItemNumbers.ts`: 챕터·항목 `(order, id)` 순서로 `1.1`, `1.2` 표시 번호 계산
  - `useLiveQuestions.ts`: 권한에 맞는 공개·검토 질문과 강사별 읽음 상태 실시간 구독
  - `LiveQuestionPanel.tsx`: 일반 질문방·번호가 있는 항목 질문 작성, 안정 정렬된 질문별 답변, 승인, 숨김·복구, 필터
  - `LiveCourseCatalogPage.tsx`: 방별 주·보조 강사 관계를 표시하고 본인 staff collection-group 구독으로 초대·회수 반영
  - `RoomParticipantsPanel.tsx`: UID를 받지 않는 참여자 목록과 질문 제한
  - 강의방·체크리스트 구독 및 순차 체크 UI
- `src/features/demo-course`: 비로그인 NoDo_00 디자인 회귀용 브라우저 mock. 로그인한 실제 강의방의 01-3 질문 저장과 구분한다.
- `src/lib/firebase`: 기본 `demo-nodo` Emulator 경계와 별도 cloud-auth App·Authentication 전용 브라우저 초기화
- `src/lib/api`: Firebase ID Token을 Bearer로 전달하는 FastAPI 클라이언트
- `emulator-tests/firebaseEmulator.test.ts`: Firestore·Storage Rules 경계 테스트
- `emulator-tests/firestoreCloudRules.test.ts`: Production Rules에서 본인·조직 단건 외 user list·staffInvitations·auditLogs·미구현 경로와 모든 쓰기 차단 테스트

Emulator 강의 화면은 허용된 Firestore 문서를 `onSnapshot`으로 읽지만 질문 작성, 답변·검토, 읽음 갱신, 참여자 제한과 종료는 모두 FastAPI로 보낸다. Cloud-auth의 조직 구성원·초대 화면은 Firestore를 직접 초기화·구독·쓰기하지 않고 모든 데이터를 FastAPI로만 주고받는다.

## backend

FastAPI, Firebase Admin SDK와 Firestore Emulator 기반 서버다.

- `app/api/routes.py`: 시스템, cloud-auth 조직 Bootstrap·구성원·직원 초대/수락, 강의, 강의방, 질문, 참여자, 종료·리포트 HTTP 경로
- `app/api/dependencies.py`: Bearer 토큰 검증과 현재 사용자 주입
- `app/domain/authorization.py`: 2개 계정 유형, `LEAD | ASSISTANT` 방 관계, 방 상태, 12개 권한과 10개 연결 권한
- `app/domain/questions.py`: 질문 텍스트 정리, 금칙어·검토어, 유사도와 공개 필드 허용 목록
- `app/domain/staff_invitations.py`: 회사 이메일 정규화, 결정적 초대·감사 ID, 상태·만료·문서 무결성 검사
- `app/domain/schemas.py`: 요청 길이·형식·추가 필드 거부
- `app/domain/checklist.py`: 순차 완료 불변식
- `app/services/nodo_service.py`: 계정 유형·조직·방별 담당 관계·권한·상태 판정
- `app/adapters/firebase_emulator.py`: 공개 질문과 서버 전용 작성자 분리, 서버 항목 번호 스냅샷, 원자적 질문·속도 기록, 방 관계 답변 스냅샷, 감사 로그, 읽음, 참여자 제한, 2단계 종료와 요약 트랜잭션
- `app/adapters/firebase_cloud_auth.py`: 서비스 계정 JSON 없이 실제 Firebase ID Token 서명을 확인하는 Authentication 전용 어댑터
- `app/adapters/firebase_cloud_firestore.py`: ADC와 별도 named app을 사용하는 실제 `(default)` Firestore Transaction 어댑터
- `app/services/cloud_auth_service.py`: Google 제공업체·이메일 인증, 영구 owner/STAFF, Bootstrap·직원 초대 수락 필요 상태 판정
- `app/services/cloud_organization_service.py`: 실제 조직 Bootstrap과 영구 소유자 문서 일관성 조정
- `app/services/cloud_staff_service.py`: 02-3 구성원·초대 조회, 소유자 초대·취소와 직원 가입 수락 Transaction 조정
- `app/scripts/seed_emulator.py`: 반복 가능한 `accountType` 계정·방별 담당 관계·강의·권한·질문 컬렉션 초기화
- `tests/test_cloud_staff.py`, `tests/test_cloud_staff_api.py`: 02-3 이메일·권한·멱등·동시성·수락 Transaction과 HTTP 경계
- `tests`: 나머지 도메인·API 단위 테스트
- `tests/emulator`: Auth·Firestore·FastAPI 실제 경계와 동시성 테스트

트랜잭션 충돌에는 프로세스 Lock을 쓰지 않는다. 새 Firestore 트랜잭션으로 제한된 `ABORTED` 재시도를 수행하고, 멱등 키와 권위 문서를 다시 읽어 성공·충돌을 판정한다.

## Firestore 책임 분리

```text
organizations/{orgId}                         # 실제 조직·ownerUid
  staffInvitations/{invitationId}             # 서버 전용 PENDING/ACCEPTED/REVOKED
  auditLogs/{eventId}                         # Bootstrap·직원 초대 서버 전용 감사
users/{uid}                                    # 영구 owner/일반 STAFF

rooms/{roomId}/questions/{questionId}          # Emulator 실시간 공개 질문 상태
                                                # itemNumberSnapshot, answer.roomRole 포함
rooms/{roomId}/questionAuthors/{questionId}    # 작성 UID·clientRequestId, 서버 전용
rooms/{roomId}/questionRateLimits/{uid}        # 속도·유사 질문 판정, 서버 전용
rooms/{roomId}/questionReads/{staffUid}/contexts/{contextId}
rooms/{roomId}/moderationLogs/{logId}          # 서버 전용 감사
rooms/{roomId}/serverState/termination         # 최초 종료 실행자·상태, 서버 전용
rooms/{roomId}/summary/current                 # 종료 시 고정되는 요약
```

## docs

- `ROLES_AND_PERMISSIONS.md`: 계정 유형·방별 담당 관계, 12개 권한과 01-3A 연결 상태
- `API_CONTRACT.md`: 요청·응답, 오류, 질문·종료 API 계약
- `FIRESTORE_SCHEMA.md`: 공개·서버 전용 문서, Rules와 트랜잭션 불변식
- `DECISIONS.md`: 구현 판단과 보안 결정

## 실제 연결과 의도적으로 없는 연결

`cloud-auth` 브라우저는 승인된 기존 Firebase 프로젝트의 Google·Anonymous Authentication만 초기화한다. FastAPI는 ID Token 검증용 named app과 ADC 기반 실제 Firestore용 named app을 분리한다. 02-2는 조직 소유자, 02-3은 회사 직원 초대·일반 STAFF 가입만 실제 Firestore에 저장한다.

구성원 관리 `/organization/members`는 조직 소유자 전용이고 `/join-organization`은 유효한 PENDING 초대를 가진 Google 사용자의 명시적 수락 화면이다. 가입 뒤 일반 STAFF는 시작·STAFF 보호 경로를 사용하지만 구성원 관리에는 접근하지 못한다.

이메일 발송, 직원 제거, 조직 관리자 지정·해제, 소유권 이전, 실제 강의·질문·체크 데이터 이전, Storage, App Check, Analytics, Firebase Hosting, Cloud Run 배포, Cloud Tasks, Gemini, Google Drive·Slides·Sheets API, 실제 파일 업로드, 판서와 결과 내보내기는 연결하지 않는다. Emulator 업무 기능은 기본 모드에만 남고 cloud-auth 브라우저에서 Firestore SDK를 직접 사용하지 않는다. 종료 요약의 `exportStatus: "NOT_CONFIGURED"`가 외부 내보내기 미연결 상태를 명시한다.

02-4에서는 `cloud_staff_service.py`가 조직 관리자 권한 변경과 초대 관리 권한을 조정한다. `OrganizationMembersPage`는 소유자에게만 관리자 지정·해제 버튼을 표시하고, 회사 관리자는 같은 화면에서 초대 관리만 한다. 실제 Firestore 변경은 FastAPI의 ADC Admin SDK Transaction만 사용한다.
