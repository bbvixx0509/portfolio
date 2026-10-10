// 식품등의 표시기준(식약처 고시) 알레르기 유발물질 19종을 원재료명에서 판정한다.
//
// 왜 필요한가 — food_products.allergen_codes 는 적재 시점 규칙으로 채워졌는데
// 메밀·잣·아황산류가 79,041건 전체에서 0건이었다. 실제로는 원재료에 해당 성분이
// 있는 상품이 각각 632·84·322건 있었다(로컬 DB 실측). 알레르기 사용자가
// 평양냉면·단무지를 '안전'으로 보게 되는 상태였으므로 규칙을 다시 만든다.
//
// 판정은 '원재료명 부분일치 + 제외어'로 한다. 한국어 원재료명은 '메밀가루'처럼
// 붙여 쓰기 때문에 토큰 완전일치로는 잡히지 않고, 반대로 '밀'을 그대로 부분일치하면
// 메밀·밀크·호밀까지 밀로 오판한다. 그래서 유발물질마다 제외어를 함께 둔다.
// 제외어는 전부 실제 DB 토큰 집계에서 나온 것이다(주석에 근거 표기).

// 한국어 라벨 → DB 코드. food_products.allergen_codes 는 한국어 라벨을 담고,
// food_allergens 테이블은 영문 코드를 담는다(schema.js migrateLegacyAllergens).
export const ALLERGEN_CODE_BY_LABEL = {
  난류: 'EGG',
  우유: 'MILK',
  메밀: 'BUCKWHEAT',
  땅콩: 'PEANUT',
  대두: 'SOY',
  밀: 'WHEAT',
  호두: 'WALNUT',
  잣: 'PINE_NUT',
  고등어: 'MACKEREL',
  게: 'CRAB',
  새우: 'SHRIMP',
  오징어: 'SQUID',
  조개류: 'SHELLFISH',
  돼지고기: 'PORK',
  닭고기: 'CHICKEN',
  쇠고기: 'BEEF',
  복숭아: 'PEACH',
  토마토: 'TOMATO',
  아황산류: 'SULFITES',
};

export const ALLERGEN_LABELS = Object.keys(ALLERGEN_CODE_BY_LABEL);

// include — 원재료명에 이 문자열이 들어가면 해당 유발물질로 본다.
// exclude — include 에 걸렸더라도 이 문자열이 들어가면 취소한다(오탐 차단).
const ALLERGEN_RULES = [
  {
    label: '난류',
    // '알'만으로 부분일치하면 알룰로오스·알긴산·면류첨가알칼리제·명태알·청어알까지
    // 난류가 된다(실측 상위 토큰). 어란은 표시대상 난류(가금류)가 아니므로 제외한다.
    include: ['계란', '달걀', '난백', '난황', '전란', '난분', '액란', '메추리알',
      '알가열', '알가공품', '알함유', '오브알부민', '리소자임'],
    exclude: [],
  },
  {
    label: '우유',
    // '유' 부분일치는 대두유·향미유·올리브유·유탕면·유화제까지 끌어온다(실측 상위 토큰).
    // 그래서 우유 유래가 확실한 표현만 넣는다.
    include: ['우유', '원유', '분유', '연유', '유크림', '생크림', '유청', '유장', '유당', '유지방',
      '유고형분', '유함유', '카제인', '카세인', '치즈', '버터', '발효유', '요구르트', '요거트',
      '락토', '휘핑크림'],
    // 두유·대두유는 SOY, 땅콩버터·코코아버터·시어버터는 유지, 무유당은 락토프리다.
    exclude: ['두유', '무유당', '땅콩버터', '피넛버터', '코코아버터', '카카오버터', '시어버터',
      '식물성유지', '락토바실', '락토코커스', '락토올리고', '락툴로스'],
  },
  {
    label: '메밀',
    include: ['메밀', '모밀'],
    exclude: [],
  },
  {
    label: '땅콩',
    include: ['땅콩', '낙화생', '피넛'],
    // '토피넛향'은 토피 캐러멜 향료로 땅콩이 아니다.
    exclude: ['토피넛'],
  },
  {
    label: '대두',
    // 간장·된장·청국장은 정의상 대두 발효품이라 포함한다. 고추장·춘장은 원료 구성이
    // 제품마다 달라 넣지 않는다(대두가 실제로 있으면 별도 원재료로 표기된다).
    // '두류가공품'(4,006건)은 녹두·완두일 수 있어 제외한다.
    include: ['대두', '두부', '두유', '간장', '된장', '청국장', '콩단백', '탈지대두', '비지'],
    exclude: ['땅콩버터'],
  },
  {
    label: '밀',
    // 메밀은 별도 유발물질, 밀크는 우유, 호밀은 표시대상이 아니다(실측 토큰
    // 메밀가루 403 · 볶은메밀가루 235 · 밀크초콜릿 231 · 호밀분말 91 · 맥아호밀가루 55).
    // 박력분·중력분·강력분은 '밀' 글자가 없는 밀가루다(사전 6,487회). 같은 자리의
    // 박력쌀가루·강력쌀가루는 쌀가루라 '분'까지 붙여야 갈린다.
    include: ['밀', '소맥', '글루텐', '세몰리나', '듀럼', '박력분', '중력분', '강력분'],
    // 아밀라아제(효소)·밀리타리스동충하초는 밀과 무관하다.
    exclude: ['메밀', '모밀', '밀크', '호밀', '옥수수글루텐', '글루텐프리', '밀랍', '밀웜', '아밀라', '밀리타리스'],
  },
  {
    label: '호두',
    include: ['호두'],
    exclude: [],
  },
  {
    label: '잣',
    include: ['잣'],
    exclude: [],
  },
  {
    label: '고등어',
    include: ['고등어'],
    exclude: [],
  },
  {
    label: '게',
    // '게' 한 글자 부분일치는 스파게티·말토게닉아밀라아제·성게·멍게까지 게로 만든다(실측 토큰).
    // 성게(극피동물)·멍게(피낭동물)는 게도 조개류도 아니다.
    include: ['게'],
    exclude: ['스파게티', '말토게닉', '성게', '멍게', '게르마늄', '유게놀', '게라니', '게피'],
  },
  {
    label: '새우',
    include: ['새우'],
    exclude: [],
  },
  {
    label: '오징어',
    include: ['오징어'],
    exclude: [],
  },
  {
    label: '조개류',
    // 표시기준의 조개류는 굴·전복·홍합을 포함한다.
    // '굴' 부분일치는 덩굴월귤·둥굴레·굴비(생선)까지 끌어온다(실측 토큰).
    include: ['조개', '굴', '전복', '홍합', '바지락', '가리비', '소라', '재첩', '꼬막', '대합', '키조개'],
    exclude: ['덩굴', '둥굴', '굴비', '굴절', '소라비', '소라껍'],
  },
  {
    label: '돼지고기',
    include: ['돼지', '돈육', '라드'],
    exclude: [],
  },
  {
    label: '닭고기',
    include: ['닭', '계육'],
    // '불닭소스'는 매운맛 소스 이름이라 닭고기가 들어가지 않는 제품이 있다.
    exclude: ['불닭'],
  },
  {
    label: '쇠고기',
    // '소' 한 글자는 소금·소스·소맥까지 잡으므로 쓰지 않는다.
    include: ['쇠고기', '소고기', '우육', '우지', '사골', '우골', '한우', '소갈비', '소내장', '차돌'],
    // 염소고기는 '소고기'에, 돼지사골·닭사골은 '사골'에 걸린다. 셋 다 쇠고기가 아니다.
    exclude: ['염소', '돼지', '닭'],
  },
  {
    label: '복숭아',
    include: ['복숭아'],
    exclude: [],
  },
  {
    label: '토마토',
    include: ['토마토'],
    exclude: [],
  },
  {
    label: '아황산류',
    // 최종 제품에 이산화황으로 10mg/kg 이상 남는 경우가 표시대상이다. 잔류량은
    // 원재료명만으로 알 수 없으므로, 아황산계 표백제가 쓰였으면 표시한다.
    include: ['아황산', '이산화황', '차아황산', '메타중아황산', '산성아황산', '무수아황산'],
    exclude: [],
  },
];

const RULES_BY_LABEL = new Map(ALLERGEN_RULES.map((rule) => [rule.label, rule]));

// 표기 흔들림(전각 괄호·공백·대소문자)을 없앤다. 한글 자체는 NFKC 로 바뀌지 않는다.
export function normalizeIngredientName(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');
}

function matches(rule, normalized) {
  if (rule.exclude.some((word) => normalized.includes(word))) return false;
  return rule.include.some((word) => normalized.includes(word));
}

// 원재료명 목록에서 유발물질을 판정한다.
// 반환 labels 는 ALLERGEN_LABELS 순서를 따르고, evidence 는 라벨별 최초 근거 원재료다.
export function deriveAllergens(ingredientNames = []) {
  const evidence = new Map();
  for (const name of ingredientNames) {
    const normalized = normalizeIngredientName(name);
    if (!normalized) continue;
    for (const rule of ALLERGEN_RULES) {
      if (evidence.has(rule.label)) continue;
      if (matches(rule, normalized)) evidence.set(rule.label, String(name));
    }
  }

  const labels = ALLERGEN_LABELS.filter((label) => evidence.has(label));
  return {
    labels,
    codes: labels.map((label) => ALLERGEN_CODE_BY_LABEL[label]),
    evidence: Object.fromEntries(labels.map((label) => [label, evidence.get(label)])),
  };
}

// 기존 DB 표시 중 '글자 겹침'으로 잘못 붙은 것만 정정하기 위한 대응표.
// 적재 규칙도 부분일치를 썼기 때문에 메밀가루 제품이 밀로, 염소고기가 쇠고기로,
// 청미래덩굴잎·둥굴레가 조개류로 표시돼 있다(실측 확인).
//
// 여기 적은 겹침어가 원재료에 있고 그 유발물질의 근거가 하나도 없을 때만 표시를 뗀다.
// 겹침으로 설명되지 않는 표시는 그대로 둔다 — 복합조미식품·식육추출가공품처럼
// 하위 원재료가 공개되지 않는 항목이 있어 원재료명만으로는 없다고 단정할 수 없다.
export const COLLISION_CORRECTIONS = {
  밀: ['메밀', '모밀', '밀크', '호밀', '아밀라'],
  쇠고기: ['염소'],
  조개류: ['덩굴', '둥굴', '굴비'],
  게: ['스파게티', '성게', '멍게', '게피'],
};

// 잘못 붙은 표시를 설명하는 원재료를 찾는다. 없으면 null 이며 이때는 표시를 유지한다.
export function findCollisionEvidence(label, ingredientNames = []) {
  const words = COLLISION_CORRECTIONS[label];
  if (!words) return null;
  for (const name of ingredientNames) {
    const normalized = normalizeIngredientName(name);
    if (words.some((word) => normalized.includes(word))) return String(name);
  }
  return null;
}

// 단일 원재료가 특정 유발물질에 걸리는지. 테스트와 재계산 스크립트의 근거 조회에 쓴다.
export function matchesAllergen(label, ingredientName) {
  const rule = RULES_BY_LABEL.get(label);
  if (!rule) return false;
  return matches(rule, normalizeIngredientName(ingredientName));
}
