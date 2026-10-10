# NoDo 자원 경계

## 소유권 표

| 구분 | NoDo가 관리하는 자원 | NoDo 접근 금지 자원 |
| --- | --- | --- |
| Firebase Web App | NoDo Web Dev | 다른 서비스 Web App |
| Firestore 데이터베이스 | `(default)` | `other-service` |
| Firestore 데이터 | `organizations/{orgId}` 및 `organizations/demo/courses/{courseId}` | `demo_other-service_internal` |
| Storage | 향후 `example-gcp-project-nodo-materials` | `example-gcp-project-other-service-materials` 및 `lectures/{강의ID}/materials/...` |
| 서버·작업·서비스 계정 | 향후 `nodo-*` | `other-service-*` |

Firestore **데이터베이스 ID가 주요 분리 경계**입니다. `(default)` 안에서는 NoDo가 `organizations/{orgId}`를 자기 서비스 데이터의 시작점으로 사용합니다. 컬렉션 이름은 데이터 정리 단위일 뿐, 다른 Firestore 데이터베이스를 대신하는 보안 경계가 아닙니다. NoDo는 `(default)`의 기존 `organizations/demo`, 사용자, 초대, 역할, 감사 로그와 수업 흐름을 이동·삭제하지 않습니다.

## 공용 인증과 서비스 권한

Firebase Authentication은 공유 프로젝트의 공용 자원입니다. Google 사용자 목록, Google·Anonymous 제공업체와 승인 도메인은 NoDo가 단독 변경하지 않습니다. 로그인 성공은 NoDo 권한을 뜻하지 않습니다. FastAPI는 ID Token을 검증한 뒤 `users/{uid}`와 `organizations/demo`를 기준으로 다음을 확인합니다.

- `orgId`가 `demo`
- 조직 구성원이며 `accountType: STAFF`
- `organizationRole`이 `ADMIN` 또는 `INSTRUCTOR`
- Anonymous 학생 계정이 아님

NoDo의 `ADMIN`과 `INSTRUCTOR`는 앱 화면의 업무 권한입니다. 이 역할은 Firestore Rules 배포, IAM, Cloud Run, 결제 또는 Firebase Console 권한을 자동으로 부여하지 않습니다. 개발 PC의 ADC는 로컬 개발·검증용이며 운영 배포 권한과 분리합니다.

## NoDo 관리 범위

- `(default)`의 NoDo 문서 생성·조회·수정·`ARCHIVED` 처리와 NoDo 데이터 마이그레이션
- `organizations/demo` 아래 조직·구성원·초대·강의·수업 흐름·감사 로그 관리
- NoDo 전용 Rules·Indexes와 데이터 구조의 검토·배포 준비
- 향후 NoDo 전용 Storage 버킷, Cloud Run, Cloud Tasks, 서비스 계정과 로그·환경 변수 관리

다른 서비스의 데이터베이스, 컬렉션, 버킷, 버킷 내부 경로, Cloud Run과 서비스 계정에는 읽기·쓰기·목록 조회를 포함한 모든 접근을 금지합니다. 실행 코드, 환경 예시와 배포 설정에는 다른 서비스 자원명을 넣지 않습니다.

## 승인 원칙과 미래 명명 규칙

다음은 NoDo 자원이라도 별도 명시 승인이 필요한 파괴적·공용 영향 작업입니다.

- Firestore 데이터베이스 삭제, 대규모 삭제 또는 전체 데이터 이전
- Rules 전체 교체·배포와 Indexes 배포
- Storage 버킷 생성·삭제·IAM 변경
- Cloud Run·Cloud Tasks·서비스 계정 생성·삭제·IAM 변경
- Firebase Auth 제공업체·승인 도메인 변경, 결제·프로젝트 설정 변경

미래 NoDo 운영 자원은 Storage 버킷 `example-gcp-project-nodo-materials`, Cloud Run·Cloud Tasks·서비스 계정 `nodo-*`를 사용합니다. 이름만 분리하지 않고 Cloud Run 서비스 계정에는 `(default)`의 NoDo 문서와 NoDo 전용 Storage 버킷에 필요한 최소 권한만 부여합니다. 프로젝트 전체 Editor 권한, 사람 계정 공유, 다른 서비스 버킷·데이터베이스 권한은 허용하지 않습니다.
