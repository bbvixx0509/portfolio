# bmi 계산
def calculate_bmi(height_cm, weight_kg):
    height_m = height_cm / 100
    if height_m <= 0:
        return 0
    return round(weight_kg / (height_m * height_m), 1)

# 대한 비만학괴 기준 bmi 구분
def get_bmi_group(bmi):
    if bmi < 18.5:
        return "저체중"
    if bmi < 23:
        return "정상"
    if bmi < 25:
        return "과체중"
    if bmi < 30:
        return "비만 1단계"
    return "비만 2단계 이상"

# BMI 판정에 따른 추천 방법
def get_bmi_guide(bmi_group):
    if bmi_group == "저체중":
        return "단백질이 포함된 식사를 우선하고, 식사로 부족해 보이는 단품은 피하는 것이 좋습니다."
    if bmi_group == "정상":
        return "식품군 균형과 단백질, 당류, 나트륨을 고르게 확인하는 식사가 좋습니다."
    if bmi_group == "과체중":
        return "당류와 나트륨이 높은 식품은 줄이고, 단백질이 포함된 균형 식사를 권장합니다."
    return "당류와 나트륨이 높은 식품을 더 주의하고, 단품보다 한 끼 구성이 되는 식사를 권장합니다."

# 사용자 정보를 하나의 딕셔너리로 정리
def build_health_profile(gender, age, height_cm, weight_kg, avoid_ingredients):
    bmi = calculate_bmi(height_cm, weight_kg)
    bmi_group = get_bmi_group(bmi)
    return {
        "gender": gender,
        "age": age,
        "height_cm": height_cm,
        "weight_kg": weight_kg,
        "bmi": bmi,
        "bmi_group": bmi_group,
        "bmi_guide": get_bmi_guide(bmi_group),
        "avoid_ingredients": avoid_ingredients,
    }
