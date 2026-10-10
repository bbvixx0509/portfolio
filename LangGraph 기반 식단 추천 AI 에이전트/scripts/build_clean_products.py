import argparse
import csv
import json
from collections import Counter
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parents[1]
# 원본 CSV(식품의약품안전처 식품영양성분DB)는 용량이 커서 저장소에 포함하지 않음
DEFAULT_SOURCE = BASE_DIR / "data" / "raw" / "식품영양성분DB정보.csv"
DEFAULT_OUTPUT = BASE_DIR / "data" / "full_products.json"


FIELD = {
    "code": "식품코드[FOOD_CD]",
    "name": "식품명[FOOD_NM_KR]",
    "group": "데이터구분명[DB_GRP_NM]",
    "cat1": "식품대분류명[FOOD_CAT1_NM]",
    "cat2": "식품중분류명[FOOD_CAT2_NM]",
    "cat3": "식품소분류명[FOOD_CAT3_NM]",
    "cat4": "식품세분류명[FOOD_CAT4_NM]",
    "ref_name": "대표식품명[FOOD_REF_NM]",
    "serving": "영양성분함량기준량[SERVING_SIZE]",
    "calories": "에너지(kcal)[AMT_NUM1]",
    "protein": "단백질(g)[AMT_NUM3]",
    "fat": "지방(g)[AMT_NUM4]",
    "carbs": "탄수화물(g)[AMT_NUM6]",
    "sugar": "당류(g)[AMT_NUM7]",
    "fiber": "식이섬유(g)[AMT_NUM8]",
    "sodium": "나트륨(mg)[AMT_NUM13]",
    "cholesterol": "콜레스테롤(mg)[AMT_NUM23]",
    "saturated_fat": "포화지방산(g)[AMT_NUM24]",
    "trans_fat": "트랜스지방산(g)[AMT_NUM25]",
    "weight": "식품중량[FOOD_SIZE]",
    "maker": "제조사명[MAKER_NM]",
    "company": "업체명[COMPANY_NM]",
    "source": "출처명[SUB_REF_NAME]",
    "method": "데이터생성방법명[CRT_MTH_NM]",
}


PRIMARY_CATEGORIES = {"즉석조리식품", "즉석섭취식품"}
EXTRA_CATEGORIES = {"신선편의식품", "간편조리세트"}

MEAL_KEYWORDS = [
    "도시락",
    "볶음밥",
    "비빔밥",
    "덮밥",
    "컵밥",
    "국밥",
    "김밥",
    "주먹밥",
    "샐러드",
    "샌드위치",
    "찌개",
    "전골",
    "곰탕",
    "설렁탕",
    "삼계탕",
    "갈비탕",
    "감자탕",
    "미역국",
    "된장국",
    "콩나물국",
    "북엇국",
    "순댓국",
    "육개장",
    "어묵탕",
    "매운탕",
]

BREAKFAST_KEYWORDS = [
    "시리얼",
    "씨리얼",
    "우유",
    "두유",
    "요거트",
    "요구르트",
]

MEDICAL_EXCLUDE_KEYWORDS = [
    "특수의료용도식품",
    "환자용 식품",
    "환자용",
    "환자식",
    "일반 환자",
    "암환자",
    "신장질환",
    "질환자",
    "당뇨",
    "투석",
    "비투석",
    "영양조제식품",
    "영양조제",
    "균형영양",
    "특수영양식품",
    "고령자용",
    "고령자",
    "시니어",
    "메디푸드",
    "메디웰",
    "MEDIWELL",
    "체중조절용 조제식품",
]

INFANT_EXCLUDE_KEYWORDS = [
    "이유식",
    "영유아",
    "영·유아",
    "유아용",
    "무른밥",
    "초기",
    "중기",
    "후기",
    "완료기",
]

NON_MEAL_EXCLUDE_KEYWORDS = [
    "소스",
    "양념",
    "분말",
    "파우더",
    "시즈닝",
    "드레싱",
    "마요네즈",
    "과자",
    "쿠키",
    "초콜릿",
    "젤리",
    "사탕",
    "디저트",
    "아이스크림",
    "도시락김",
    "조미김",
    "구운김",
    "김자반",
    "김밥김",
    "죽염",
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

REQUIRED_NUTRIENTS = ["calories", "protein", "sugar", "sodium"]
JUK_FALSE_POSITIVES = ["죽순", "반죽", "죽염"]


def clean_text(value):
    if value is None:
        return ""
    return str(value).strip()


def number(value):
    text = clean_text(value).replace(",", "")
    if not text:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def normalize_name(value):
    return clean_text(value).replace("_", " ").replace("  ", " ").strip()


def row_value(row, key):
    return clean_text(row.get(FIELD[key], ""))


def category(row):
    return (
        row_value(row, "cat4")
        or row_value(row, "cat3")
        or row_value(row, "cat2")
        or row_value(row, "cat1")
        or "식품"
    )


def row_text(row):
    keys = ["name", "cat1", "cat2", "cat3", "cat4", "ref_name", "maker", "company"]
    return " ".join(row_value(row, key) for key in keys)


def has_juk_meal(name):
    if "죽" not in name:
        return False
    return not any(word in name for word in JUK_FALSE_POSITIVES)


def has_meal_keyword(name):
    return any(keyword in name for keyword in MEAL_KEYWORDS) or has_juk_meal(name)


def is_ingredient_only_name(name):
    if any(keyword in name for keyword in NON_MEAL_EXCLUDE_KEYWORDS):
        return True
    return False


def has_required_nutrients(row):
    return all(number(row.get(FIELD[key])) is not None for key in REQUIRED_NUTRIENTS)


def is_included(row):
    name = row_value(row, "name")
    cat3 = row_value(row, "cat3")
    if is_ingredient_only_name(name):
        return False
    if cat3 in PRIMARY_CATEGORIES or cat3 in EXTRA_CATEGORIES:
        return True
    if has_meal_keyword(name):
        return True
    return any(keyword in name for keyword in BREAKFAST_KEYWORDS)


def exclusion_reason(row):
    text = row_text(row)
    name = row_value(row, "name")
    category_text = " ".join(row_value(row, key) for key in ["cat1", "cat2", "cat3", "cat4", "ref_name"])

    if is_ingredient_only_name(name):
        return "non_meal:ingredient_only"

    for keyword in MEDICAL_EXCLUDE_KEYWORDS:
        if keyword in text:
            return f"medical:{keyword}"

    for keyword in INFANT_EXCLUDE_KEYWORDS:
        if keyword in text:
            return f"infant:{keyword}"

    for keyword in NON_MEAL_EXCLUDE_KEYWORDS:
        if keyword in name or keyword in category_text:
            return f"non_meal:{keyword}"

    return ""


def infer_meal_slots(row):
    name = row_value(row, "name")
    cat3 = row_value(row, "cat3")
    slots = set()

    if any(keyword in name for keyword in BREAKFAST_KEYWORDS):
        slots.add("breakfast")
    if any(keyword in name for keyword in ["샌드위치", "계란", "달걀"]) or has_juk_meal(name):
        slots.add("breakfast")
    if any(keyword in name for keyword in ["도시락", "볶음밥", "비빔밥", "덮밥", "컵밥", "김밥", "주먹밥", "샐러드", "샌드위치"]):
        slots.add("lunch")
    if any(keyword in name for keyword in ["도시락", "볶음밥", "비빔밥", "덮밥", "컵밥", "국밥"]):
        slots.update(["lunch", "dinner"])
    if any(keyword in name for keyword in ["찌개", "전골", "곰탕", "설렁탕", "삼계탕", "갈비탕", "감자탕", "미역국", "된장국", "콩나물국", "북엇국", "순댓국", "육개장", "어묵탕", "매운탕"]):
        slots.add("dinner")
    if cat3 in PRIMARY_CATEGORIES or cat3 in EXTRA_CATEGORIES:
        if not slots:
            slots.update(["lunch", "dinner"])
        elif any(keyword in name for keyword in ["도시락", "볶음밥", "비빔밥", "덮밥", "컵밥"]):
            slots.update(["lunch", "dinner"])
    if not slots:
        slots.update(["lunch", "dinner"])

    order = ["breakfast", "lunch", "dinner"]
    return [slot for slot in order if slot in slots]


def build_nutrients(row):
    return {
        "calories": number(row.get(FIELD["calories"])),
        "protein": number(row.get(FIELD["protein"])),
        "fat": number(row.get(FIELD["fat"])),
        "carbs": number(row.get(FIELD["carbs"])),
        "sugar": number(row.get(FIELD["sugar"])),
        "fiber": number(row.get(FIELD["fiber"])),
        "sodium": number(row.get(FIELD["sodium"])),
        "cholesterol": number(row.get(FIELD["cholesterol"])),
        "saturatedFat": number(row.get(FIELD["saturated_fat"])),
        "transFat": number(row.get(FIELD["trans_fat"])),
    }


def build_product(row, index):
    name = normalize_name(row.get(FIELD["name"]))
    maker = row_value(row, "maker") or row_value(row, "company")
    return {
        "id": f"FG07-DB-{index:05d}",
        "source_id": row_value(row, "code"),
        "name": name,
        "product_name": name,
        "category": category(row),
        "meal_slots": infer_meal_slots(row),
        "ingredients": "",
        "maker": maker,
        "brand": "",
        "store": "식품영양성분DB",
        "serving": row_value(row, "serving") or "100g 기준",
        "food_weight": row_value(row, "weight"),
        "price": None,
        "link": "",
        "match_status": "PUBLIC_NUTRITION_DB_CLEAN",
        "match_score": 100.0,
        "nutrients": build_nutrients(row),
    }


def dedupe_key(row):
    code = row_value(row, "code")
    if code:
        return code
    return "|".join([normalize_name(row.get(FIELD["name"])), category(row), row_value(row, "serving")])


def load_clean_products(source_path):
    selected = {}
    stats = Counter()
    excluded = Counter()

    with Path(source_path).open("r", encoding="utf-8-sig", newline="") as file:
        reader = csv.DictReader(file)
        for row in reader:
            stats["source_rows"] += 1

            if not is_included(row):
                stats["not_meal_like"] += 1
                continue

            stats["meal_like"] += 1

            if not has_required_nutrients(row):
                stats["missing_required_nutrients"] += 1
                continue

            reason = exclusion_reason(row)
            if reason:
                stats["excluded"] += 1
                excluded[reason] += 1
                continue

            key = dedupe_key(row)
            if key not in selected:
                selected[key] = row
            else:
                stats["duplicate"] += 1

    rows = list(selected.values())
    rows.sort(key=lambda row: (category(row), normalize_name(row.get(FIELD["name"]))))
    products = [build_product(row, index + 1) for index, row in enumerate(rows)]
    stats["selected"] = len(products)
    return products, stats, excluded


def main():
    parser = argparse.ArgumentParser(description="Build clean FoodiGuard product data.")
    parser.add_argument("--source", default=str(DEFAULT_SOURCE), help="Path to 식품영양성분DB정보.csv")
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT), help="Output JSON path")
    args = parser.parse_args()

    products, stats, excluded = load_clean_products(args.source)
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(products, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"source: {args.source}")
    print(f"output: {output_path}")
    print(f"selected: {len(products)}")
    print("stats:")
    for key, value in stats.most_common():
        print(f"- {key}: {value}")
    print("excluded top:")
    for key, value in excluded.most_common(30):
        print(f"- {key}: {value}")


if __name__ == "__main__":
    main()
