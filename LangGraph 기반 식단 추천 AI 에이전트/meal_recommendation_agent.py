import argparse
import re
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any, Dict, List, TypedDict

from langgraph.graph import END, StateGraph

from data_loader import filter_avoid_foods, load_food_groups, load_products
from food_group_rules import (
    MEAL_LABELS,
    add_food_groups,
    build_rule_summary,
    is_complete_meal,
    is_ingredient_only,
    meal_match_score,
    needs_rice_pair,
    nutrition_score,
    product_text,
    select_rice_product,
)
from health_profile import build_health_profile
from llm_chains import analyze_question_with_llm, generate_explanation_with_llm


BASE_DIR = Path(__file__).resolve().parent
DEFAULT_PRODUCTS = BASE_DIR / "data" / "full_products.json"
DEFAULT_GROUPS = BASE_DIR / "data" / "food_groups.json"


# 그래프에서 사용하는 상태값
class MealRecommendationState(TypedDict, total=False):
    profile: Dict[str, Any]
    question: str
    intent: Dict[str, Any]
    products_path: str
    groups_path: str
    products: List[Dict[str, Any]]
    food_groups: List[Dict[str, Any]]
    safe_products: List[Dict[str, Any]]
    removed_products: List[Dict[str, Any]]
    candidates: List[Dict[str, Any]]
    scored_products: List[Dict[str, Any]]
    recommendations: List[Dict[str, Any]]
    ai_explanation: str
    answer: str
    response_type: str


# 제외할 단어
BAD_KEYWORDS = [
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

# 끼니별 검색 키워드
MEAL_FOOD_KEYWORDS = {
    "breakfast": ["죽", "샌드위치", "시리얼", "씨리얼", "계란", "달걀", "요거트", "요구르트", "우유", "두유"],
    "lunch": ["도시락", "볶음밥", "비빔밥", "덮밥", "컵밥", "김밥", "주먹밥", "샐러드", "샌드위치"],
    "dinner": ["국밥", "찌개", "탕", "전골", "곰탕", "설렁탕", "삼계탕", "갈비탕", "감자탕", "덮밥", "볶음밥", "비빔밥", "도시락"],
}

# 요청할 수 있는 식품 형태
FORM_TERMS = ["도시락", "김밥", "샐러드", "샌드위치", "국밥", "찌개", "덮밥", "볶음밥"]

# 화면에 보여줄 식품군
DISPLAY_GROUPS = [
    "곡류",
    "고기·생선·계란·콩류",
    "채소류",
    "과일류",
    "우유·유제품류",
]

# 요청별 점수 기준
STRATEGY_GOALS = {
    "default": "blood_sugar",
    "low_sodium": "low_sodium",
    "moderate_sodium": "blood_sugar",
    "low_sugar": "blood_sugar",
    "protein_focus": "blood_sugar",
    "light_meal": "weight_control",
}

# 비슷한 이름 비교용 단어
VARIANT_WORDS = [
    "곰곰",
    "치즈",
    "렌틸콩",
    "귀리",
    "현미",
    "흑미",
    "카무트",
    "토마토",
    "플러스",
    "오리지널",
    "맛",
]


def split_csv(value):
    return [item.strip() for item in value.split(",") if item.strip()]


def only_number_text(value):
    return "".join(ch for ch in value if ch.isdigit() or ch == ".")


def number(value, default=0):
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def has_bad_keyword(product):
    # 추천에서 제외할 식품 확인
    if is_ingredient_only(product):
        return True
    text = product_text(product)
    return any(keyword in text for keyword in BAD_KEYWORDS)


def is_meal_like(product):
    # 식사 후보인지 확인
    if is_ingredient_only(product):
        return False
    text = product_text(product)
    if is_complete_meal(product) or needs_rice_pair(product):
        return True
    return any(keyword in text for keyword in ["밥", "면", "국수", "라면", "스프", "스튜"])


def get_display_group(product):
    groups = [group for group in product.get("food_groups", []) if group in DISPLAY_GROUPS]
    if groups:
        return ", ".join(groups)
    if needs_rice_pair(product):
        return "국·찌개·탕류"
    return "식품"


def get_request_terms(intent):
    terms = []
    terms.extend(intent.get("food_terms", []))
    terms.extend(intent.get("reduce_targets", []))
    return [term for term in terms if term]


def food_group_score(product, meal):
    # 식품군 기준 점수
    groups = product.get("food_groups", [])
    score = 0
    if "곡류" in groups:
        score += 8
    if "고기·생선·계란·콩류" in groups:
        score += 8
    if "채소류" in groups:
        score += 8
    if meal == "breakfast" and "우유·유제품류" in groups:
        score += 4
    if meal == "breakfast" and "과일류" in groups:
        score += 4
    return score


def sodium_preference_score(sodium):
    # 저나트륨 점수
    if sodium <= 0:
        return -24
    if sodium <= 100:
        return 30
    if sodium <= 200:
        return 22
    if sodium <= 300:
        return 10
    if sodium <= 500:
        return -2
    if sodium <= 800:
        return -16
    return -32


def moderate_sodium_score(sodium):
    # 보통 나트륨 점수
    if sodium <= 0:
        return -18
    if sodium < 120:
        return -12
    if sodium <= 350:
        return 12
    if sodium <= 650:
        return 18
    if sodium <= 850:
        return 4
    return -24


def suspicious_zero_sodium(product, sodium):
    # 나트륨 0mg 데이터 확인
    if sodium > 0:
        return False
    text = product_text(product)
    return any(keyword in text for keyword in ["도시락", "국밥", "찌개", "탕", "전골", "덮밥", "볶음밥"])


def suspicious_too_low_sodium(product, sodium):
    # 나트륨 값이 이상하게 낮은 경우 보정
    if sodium <= 0:
        return suspicious_zero_sodium(product, sodium)
    if sodium >= 30:
        return False
    text = product_text(product)
    return any(keyword in text for keyword in ["도시락", "국밥", "찌개", "탕", "전골", "덮밥", "볶음밥"])


def strategy_adjust_score(product, intent, profile):
    # 요청 조건에 따른 가점과 감점
    nutrients = product.get("nutrients", {})
    sugar = number(nutrients.get("sugar"))
    sodium = number(nutrients.get("sodium"))
    protein = number(nutrients.get("protein"))
    strategy = intent.get("strategy", "default")
    score = 0
    reasons = []

    if strategy == "low_sodium":
        sodium_score = sodium_preference_score(sodium)
        score += sodium_score
        if sodium <= 300 and sodium > 0:
            reasons.append(f"나트륨 {sodium:g}mg으로 저나트륨 요청에 잘 맞습니다.")
        elif sodium > 800:
            reasons.append("나트륨을 줄이고 싶은 요청이 있어 나트륨이 높은 식품은 감점했습니다.")
    elif strategy == "moderate_sodium":
        score += moderate_sodium_score(sodium)
        if 120 <= sodium <= 650:
            reasons.append(f"나트륨 {sodium:g}mg으로 너무 낮지도 높지도 않은 보통 범위 후보입니다.")
    elif strategy == "low_sugar":
        if sugar <= 5:
            score += 10
            reasons.append(f"당류 {sugar:g}g으로 당류 관리 요청에 비교적 잘 맞습니다.")
        elif sugar > 10:
            score -= 20
            reasons.append("당류를 줄이고 싶은 요청이 있어 당류가 높은 식품은 감점했습니다.")
    elif strategy == "protein_focus":
        if protein >= 15:
            score += 12
            reasons.append(f"단백질 {protein:g}g으로 단백질 보충 요청에 잘 맞습니다.")
        elif protein < 7:
            score -= 8
    elif strategy == "light_meal":
        if sugar <= 5 and sodium <= 500:
            score += 8
            reasons.append("가볍게 먹고 싶은 요청에 맞춰 당류와 나트륨이 낮은 편입니다.")

    if "sugar" in intent.get("reduce_targets", []) and sugar > 10:
        score -= 15
        reasons.append("당류를 줄이고 싶은 요청이 있어 당류가 높은 식품은 추가 감점했습니다.")

    if "sodium" in intent.get("reduce_targets", []) and sodium > 900:
        score -= 15
        reasons.append("나트륨을 줄이고 싶은 요청이 있어 나트륨이 높은 식품은 추가 감점했습니다.")

    if suspicious_too_low_sodium(product, sodium):
        score -= 35
        reasons.append("완성 식사형 식품인데 나트륨 값이 지나치게 낮아 데이터 신뢰도 보정을 적용했습니다.")

    if profile.get("bmi_group") in ["과체중", "비만 1단계", "비만 2단계 이상"]:
        if sugar > 10:
            score -= 8
        if sodium > 900:
            score -= 8

    return score, reasons


def normalized_recommendation_name(name):
    value = re.sub(r"[^0-9A-Za-z가-힣]", "", str(name)).lower()
    for word in VARIANT_WORDS:
        value = value.replace(word.lower(), "")
    return value


def recommendation_family_key(name):
    # 비슷한 식품을 묶기 위한 이름
    value = re.sub(r"[^0-9A-Za-z가-힣]", "", str(name)).lower()
    for term in ["도시락", "샌드위치", "김밥", "국밥", "볶음밥", "덮밥", "샐러드", "찌개", "탕", "죽"]:
        index = value.find(term)
        if index >= 0:
            return value[: index + len(term)]
    return normalized_recommendation_name(name)


def is_too_similar_recommendation(item, selected):
    # 이미 고른 식품과 비슷한지 확인
    name = normalized_recommendation_name(item.get("name", ""))
    family = recommendation_family_key(item.get("name", ""))
    for other in selected:
        other_name = normalized_recommendation_name(other.get("name", ""))
        other_family = recommendation_family_key(other.get("name", ""))
        if not name or not other_name:
            continue
        if family and family == other_family:
            return True
        if name == other_name:
            return True
        if name in other_name or other_name in name:
            return True
        if SequenceMatcher(None, name, other_name).ratio() >= 0.68:
            return True
    return False


def requested_form_terms(intent):
    return [term for term in intent.get("food_terms", []) if term in FORM_TERMS]


def analyze_question_node(state: MealRecommendationState):
    intent = analyze_question_with_llm(state.get("question", ""), state["profile"])
    return {"intent": intent}


def choose_route(state: MealRecommendationState):
    if state.get("intent", {}).get("intent_type") == "chat":
        return "chat"
    return "recommend"


def load_food_data_node(state: MealRecommendationState):
    products = load_products(state["products_path"])
    food_groups = load_food_groups(state["groups_path"])
    products = add_food_groups(products, food_groups)
    return {
        "products": products,
        "food_groups": food_groups,
    }


def first_filter_node(state: MealRecommendationState):
    # 1차 후보 선정
    profile = state["profile"]
    intent = state["intent"]

    safe_products, removed_products = filter_avoid_foods(
        state["products"],
        profile.get("avoid_ingredients", []),
    )

    candidates = []
    for product in safe_products:
        if has_bad_keyword(product):
            continue
        if not is_meal_like(product):
            continue
        candidates.append(product)

    food_terms = intent.get("food_terms", [])
    if food_terms:
        form_terms = requested_form_terms(intent)
        search_terms = form_terms or food_terms
        matched = []
        for product in candidates:
            text = product_text(product)
            if form_terms and all(term in text for term in form_terms):
                matched.append(product)
            elif not form_terms and any(term in text for term in search_terms):
                matched.append(product)
        if not matched and form_terms:
            for product in candidates:
                text = product_text(product)
                if any(term in text for term in search_terms):
                    matched.append(product)
        if matched:
            candidates = matched
    else:
        meal = intent.get("meal", "lunch")
        meal_keywords = MEAL_FOOD_KEYWORDS.get(meal, [])
        matched = []
        for product in candidates:
            text = product_text(product)
            if any(keyword in text for keyword in meal_keywords):
                matched.append(product)
        if not matched:
            for product in candidates:
                if meal in product.get("meal_slots", []):
                    matched.append(product)
        if matched:
            candidates = matched

    if intent.get("avoid_recent_food"):
        recent_foods = intent.get("recent_foods", [])
        if recent_foods:
            candidates = [
                product for product in candidates
                if not any(food in product_text(product) for food in recent_foods)
            ]

    return {
        "safe_products": safe_products,
        "removed_products": removed_products,
        "candidates": candidates,
    }


def score_product(product, state):
    # 식품 하나의 점수 계산
    profile = state["profile"]
    intent = state["intent"]
    nutrients = product.get("nutrients", {})
    sugar = number(nutrients.get("sugar"))
    sodium = number(nutrients.get("sodium"))
    protein = number(nutrients.get("protein"))
    meal = intent.get("meal", "lunch")
    goal = STRATEGY_GOALS.get(intent.get("strategy", "default"), "blood_sugar")
    request_terms = get_request_terms(intent)

    food_score = nutrition_score(product, goal)
    meal_score = meal_match_score(product, meal, request_terms)
    group_score = food_group_score(product, meal)
    strategy_score, strategy_reasons = strategy_adjust_score(product, intent, profile)
    complete_score = 0
    reasons = []

    if is_complete_meal(product):
        complete_score += 12
        reasons.append("한 끼 식사로 보기 쉬운 완성 식사형 식품입니다.")
    elif needs_rice_pair(product):
        complete_score += 6
        reasons.append("국·찌개·탕류라서 밥과 함께 먹는 조합으로 안내합니다.")

    if protein >= 15:
        reasons.append(f"단백질 {protein:g}g으로 단백질 보충에 도움이 됩니다.")

    if sugar <= 5:
        reasons.append(f"당류 {sugar:g}g으로 당류가 비교적 낮습니다.")

    if sodium <= 500:
        reasons.append(f"나트륨 {sodium:g}mg으로 나트륨이 비교적 낮습니다.")

    groups = product.get("food_groups", [])
    balanced_groups = [group for group in ["곡류", "고기·생선·계란·콩류", "채소류"] if group in groups]
    if balanced_groups:
        reasons.append("식품구성자전거 기준 식품군을 반영했습니다: " + ", ".join(balanced_groups))

    reasons.extend(strategy_reasons)

    raw_score = food_score + meal_score + group_score + strategy_score + complete_score
    meal_part = max(0, min(55, meal_score)) / 55 * 18
    group_part = max(0, min(24, group_score)) / 24 * 8
    complete_part = max(0, min(12, complete_score)) / 12 * 6
    display_score = food_score * 0.52 + meal_part + group_part + complete_part + strategy_score * 0.5
    score = max(0, min(100, display_score))
    sort_score = raw_score
    strategy = intent.get("strategy", "default")
    if strategy == "low_sodium":
        sort_score -= sodium * 0.10
    elif strategy == "moderate_sodium":
        sort_score -= abs(sodium - 450) * 0.06
    elif strategy == "low_sugar":
        sort_score -= sugar * 1.5
    elif strategy == "protein_focus":
        sort_score += protein * 0.8
    if suspicious_too_low_sodium(product, sodium):
        sort_score -= 60
    selected_group = get_display_group(product)
    return {
        **product,
        "score": round(score, 1),
        "raw_score": round(raw_score, 1),
        "sort_score": round(sort_score, 1),
        "nutrition_score": round(food_score, 1),
        "meal_score": round(meal_score, 1),
        "group_score": round(group_score, 1),
        "reasons": reasons[:3] or ["사용자 상태와 식품영양성분 데이터를 함께 반영했습니다."],
        "selected_group": selected_group,
        "selected_groups": [group.strip() for group in selected_group.split(",")],
    }


def score_foods_node(state: MealRecommendationState):
    # 점수순 정렬 후 비슷한 추천 제거
    scored = [score_product(product, state) for product in state.get("candidates", [])]
    scored = sorted(
        scored,
        key=lambda item: (
            item.get("sort_score", 0),
            item.get("raw_score", 0),
            item.get("meal_score", 0),
            item.get("nutrition_score", 0),
            item.get("group_score", 0),
            number(item.get("nutrients", {}).get("protein")),
            -number(item.get("nutrients", {}).get("sodium")),
            -number(item.get("nutrients", {}).get("sugar")),
        ),
        reverse=True,
    )
    unique = []
    used_names = set()
    for item in scored:
        name = item.get("name", "")
        if name in used_names:
            continue
        if is_too_similar_recommendation(item, unique):
            continue
        unique.append(item)
        used_names.add(name)
        if len(unique) >= 5:
            break
    if not unique:
        for item in scored:
            name = item.get("name", "")
            if name in used_names:
                continue
            unique.append(item)
            used_names.add(name)
            break
    return {
        "scored_products": unique,
        "recommendations": unique[:5],
    }


def explain_with_llm_node(state: MealRecommendationState):
    explanation = generate_explanation_with_llm(
        state["profile"],
        state.get("question", ""),
        state.get("intent", {}),
        state.get("recommendations", []),
    )
    return {"ai_explanation": explanation}


def make_answer_node(state: MealRecommendationState):
    selected = list(state.get("recommendations", []))
    if selected and needs_rice_pair(selected[0]):
        rice = select_rice_product(state.get("safe_products", []), "blood_sugar")
        selected.insert(0, rice)

    answer = format_answer(state, selected)
    return {
        "recommendations": selected,
        "answer": answer,
        "response_type": "recommend",
    }


def make_chat_answer_node(state: MealRecommendationState):
    intent = state.get("intent", {})
    reply = intent.get("reply") or "현재 상태나 원하는 식단을 말해주시면 추천해드릴게요."
    return {
        "ai_explanation": reply,
        "answer": reply,
        "recommendations": [],
        "response_type": "chat",
    }


def build_app():
    # LangGraph 흐름 구성
    workflow = StateGraph(MealRecommendationState)

    workflow.add_node("analyze_question", analyze_question_node)
    workflow.add_node("load_food_data", load_food_data_node)
    workflow.add_node("first_filter", first_filter_node)
    workflow.add_node("score_foods", score_foods_node)
    workflow.add_node("explain_with_llm", explain_with_llm_node)
    workflow.add_node("make_answer", make_answer_node)
    workflow.add_node("make_chat_answer", make_chat_answer_node)

    workflow.set_entry_point("analyze_question")
    workflow.add_conditional_edges(
        "analyze_question",
        choose_route,
        {
            "recommend": "load_food_data",
            "chat": "make_chat_answer",
        },
    )
    workflow.add_edge("load_food_data", "first_filter")
    workflow.add_edge("first_filter", "score_foods")
    workflow.add_edge("score_foods", "explain_with_llm")
    workflow.add_edge("explain_with_llm", "make_answer")
    workflow.add_edge("make_answer", END)
    workflow.add_edge("make_chat_answer", END)

    return workflow.compile()


def format_nutrients(product):
    nutrients = product.get("nutrients", {})
    if not nutrients:
        return "영양성분: 식품구성자전거 1회 분량 기준 보완 항목"
    return (
        "영양성분: "
        f"당류 {nutrients.get('sugar')}g, "
        f"나트륨 {nutrients.get('sodium')}mg, "
        f"단백질 {nutrients.get('protein')}g"
    )


def format_food(product):
    lines = [
        f"- {product.get('selected_group', '식품')}: {product.get('name')}",
        f"  기준: {product.get('serving', '100g 기준')}",
        f"  {format_nutrients(product)}",
        f"  점수: {product.get('score', '기준 보완')}점",
    ]
    for reason in product.get("reasons", []):
        lines.append(f"  근거: {reason}")
    if product.get("pair_reason"):
        lines.append(f"  조합 이유: {product.get('pair_reason')}")
    return "\n".join(lines)


def format_answer(state, selected):
    # 콘솔 출력 문장 생성
    profile = state["profile"]
    intent = state.get("intent", {})
    meal_label = MEAL_LABELS.get(intent.get("meal"), intent.get("meal"))
    llm_status = "Gemini 사용" if intent.get("used_llm") else "기본 규칙 분석"

    lines = [
        "식단 추천 에이전트 추천 결과",
        "=" * 45,
        f"질문: {state.get('question')}",
        f"추천 끼니: {meal_label}",
        f"BMI: {profile.get('bmi')} / 판정: {profile.get('bmi_group')}",
        f"질문 분석: {llm_status}",
        f"선택 전략: {intent.get('strategy')}",
        f"분석 이유: {intent.get('reason')}",
        f"분석 식품: {len(state.get('products', []))}개",
        f"1차 후보 식품: {len(state.get('candidates', []))}개",
        f"알레르기/제외 재료로 제외된 식품: {len(state.get('removed_products', []))}개",
        "",
        "추천 식단",
        "-" * 45,
    ]

    if not selected:
        lines.append("조건에 맞는 식품을 찾지 못했습니다. 다른 질문으로 다시 입력해주세요.")
        return "\n".join(lines)

    for product in selected[:3]:
        lines.append(format_food(product))

    rule_summary = build_rule_summary(state.get("food_groups", []), selected)
    if rule_summary:
        lines.extend(["", "식품구성자전거 기준", "-" * 45, rule_summary])

    lines.extend(["", "추천 설명", "-" * 45, state.get("ai_explanation", "")])
    lines.extend(
        [
            "",
            "안내",
            "-" * 45,
            "질문 내용과 영양성분 데이터를 함께 참고했습니다.",
            "영양성분은 데이터의 100g 또는 1회 기준값입니다.",
            "의료 진단이 아니라 식품 선택을 돕기 위한 참고용 추천입니다.",
        ]
    )
    return "\n".join(lines)


def print_intro():
    print("식단 추천 에이전트")
    print("=" * 45)
    print("이 에이전트는 Gemini로 질문 의도를 분석하고,")
    print("Python으로 식품 데이터를 필터링한 뒤, Gemini로 추천 설명을 생성합니다.")
    print()


def ask_gender():
    while True:
        print("성별을 선택하세요.")
        print("1. 남자")
        print("2. 여자")
        value = input("입력: ").strip()
        if "1" in value or value == "남자":
            return "남자"
        if "2" in value or value == "여자":
            return "여자"
        print("1 또는 2를 입력하거나 남자/여자 중 하나를 입력해주세요.")


def ask_int(label):
    while True:
        value = only_number_text(input(label).strip())
        try:
            return int(value)
        except ValueError:
            print("숫자로 입력해주세요.")


def ask_float(label):
    while True:
        value = only_number_text(input(label).strip())
        try:
            return float(value)
        except ValueError:
            print("숫자로 입력해주세요.")


def ask_profile():
    gender = ask_gender()
    age = ask_int("나이를 입력하세요: ")
    height_cm = ask_float("키(cm)를 입력하세요: ")
    weight_kg = ask_float("몸무게(kg)를 입력하세요: ")
    avoid = split_csv(input("알레르기나 피해야 할 재료를 입력하세요. 없으면 Enter: ").strip())
    return build_health_profile(gender, age, height_cm, weight_kg, avoid)


def print_profile(profile):
    avoid_text = ", ".join(profile.get("avoid_ingredients", [])) or "없음"
    print()
    print("개인 분석 완료")
    print("-" * 45)
    print(f"- 성별: {profile.get('gender')}")
    print(f"- 나이: {profile.get('age')}세")
    print(f"- BMI: {profile.get('bmi')}")
    print(f"- 판정: {profile.get('bmi_group')}")
    print(f"- 주의 재료: {avoid_text}")
    print(f"- 추천 방향: {profile.get('bmi_guide')}")


def print_examples():
    print()
    print("현재 상태나 원하는 식단을 자유롭게 입력하세요.")
    print("예시 질문:")
    print("- 오늘 활동량이 적고 점심에 국밥 먹어서 저녁은 나트륨 낮게 추천해줘")
    print("- 전에 먹은 김밥 말고 당류 낮은 아침 추천해줘")
    print("- 저녁으로 먹기 좋은 도시락 추천해줘")
    print("- 단백질 보충에 좋은 점심 추천해줘")
    print("종료하려면 exit, quit, 종료 중 하나를 입력하세요.")


def run_once(app, args, profile, question):
    result = run_recommendation(app, profile, question, args.products, args.groups)
    print()
    print(result.get("answer", ""))


def run_recommendation(app, profile, question, products_path=DEFAULT_PRODUCTS, groups_path=DEFAULT_GROUPS):
    return app.invoke(
        {
            "profile": profile,
            "question": question,
            "products_path": str(products_path),
            "groups_path": str(groups_path),
        }
    )


def run_chat(app, args):
    print_intro()
    profile = ask_profile()
    print_profile(profile)
    print_examples()

    while True:
        question = input("\n입력: ").strip()
        if question.lower() in ["exit", "quit", "q", "종료"]:
            print("식단 추천 에이전트를 종료합니다.")
            break
        if not question:
            print("질문을 입력해주세요.")
            continue
        run_once(app, args, profile, question)


def build_profile_from_args(args):
    return build_health_profile(
        args.gender,
        args.age,
        args.height,
        args.weight,
        split_csv(args.avoid),
    )


def main():
    parser = argparse.ArgumentParser(description="식단 추천 에이전트")
    parser.add_argument("--message", default=None, help="질문 문장. 생략하면 대화형 모드로 실행")
    parser.add_argument("--gender", default="남자", choices=["남자", "여자"])
    parser.add_argument("--age", type=int, default=34)
    parser.add_argument("--height", type=float, default=173)
    parser.add_argument("--weight", type=float, default=72)
    parser.add_argument("--avoid", default="", help="알레르기나 피해야 할 재료. 예: 땅콩,새우")
    parser.add_argument("--products", default=str(DEFAULT_PRODUCTS), help="상품 데이터 JSON 경로")
    parser.add_argument("--groups", default=str(DEFAULT_GROUPS), help="식품군 규칙 JSON 경로")
    args = parser.parse_args()

    app = build_app()
    if args.message:
        run_once(app, args, build_profile_from_args(args), args.message)
    else:
        run_chat(app, args)


if __name__ == "__main__":
    main()
