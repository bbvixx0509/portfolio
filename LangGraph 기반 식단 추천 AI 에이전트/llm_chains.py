import json
import os
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parent


def load_env():
    env_path = BASE_DIR / ".env"
    if not env_path.exists():
        return

    for line in env_path.read_text(encoding="utf-8").splitlines():
        if "=" not in line or line.strip().startswith("#"):
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip())


def get_llm():
    load_env()
    api_key = os.getenv("GOOGLE_API_KEY")
    if not api_key:
        return None

    try:
        from langchain_google_genai import ChatGoogleGenerativeAI
    except ImportError:
        return None

    return ChatGoogleGenerativeAI(
        model=os.getenv("GEMINI_MODEL", "gemini-3.5-flash"),
        temperature=0.2,
        google_api_key=api_key,
    )


def get_model_name():
    load_env()
    return os.getenv("GEMINI_MODEL", "gemini-3.5-flash")


def is_model_info_question(question):
    text = question.lower()
    model_words = ["gemini", "제미니", "재미니", "제미나이", "재민", "모델", "버전"]
    ask_words = ["뭐", "무엇", "알려", "버전", "모델", "써", "사용"]
    return any(word in text for word in model_words) and any(word in text for word in ask_words)


def compact_text(value):
    return "".join(str(value).split()).lower()


def has_any(text, words):
    return any(word in text for word in words)


def simple_meal_request(question):
    text = compact_text(question)
    return text in [
        "아침",
        "아침추천",
        "아침식단",
        "아침메뉴",
        "아침밥",
        "점심",
        "점심추천",
        "점심식단",
        "점심메뉴",
        "점심밥",
        "저녁",
        "저녁추천",
        "저녁식단",
        "저녁메뉴",
        "저녁밥",
    ]


def refine_intent_with_question(question, intent):
    text = compact_text(question)

    if intent.get("intent_type") != "recommend":
        return intent

    food_terms = list(intent.get("food_terms", []))
    for term in ["도시락", "김밥", "샐러드", "샌드위치", "국밥", "찌개", "덮밥", "볶음밥"]:
        if term in question and term not in food_terms:
            food_terms.append(term)
    intent["food_terms"] = food_terms

    if "저녁" in question:
        intent["meal"] = "dinner"
    elif "점심" in question:
        intent["meal"] = "lunch"
    elif "아침" in question:
        intent["meal"] = "breakfast"

    recent_foods = intent.get("recent_foods", [])
    if recent_foods:
        intent["food_terms"] = [term for term in intent.get("food_terms", []) if term not in recent_foods]

    sodium_words = ["나트륨", "나트륩", "natrium", "sodium"]
    low_sodium_words = [
        "나트륨적", "나트륨이적", "나트륨낮", "나트륨이낮",
        "나트륨줄", "나트륨을줄", "나트륨덜", "나트륨이덜", "나트륨안", "나트륨이안",
        "나트륩적", "나트륩이적", "나트륩낮", "나트륩이낮",
        "저나트륨", "저염", "덜짠", "안짠", "싱겁",
    ]
    moderate_sodium_words = [
        "나트륨좀있는", "나트륨이좀있는", "나트륨조금있는", "나트륨이조금있는",
        "나트륨약간있는", "나트륨이약간있는", "나트륨적당", "나트륨이적당",
        "나트륨보통", "나트륨이보통", "나트륨상관없", "나트륨은상관없",
        "나트륩좀있는", "나트륩이좀있는", "나트륩조금있는", "나트륩이조금있는",
        "나트륩약간있는", "나트륩이약간있는", "나트륩적당", "나트륩이적당", "나트륩보통",
        "약간짠", "조금짠", "적당히짠",
    ]

    if has_any(text, sodium_words):
        reduce_targets = [item for item in intent.get("reduce_targets", []) if item != "sodium"]
        if has_any(text, moderate_sodium_words):
            intent["strategy"] = "moderate_sodium"
            intent["reduce_targets"] = reduce_targets
            intent["reason"] = (
                "사용자가 나트륨을 줄이라고 한 것이 아니라 어느 정도 있는 도시락을 요청했기 때문에 "
                "저나트륨이 아닌 보통 나트륨 전략으로 보정했습니다."
            )
        elif has_any(text, low_sodium_words):
            intent["strategy"] = "low_sodium"
            if "sodium" not in reduce_targets:
                reduce_targets.append("sodium")
            intent["reduce_targets"] = reduce_targets

    return intent


def parse_json_text(text):
    text = text.strip()
    if text.startswith("```"):
        text = text.replace("```json", "").replace("```", "").strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return {}


def gemini_unavailable_intent(reason):
    return {
        "intent_type": "chat",
        "meal": "lunch",
        "food_terms": [],
        "reduce_targets": [],
        "recent_foods": [],
        "avoid_recent_food": False,
        "strategy": "default",
        "reason": reason,
        "reply": "질문 분석 기능이 연결되지 않아 지금은 답변을 준비할 수 없습니다. 설정을 확인한 뒤 다시 실행해주세요.",
        "used_llm": False,
    }


def analyze_question_with_llm(question, profile):
    llm = get_llm()
    if llm is None:
        return gemini_unavailable_intent("Gemini API 키가 없거나 langchain-google-genai를 불러올 수 없습니다.")

    try:
        from langchain_core.output_parsers import StrOutputParser
        from langchain_core.prompts import ChatPromptTemplate
    except ImportError:
        return gemini_unavailable_intent("LangChain 패키지를 불러올 수 없습니다.")

    prompt = ChatPromptTemplate.from_template(
        """
너는 식단 추천 에이전트의 질문 분석기이자 일반 대화 응답 작성기입니다.
사용자의 질문을 보고 아래 JSON 형식으로만 답하세요.

가능한 intent_type 값: recommend, chat
가능한 meal 값: breakfast, lunch, dinner
가능한 reduce_targets 값: sugar, sodium
가능한 strategy 값: default, low_sodium, moderate_sodium, low_sugar, protein_focus, light_meal

규칙:
- JSON 이외의 설명은 출력하지 마세요.
- 식단 추천, 음식 추천, 무엇을 먹을지 묻는 말이면 intent_type을 recommend로 하세요.
- 인사, 감사, 사용법 질문, 기능 질문처럼 음식 추천이 아닌 말이면 intent_type을 chat으로 하세요.
- "왜 추천했어?", "아니라고 했는데", "아녀라고 했는데", "잘못 추천했어"처럼 이전 답변에 대한 불만이나 오류 지적은 chat으로 하세요.
- 사용자가 실제로 먹을 음식을 새로 추천해달라고 요청할 때만 recommend로 판단하세요.
- intent_type이 chat이면 reply에 사용자의 문장 의미를 직접 읽고 그 질문에 맞는 답변을 작성하세요.
- chat reply는 사용자가 물어본 내용에 답해야 하며, 단순 홍보 문구나 인사말로만 답하지 마세요.
- 사용자가 Gemini 버전, 모델명, 사용 중인 AI를 물으면 현재 모델명 "{model_name}"을 정확히 말하세요.
- intent_type이 chat이면 식품 데이터 검색은 하지 않도록 meal 등은 기본값으로 두세요.
- 사용자가 전에 먹은 음식이나 피하고 싶은 음식을 말하면 recent_foods에 넣으세요.
- 활동량이 적다, 가볍게 먹고 싶다 같은 표현은 light_meal 전략으로 해석하세요.
- 짠 음식을 먹었다, 나트륨이 낮은/적은/줄인/저염/덜 짠 식단을 원한다는 표현은 low_sodium 전략으로 해석하세요.
- "나트륨이 좀 있는", "나트륨이 약간 있는", "나트륨이 보통인", "나트륨은 상관없다"처럼 저나트륨 요청이 아닌 표현은 moderate_sodium 전략으로 해석하고 reduce_targets에 sodium을 넣지 마세요.
- 당류를 줄이고 싶다는 표현은 low_sugar 전략으로 해석하세요.
- 단백질을 원하면 protein_focus 전략으로 해석하세요.

사용자 BMI 판정: {bmi_group}
현재 Gemini 모델명: {model_name}
사용자 질문: {question}

출력 예시:
{{
  "intent_type": "recommend",
  "meal": "dinner",
  "food_terms": ["도시락"],
  "reduce_targets": ["sodium"],
  "recent_foods": ["국밥"],
  "avoid_recent_food": true,
  "strategy": "low_sodium",
  "reason": "점심에 짠 국밥을 먹었고 저녁은 나트륨을 낮추고 싶다고 했기 때문",
  "reply": ""
}}

chat 출력 예시:
{{
  "intent_type": "chat",
  "meal": "lunch",
  "food_terms": [],
  "reduce_targets": [],
  "recent_foods": [],
  "avoid_recent_food": false,
  "strategy": "default",
  "reason": "사용자가 새 식단 추천이 아니라 이전 추천이 잘못된 이유를 묻고 있기 때문",
  "reply": "맞아요. 그 문장은 추천 요청이 아니라 이전 답변에 대한 지적이므로 식품 검색을 실행하지 않아야 합니다. 다시 원하는 식단 조건을 말해주시면 그때 추천해드릴게요."
}}

모델 질문 chat 출력 예시:
{{
  "intent_type": "chat",
  "meal": "lunch",
  "food_terms": [],
  "reduce_targets": [],
  "recent_foods": [],
  "avoid_recent_food": false,
  "strategy": "default",
  "reason": "사용자가 현재 사용 중인 Gemini 모델명을 물었기 때문",
  "reply": "현재 식단 추천 에이전트에서 사용하는 Gemini 모델은 {model_name}입니다."
}}
"""
    )
    chain = prompt | llm | StrOutputParser()

    try:
        result = parse_json_text(
            chain.invoke(
                {
                    "question": question,
                    "bmi_group": profile.get("bmi_group", ""),
                    "model_name": get_model_name(),
                }
            )
        )
    except Exception:
        return gemini_unavailable_intent("Gemini 호출 중 오류가 발생했습니다.")

    intent = {
        "intent_type": result.get("intent_type") or "chat",
        "meal": result.get("meal") or "lunch",
        "food_terms": result.get("food_terms") or [],
        "reduce_targets": result.get("reduce_targets") or [],
        "recent_foods": result.get("recent_foods") or [],
        "avoid_recent_food": bool(result.get("avoid_recent_food", False)),
        "strategy": result.get("strategy") or "default",
        "reason": result.get("reason") or "Gemini가 사용자 질문 의도를 분석했습니다.",
        "reply": result.get("reply") or "",
        "used_llm": True,
    }

    if simple_meal_request(question):
        meal = "lunch"
        if "아침" in question:
            meal = "breakfast"
        elif "저녁" in question:
            meal = "dinner"
        intent.update(
            {
                "intent_type": "recommend",
                "meal": meal,
                "strategy": intent.get("strategy") or "default",
                "reason": "사용자가 끼니 버튼처럼 짧게 입력했으므로 식단 추천 요청으로 보정했습니다.",
                "reply": "",
            }
        )

    if is_model_info_question(question):
        model_name = get_model_name()
        intent.update(
            {
                "intent_type": "chat",
                "meal": "lunch",
                "food_terms": [],
                "reduce_targets": [],
                "recent_foods": [],
                "avoid_recent_food": False,
                "strategy": "default",
                "reason": "사용자가 현재 사용 중인 Gemini 모델명을 물었기 때문",
                "reply": f"현재 식단 추천 에이전트에서 사용하는 Gemini 모델은 {model_name}입니다.",
            }
        )

    return refine_intent_with_question(question, intent)


def product_summary(product):
    nutrients = product.get("nutrients", {})
    return (
        f"- {product.get('name')} "
        f"(점수 {product.get('score')}점, "
        f"당류 {nutrients.get('sugar')}g, "
        f"나트륨 {nutrients.get('sodium')}mg, "
        f"단백질 {nutrients.get('protein')}g)"
    )


def fallback_explanation(profile, question, intent, recommendations):
    if not recommendations:
        return "조건에 맞는 추천 후보가 부족합니다. 질문을 조금 더 넓게 입력하면 다시 추천할 수 있습니다."

    best = recommendations[0]
    name = best.get("name", "")
    reasons = best.get("reasons", [])
    reason_text = " ".join(reasons[:2]) if reasons else "BMI와 영양성분 기준을 함께 반영했습니다."
    return (
        f"{profile.get('bmi_group')} 판정과 사용자의 요청을 반영한 추천 식품은 {name}입니다. "
        f"{reason_text} "
        "영양성분은 데이터 기준값이므로 실제 섭취량은 제품 표시를 함께 확인하는 것이 좋습니다."
    )


def generate_explanation_with_llm(profile, question, intent, recommendations):
    llm = get_llm()
    if llm is None:
        return fallback_explanation(profile, question, intent, recommendations)

    try:
        from langchain_core.output_parsers import StrOutputParser
        from langchain_core.prompts import ChatPromptTemplate
    except ImportError:
        return fallback_explanation(profile, question, intent, recommendations)

    prompt = ChatPromptTemplate.from_template(
        """
너는 개인 맞춤 식단 추천 에이전트입니다.
아래 정보와 추천 후보만 사용해서 한국어로 3문장 이내 설명을 작성하세요.

규칙:
- 후보 밖의 식품을 새로 만들지 마세요.
- 데이터에 없는 영양성분을 만들지 마세요.
- 의료 진단처럼 말하지 말고 식품 선택 참고용으로 설명하세요.
- 사용자 질문과 BMI 판정, 알레르기 제외 결과를 자연스럽게 반영하세요.

사용자 정보:
- 성별: {gender}
- 나이: {age}
- BMI: {bmi}
- BMI 판정: {bmi_group}
- 피해야 할 재료: {avoid}

사용자 질문:
{question}

Gemini 질문 분석 결과:
{intent_reason}

추천 후보:
{candidates}
"""
    )
    chain = prompt | llm | StrOutputParser()

    try:
        return chain.invoke(
            {
                "gender": profile.get("gender", ""),
                "age": profile.get("age", ""),
                "bmi": profile.get("bmi", ""),
                "bmi_group": profile.get("bmi_group", ""),
                "avoid": ", ".join(profile.get("avoid_ingredients", [])) or "없음",
                "question": question,
                "intent_reason": intent.get("reason", ""),
                "candidates": "\n".join(product_summary(item) for item in recommendations[:3]),
            }
        ).strip()
    except Exception:
        return fallback_explanation(profile, question, intent, recommendations)
