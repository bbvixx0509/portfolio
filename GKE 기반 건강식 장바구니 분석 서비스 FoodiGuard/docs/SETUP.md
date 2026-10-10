# 26-1 Cloud Capstone — FoodiGuard

클라우드 기반 건강식 장바구니 분석 및 대체상품 추천 서비스입니다.
식약처 통합식품영양성분 DB와 품목제조보고 원재료 DB를 매칭한 식품 79,041건(분해 원재료 90만 행)과
건강기능식품 45,593건을 기반으로
식품 검색, 개별 식품 점수, 원재료·알레르기 분석, 장바구니 영양 분석을 제공합니다.

## 저장소 구조

| 경로 | 설명 |
| --- | --- |
| `mobile/` | Expo(React Native) 모바일 앱 — iOS·Android·웹 지원 |
| `backend/` | Node.js(Express) API 서버 — PostgreSQL 식품 DB 조회, 인증, AI 코치 |
| `docs/`, `k8s/`, `infra/`, `Jenkinsfile` | GCP 배포 아키텍처 문서 및 배포 설정 |

## 데이터베이스 준비 (Docker)

백엔드는 새 식품 DB 스키마(`food_products`, `food_ingredients`, `ingredient_source_rows`,
`food_product_versions`, `sync_runs`)를 사용합니다. 팀에서 공유하는 덤프 파일로 복원하세요.

```bash
# 1. PostgreSQL 17 컨테이너 생성
docker run -d --name foodiguard-db -e POSTGRES_PASSWORD=foodiguard -e POSTGRES_DB=foodiguard -p 5432:5432 postgres:17

# 2. 덤프 무결성 확인 후 컨테이너로 복사 (파일명은 공유받은 날짜 기준)
docker cp foodiguard-20260817.dump foodiguard-db:/tmp/

# 3. 복원 (약 1~2분 소요, 총 약 215만 행 · 867MB)
docker exec foodiguard-db pg_restore -U postgres -d foodiguard --no-owner --no-privileges /tmp/foodiguard-20260817.dump
```

## 실행 방법

```bash
# 백엔드 (8080) — 먼저 backend/.env 를 .env.example 참고해 작성 (DB_PASSWORD 등)
cd backend
npm install
npm run db:migrate
npm start

# 모바일 앱 (8081, 웹 미리보기)
cd mobile && npm install && npm run web
```

브라우저에서 `http://localhost:8081` 접속. 폰에서 보려면 `npx expo start` 후 Expo Go로 QR 스캔.

- 테스트 계정: `test@foodiguard.kr` / `test1234`

위 계정은 로컬 데모 데이터용입니다. 2026-10-02 새 GCP 프로젝트에는 식품 데이터만
복원했으므로 회원가입을 통해 새 계정을 만듭니다.

### iOS·Android에서 GKE API 사용

로컬 PostgreSQL과 백엔드를 띄우지 않고 현재 GKE API와 Cloud SQL을 사용하는 실행 방법입니다.
먼저 별도 터미널에서 GKE API 터널을 열어 둡니다.

```bash
gcloud container clusters get-credentials foodiguard-cluster \
  --region=asia-northeast3 \
  --project=foodigard

# GKE가 Pod를 교체해 연결이 끊겨도 자동 재연결
bash mobile/scripts/gke-api-tunnel.sh
```

```bash
cd mobile
npm ci

# iOS Simulator
EXPO_PUBLIC_API_BASE_URL=http://127.0.0.1:18081/api npm run ios

# Android Emulator: 10.0.2.2는 Android에서 Mac 호스트를 가리킨다.
# iOS Metro(8081)와 동시에 실행할 수 있도록 Android는 8082 사용.
npm run android:gke
```

이 경로는 `Simulator/Emulator → Mac 터널 → GKE API Pod → Cloud SQL Proxy → Cloud SQL`로
연결된다. 실제 기기 배포 전에는 도메인과 HTTPS 인증서를 붙인 뒤
`EXPO_PUBLIC_API_BASE_URL`을 HTTPS 주소로 변경해야 합니다.

### Jenkins 접속

Jenkins VM의 8080은 인터넷에 공개하지 않습니다. IAP 터널을 실행한 터미널을 열어 둔 뒤
`http://127.0.0.1:18082`로 접속합니다.

```bash
gcloud compute start-iap-tunnel jenkins-vm 8080 \
  --local-host-port=127.0.0.1:18082 \
  --zone=asia-northeast3-a \
  --project=foodigard
```

새 프로젝트에서 Jenkins 관리자 계정도 다시 설정했습니다. 복구 방법과 비밀 파일의
보관 위치는 [Terraform 운영 안내](../infra/gcp/terraform/README.md)를 따릅니다.

현재 GCP 웹 주소는 `http://<EXTERNAL_IP>`입니다. 새 프로젝트를 다시 만들면 IP가
변경될 수 있습니다. 도메인·HTTPS는 아직 구성하지 않았습니다.

## 배포 (Docker Compose)

서버 한 대만 있으면 웹·API·DB 세 컨테이너를 한 번에 띄울 수 있습니다.
배포용 덤프(`foodiguard-deploy-*.dump`, 압축 22MB)는 앱이 실제로 조회하는 데이터만 담아
무료 PostgreSQL(500MB~1GB)에도 들어가며 복원도 수 분이면 끝납니다.

| 덤프 | DB 크기 | 담긴 내용 |
| --- | --- | --- |
| 전체 (`foodiguard-20260817.dump`) | 867MB | 식품 79,041건 + 원재료 원본 105만 행 + 건강기능식품 (증분 갱신·재매칭용) |
| 배포용 (`foodiguard-deploy-20260817.dump`) | 271MB | 위에서 미참조 원본 행·데이터 이력을 제거한 앱 구동용 |

```bash
# 1. DB만 먼저 기동 (db-data 볼륨에 보존)
DB_PASSWORD=원하는비밀번호 docker compose up -d db

# 2. 슬림 덤프 복원 (최초 1회)
docker cp foodiguard-deploy-20260817.dump $(docker compose ps -q db):/tmp/
docker compose exec db pg_restore -U postgres -d foodiguard --no-owner --no-privileges /tmp/foodiguard-deploy-20260817.dump

# 3. 스키마 마이그레이션 성공 후 API와 웹 기동
DB_PASSWORD=원하는비밀번호 docker compose up --build --abort-on-container-exit --exit-code-from migrate migrate
DB_PASSWORD=원하는비밀번호 docker compose up -d --build --no-deps api web
```

`http://서버주소`로 접속합니다. 포트를 바꾸려면 `WEB_PORT=8090 docker compose up -d`.
웹 컨테이너는 `/api` 요청을 `API_UPSTREAM`으로 프록시하므로, GKE처럼 백엔드가 다른 곳에 있으면
`API_UPSTREAM` 환경변수만 바꾸면 됩니다(기본값은 GKE 서비스 주소).

API 시작 시에는 DB 스키마를 자동 변경하거나 샘플 데이터를 넣지 않습니다. 마이그레이션은
`npm run db:migrate`로 분리했고, 데모 데이터가 꼭 필요한 로컬 환경에서만
`SEED_DEMO_DATA=true npm run db:seed-demo`를 명시적으로 실행합니다.

상태 확인 엔드포인트는 프로세스 생존 확인용 `/api/health/live`와 DB·필수 스키마 준비 확인용
`/api/health/ready`로 분리되어 있습니다. 기존 `/api/health`도 호환 목적으로 유지합니다.

## 주요 기능

- 식품 검색: 원재료 분석 완료 식품 79,041건 검색 (pg_trgm 인덱스, 띄어쓰기 무시 정규화)
- 개별 식품 점수: 영양성분 + 원재료 파생 플래그(첨가당·감미료·정제탄수화물·나트륨 첨가물·보존료) 반영
- 원재료 상세: 표시 순서 그대로 전체 원재료, 알레르기 경고(16종), 데이터 변경 이력
- 알레르기 제외 검색: 분석 완료 식품만 대상으로 안전하게 제외 (`?excludeAllergens=밀,우유`)
- 장바구니 분석: 권장량 대비 누적 영양, 위험도, 대체식품 추천, Gemini 기반 AI 코치 설명

## 기술 스택

- 모바일: React Native (Expo), React 19
- 백엔드: Node.js, Express, PostgreSQL 17 (pg_trgm)
- AI: Gemini (Vertex AI)
- 인프라: GCP — GKE, Cloud SQL, Artifact Registry, Jenkins CI/CD
