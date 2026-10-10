# 화면 표시 이름
MEAL_LABELS = {
    "breakfast": "아침",
    "lunch": "점심",
    "dinner": "저녁",
}

NUTRIENT_LABELS = {
    "calories": "열량",
    "sugar": "당류",
    "sodium": "나트륨",
    "protein": "단백질",
}

GOAL_LABELS = {
    "blood_sugar": "혈당관리형",
    "low_sodium": "저나트륨형",
    "weight_control": "체중관리형",
}

# 점수 기준
GOAL_WEIGHTS = {
    "blood_sugar": {"sugar": 0.45, "protein": 0.35, "sodium": 0.20},
    "low_sodium": {"sodium": 0.55, "protein": 0.25, "sugar": 0.20},
    "weight_control": {"sugar": 0.40, "protein": 0.35, "sodium": 0.25},
}

MEAL_TARGET_GROUPS = {
    "breakfast": ["곡류", "고기·생선·계란·콩류", "채소류"],
    "lunch": ["곡류", "고기·생선·계란·콩류", "채소류"],
    "dinner": ["곡류", "고기·생선·계란·콩류", "채소류"],
}

# 끼니별 검색 키워드
MEAL_KEYWORDS = {
    "breakfast": ["죽", "샌드위치", "시리얼", "씨리얼", "요거트", "요구르트", "우유", "두유", "계란", "달걀"],
    "lunch": ["도시락", "볶음밥", "비빔밥", "덮밥", "컵밥", "김밥", "주먹밥", "샐러드", "샌드위치"],
    "dinner": ["국밥", "찌개", "탕", "전골", "곰탕", "설렁탕", "삼계탕", "갈비탕", "감자탕", "덮밥", "볶음밥", "비빔밥", "도시락"],
}

MEAL_PRIMARY_KEYWORDS = {
    "breakfast": ["죽", "시리얼", "씨리얼", "요거트", "요구르트", "우유", "두유", "계란", "달걀"],
    "lunch": ["도시락", "볶음밥", "비빔밥", "덮밥", "컵밥", "김밥", "주먹밥"],
    "dinner": ["국밥", "찌개", "탕", "전골", "곰탕", "설렁탕", "삼계탕", "갈비탕", "감자탕"],
}

MEAL_SECONDARY_KEYWORDS = {
    "breakfast": ["샌드위치", "샐러드"],
    "lunch": ["샌드위치", "샐러드", "국밥"],
    "dinner": ["덮밥", "볶음밥", "비빔밥", "도시락"],
}

MEAL_NEGATIVE_KEYWORDS = {
    "breakfast": ["도시락", "볶음밥", "비빔밥", "덮밥", "국밥", "찌개", "전골", "감자탕", "매운탕", "곰탕", "설렁탕"],
    "lunch": ["시리얼", "씨리얼", "요거트", "요구르트", "우유"],
    "dinner": ["시리얼", "씨리얼", "요거트", "요구르트", "우유", "샌드위치"],
}

# 식사 형태와 밥 조합 키워드
COMPLETE_MEAL_KEYWORDS = [
    "도시락",
    "볶음밥",
    "비빔밥",
    "덮밥",
    "컵밥",
    "국밥",
    "샐러드",
    "김밥",
    "샌드위치",
    "영양밥",
]

SELF_CONTAINED_MEAL_KEYWORDS = [
    "도시락",
    "볶음밥",
    "비빔밥",
    "덮밥",
    "컵밥",
    "국밥",
    "김밥",
    "샌드위치",
]

RICE_PAIR_KEYWORDS = [
    "국",
    "찌개",
    "탕",
    "전골",
    "곰탕",
    "설렁탕",
]

SOUP_STEW_KEYWORDS = [
    "미역국",
    "콩나물국",
    "북엇국",
    "소고기무국",
    "된장국",
    "청국장",
    "찌개",
    "김치찌개",
    "된장찌개",
    "순두부찌개",
    "곰탕",
    "설렁탕",
    "삼계탕",
    "갈비탕",
    "감자탕",
    "전골",
]

RICE_KEYWORDS = [
    "햇반",
    "즉석밥",
    "쌀밥",
    "백미밥",
    "현미밥",
    "잡곡밥",
    "흑미밥",
    "보리밥",
]

# 제외 조건
EXCLUDE_CATEGORIES = {
    "영·유아용 이유식",
}

EXCLUDE_KEYWORDS = [
    "이유식",
    "무른밥",
    "초기",
    "중기",
    "후기",
    "완료기",
    "투석",
    "비투석",
    "암환자",
    "환자식",
    "환자용",
    "특수의료",
    "영양조제",
    "신장질환",
    "질환자",
    "메디푸드",
]

JUK_FALSE_POSITIVES = ["죽순", "반죽", "죽염"]

INGREDIENT_ONLY_KEYWORDS = [
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

MEAL_CONTAINER_KEYWORDS = [
    "도시락",
    "볶음밥",
    "비빔밥",
    "덮밥",
    "컵밥",
    "국밥",
    "김밥",
    "주먹밥",
    "샌드위치",
    "샐러드",
    "죽",
    "찌개",
    "탕",
    "전골",
]


def number(value, default=0):
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def score_low(value, good, ok):
    if value <= good:
        return 100
    if value <= ok:
        return 70
    return 30


def score_high(value, good, ok):
    if value >= good:
        return 100
    if value >= ok:
        return 70
    return 30


def product_text(product):
    return " ".join(
        [
            str(product.get("name", "")),
            str(product.get("product_name", "")),
            str(product.get("category", "")),
            str(product.get("ingredients", "")),
        ]
    )


def has_juk_meal_text(text):
    if "죽" not in text:
        return False
    return not any(word in text for word in JUK_FALSE_POSITIVES)


def is_ingredient_only(product):
    text = product_text(product)
    if any(keyword in text for keyword in INGREDIENT_ONLY_KEYWORDS):
        return True
    if "햄" in text and not any(keyword in text for keyword in MEAL_CONTAINER_KEYWORDS):
        return True
    return False


def find_food_groups(product, food_groups):
    text = product_text(product)
    matched = []

    for group in food_groups:
        keywords = group.get("keywords", [])
        if any(keyword in text for keyword in keywords):
            matched.append(group["group"])

    return matched


def add_food_groups(products, food_groups):
    result = []
    for product in products:
        groups = find_food_groups(product, food_groups)
        result.append({**product, "food_groups": groups})
    return result


def nutrition_score(product, goal):
    # 목표에 맞는 영양 점수 계산
    nutrients = product.get("nutrients", {})
    sugar = number(nutrients.get("sugar"))
    sodium = number(nutrients.get("sodium"))
    protein = number(nutrients.get("protein"))

    detail = {
        "sugar": score_low(sugar, 5, 15),
        "sodium": score_low(sodium, 300, 800),
        "protein": score_high(protein, 15, 7),
    }
    weights = GOAL_WEIGHTS.get(goal, GOAL_WEIGHTS["blood_sugar"])
    return round(sum(detail[key] * weights[key] for key in weights), 1)


def meal_match_score(product, meal, request_terms):
    # 끼니와 질문 조건이 얼마나 맞는지 계산
    text = product_text(product)
    score = 0

    if is_ingredient_only(product):
        return -100
    if any(keyword in text for keyword in MEAL_PRIMARY_KEYWORDS.get(meal, [])):
        score += 35
    if any(keyword in text for keyword in MEAL_SECONDARY_KEYWORDS.get(meal, [])):
        score += 15
    if meal in product.get("meal_slots", []):
        score += 5
    if any(keyword in text for keyword in MEAL_NEGATIVE_KEYWORDS.get(meal, [])):
        score -= 20
    for term in request_terms:
        if term and term in text:
            score += 30

    return score


def total_score(product, meal, goal, request_terms):
    food_score = nutrition_score(product, goal)
    match_score = meal_match_score(product, meal, request_terms)
    return round(min(100, food_score + match_score), 1)


def raw_total_score(product, meal, goal, request_terms):
    food_score = nutrition_score(product, goal)
    match_score = meal_match_score(product, meal, request_terms)
    return round(food_score + match_score, 1)


def is_complete_meal(product):
    # 완성 식사형인지 확인
    if is_ingredient_only(product):
        return False
    text = product_text(product)
    return any(keyword in text for keyword in COMPLETE_MEAL_KEYWORDS) or has_juk_meal_text(text)


def needs_rice_pair(product):
    # 밥을 같이 안내해야 하는지 확인
    if is_ingredient_only(product):
        return False
    text = product_text(product)
    if any(keyword in text for keyword in SELF_CONTAINED_MEAL_KEYWORDS) or has_juk_meal_text(text):
        return False
    return any(keyword in text for keyword in SOUP_STEW_KEYWORDS)


def is_rice_product(product):
    text = product_text(product)
    if any(keyword in text for keyword in ["&", "+", "도시락", "볶음밥", "비빔밥", "덮밥", "국밥", "김밥", "삼각김밥", "닭가슴살"]):
        return False
    return "곡류" in product.get("food_groups", []) and any(keyword in text for keyword in RICE_KEYWORDS)


def is_excluded_product(product):
    # 추천에서 제외할 식품 확인
    category = str(product.get("category", ""))
    text = product_text(product)
    return category in EXCLUDE_CATEGORIES or is_ingredient_only(product) or any(keyword in text for keyword in EXCLUDE_KEYWORDS)


def select_best_product(products, meal, goal, request_terms, required_group=None, complete_only=False):
    # 조건에 맞는 가장 좋은 식품 선택
    candidates = []

    for product in products:
        if is_excluded_product(product):
            continue
        if complete_only and not is_complete_meal(product):
            continue
        if required_group and required_group not in product.get("food_groups", []):
            continue
        score = total_score(product, meal, goal, request_terms)
        raw_score = raw_total_score(product, meal, goal, request_terms)
        candidates.append({
            **product,
            "score": score,
            "raw_score": raw_score,
            "nutrition_score": nutrition_score(product, goal),
        })

    if not candidates:
        return None
    return sorted(candidates, key=lambda item: (item["raw_score"], item["nutrition_score"]), reverse=True)[0]


def select_rice_product(products, goal):
    # 국, 찌개류 보완용 밥 예시
    return {
        "id": "FG-RULE-RICE-001",
        "name": "밥 1공기",
        "product_name": "식품구성자전거 1회 분량 예시: 밥 1공기(210g)",
        "category": "식품구성자전거 보완",
        "serving": "1공기(210g)",
        "nutrients": {},
        "score": "기준 보완",
        "raw_score": 0,
        "nutrition_score": 0,
        "selected_group": "곡류",
        "selected_groups": ["곡류"],
        "pair_reason": "국·찌개·탕류는 단독보다 밥과 함께 한 끼로 구성하는 것이 자연스러워 식품구성자전거의 곡류 1회 분량을 보완했습니다.",
    }


def select_requested_rice_pair_product(products, meal, goal, request_terms):
    # 사용자가 국, 찌개류를 요청했을 때 후보 선택
    if "국밥" in request_terms:
        return None
    pair_terms = [term for term in request_terms if term in RICE_PAIR_KEYWORDS]
    if not pair_terms:
        return None

    candidates = []
    for product in products:
        if is_excluded_product(product) or not needs_rice_pair(product):
            continue
        text = product_text(product)
        if not any(term in text for term in pair_terms) and not any(term in text for term in SOUP_STEW_KEYWORDS):
            continue
        score = total_score(product, meal, goal, request_terms)
        raw_score = raw_total_score(product, meal, goal, request_terms)
        candidates.append({
            **product,
            "score": score,
            "raw_score": raw_score,
            "nutrition_score": nutrition_score(product, goal),
        })

    if not candidates:
        return None
    return sorted(candidates, key=lambda item: (item["raw_score"], item["nutrition_score"]), reverse=True)[0]


def build_meal_plan(products, food_groups, meal, goal, request_terms):
    # 한 끼 추천 구성
    target_groups = MEAL_TARGET_GROUPS.get(meal, MEAL_TARGET_GROUPS["lunch"])

    if meal in ["breakfast", "lunch", "dinner"]:
        product = select_requested_rice_pair_product(products, meal, goal, request_terms)
        if not product:
            product = select_best_product(products, meal, goal, request_terms, complete_only=True)
        if not product:
            product = select_best_product(products, meal, goal, request_terms)
        if not product:
            return []

        product_groups = [
            item for item in target_groups
            if item in product.get("food_groups", [])
        ]
        product_needs_rice = needs_rice_pair(product)
        if product_needs_rice and not product_groups:
            product_groups = ["국·찌개·탕류"]
        elif not product_groups:
            product_groups = [target_groups[0]]
        selected = [{
            **product,
            "selected_group": ", ".join(product_groups),
            "selected_groups": product_groups,
        }]

        if product_needs_rice and "곡류" not in product_groups:
            rice_product = select_rice_product(products, goal)
            if rice_product and rice_product.get("id") != product.get("id"):
                selected.insert(0, rice_product)

        covered_groups = set()
        for item in selected:
            covered_groups.update(item.get("selected_groups", []))
        missing_groups = [group for group in target_groups if group not in covered_groups]
        for item in selected:
            item["missing_groups"] = missing_groups

        return selected

    selected = []
    covered_groups = set()
    used_ids = set()

    for group in target_groups:
        if group in covered_groups:
            continue
        product = select_best_product(products, meal, goal, request_terms, required_group=group)
        if not product or product.get("id") in used_ids:
            continue

        product_groups = [
            item for item in target_groups
            if item in product.get("food_groups", [])
        ]
        if not product_groups:
            product_groups = [group]

        selected.append({
            **product,
            "selected_group": ", ".join(product_groups),
            "selected_groups": product_groups,
            "missing_groups": [item for item in target_groups if item not in product_groups],
        })
        covered_groups.update(product_groups)
        used_ids.add(product.get("id"))

    if selected:
        return selected

    product = select_best_product(products, meal, goal, request_terms)
    return [product] if product else []


def get_group_rule(food_groups, group_name):
    for group in food_groups:
        if group.get("group") == group_name:
            return group
    return {}


def build_rule_summary(food_groups, selected_products):
    # 식품군 기준 설명 만들기
    lines = []
    used_groups = []

    for product in selected_products:
        group_names = product.get("selected_groups") or [product.get("selected_group") or (product.get("food_groups") or ["기타"])[0]]
        for group_name in group_names:
            if group_name in used_groups:
                continue
            used_groups.append(group_name)
            rule = get_group_rule(food_groups, group_name)
            if not rule:
                continue
            frequency = rule.get("recommended_frequency", "")
            roles = ", ".join(rule.get("roles", [])[:2])
            lines.append(f"- {group_name}: {frequency} / 역할: {roles}")

    return "\n".join(lines)
