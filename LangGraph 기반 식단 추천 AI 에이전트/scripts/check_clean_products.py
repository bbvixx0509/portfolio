import argparse
import gzip
import json
from collections import Counter
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parents[1]
DEFAULT_PRODUCTS = BASE_DIR / "data" / "full_products.json"

FORBIDDEN_KEYWORDS = [
    "특수의료",
    "환자",
    "환자식",
    "환자용",
    "투석",
    "비투석",
    "암환자",
    "신장질환",
    "질환자",
    "영양조제",
    "메디푸드",
    "메디웰",
    "이유식",
    "영유아",
    "유아용",
    "소스",
    "양념",
    "분말",
    "파우더",
    "드레싱",
    "마요네즈",
    "초콜릿",
    "젤리",
    "사탕",
    "아이스크림",
    "반죽",
    "라이프샐러드",
    "김밥햄",
    "김밥용",
    "샌드위치용",
    "샌드위치햄",
    "샌드위치샐러드",
    "슬라이스햄",
    "햄슬라이스",
    "김밥단무지",
    "단무지",
    "맛살",
    "크래미",
    "참치캔",
    "캔참치",
    "어묵바",
    "핫바",
]

EXACT_FORBIDDEN_NAMES = [
    "라이프샐러드 L4 비투석",
    "라이프샐러드 L4 투석",
    "라이프샐러드 암환자식",
]


def product_text(product):
    return " ".join(
        [
            str(product.get("name", "")),
            str(product.get("product_name", "")),
            str(product.get("category", "")),
            str(product.get("maker", "")),
        ]
    )


def main():
    parser = argparse.ArgumentParser(description="Check clean FoodiGuard product data.")
    parser.add_argument("--products", default=str(DEFAULT_PRODUCTS), help="Path to full_products.json")
    args = parser.parse_args()

    products_path = Path(args.products)
    if not products_path.exists():
        products_path = products_path.with_name(products_path.name + ".gz")
    if products_path.suffix == ".gz":
        with gzip.open(products_path, "rt", encoding="utf-8") as file:
            products = json.load(file)
    else:
        products = json.loads(products_path.read_text(encoding="utf-8"))
    keyword_hits = Counter()
    exact_hits = []
    samples = []

    for product in products:
        text = product_text(product)
        name = str(product.get("name", ""))
        if name in EXACT_FORBIDDEN_NAMES:
            exact_hits.append(name)
        matched = [keyword for keyword in FORBIDDEN_KEYWORDS if keyword in text]
        if matched:
            for keyword in matched:
                keyword_hits[keyword] += 1
            if len(samples) < 10:
                samples.append(
                    {
                        "name": name,
                        "category": product.get("category", ""),
                        "matched": matched,
                    }
                )

    print(f"products: {len(products)}")
    print(f"exact_forbidden_hits: {len(exact_hits)}")
    print(f"keyword_hit_products: {sum(keyword_hits.values())}")
    if exact_hits:
        print("exact names:")
        for name in exact_hits:
            print(f"- {name}")
    if keyword_hits:
        print("keyword hits:")
        for keyword, count in keyword_hits.most_common():
            print(f"- {keyword}: {count}")
        print("samples:")
        for sample in samples:
            print(sample)
        raise SystemExit(1)
    print("clean check passed")


if __name__ == "__main__":
    main()
