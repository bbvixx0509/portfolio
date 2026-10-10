# Existing operational and data-quality dashboards. Import both before any
# apply; a display name alone is not enough to adopt an existing dashboard.

resource "google_monitoring_dashboard" "operations" {
  project = var.project_number

  dashboard_json = jsonencode({
    displayName = "Foodigard"
    mosaicLayout = {
      columns = 48
      tiles = [
        {
          width  = 24
          height = 16
          widget = {
            title = "요청량(RPS)"
            xyChart = {
              dataSets = [{
                timeSeriesQuery = { prometheusQuery = "sum(rate(foodiguard_http_requests_total[5m]))" }
                plotType        = "LINE"
                targetAxis      = "Y1"
              }]
              yAxis        = { scale = "LINEAR" }
              chartOptions = { mode = "COLOR" }
            }
          }
        },
        {
          xPos   = 24
          width  = 24
          height = 16
          widget = {
            title = "5xx 오류율(%):"
            xyChart = {
              dataSets = [{
                timeSeriesQuery = { prometheusQuery = "100 *\nsum(rate(foodiguard_http_requests_total{status_class=\"5xx\"}[5m]))\n/\nclamp_min(sum(rate(foodiguard_http_requests_total[5m])), 0.001)" }
                plotType        = "LINE"
                targetAxis      = "Y1"
              }]
              yAxis        = { scale = "LINEAR" }
              chartOptions = { mode = "COLOR" }
            }
          }
        },
        {
          yPos   = 16
          width  = 24
          height = 16
          widget = {
            title = "API p95 응답시간:"
            xyChart = {
              dataSets = [{
                timeSeriesQuery = { prometheusQuery = "histogram_quantile(\n  0.95,\n  sum by (le, route) (\n    rate(foodiguard_http_request_duration_seconds_bucket[5m])\n  )\n)" }
                plotType        = "LINE"
                targetAxis      = "Y1"
              }]
              yAxis        = { scale = "LINEAR" }
              chartOptions = { mode = "COLOR" }
            }
          }
        },
        {
          xPos   = 24
          yPos   = 16
          width  = 24
          height = 16
          widget = {
            title = "DB p95 조회시간"
            xyChart = {
              dataSets = [{
                timeSeriesQuery = { prometheusQuery = "histogram_quantile(\n  0.95,\n  sum by (le, operation) (\n    rate(foodiguard_db_query_duration_seconds_bucket[5m])\n  )\n)" }
                plotType        = "LINE"
                targetAxis      = "Y1"
              }]
              yAxis        = { scale = "LINEAR" }
              chartOptions = { mode = "COLOR" }
            }
          }
        },
      ]
    }
  })

  lifecycle {
    prevent_destroy = true
  }
}

# Data quality catches failures that can remain invisible in API latency and
# availability metrics.
#
# 이 영역은 장애가 아니라 조용한 부패를 본다. 적재가 멈추거나 원재료 매칭이 틀어져도
# API 는 200 을 계속 돌려주므로 지연·오류 지표로는 드러나지 않는다.
resource "google_monitoring_dashboard" "data_quality" {
  project = var.project_number

  dashboard_json = jsonencode({
    displayName = "FoodiGuard 데이터 품질"
    mosaicLayout = {
      columns = 48
      tiles = [
        {
          width  = 24
          height = 16
          widget = {
            title = "원재료 매칭률"
            xyChart = {
              dataSets = [{
                timeSeriesQuery = { prometheusQuery = "foodiguard_ingredient_match_ratio" }
                plotType        = "LINE"
                targetAxis      = "Y1"
              }]
              yAxis        = { scale = "LINEAR" }
              chartOptions = { mode = "COLOR" }
            }
          }
        },
        {
          xPos   = 24
          width  = 24
          height = 16
          widget = {
            title = "영양성분 누락률"
            xyChart = {
              dataSets = [{
                timeSeriesQuery = { prometheusQuery = "foodiguard_nutrition_missing_ratio" }
                plotType        = "LINE"
                targetAxis      = "Y1"
              }]
              yAxis        = { scale = "LINEAR" }
              chartOptions = { mode = "COLOR" }
            }
          }
        },
        {
          yPos   = 16
          width  = 24
          height = 16
          widget = {
            # 증분 적재가 성공한 뒤 흐른 시간. 적재기가 멈추면 이 선만 계속 올라간다.
            # 시계열이 아예 비어 있으면 적재가 한 번도 성공한 적이 없다는 뜻이다.
            title = "마지막 증분 적재 이후 경과(시간)"
            xyChart = {
              dataSets = [{
                timeSeriesQuery = { prometheusQuery = "(time() - foodiguard_data_last_success_timestamp_seconds) / 3600" }
                plotType        = "LINE"
                targetAxis      = "Y1"
              }]
              yAxis        = { scale = "LINEAR" }
              chartOptions = { mode = "COLOR" }
            }
          }
        },
        {
          xPos   = 24
          yPos   = 16
          width  = 24
          height = 16
          widget = {
            # 알레르기 제외가 실제로 쓰이는 빈도. 0 이 계속되면 기능이 노출되지 않았거나
            # 프로필에 회피 성분을 넣은 사용자가 없다는 뜻이라, 품질 판단의 전제가 달라진다.
            title = "알레르기 제외 사용 빈도(회/초)"
            xyChart = {
              dataSets = [{
                timeSeriesQuery = { prometheusQuery = "sum(rate(foodiguard_allergen_exclusions_total[30m]))" }
                plotType        = "LINE"
                targetAxis      = "Y1"
              }]
              yAxis        = { scale = "LINEAR" }
              chartOptions = { mode = "COLOR" }
            }
          }
        },
      ]
    }
  })

  lifecycle {
    prevent_destroy = true
  }
}
