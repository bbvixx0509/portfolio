import gzip
import json
from pathlib import Path


#JSON 파일 읽기 (용량이 큰 데이터는 .json.gz로 압축해 두고 그대로 읽음)
def load_json(path):
    file_path = Path(path)
    gz_path = file_path.with_name(file_path.name + ".gz")
    if not file_path.exists() and gz_path.exists():
        with gzip.open(gz_path, "rt", encoding="utf-8") as file:
            return json.load(file)
    with file_path.open("r", encoding="utf-8") as file:
        return json.load(file)


#식품 데이터 호출
def load_products(path):
    products = load_json(path)
    if not isinstance(products, list):
        raise ValueError("상품 데이터는 리스트 형태여야 합니다.")
    return products


#식품 데이터 호출
def load_food_groups(path):
    groups = load_json(path)
    if not isinstance(groups, list):
        raise ValueError("식품군 데이터는 리스트 형태여야 합니다.")
    return groups


#피해야 할 재료 들어간 식품 제외
def filter_avoid_foods(products, avoid_words):
    safe_foods = []
    removed_foods = []

    for product in products:
        text = f"{product.get('name', '')} {product.get('ingredients', '')}"
        matches = [word for word in avoid_words if word and word in text]
        if matches:
            removed_foods.append({**product, "avoid_matches": matches})
        else:
            safe_foods.append(product)

    return safe_foods, removed_foods
