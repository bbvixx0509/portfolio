# 알림 정책. 임계값은 2026-08-31 부하·장애 실험에서 잰 기준선에서 잡았고, 근거는
# docs/sre-validation.md 에 있다. 콘솔에서 고치면 다음 apply 가 되돌리므로 여기서 고친다.
#
# Set existing verified notification channel IDs before applying production alerts.
locals {
  alert_policies = {
    api_5xx = {
      display_name = "FoodiGuard API 5xx 오류율"
      description  = "5분 평균 5xx 비율이 5% 초과"
      duration     = "300s"
      # 없는 5xx 분자는 0으로 처리하고 헬스체크는 사용자 오류율에서 제외한다.
      # 무트래픽/수집 중단은 별도 가용성 정책으로 감지한다.
      query = "((sum(rate(foodiguard_http_requests_total{cluster=\"${var.gke_cluster_name}\",namespace=\"${var.api_kubernetes_namespace}\",route!~\"/api/health.*\",status_class=\"5xx\"}[5m])) or vector(0)) / clamp_min(sum(rate(foodiguard_http_requests_total{cluster=\"${var.gke_cluster_name}\",namespace=\"${var.api_kubernetes_namespace}\",route!~\"/api/health.*\"}[5m])), 0.001)) > 0.05"
    }
    api_latency = {
      display_name = "FoodiGuard API p95 지연"
      description  = "route별 p95 응답시간이 1초 초과"
      duration     = "600s"
      # route 라벨은 쿼리 종류를 구분하지 않는다. /api/products 에는 24ms 인 기본 목록과
      # 300ms 대인 키워드 검색이 함께 들어가므로 p95 는 둘이 섞인 값이다.
      query = "histogram_quantile(0.95, sum by (le, route) (rate(foodiguard_http_request_duration_seconds_bucket{cluster=\"${var.gke_cluster_name}\",namespace=\"${var.api_kubernetes_namespace}\"}[5m]))) > 1"
    }
    db_latency = {
      display_name = "FoodiGuard DB p95 지연"
      description  = "operation별 p95 조회시간이 500ms 초과"
      duration     = "600s"
      query        = "histogram_quantile(0.95, sum by (le, operation) (rate(foodiguard_db_query_duration_seconds_bucket{cluster=\"${var.gke_cluster_name}\",namespace=\"${var.api_kubernetes_namespace}\"}[5m]))) > 0.5"
    }
    api_availability = {
      display_name = "FoodiGuard API 가용성"
      description  = "수집 대상이 3분간 응답 없음"
      # 파드 하나가 죽는 장애는 약 4초 만에 자동 복구된다(실측). 3분 조건은 그런 장애가
      # 아니라 지속되는 중단을 잡는다. 짧은 중단까지 보려면 외부 업타임 체크가 따로 필요하다.
      duration = "180s"
      query    = "(max(up{cluster=\"${var.gke_cluster_name}\",namespace=\"${var.api_kubernetes_namespace}\",job=\"foodiguard-api\"}) == 0) or absent(up{cluster=\"${var.gke_cluster_name}\",namespace=\"${var.api_kubernetes_namespace}\",job=\"foodiguard-api\"})"
    }
    container_restart = {
      display_name = "FoodiGuard 컨테이너 재시작"
      description  = "10분 내 컨테이너 재시작 발생"
      duration     = "0s"
      query        = "sum(increase(kube_pod_container_status_restarts_total{cluster=\"${var.gke_cluster_name}\",namespace=\"${var.api_kubernetes_namespace}\",pod=~\"foodiguard-api-.*|foodiguard-web-.*\"}[10m])) > 0"
    }
    data_freshness = {
      display_name = "FoodiGuard 알레르기 재계산 지연"
      description  = "기존 원재료 알레르기 재계산 성공 후 26시간 초과; 외부 원본 갱신이 아님"
      duration     = "600s"
      # 하루 한 번 도는 적재가 한 번 걸러도 26시간이면 걸린다. 적재가 멈춰도 API 는 200 을
      # 계속 돌려주므로 지연·오류 지표로는 드러나지 않는다. 실제로 30시간 관측 중 적재가
      # 나흘째 멈춰 있었는데 이 정책이 없어 아무도 몰랐다(2026-09-04).
      #
      # Never-successful and absent series are both actionable.
      query = "(time() - max(foodiguard_sync_last_success_timestamp_seconds{project_id=\"${var.project_id}\",cluster=\"${var.gke_cluster_name}\",namespace=\"${var.api_kubernetes_namespace}\",operation=\"allergen_projection\"})) > 93600 or max(absent(foodiguard_sync_last_success_timestamp_seconds{project_id=\"${var.project_id}\",cluster=\"${var.gke_cluster_name}\",namespace=\"${var.api_kubernetes_namespace}\",operation=\"allergen_projection\"}))"
    }
    data_quality_collection = {
      display_name = "FoodiGuard 데이터 품질 수집 중단"
      description  = "품질 DB 조회 성공이 15분 이상 없거나 지표가 없음"
      duration     = "300s"
      query        = "(time() - foodiguard_data_quality_last_refresh_timestamp_seconds{cluster=\"${var.gke_cluster_name}\",namespace=\"${var.api_kubernetes_namespace}\"}) > 900 or absent(foodiguard_data_quality_last_refresh_timestamp_seconds{cluster=\"${var.gke_cluster_name}\",namespace=\"${var.api_kubernetes_namespace}\"})"
    }
    sync_failure = {
      display_name = "FoodiGuard 알레르기 재계산 실패"
      description  = "최근 24시간 알레르기 재계산 실패 기록"
      duration     = "0s"
      query        = "foodiguard_sync_failures_24h{cluster=\"${var.gke_cluster_name}\",namespace=\"${var.api_kubernetes_namespace}\",operation=\"allergen_projection\"} > 0"
    }
    ingredient_match_ratio = {
      display_name = "FoodiGuard 원재료 매칭률 하락"
      description  = "매칭률이 0.95 미만"
      duration     = "600s"
      # 기준선 1.0(79,041건 전부 매칭). 5%p 하락이면 원재료 분석 파이프라인 이상으로 본다.
      query = "foodiguard_ingredient_match_ratio{cluster=\"${var.gke_cluster_name}\",namespace=\"${var.api_kubernetes_namespace}\"} < 0.95"
    }
    nutrition_missing_ratio = {
      display_name = "FoodiGuard 영양정보 누락률 상승"
      description  = "누락률이 1% 초과"
      duration     = "600s"
      # 기준선 0.0025%(79,041건 중 약 2건). 1% 는 400배 여유라 적재 사고만 잡는다.
      query = "foodiguard_nutrition_missing_ratio{cluster=\"${var.gke_cluster_name}\",namespace=\"${var.api_kubernetes_namespace}\"} > 0.01"
    }
  }
}

resource "google_monitoring_alert_policy" "foodiguard" {
  # Fresh projects reject PromQL referencing metrics that do not exist yet.
  for_each = { for name, policy in local.alert_policies : name => policy
    if var.create_application_alerts || contains(["api_availability", "container_restart"], name)
  }

  project               = var.project_id
  display_name          = each.value.display_name
  combiner              = "OR"
  enabled               = var.alerts_enabled
  notification_channels = [google_monitoring_notification_channel.primary.name]

  lifecycle {
    prevent_destroy = true
  }

  alert_strategy {
    notification_prompts = ["OPENED", "CLOSED"]
  }

  documentation {
    content   = each.value.description
    mime_type = "text/markdown"
  }

  conditions {
    display_name = each.value.description

    condition_prometheus_query_language {
      query               = each.value.query
      duration            = each.value.duration
      evaluation_interval = "60s"
    }
  }
}
