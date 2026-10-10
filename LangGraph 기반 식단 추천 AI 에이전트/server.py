import json
import mimetypes
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from meal_recommendation_agent import DEFAULT_GROUPS, DEFAULT_PRODUCTS, build_app, run_recommendation
from health_profile import build_health_profile


BASE_DIR = Path(__file__).resolve().parent
WEB_DIR = BASE_DIR / "web"
PORT = 8008
APP = build_app()


def split_csv(value):
    return [item.strip() for item in value.split(",") if item.strip()]


def make_product_item(product):
    nutrients = product.get("nutrients", {})
    return {
        "name": product.get("name"),
        "group": product.get("selected_group", "식품"),
        "serving": product.get("serving", "100g 기준"),
        "score": product.get("score"),
        "sugar": nutrients.get("sugar"),
        "sodium": nutrients.get("sodium"),
        "protein": nutrients.get("protein"),
        "reasons": product.get("reasons", []),
        "pair_reason": product.get("pair_reason", ""),
    }


class MealRecommendHandler(BaseHTTPRequestHandler):
    def send_json(self, status, data):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, file_path):
        if not file_path.exists() or not file_path.is_file():
            self.send_json(404, {"error": "file not found"})
            return
        body = file_path.read_bytes()
        content_type = mimetypes.guess_type(str(file_path))[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/health":
            self.send_json(200, {"ok": True})
            return
        if parsed.path in ["", "/"]:
            self.send_file(WEB_DIR / "index.html")
            return
        safe_name = parsed.path.lstrip("/").replace("\\", "/")
        if ".." in safe_name:
            self.send_json(400, {"error": "bad path"})
            return
        self.send_file(WEB_DIR / safe_name)

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path != "/api/recommend":
            self.send_json(404, {"error": "not found"})
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(length).decode("utf-8")
            data = json.loads(body)

            gender = data.get("gender", "남자")
            age = int(data.get("age", 34))
            height = float(data.get("height", 173))
            weight = float(data.get("weight", 72))
            avoid = split_csv(data.get("avoid", ""))
            question = data.get("question", "").strip()

            if not question:
                self.send_json(400, {"error": "질문을 입력해주세요."})
                return

            profile = build_health_profile(gender, age, height, weight, avoid)
            result = run_recommendation(APP, profile, question, DEFAULT_PRODUCTS, DEFAULT_GROUPS)
            products = [make_product_item(item) for item in result.get("recommendations", [])[:3]]

            self.send_json(
                200,
                {
                    "profile": result.get("profile", profile),
                    "intent": result.get("intent", {}),
                    "products_count": len(result.get("products", [])),
                    "candidates_count": len(result.get("candidates", [])),
                    "removed_count": len(result.get("removed_products", [])),
                    "recommendations": products,
                    "ai_explanation": result.get("ai_explanation", ""),
                    "answer": result.get("answer", ""),
                    "response_type": result.get("response_type", "recommend"),
                },
            )
        except Exception as exc:
            self.send_json(500, {"error": str(exc)})


def main():
    server = ThreadingHTTPServer(("127.0.0.1", PORT), MealRecommendHandler)
    print(f"식단 추천 에이전트 웹앱: http://127.0.0.1:{PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
