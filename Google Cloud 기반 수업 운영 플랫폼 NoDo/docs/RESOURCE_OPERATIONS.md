# NoDo 운영 권한 분리

| 역할 | NoDo 앱 데이터 관리 | NoDo 조직 관리 | Rules·Indexes 배포 | Storage 관리 | Cloud Run 배포 | IAM 변경 | Firebase Auth 제공업체 변경 | 결제·프로젝트 변경 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| NoDo ADMIN | 허용 | 허용 | 불가 | 불가 | 불가 | 불가 | 불가 | 불가 |
| NoDo INSTRUCTOR | 본인 수업 흐름·강의 운영만 | 불가 | 불가 | 불가 | 불가 | 불가 | 불가 | 불가 |
| NoDo 배포 운영 계정 | 서버 운영 범위에서만 | 앱 화면 권한으로 대신하지 않음 | 승인 후 허용 | 승인 후 NoDo 버킷만 | 승인 후 허용 | 승인 후 최소 범위만 | 불가 | 불가 |
| NoDo Cloud Run 서비스 계정 | 서버 요청 처리 범위만 | 앱 역할과 무관 | 불가 | 미래 NoDo 버킷 최소 권한만 | 불가 | 불가 | 불가 | 불가 |
| 프로젝트 공용 운영자 | 필요 시 점검 | 앱 권한으로 대신하지 않음 | 명시 승인 후 | 명시 승인 후 | 명시 승인 후 | 명시 승인 후 | 명시 승인 후 | 명시 승인 후 |

## 운영 원칙

- NoDo ADMIN/INSTRUCTOR와 GCP IAM 주체는 서로 다른 권한 체계다. 앱 역할을 GCP 역할에 매핑하거나 Cloud Run 서비스 계정에 연결하지 않는다.
- 배포 운영 계정은 실제 배포를 수행할 때만 사용하며, Firebase CLI에는 NoDo 전용 config와 프로젝트 ID를 함께 명시한다.
- Cloud Run 서비스 계정은 사람 계정이나 NoDo ADMIN이 아니다. 서비스별 최소 권한을 사용하고 프로젝트 전체 Editor 권한을 부여하지 않는다.
- Firebase Authentication은 공유 프로젝트 자원이므로 사용자 삭제, 제공업체·승인 도메인 변경은 프로젝트 공용 운영자와 별도 승인 절차가 필요하다.
- Storage 버킷·Cloud Run·Cloud Tasks·IAM은 현재 생성하지 않는다. 생성 승인 뒤에도 `nodo-*`와 NoDo 전용 버킷으로 범위를 한정한다.

## Firestore 배포 절차

NoDo는 `firebase.nodo.json`만 사용하며 이 파일은 `(default)` 데이터베이스, `firestore.nodo.rules`, `firestore.nodo.indexes.json`을 명시합니다. 기본 `firebase.json`은 Emulator 전용이며 실제 프로젝트 배포에 사용하지 않습니다.

```powershell
# 실제 배포는 별도 승인 후에만 실행합니다.
firebase deploy --config firebase.nodo.json --project example-gcp-project --only firestore:rules,firestore:indexes
```

Database ID를 생략한 배포, 다른 서비스 config 사용, Storage·Hosting·Functions를 함께 배포하는 명령은 금지합니다. 실제 Rules/Indexes 배포 전에는 변경 diff, 대상 프로젝트, `(default)` Database ID, 영향 범위와 롤백 계획을 검토합니다.
