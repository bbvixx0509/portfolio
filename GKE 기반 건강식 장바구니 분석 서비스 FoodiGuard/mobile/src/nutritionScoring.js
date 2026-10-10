// 영양 점수 계산의 단일 원본. 화면·플랫폼 API에는 의존하지 않는 순수 도메인 모듈이다.
// 단일 식품 점수는 최종보고서 v2 설계(100g 밀도 + 법정 1회 섭취참고량 + 동일가중)를 따르고,
// 장바구니 점수는 v2 8장 「두 축 분리」에 따라 담은 식품 점수의 평균만 쓴다.

export const healthScoreMax = 95;

// 5단계 등급 컷(최종보고서 v2 9장). Nutri-Score의 A~E 등급 분포(전체 79,041건)에
// 우리 점수의 백분위를 맞춰 재산출한 값이다. 점수 체계(기준량·가중치·열량 처리)가
// 바뀌면 반드시 같은 방법으로 재도출해야 한다 — 옛 컷을 유지하면 상위 등급이 폭증한다.
export const scoreThresholds = {
  excellent: 79.9,
  good: 73.9,
  fair: 51.6,
  poor: 38.4,
};

// 장바구니 전용 컷은 없앴다. v2 8장에 따라 장바구니 점수가 '식품 점수 평균'이 되면서
// 단일 식품과 완전히 같은 0~100 척도가 됐고, 따라서 같은 컷(scoreThresholds)을 쓰는 것이 맞다.
// (옛 구조에서는 스케일이 달라 별도 컷 70/60/40/22가 필요했다 — 이제 불필요.)

const metricLabels = {
  calories: '열량',
  protein: '단백질',
  fiber: '식이섬유',
  sugar: '당류',
  saturatedFat: '포화지방',
  sodium: '나트륨',
};

const activityFactors = {
  none: 1.2,
  light: 1.375,
  normal: 1.55,
  high: 1.725,
};

const bmiNutritionProfiles = {
  underweight: {
    label: '저체중',
    calorieDelta: { min: 0, max: 200, hardMax: 400 },
    weights: { calories: 22, protein: 30, fiber: 18, sugar: 12, saturatedFat: 8, sodium: 10 },
    sodium: { max: 2300, hardMax: 2300 },
    saturatedFatPercent: { max: 0.07, hardMax: 0.1 }, // KDRIs 2025: 19세 이상 7%E 미만
    sugarPercent: { max: 0.1, hardMax: 0.1 },
    fiber: { min: 20, max: 35, hardMax: 55 },
  },
  normal: {
    label: '정상',
    calorieDelta: { min: -200, max: 0, hardMax: 150 },
    weights: { calories: 24, protein: 22, fiber: 22, sugar: 12, saturatedFat: 10, sodium: 10 },
    sodium: { max: 2000, hardMax: 2300 },
    saturatedFatPercent: { max: 0.07, hardMax: 0.1 }, // KDRIs 2025: 19세 이상 7%E 미만
    sugarPercent: { max: 0.1, hardMax: 0.1 },
    fiber: { min: 25, max: 40, hardMax: 55 },
  },
  overweight: {
    label: '과체중',
    calorieDelta: { min: -300, max: -100, hardMax: 50 },
    weights: { calories: 36, protein: 18, fiber: 18, sugar: 14, saturatedFat: 9, sodium: 5 },
    sodium: { max: 1800, hardMax: 2300 },
    saturatedFatPercent: { max: 0.07, hardMax: 0.1 }, // KDRIs 2025: 19세 이상 7%E 미만
    sugarPercent: { max: 0.08, hardMax: 0.1 },
    fiber: { min: 25, max: 40, hardMax: 55 },
  },
  obese1: {
    label: '비만 1단계',
    calorieDelta: { min: -500, max: -300, hardMax: -100 },
    weights: { calories: 40, protein: 20, fiber: 18, sugar: 12, saturatedFat: 7, sodium: 3 },
    sodium: { max: 1700, hardMax: 2300 },
    saturatedFatPercent: { max: 0.07, hardMax: 0.1 },
    sugarPercent: { max: 0.07, hardMax: 0.1 },
    fiber: { min: 28, max: 45, hardMax: 55 },
  },
  obese2: {
    label: '비만 2단계+',
    calorieDelta: { min: -750, max: -500, hardMax: -250 },
    weights: { calories: 44, protein: 20, fiber: 18, sugar: 10, saturatedFat: 5, sodium: 3 },
    sodium: { max: 1500, hardMax: 2300 },
    saturatedFatPercent: { max: 0.07, hardMax: 0.1 },
    sugarPercent: { max: 0.06, hardMax: 0.1 },
    fiber: { min: 30, max: 45, hardMax: 55 },
  },
};

const nutrientWeightKeys = ['calories', 'protein', 'fiber', 'sugar', 'saturatedFat', 'sodium'];

// 목표별 가중치 가산표(+8/+10 등)는 최종보고서 v2에 따라 제거했다 — 문헌 근거 부재,
// 실측(79,041건)에서 순위 무효과, 나트륨 저감 선택 시 오히려 비중이 떨어지는 역전 결함.
// 개인화는 가중치가 아니라 개인 목표량(기준량)과 하루 예산에서 수행한다.

const proteinRangeByBmiAndAge = {
  underweight: { young: [1.0, 1.6], middle: [1.1, 1.7], older: [1.2, 1.8] },
  normal: { young: [0.8, 1.6], middle: [1.0, 1.7], older: [1.0, 1.8] },
  overweight: { young: [1.0, 1.8], middle: [1.1, 1.9], older: [1.2, 2.0] },
  obese1: { young: [1.2, 2.0], middle: [1.3, 2.0], older: [1.3, 2.0] },
  obese2: { young: [1.2, 2.0], middle: [1.3, 2.0], older: [1.3, 2.0] },
};

const ingredientRules = {
  addedSugar: ['설탕', '물엿', '액상과당', '과당', '시럽', '올리고당', '당류가공품', '꿀'],
  sweetener: ['수크랄로스', '아스파탐', '아세설팜', '스테비아', '에리스리톨', '감미료'],
  refinedCarb: ['밀가루', '전분', '백미', '당면', '튀김가루', '빵가루'],
};

const avoidIngredientTokens = {
  우유: ['우유', '유청', '분유', '버터', '치즈', '카제인'],
  대두: ['대두', '콩', '두부'],
  밀: ['밀', '밀가루', '글루텐'],
  계란: ['계란', '달걀', '난류'],
  땅콩: ['땅콩'],
  견과류: ['아몬드', '호두', '캐슈', '피스타치오', '견과'],
  갑각류: ['새우', '게', '갑각류'],
  생선: ['고등어', '명태', '연어', '참치', '생선'],
  카페인: ['카페인', '커피'],
};

const mealComponentRoles = [
  { key: 'rice', label: '밥/탄수화물', keywords: ['햇반', '즉석밥', '공기밥', '현미밥', '잡곡밥', '백미밥'] },
  { key: 'protein', label: '단백질', keywords: ['닭가슴살', '닭 안심', '프로틴', '훈제닭'] },
  { key: 'vegetable', label: '채소/식이섬유', keywords: ['샐러드', '채소', '야채'] },
];

const amountWithUnitPattern = /(\d+(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)\s*(kg|g|mg|l|ml)/i;
const packageCountPattern = /(?:x|×|\*)?\s*(\d+)\s*(개입|개|팩|봉|병|캔|입|세트|묶음|박스|통)/gi;
const packageUnitAmountPattern = /(\d+(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)\s*(kg|g|mg|l|ml)\s*(?:x|×|\*)?\s*\d+\s*(개입|개|팩|봉|병|캔|입|세트|묶음|박스|통)/i;
const servingCountRangePattern = /(\d+(?:\.\d+)?)\s*(?:~|-|–|\/)\s*(\d+(?:\.\d+)?)\s*인분/i;
const servingCountPattern = /(\d+(?:\.\d+)?)\s*인분/i;

export const defaultAnalysisSettings = {
  singleMode: 'meal',
  cartMode: 'meals',
  cartUnits: 1,
};

export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

export function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// 점수에 실제로 반영되는 저감 목표. 'calories'·'refinedCarb'·'caffeine'은 v2에서 빠졌으므로
// 저장된 프로필에 남아 있어도 여기서 걸러 낸다 — 그대로 두면 UI가 "관리 목표 1개"로 세는데
// 칩이 없어 해제할 수도 없는 유령 항목이 된다.
export const supportedReduceTargets = ['sugar', 'saturatedFat', 'sodium'];

export function normalizeScoringProfile(profile = {}) {
  const activityAliases = { low: 'none', moderate: 'normal', veryHigh: 'high' };
  const originalGoal = profile.weightGoal || profile.goal || 'maintain';

  return {
    ...profile,
    activity: activityAliases[profile.activity] || profile.activity || 'light',
    weightGoal: originalGoal,
    goalIntensity: profile.goalIntensity || profile.intensity || 'gentle',
    reduceTargets: (Array.isArray(profile.reduceTargets) ? profile.reduceTargets : []).filter((key) => supportedReduceTargets.includes(key)),
  };
}

function toHealthScore(value) {
  return Math.round(clamp(toNumber(value), 0, healthScoreMax));
}

export function getHealthScoreLabel(score) {
  const normalized = toNumber(score, -1);
  if (normalized >= scoreThresholds.excellent) return 'excellent';
  if (normalized >= scoreThresholds.good) return 'good';
  if (normalized >= scoreThresholds.fair) return 'fair';
  if (normalized >= scoreThresholds.poor) return 'poor';
  return 'veryPoor';
}

function getBmiGroup(bmi) {
  if (bmi < 18.5) return 'underweight';
  if (bmi < 23) return 'normal';
  if (bmi < 25) return 'overweight';
  if (bmi < 30) return 'obese1';
  return 'obese2';
}

function getAgeBand(age) {
  if (age >= 65) return 'older';
  if (age >= 50) return 'middle';
  return 'young';
}

function getDri2025Reference(profile) {
  const age = clamp(toNumber(profile.age, 24), 1, 120);
  const sex = profile.sex === 'female' ? 'female' : 'male';
  const ageGroup = age >= 75 ? '75plus'
    : age >= 65 ? '65to74'
      : age >= 50 ? '50to64'
        : age >= 30 ? '30to49'
          : '19to29';
  const energy = {
    male: { '19to29': 2600, '30to49': 2500, '50to64': 2200, '65to74': 2000, '75plus': 1900 },
    female: { '19to29': 2000, '30to49': 1900, '50to64': 1700, '65to74': 1600, '75plus': 1500 },
  };
  const protein = {
    male: { '19to29': 65, '30to49': 65, '50to64': 60, '65to74': 60, '75plus': 60 },
    female: { '19to29': 55, '30to49': 50, '50to64': 50, '65to74': 50, '75plus': 50 }, // 30~49세 50g — KDRIs 2025 1권 표 1(구판 55는 오기)
  };
  const fiber = {
    male: { '19to29': 30, '30to49': 30, '50to64': 30, '65to74': 30, '75plus': 30 },
    female: { '19to29': 20, '30to49': 20, '50to64': 25, '65to74': 25, '75plus': 25 },
  };
  const sodiumAi = { '19to29': 1500, '30to49': 1500, '50to64': 1500, '65to74': 1300, '75plus': 1200 };
  const sodiumLimit = { '19to29': 2300, '30to49': 2300, '50to64': 2300, '65to74': 1900, '75plus': 1800 };

  return {
    ageGroup,
    energy: energy[sex][ageGroup],
    carbohydrateRda: 130,
    proteinRda: protein[sex][ageGroup],
    fiberAi: fiber[sex][ageGroup],
    sodiumAi: sodiumAi[ageGroup],
    sodiumLimit: sodiumLimit[ageGroup],
  };
}

// 하루 적자 상한. NHLBI 1998 — BMI 27~35는 300~500, ≥35는 500~1,000 kcal/일(중하단 750 채택).
// BMI<27 구간은 지침 미제시 → 최저 구간 값(300)을 하단 연장(내부 판단). TDEE 25%는 보수적 추가 제한.
// 상한은 목표 적자(밴드 중앙)에 적용한다 — 밴드 폭 ±100kcal은 허용 오차다.
function getDeficitCap(bmi, tdee) {
  return Math.max(100, Math.min(bmi >= 35 ? 750 : bmi >= 27 ? 500 : 300, Math.round(tdee * 0.25)));
}

// 적자(음수 delta)만 상한까지 완화한다. 밴드 폭은 평행이동으로 보존하고, 잉여(저체중)는 건드리지 않는다.
function capCalorieDeficit(delta, cap) {
  const shortfall = -cap - delta.min;
  if (shortfall <= 0) return delta;
  return { min: delta.min + shortfall, max: delta.max + shortfall, hardMax: delta.hardMax + shortfall };
}

// 체중 목표별 하루 열량 조정(최종보고서 v2 7장·13장).
// 여기서 만드는 밴드는 '하루 예산'이다. 개별 식품 점수는 이 밴드를 쓰지 않고
// metrics.scoringRanges(목표를 뺀 밴드)를 쓴다 — 목표로 식품 점수를 흔드는 선례가 없다(v2 8장).
//
// 적자 상한은 '유지'에도 똑같이 적용한다. BMI 프로파일이 비만군에 이미 -500~-750의 적자를
// 담고 있어서 상한을 감량에만 씌우면 감량 예산이 유지 예산보다 커지는 역전이 났다
// (비만2단계 BMI 32.5·TDEE 2,190: 유지 1,440~1,690인데 감량이 1,590~1,790이 되는 식.
// 상한 적용 후에는 유지 1,690~1,940 / 감량 1,590~1,790으로 순서가 회복된다).
// 같은 상한을 양쪽에 적용하고, 마지막에 감량 ≤ 유지를 성분별로 강제해 역전을 구조적으로 막는다.
function getGoalCalorieDelta(profile, bmi, tdee, bmiProfile) {
  if (profile.weightGoal === 'gain') return { min: 100, max: 400, hardMax: 650 };
  const cap = getDeficitCap(bmi, tdee);
  const maintain = capCalorieDeficit(bmiProfile.calorieDelta, cap);
  if (profile.weightGoal !== 'loss' && profile.weightGoal !== 'lossProtein') return maintain;
  // 유지 예산이 이미 담고 있는 적자 위에 목표 강도만큼 더 얹고, 총 적자를 상한으로 자른다.
  const baseline = Math.max(0, -Math.round((maintain.min + maintain.max) / 2));
  const desired = profile.goalIntensity === 'aggressive' ? 500 : 300;
  const deficit = Math.max(100, Math.min(baseline + desired, cap));
  const band = { min: -(deficit + 100), max: -(deficit - 100), hardMax: -(deficit - 250) };
  return {
    min: Math.min(band.min, maintain.min),
    max: Math.min(band.max, maintain.max),
    hardMax: Math.min(band.hardMax, maintain.hardMax),
  };
}

export function calculateHealthMetrics(rawProfile = {}) {
  const profile = normalizeScoringProfile(rawProfile);
  const age = clamp(toNumber(profile.age, 24), 1, 120);
  const height = clamp(toNumber(profile.height, 165), 80, 230);
  const weight = clamp(toNumber(profile.weight, 68), 20, 250);
  const heightM = height / 100;
  const bmi = heightM ? weight / (heightM * heightM) : 0;
  const bmiGroup = getBmiGroup(bmi);
  const bmiProfile = bmiNutritionProfiles[bmiGroup];
  const dri2025 = getDri2025Reference({ ...profile, age });
  const sexOffset = profile.sex === 'female' ? -161 : profile.sex === 'none' ? -78 : 5;
  const bmr = 10 * weight + 6.25 * height - 5 * age + sexOffset;
  const activityFactor = activityFactors[profile.activity] || activityFactors.light;
  const tdee = bmr * activityFactor;
  // 여 1,200 / 남 1,500은 "안전 하한"이 아니라 AHA/ACC/TOS(2013) 권고 처방 범위의 하단이다.
  const minimumCalories = profile.sex === 'female' ? 1200 : profile.sex === 'male' ? 1500 : 1350;
  const idealWeight = heightM ? 22 * heightM * heightM : weight;
  const adjustedWeight = idealWeight + 0.25 * (weight - idealWeight);
  const proteinReferenceWeight = bmi >= 25 ? adjustedWeight : weight;
  const ageBand = getAgeBand(age);

  // 열량 밴드에서 단백질·식이섬유 목표까지 한 벌로 뽑는다. 체중 목표가 반영된 밴드와
  // 목표를 뺀 밴드를 같은 식으로 두 번 계산하기 위해 함수로 묶었다.
  const buildRanges = (delta, [proteinMinFactor, proteinMaxFactor]) => {
    // 800 kcal/일 = 지침(NHLBI·NICE·대한비만학회)이 명시한 유일한 위험선(초저열량식 경계) — 하드플로어.
    const calorieMin = Math.round(Math.max(tdee + delta.min, minimumCalories, bmr * 0.95, 800));
    const calorieMax = Math.round(Math.max(calorieMin + 100, tdee + delta.max));
    const calorieHardMax = Math.round(Math.max(calorieMax + 100, tdee + delta.hardMax));
    const proteinMin = Math.round(Math.max(dri2025.proteinRda, proteinReferenceWeight * proteinMinFactor));
    // 체중이 적으면 RDA 하한이 체중 기반 상한을 넘을 수 있어 상한을 함께 보정한다.
    const proteinMax = Math.round(Math.max(proteinReferenceWeight * proteinMaxFactor, proteinMin + 5));
    const proteinHardMax = Math.round(Math.max(proteinMax + 5, Math.min(proteinReferenceWeight * 2.2, calorieMax * 0.35 / 4)));
    const fiberMin = Math.round(Math.max(dri2025.fiberAi, bmiProfile.fiber.min, calorieMax / 1000 * 12.5)); // 12.5g/1,000kcal — KDRIs 2025 산출 계수(14는 미국 IOM 값)
    // 열량 상향(특히 증량) 시 fiberMin이 BMI 프로파일의 max를 넘어 역전되지 않게 상한을 함께 끌어올린다.
    const fiberMax = Math.max(bmiProfile.fiber.max, fiberMin + 5);
    return {
      calorieRange: { min: calorieMin, max: calorieMax, hardMax: calorieHardMax },
      proteinRange: { min: proteinMin, max: proteinMax, hardMax: proteinHardMax },
      fiberRange: { min: fiberMin, max: fiberMax, hardMax: Math.max(bmiProfile.fiber.hardMax, fiberMax + 10) },
    };
  };

  const baseProteinFactors = proteinRangeByBmiAndAge[bmiGroup][ageBand];
  let goalProteinFactors = baseProteinFactors;
  if (profile.weightGoal === 'gain') {
    goalProteinFactors = [Math.max(baseProteinFactors[0], 1.2), Math.max(baseProteinFactors[1], 2.0)];
  } else if (isProteinPriorityGoal(profile)) {
    // 근육 보존(감량기) 단백질 1.2~1.6 g/kg — Leidy 2015(일반 성인 감량기에서 검증된 유일 범위).
    // ISSN 2.3~3.1은 저항운동 병행 훈련자 대상이라 채택하지 않는다. 상한 2.0 → 1.6 하향.
    const minFactor = Math.max(baseProteinFactors[0], 1.2);
    goalProteinFactors = [minFactor, Math.max(Math.min(baseProteinFactors[1], 1.6), minFactor)];
  }

  // 하루 예산: 체중 목표를 반영한다. 장바구니('담은 총량 vs 내 예산')와 화면 표시가 이 값을 쓴다.
  const goalRanges = buildRanges(getGoalCalorieDelta(profile, bmi, tdee, bmiProfile), goalProteinFactors);
  // 채점 기준: 체중 목표를 뺀다. 개별 식품의 좋고 나쁨은 무엇을 목표하든 같아야 하고,
  // 목표는 하루 예산에만 반영한다(최종보고서 v2 8장 — 목표로 식품 점수를 흔드는 선례가 없다).
  // 체형·성별·나이·활동량 개인화는 그대로 남는다(유지 기준 BMI 프로파일을 쓰므로).
  const scoringRanges = buildRanges(getGoalCalorieDelta({ ...profile, weightGoal: 'maintain' }, bmi, tdee, bmiProfile), baseProteinFactors);
  const { calorieRange, proteinRange, fiberRange } = goalRanges;
  const { min: calorieMin, max: calorieMax } = calorieRange;

  let bmiLabel = '정상 범위';
  if (bmi >= 30) bmiLabel = '고도 비만 범위';
  else if (bmi >= 25) bmiLabel = '비만 범위';
  else if (bmi >= 23) bmiLabel = '과체중 범위';
  else if (bmi < 18.5) bmiLabel = '저체중 범위';

  return {
    bmi,
    bmiGroup,
    bmiGroupLabel: bmiProfile.label,
    bmiLabel,
    bmr: Math.round(bmr),
    tdee: Math.round(tdee),
    targetCalories: Math.round((calorieMin + calorieMax) / 2),
    calorieRange,
    proteinReferenceWeight: Math.round(proteinReferenceWeight),
    proteinRange,
    proteinTarget: Math.round((proteinRange.min + proteinRange.max) / 2),
    fiberRange,
    scoringRanges,
    dri2025,
  };
}

function isProteinPriorityGoal(profile) {
  return ['lossProtein', 'preserve'].includes(profile.weightGoal);
}

export function normalizeNutrientWeights(weights) {
  const safeWeights = nutrientWeightKeys.reduce((result, key) => {
    result[key] = Math.max(1, toNumber(weights[key]));
    return result;
  }, {});
  const totalWeight = nutrientWeightKeys.reduce((sum, key) => sum + safeWeights[key], 0) || 1;
  return nutrientWeightKeys.reduce((result, key) => {
    result[key] = safeWeights[key] / totalWeight * 100;
    return result;
  }, {});
}

export function getPersonalizedWeights() {
  // 최종보고서 v2: 동일가중(각 16.7%). 근거 — OECD/EC-JRC(2008) p.31 "어떤 방법을 쓰든
  // 가중치는 본질적으로 가치판단", NRF9.3·PFS의 동일가중 선례, 79,041건 실측에서 등급 일치도 최적.
  // BMI군별 차등 가중(bmiNutritionProfiles.weights)은 점수에 더 이상 쓰지 않는다.
  return normalizeNutrientWeights({ calories: 1, protein: 1, fiber: 1, sugar: 1, saturatedFat: 1, sodium: 1 });
}

export function getNutritionMultiplier(scope = 'cart', settings = defaultAnalysisSettings) {
  if (scope === 'single') return 0.33;
  return settings.cartMode === 'days' ? 1 : 0.33;
}

function getNutritionDistributionUnits(settings = defaultAnalysisSettings) {
  const max = settings.cartMode === 'days' ? 7 : 3;
  return clamp(toNumber(settings.cartUnits, 1), 1, max);
}

function getNutritionScopeLabel(scope = 'cart', settings = defaultAnalysisSettings) {
  if (scope === 'single') return '식사';
  const units = getNutritionDistributionUnits(settings);
  return settings.cartMode === 'days' ? `${units}일` : `${units}끼`;
}

export function getProteinPer100Kcal(product) {
  const rawCalories = product?.nutrients?.calories;
  const rawProtein = product?.nutrients?.protein;
  if (rawCalories == null || rawCalories === '' || rawProtein == null || rawProtein === '') return null;
  const calories = toNumber(rawCalories);
  if (!calories) return 0;
  return toNumber(rawProtein) / (calories / 100);
}

export function buildCategoryStats(products = []) {
  const stats = new Map();
  const global = { calories: [], sugar: [], sodium: [], saturatedFat: [], proteinDensity: [], fiber: [] };
  products.forEach((product) => {
    if (!product?.nutrients) return;
    const category = product.category || '기타';
    const target = stats.get(category) || { calories: [], sugar: [], sodium: [], saturatedFat: [], proteinDensity: [], fiber: [] };
    // 결측(null)은 0이 아니므로 백분위 모집단에 넣지 않는다.
    const rawOrNull = (value) => (value == null || value === '' ? null : toNumber(value));
    const values = {
      calories: rawOrNull(product.nutrients.calories),
      sugar: rawOrNull(product.nutrients.sugar),
      sodium: rawOrNull(product.nutrients.sodium),
      saturatedFat: rawOrNull(product.nutrients.saturatedFat),
      proteinDensity: getProteinPer100Kcal(product),
      fiber: rawOrNull(product.nutrients.fiber),
    };
    Object.entries(values).forEach(([key, value]) => {
      if (value == null || !Number.isFinite(value)) return;
      target[key].push(value);
      global[key].push(value);
    });
    stats.set(category, target);
  });
  stats.set('__global__', global);
  return stats;
}

// (구) percentileScore·getCategoryScores는 v2 점수 재설계로 제거 — 카테고리 백분위 가점(×0.18)은
// 더 이상 점수에 쓰이지 않는다. buildCategoryStats는 외부 호환을 위해 남겨둔다.

function scaleRange(range, multiplier) {
  return {
    min: Math.round(range.min * multiplier * 10) / 10,
    max: Math.round(range.max * multiplier * 10) / 10,
    hardMax: Math.round(range.hardMax * multiplier * 10) / 10,
  };
}

function scoreRangeBound(value, min, max, hardMax) {
  if (!Number.isFinite(value)) return { score: 0, level: 'danger', ratio: 0, state: '값 없음' };
  if (value < min) {
    const shortageRatio = min > 0 ? (min - value) / min : 1;
    const score = Math.round(clamp(healthScoreMax - shortageRatio * 45, 55, healthScoreMax));
    return { score, level: score < 65 ? 'caution' : 'watch', ratio: min > 0 ? value / min : 0, state: score < 65 ? '보완 필요' : '조금 부족' };
  }
  if (value <= max) return { score: healthScoreMax, level: 'stable', ratio: max > 0 ? value / max : 1, state: '적정' };
  if (value > hardMax) {
    const hardExcessRatio = hardMax > 0 ? (value - hardMax) / hardMax : 1;
    return { score: Math.round(clamp(55 - hardExcessRatio * 90, 5, 55)), level: 'danger', ratio: max > 0 ? value / max : 2, state: '위험 초과' };
  }
  const excessRatio = max > 0 ? (value - max) / max : 1;
  const score = Math.round(clamp(healthScoreMax - excessRatio * 80, 10, healthScoreMax));
  return { score, level: score < 70 ? 'caution' : 'watch', ratio: max > 0 ? value / max : 2, state: '초과' };
}

function scoreUpperBound(value, max, hardMax) {
  if (!Number.isFinite(value)) return { score: 0, level: 'danger', ratio: 0, state: '값 없음' };
  if (value <= max) return { score: healthScoreMax, level: 'stable', ratio: max > 0 ? value / max : 0, state: value <= max * 0.9 ? '안정' : '상한 근접' };
  if (value > hardMax) {
    const hardExcessRatio = hardMax > 0 ? (value - hardMax) / hardMax : 1;
    return { score: Math.round(clamp(55 - hardExcessRatio * 90, 5, 55)), level: 'danger', ratio: max > 0 ? value / max : 2, state: '위험 초과' };
  }
  const excessRatio = max > 0 ? (value - max) / max : 1;
  const score = Math.round(clamp(healthScoreMax - excessRatio * 90, 5, healthScoreMax));
  return { score, level: score < 70 ? 'caution' : 'watch', ratio: max > 0 ? value / max : 2, state: '초과' };
}

export function getNutrientGuidelineSpecs(rawProfile, metrics, scope = 'cart', settings = defaultAnalysisSettings, personalizedWeights = null) {
  const profile = normalizeScoringProfile(rawProfile);
  const bmiGroup = metrics?.bmiGroup || 'normal';
  const bmiProfile = bmiNutritionProfiles[bmiGroup] || bmiNutritionProfiles.normal;
  const scoringWeights = normalizeNutrientWeights(personalizedWeights || bmiProfile.weights);
  const multiplier = getNutritionMultiplier(scope, settings);
  // 개별 식품 채점('single')은 체중 목표를 뺀 기준을 쓴다 — 같은 식품이 목표에 따라 다른 점수를
  // 받지 않게 한다(v2 8장). 장바구니('cart')는 '담은 총량 vs 내 하루 예산' 비교이므로
  // 목표가 반영된 밴드를 그대로 써야 맞다.
  const ranges = (scope === 'single' && metrics?.scoringRanges) ? metrics.scoringRanges : metrics;
  const calorieRange = scaleRange(ranges?.calorieRange || { min: 1600, max: 1800, hardMax: 2100 }, multiplier);
  const proteinRange = scaleRange(ranges?.proteinRange || { min: 60, max: 100, hardMax: 130 }, multiplier);
  const fiberRange = scaleRange(ranges?.fiberRange || { min: 25, max: 40, hardMax: 55 }, multiplier);
  const sodiumReference = metrics?.dri2025 || getDri2025Reference(profile);
  const sodiumBaseMax = Math.min(bmiProfile.sodium.max, sodiumReference.sodiumLimit);
  // 식생활 목표는 단일식품 점수식을 바꾸지 않는다. 나트륨·단백질·당류·포화지방
  // 목표는 기존 소점수로 테마 후보를 고르는 탐색 기능에서만 사용한다(IRB 1-5).
  const sodiumMax = sodiumBaseMax * multiplier;
  const sugarPercent = bmiProfile.sugarPercent.max;
  const saturatedFatPercent = bmiProfile.saturatedFatPercent.max;
  const percentEnergyBase = ranges?.calorieRange?.max || 1800;
  const sugarMax = percentEnergyBase * sugarPercent / 4 * multiplier;
  const sugarHardMax = percentEnergyBase * bmiProfile.sugarPercent.hardMax / 4 * multiplier;
  const saturatedFatMax = percentEnergyBase * saturatedFatPercent / 9 * multiplier;
  const saturatedFatHardMax = percentEnergyBase * bmiProfile.saturatedFatPercent.hardMax / 9 * multiplier;

  return [
    { key: 'calories', label: metricLabels.calories, unit: 'kcal', direction: 'range', ...calorieRange, weight: scoringWeights.calories },
    { key: 'protein', label: metricLabels.protein, unit: 'g', direction: 'range', ...proteinRange, weight: scoringWeights.protein },
    { key: 'fiber', label: metricLabels.fiber, unit: 'g', direction: 'range', ...fiberRange, weight: scoringWeights.fiber },
    { key: 'sugar', label: metricLabels.sugar, unit: 'g', direction: 'upper', max: Math.round(sugarMax * 10) / 10, hardMax: Math.round(Math.max(sugarHardMax, sugarMax + 1) * 10) / 10, weight: scoringWeights.sugar },
    { key: 'saturatedFat', label: metricLabels.saturatedFat, unit: 'g', direction: 'upper', max: Math.round(saturatedFatMax * 10) / 10, hardMax: Math.round(Math.max(saturatedFatHardMax, saturatedFatMax + 0.5) * 10) / 10, weight: scoringWeights.saturatedFat },
    { key: 'sodium', label: metricLabels.sodium, unit: 'mg', direction: 'upper', max: Math.round(sodiumMax), hardMax: Math.round(Math.min(bmiProfile.sodium.hardMax, sodiumReference.sodiumLimit) * multiplier), weight: scoringWeights.sodium },
  ];
}

function averageScoredRows(rows) {
  const scored = rows.filter((row) => row.score !== null);
  const totalWeight = scored.reduce((sum, row) => sum + row.weight, 0) || 1;
  return {
    score: toHealthScore(scored.reduce((sum, row) => sum + row.score * row.weight, 0) / totalWeight),
    hasScoredRows: scored.length > 0,
  };
}

export function buildGuidelineComparison(nutrients, rawProfile, metrics, scope = 'cart', settings = defaultAnalysisSettings, personalizedWeights = null) {
  const specs = getNutrientGuidelineSpecs(rawProfile, metrics, scope, settings, personalizedWeights);
  const scopeLabel = getNutritionScopeLabel(scope, settings);
  const rows = specs.map((spec) => {
    const raw = nutrients?.[spec.key];
    // 결측은 0으로 평가하지 않는다 — 예: 식이섬유는 전체의 97%가 미표기라 0g 취급 시 전 상품이 일괄 감점된다.
    if (raw == null || raw === '') {
      return { ...spec, total: null, ratio: 0, percent: 0, score: null, level: 'unknown', state: '정보 없음', scopeLabel, reason: `${scopeLabel} ${spec.label} 정보 없음` };
    }
    const total = toNumber(raw);
    const scored = spec.direction === 'upper'
      ? scoreUpperBound(total, spec.max, spec.hardMax)
      : scoreRangeBound(total, spec.min, spec.max, spec.hardMax);
    return {
      ...spec,
      total,
      ratio: scored.ratio,
      percent: Math.round(scored.ratio * 100),
      score: scored.score,
      level: scored.level,
      state: scored.state,
      scopeLabel,
      reason: `${scopeLabel} ${spec.label} ${scored.state}`,
    };
  });
  // 값이 있는 영양소끼리만 가중 평균한다 — 결측 영양소의 가중치는 자연히 나머지로 재분배된다.
  const averaged = averageScoredRows(rows);
  const scoredRows = rows.filter((row) => row.score !== null);
  const score = averaged.score;
  return {
    rows,
    score,
    hasScoredRows: averaged.hasScoredRows,
    reasons: scoredRows
      .map((row) => ({ row, impact: row.weight * (healthScoreMax - row.score) }))
      .filter((item) => item.impact > 2)
      .sort((a, b) => b.impact - a.impact)
      .slice(0, 3)
      .map(({ row }) => row.reason),
  };
}

// (구) getScoreAdjustment는 v2 단일 식품 점수 재설계로 제거 — 초과 위험은 나트륨 600mg 캡과
// 소점수 자체(상한 대비 감점)가 담당한다. 장바구니도 v2 8장 「두 축 분리」 이후로는
// 위험 보정을 점수에 적용하지 않으며, 예산 축은 rows(누적 영양량 게이지)가 전담한다.

export function buildAvoidTerms(rawProfile = {}) {
  const profile = normalizeScoringProfile(rawProfile);
  const selected = (profile.avoidIngredients || [])
    .filter((item) => item && item !== '없음')
    .flatMap((item) => avoidIngredientTokens[item] || [item]);
  const custom = String(profile.avoidCustom || '')
    .split(/[,/·\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  return [...new Set([...selected, ...custom])];
}

export function getAvoidMatches(product, avoidTerms = []) {
  const text = `${product?.ingredients || ''} ${product?.name || ''}`;
  return avoidTerms.filter((term) => text.includes(term));
}

function getIngredientTags(product) {
  const text = product?.ingredients || '';
  const tags = [];
  if (ingredientRules.addedSugar.some((token) => text.includes(token))) tags.push('첨가당');
  if (ingredientRules.sweetener.some((token) => text.includes(token))) tags.push('감미료');
  if (ingredientRules.refinedCarb.some((token) => text.includes(token))) tags.push('정제탄수화물');
  return tags;
}

function normalizeAmountUnit(rawAmount, rawUnit) {
  const amount = Number(String(rawAmount).replace(/,/g, ''));
  if (!Number.isFinite(amount)) return null;
  const unit = String(rawUnit || '').toLowerCase();
  if (unit === 'kg') return { amount: amount * 1000, unit: 'g', label: `${amount}kg` };
  if (unit === 'l') return { amount: amount * 1000, unit: 'ml', label: `${amount}L` };
  return { amount, unit, label: `${amount}${unit}` };
}

function parseAmountWithUnit(value) {
  const match = String(value || '').normalize('NFKC').match(amountWithUnitPattern);
  return match ? normalizeAmountUnit(match[1], match[2]) : null;
}

function getProductIdentityText(product) {
  return [product?.name, product?.originalTitle, product?.category, product?.matchedProductName, product?.nutritionMatch?.foodName]
    .filter(Boolean)
    .join(' ')
    .normalize('NFKC')
    .toLowerCase();
}

function getProductSearchText(product) {
  return [
    product?.name,
    product?.originalTitle,
    product?.category,
    product?.store,
    product?.brand,
    product?.maker,
    product?.matchedProductName,
    product?.ingredients,
  ].filter(Boolean).join(' ').normalize('NFKC').toLowerCase();
}

function getMealComponentRole(product) {
  const text = getProductSearchText(product);
  return mealComponentRoles.find((role) => role.keywords.some((keyword) => text.includes(keyword.toLowerCase()))) || null;
}

function getServingBasis(product) {
  const candidates = [product?.serving, product?.nutritionMatch?.servingSize, product?.nutritionMatch?.nutritionServing];
  const source = candidates.find((value) => parseAmountWithUnit(value));
  const parsed = parseAmountWithUnit(source);
  return parsed ? { ...parsed, source: source || '' } : null;
}

function getPackageAmount(product) {
  const candidates = [product?.foodWeight, product?.nutritionMatch?.totalWeight, product?.name, product?.originalTitle];
  const source = candidates.find((value) => parseAmountWithUnit(value));
  const parsed = parseAmountWithUnit(source);
  return parsed ? { ...parsed, source: source || '' } : null;
}

function getPackageCount(product) {
  const text = [product?.name, product?.originalTitle].filter(Boolean).join(' ').normalize('NFKC');
  const matches = [...text.matchAll(packageCountPattern)].map((match) => Number(match[1])).filter((value) => Number.isFinite(value) && value > 0);
  return matches.length ? Math.max(...matches) : 1;
}

function getServingCount(product) {
  const text = [product?.name, product?.originalTitle].filter(Boolean).join(' ').normalize('NFKC');
  const rangeMatch = text.match(servingCountRangePattern);
  if (rangeMatch) {
    const min = Number(rangeMatch[1]);
    const max = Number(rangeMatch[2]);
    if (Number.isFinite(min) && Number.isFinite(max) && min > 0 && max > 0) return { count: (min + max) / 2, label: `${rangeMatch[1]}~${rangeMatch[2]}인분` };
  }
  const match = text.match(servingCountPattern);
  if (!match) return null;
  const count = Number(match[1]);
  return Number.isFinite(count) && count > 0 ? { count, label: `${match[1]}인분` } : null;
}

function getPackageUnitAmount(product) {
  const text = [product?.name, product?.originalTitle].filter(Boolean).join(' ').normalize('NFKC');
  const match = text.match(packageUnitAmountPattern);
  if (!match) return null;
  const parsed = normalizeAmountUnit(match[1], match[2]);
  return parsed ? { ...parsed, source: match[0] } : null;
}

function isGenericNutritionBasis(amount) {
  return Boolean(amount && ['g', 'ml'].includes(amount.unit) && Math.abs(amount.amount - 100) < 0.01);
}

function buildIntakeAmount(amount, overrides = {}) {
  return amount ? { ...amount, ...overrides } : null;
}

const singleIntakeRules = [
  { key: 'mealKit', label: '밀키트/전골세트', pattern: /밀키트|전골세트|쿠킹박스|간편조리세트/, limits: { g: 500, ml: 500 }, manualRecommended: true },
  { key: 'riceCake', label: '즉석밥/떡류', pattern: /떡볶이떡|떡국떡|가래떡/, limits: { g: 200 } },
  { key: 'fishCake', label: '어묵류', pattern: /어묵|오뎅/, limits: { g: 100 } },
  { key: 'boneBroth', label: '사골 국물류', pattern: /사골(?:육수|국물|국|탕|곰탕|설렁탕)?/, limits: { g: 250, ml: 250 } },
  { key: 'galbitang', label: '갈비탕/곰탕/설렁탕/육개장', pattern: /갈비탕|설렁탕|곰탕|도가니탕|삼계탕|육개장|해장국|순대국|추어탕/, limits: { g: 500, ml: 500 } },
  { key: 'gukbap', label: '국밥류', pattern: /국밥/, limits: { g: 500, ml: 500 } },
  { key: 'jjigae', label: '찌개', pattern: /김치찌개(?!용)|된장찌개|순두부찌개|부대찌개|고추장찌개|청국장|찌개(?!용)/, limits: { g: 300, ml: 300 } },
  { key: 'tangJeongol', label: '탕/전골', pattern: /감자탕|알탕|곱창전골|전골(?!용)|매운탕|해물탕|동태탕|꽃게탕|대구탕/, limits: { g: 400, ml: 400 } },
  { key: 'soup', label: '국/일반국', pattern: /국\/탕\/찌개|된장국|미역국|콩나물국|북엇국|무국|소고기국|쇠고기국|김치국|어묵국|계란국|달걀국|시래기국|근대국|아욱국|국물요리/, limits: { g: 250, ml: 250 } },
  { key: 'porridge', label: '죽', pattern: /전복죽|야채죽|닭죽|죽/, limits: { g: 350, ml: 350 } },
  { key: 'instantRice', label: '즉석밥/밥류', pattern: /즉석밥|햇반|공기밥|현미밥|잡곡밥|백미밥|밥류/, limits: { g: 200 } },
  { key: 'friedRiceBowl', label: '볶음밥/덮밥', pattern: /볶음밥|덮밥/, limits: { g: 300 } },
  { key: 'lunchbox', label: '도시락', pattern: /도시락(?!김)/, mode: 'whole' },
  { key: 'gimbap', label: '김밥/주먹밥', pattern: /삼각김밥|주먹밥|김밥(?!김|용)/, exclude: /김밥용|전골용|우동용/, mode: 'whole' },
  { key: 'noodle', label: '면류', pattern: /컵라면|라면|우동|냉면|칼국수|쌀국수|짜장면|짬뽕|비빔면|파스타|스파게티|면류/, exclude: /우동용|전골용|김밥용/, mode: 'whole' },
  { key: 'saladMeal', label: '샐러드 식사류', pattern: /샐러드|샐러드볼/, limits: { g: 250 }, mode: 'wholeOrDefault' },
  // 젓갈류는 별표 3에서 1회 섭취참고량이 '－'(미지정)이라 법정값을 빌릴 데가 없다(DB 979건 전부 미표기).
  // 법이 값을 정한 인접 염장 반찬류 — 장류절임 중 장아찌 15g · 절임식품 25g · 김치 40g — 의
  // 대역 중앙인 25g을 쓴다. 법정값이 아니라 내부 판단이므로 보고서에 그렇게 표기해야 한다.
  // 이 규칙이 없으면 분류명에 '양념'이 없는 젓갈 126건이 소스 규칙에도 안 걸려 기본 상한 450g까지
  // 통과한다 — 평균 197g · 나트륨 11,599mg, 101건이 한 품목만으로 하루 상한(2,300mg)을 넘고
  // 최악은 450g · 40,415mg이다(멸치젓 계열, 100g당 8,981mg). 양념젓갈 853건은 소스 규칙이 30g으로 잘랐다.
  { key: 'saltedSeafood', label: '젓갈류', pattern: /젓갈|액젓|식해/, limits: { g: 25, ml: 25 } },
  // exclude에는 '양념육·조림'만 남긴다. 양념육 1회량은 100~150g대라 소스 30g으로 잡히면 안 된다.
  // 젓갈·절임·김치·장아찌를 뺀 이유: 법정 참고량(별표 3)이 소스 규칙보다 먼저 적용되도록 바꿔서
  // 김치 40g·절임 25g이 자동으로 잡히고, 법정값이 없는 젓갈은 위 전용 규칙이 받는다.
  { key: 'sauce', label: '소스/드레싱', pattern: /소스|드레싱|양념/, exclude: /육|조림/, limits: { g: 30, ml: 30 } },
];

function getSingleIntakeRule(product) {
  const text = getProductIdentityText(product);
  return singleIntakeRules.find((rule) => rule.pattern.test(text) && (!rule.exclude || !rule.exclude.test(text))) || null;
}

function getFallbackSingleIntakeLimit(product, unit) {
  const rule = getSingleIntakeRule(product);
  if (rule?.limits?.[unit]) return rule.limits[unit];
  const role = getMealComponentRole(product);
  if (role) return unit === 'g' ? 200 : unit === 'ml' ? 300 : null;
  if (unit === 'g') return 450;
  if (unit === 'ml') return 600;
  return null;
}

function getCategoryIntakeAmount(product, serving, packageAmount) {
  const rule = getSingleIntakeRule(product);
  const amount = packageAmount || serving;
  if (!amount) return null;
  if (rule?.mode === 'whole') return buildIntakeAmount(amount, { servingRuleKey: rule.key, servingRuleLabel: rule.label });
  if (rule?.mode === 'wholeOrDefault' && packageAmount) return buildIntakeAmount(packageAmount, { servingRuleKey: rule.key, servingRuleLabel: rule.label });
  const limit = getFallbackSingleIntakeLimit(product, amount.unit);
  if (!limit) return buildIntakeAmount(amount, { servingRuleKey: rule?.key, servingRuleLabel: rule?.label, manualRecommended: Boolean(rule?.manualRecommended) });
  if (!packageAmount && serving && isGenericNutritionBasis(serving) && limit > serving.amount) {
    return { amount: limit, unit: serving.unit, label: `1회 ${limit}${serving.unit}`, source: serving.source, cappedFrom: serving, servingRuleKey: rule?.key, servingRuleLabel: rule?.label, manualRecommended: Boolean(rule?.manualRecommended) };
  }
  if (amount.amount <= limit) return buildIntakeAmount(amount, { servingRuleKey: packageAmount ? 'productAmount' : rule?.key, servingRuleLabel: packageAmount ? '상품 총량' : rule?.label, manualRecommended: Boolean(rule?.manualRecommended) });
  return { amount: limit, unit: amount.unit, label: `1회 ${limit}${amount.unit}`, source: amount.source, cappedFrom: amount, servingRuleKey: rule?.key, servingRuleLabel: rule?.label, manualRecommended: Boolean(rule?.manualRecommended) };
}

function getSingleIntakeAmount(product, serving, packageAmount) {
  const amount = packageAmount || serving;
  if (!amount) return null;
  if (product?.isRiceAddon) return amount;
  const servingCount = packageAmount ? getServingCount(product) : null;
  if (servingCount?.count >= 1) return { amount: packageAmount.amount / servingCount.count, unit: packageAmount.unit, label: `1회 ${Math.round((packageAmount.amount / servingCount.count) * 10) / 10}${packageAmount.unit}`, source: `${servingCount.label} 기준`, cappedFrom: packageAmount, servingRuleKey: 'servingCount', servingRuleLabel: '인분 정보' };
  const packageCount = getPackageCount(product);
  const packageUnitAmount = packageCount > 1 ? getPackageUnitAmount(product) : null;
  if (packageAmount && packageUnitAmount && packageUnitAmount.unit === packageAmount.unit) return buildIntakeAmount(packageUnitAmount, { servingRuleKey: 'packageCount', servingRuleLabel: '팩/개수 정보' });
  if (serving && !isGenericNutritionBasis(serving) && (!packageAmount || serving.unit === packageAmount.unit)) return buildIntakeAmount(serving, { servingRuleKey: 'dbServing', servingRuleLabel: 'DB 1회 섭취량' });
  // 법정 1회 섭취참고량(별표 3)은 손으로 쓴 카테고리 추정보다 근거가 강하므로 먼저 쓴다.
  // DB 64,715건(81.9%)에 존재한다. 표기가 'ml(g)'처럼 섞여 있어 g/ml은 서로 대체 가능한 것으로 본다.
  const legal = getLegalIntakeAmount(product, amount.unit);
  if (legal) return legal;
  return getCategoryIntakeAmount(product, serving, packageAmount);
}

function getLegalIntakeAmount(product, unit) {
  const picked = pickReferenceIntakeEntry(parseReferenceIntakeEntries(product?.nutritionBasis?.referenceIntake), product);
  if (!picked || !(picked.amount > 0)) return null;
  const massUnits = ['g', 'ml'];
  if (picked.unit !== unit && !(massUnits.includes(picked.unit) && massUnits.includes(unit))) return null;
  return { amount: picked.amount, unit, label: `1회 ${picked.amount}${unit}`, source: '1회 섭취참고량', servingRuleKey: 'legalReference', servingRuleLabel: '법정 1회 섭취참고량' };
}

export function getUnitConversion(product, units = 1) {
  const serving = getServingBasis(product);
  const packageAmount = getPackageAmount(product);
  const intakeAmount = getSingleIntakeAmount(product, serving, packageAmount);
  const count = getPackageCount(product);
  const unitCount = clamp(toNumber(units, 1), 1, 10);
  if (serving && intakeAmount && serving.unit === intakeAmount.unit && serving.amount > 0) {
    const factor = (intakeAmount.amount / serving.amount) * unitCount;
    return { factor, confidence: 'converted', basisLabel: `${serving.label} 기준`, packageLabel: `${intakeAmount.label} × ${unitCount}개`, salesLabel: count > 1 ? `판매묶음 ${count}개` : '단품', unitLabel: `${intakeAmount.label} 1개`, units: unitCount, packageCount: count, servingAmount: serving, packageAmount, intakeAmount, factorLabel: `(${intakeAmount.amount}/${serving.amount}) × ${unitCount}` };
  }
  return { factor: unitCount, confidence: serving || intakeAmount ? 'partial' : 'unknown', basisLabel: serving ? `${serving.label} 기준` : '기준 단위 불명', packageLabel: intakeAmount ? `${intakeAmount.label} × ${unitCount}개` : `${unitCount}개`, salesLabel: count > 1 ? `판매묶음 ${count}개` : '단품', unitLabel: intakeAmount ? `${intakeAmount.label} 1개` : '1개', units: unitCount, packageCount: count, servingAmount: serving, packageAmount, intakeAmount, factorLabel: unitCount > 1 ? `${unitCount}` : '1' };
}

export function getCalculatedNutrients(product, units = 1) {
  const conversion = getUnitConversion(product, units);
  // 결측(null)은 0g가 아니므로 그대로 보존한다 — 점수 단계에서 가중치를 재분배한다.
  const nutrients = Object.fromEntries(Object.entries(product?.nutrients || {}).map(([key, value]) => [
    key,
    value == null || value === '' ? null : toNumber(value) * conversion.factor,
  ]));
  return { nutrients, conversion };
}

export function createScoreContext(rawProfile = {}, productPool = [], overrides = {}) {
  const profile = normalizeScoringProfile(rawProfile);
  const metrics = overrides.metrics || calculateHealthMetrics(profile);
  return {
    profile,
    metrics,
    weights: overrides.weights || getPersonalizedWeights(profile, metrics),
    // v2 점수 경로는 카테고리 백분위를 쓰지 않는다 — 목록 재정렬 때마다 통계를 새로 만들던 낭비 제거.
    categoryStats: overrides.categoryStats || null,
    avoidTerms: overrides.avoidTerms || buildAvoidTerms(profile),
    analysisSettings: { ...defaultAnalysisSettings, ...(overrides.analysisSettings || {}) },
  };
}

// ─── 단일 식품 점수(최종보고서 v2 설계) ─────────────────────────────────────────
// 부정 영양소(열량·당류·포화지방·나트륨)는 100g(밀도) 기준, 긍정 영양소(단백질·식이섬유)는
// 법정 1회 섭취참고량(「식품등의 표시기준」 별표 3) 기준으로 평가한다 — Drewnowski 2009 하이브리드.
// 6개 소점수를 동일가중 평균하고, 나트륨 600mg/100g 초과 시 50점 상한(고열량·저영양 고시 컷)을 건다.

const KCAL_POINT_STEP = 335 / 4.184; // 80.07 kcal/100g — FSA-Ofcom·FSANZ 배점표의 0점 구간(≤335 kJ)이자 1점 간격

// 열량 소점수: 사용자 무관 단조 감점. 국제 표준의 335 kJ 계단(0~10점)을 95→5점에 선형 사상.
// 연속화(계단 제거)는 문헌이 아닌 자체 판단 — 79↔81 kcal에서 등급이 갈리는 절벽을 없애기 위함.
// 열량 소점수만 5~95 범위다(명세서 v3 13장 공식 그대로). 나머지 5개 소점수는 0~100이라
// 6개 평균의 실제 도달 범위가 0~100이 아니다 — 전수 측정 결과 5.4 ~ 98.9점.
// (명세서 F-4에는 6.8 ~ 98.9로 적혀 있는데, 면류 1회 섭취참고량 파싱을 고치면서 하한이 내려갔다.)
// 화면 문구를 "100점 만점" → "0~100점 척도"로 바꿔 도달 불가한 만점을 주장하지 않도록 했다.
// 소점수 범위를 0~100으로 재정규화하는 대안은 채택하지 않았다 — 전체 점수 분포가 이동해
// 보고서 9장에서 재산출한 등급 컷(79.9/73.9/51.6/38.4)을 다시 뽑아야 하기 때문이다.
// (최종보고서 v2 15장 8번 "점수 범위 0~100 또는 만점 명시" 중 후자를 택한 것.)
function scoreCaloriesPer100g(kcalPer100g) {
  const steps = clamp((kcalPer100g - KCAL_POINT_STEP) / KCAL_POINT_STEP, 0, 10);
  return clamp(95 - 9 * steps, 5, 95);
}

// 영양성분 표시 기준량(식약처 DB는 대부분 100g/100ml). 후보를 각각 파싱해 먼저 성공하는 값을 쓰고,
// 전부 실패하면 100으로 본다 (getServingBasis의 후보 순회 관례와 동일).
function getNutritionBasisAmount(product) {
  const parsed = parseAmountWithUnit(product?.nutritionBasis?.servingSize) || parseAmountWithUnit(product?.serving);
  return parsed && parsed.amount > 0 ? parsed.amount : 100;
}

// 「식품등의 표시기준」 별표 3의 1회 섭취참고량은 한 칸에 세부 유형을 함께 적는 경우가 있다.
// 면류: "생·숙면 200g, 건면 100g, 당면 30g, 유탕면(봉지)120g, 유탕면(용기)80g"
// 첫 값(200g)만 읽으면 건면·유탕면 1,646건이 1.7~2.5배 부풀려진 기준량으로 채점된다
// (긍정 영양소는 1회 제공량 기준이라 섭취량이 과대평가 → 점수 상승, 표준 프로필 기준 529건의 등급이 바뀐다).
// 실측상 다중값은 DB 79,041건 중 이 한 형식(4,243건)뿐이고, 세부 유형은 category_small이
// 그대로 담고 있어(생면 804 / 숙면 1,793 / 건면 832 / 유탕면 814) 분류 텍스트로 판별한다.
const referenceIntakeEntryPattern = /([^,;]*?)(\d+(?:,\d{3})*(?:\.\d+)?)\s*(kg|g|mg|l|ml)(?![a-z])/gi;

// 유탕면만 포장 형태로 갈린다(봉지 120g / 용기 80g). 제품명에 용기형 표기가 있으면 용기로 본다.
const cupNoodlePattern = /용기|컵|사발|왕뚜껑|도시락|보울|bowl|cup/i;

// 별표 3 라벨 → 제품 텍스트에서 확인할 세부 유형. cup은 포장 형태까지 일치해야 하는 항목.
const referenceIntakeRules = [
  { label: /생.*숙면|숙면|생면/, keywords: [/생면/, /숙면/] },
  { label: /건면/, keywords: [/건면/] },
  { label: /당면/, keywords: [/당면/] },
  { label: /유탕면[^)]*용기/, keywords: [/유탕면|튀김면/], cup: true },
  { label: /유탕면/, keywords: [/유탕면|튀김면/], cup: false },
];

function parseReferenceIntakeEntries(value) {
  const text = String(value || '').normalize('NFKC');
  const entries = [];
  for (const match of text.matchAll(referenceIntakeEntryPattern)) {
    const parsed = normalizeAmountUnit(match[2], match[3]);
    if (parsed && parsed.amount > 0) entries.push({ ...parsed, tag: String(match[1] || '').trim() });
  }
  return entries;
}

// 세부 유형은 분류 텍스트로만 본다. 제품명은 마케팅 문구라 유형을 오인시킨다 —
// '생면식감'(실제 건면)·'영생면'(실제 유탕면)이 이름의 '생면' 때문에 200g으로 잡혔다.
// 분류에 유형이 없는 제품만 이름까지 넓혀서 한 번 더 본다.
function findReferenceIntakeMatch(entries, text, isCup) {
  return entries.find((entry) => {
    const rule = referenceIntakeRules.find((item) => item.label.test(entry.tag));
    if (!rule || !rule.keywords.some((keyword) => keyword.test(text))) return false;
    return rule.cup === undefined || rule.cup === isCup;
  });
}

function pickReferenceIntakeEntry(entries, product) {
  if (entries.length <= 1) return entries[0] || null;
  const identityText = getProductIdentityText(product);
  // 포장 형태(봉지/용기)는 분류에 없고 제품명에만 나타나므로 이름까지 포함해 본다.
  const isCup = cupNoodlePattern.test(identityText);
  const categoryText = [product?.category, ...(product?.categories || [])].filter(Boolean).join(' ').normalize('NFKC').toLowerCase();
  const matched = findReferenceIntakeMatch(entries, categoryText, isCup) || findReferenceIntakeMatch(entries, identityText, isCup);
  // 판별 불가하면 기존 동작(첫 값)을 유지한다 — 임의의 다른 값을 고르면 근거 없이 점수만 흔든다.
  return matched || entries[0];
}

// 법정 1회 섭취참고량. DB의 81.9%에 존재하며, 없으면 100g으로 본다.
function getLegalReferenceAmount(product) {
  const picked = pickReferenceIntakeEntry(parseReferenceIntakeEntries(product?.nutritionBasis?.referenceIntake), product);
  return picked ? picked.amount : 100;
}

const positiveNutrientKeys = ['protein', 'fiber'];
const negativeNutrientKeys = ['sugar', 'saturatedFat', 'sodium'];

export function scoreProduct(product, context = {}) {
  if (!product?.nutrients) return { score: null, label: 'pending', ingredientTags: [], avoidMatches: [], features: {} };
  const resolvedContext = context.profile ? context : createScoreContext(context, context.productPool || []);
  const ingredientTags = getIngredientTags(product);
  const avoidMatches = getAvoidMatches(product, resolvedContext.avoidTerms || []);

  const specs = getNutrientGuidelineSpecs(resolvedContext.profile || {}, resolvedContext.metrics || {}, 'single', resolvedContext.analysisSettings || defaultAnalysisSettings, resolvedContext.weights);
  const specByKey = Object.fromEntries(specs.map((spec) => [spec.key, spec]));
  const basisAmount = getNutritionBasisAmount(product);
  const referenceAmount = getLegalReferenceAmount(product);
  // 결측(null)은 0이 아니므로 소점수에서 제외한다 — 남은 소점수끼리 평균(가중치 자동 재분배).
  // 명세서 v3 C-1·F-4 규정("값이 있는 영양소만 평균, 0으로 대체하지 않음").
  //
  // 알려진 부작용 — 놓친 게 아니라 재보고 채택한 것이다(2026-08-20 전수 측정).
  // 식이섬유는 79,041건 중 2.4%(1,895건)만 표기돼 있고, 1끼 목표(8.3~13.2g)에 견줘
  // 가공식품 1회 제공량의 식이섬유가 중앙 2.6g(사분위 0.9~5.5g)뿐이라 소점수 중앙값이 27점으로 구조적으로 낮다.
  // 그래서 '표기한 제품만' 그 낮은 점수를 반영받는다 — 표기 제품은 미표기 제품 대비
  // 실제 품질 우위가 +5.5점인데 점수 차이는 +1.8점에 그친다(= 표기에 3.7점 페널티).
  // 등급이 갈리는 건 481건(전체의 0.61%).
  //
  // 대안을 전부 재봤으나 더 나빴다: 결측=0(Nutri-Score 방식)은 왜곡이 반대로 5.0점 생기고
  // 매우좋음이 8.3% → 0.4%로 붕괴한다. 결측=중립 50점은 근거 없는 임의값이다.
  // 왜곡이 0인 유일한 안은 식이섬유를 빼고 5영양소로 가는 것인데, 보고서 13장
  // 「최종 설정 — 영양소 6개 유지」를 뒤집는 결정이라 채택하지 않았다(보고서 14장 ⑦
  //  "식이섬유는 2.4%만 있어 아무것도 주장할 수 없습니다"와 함께 읽을 것).
  const per100 = Object.fromEntries(Object.entries(product.nutrients).map(([key, value]) => [
    key,
    value == null || value === '' ? null : toNumber(value) / basisAmount * 100,
  ]));

  const subScores = {};
  const rows = [];
  if (per100.calories != null) {
    const sub = scoreCaloriesPer100g(per100.calories);
    subScores.calories = sub;
    const state = per100.calories <= KCAL_POINT_STEP ? '저열량' : per100.calories <= KCAL_POINT_STEP * 4 ? '보통' : '고열량';
    rows.push({ key: 'calories', label: metricLabels.calories, unit: 'kcal', score: Math.round(sub * 10) / 10, total: Math.round(per100.calories), basis: '100g', state, reason: `100g당 열량 ${Math.round(per100.calories)}kcal (${state})` });
  }
  positiveNutrientKeys.forEach((key) => {
    const raw = per100[key];
    const spec = specByKey[key];
    if (raw == null || !spec) return;
    const intake = raw * referenceAmount / 100; // 법정 1회분을 먹었을 때의 섭취량
    const target = spec.min;
    const sub = 100 * Math.min(1, target > 0 ? intake / target : 1);
    subScores[key] = sub;
    const state = sub >= 95 ? '충분' : sub >= 60 ? '보통' : '부족';
    rows.push({ key, label: spec.label, unit: spec.unit, score: Math.round(sub * 10) / 10, total: Math.round(intake * 10) / 10, target, basis: `1회 제공량(${referenceAmount}g)`, state, reason: `1회 제공량당 ${spec.label} ${Math.round(intake * 10) / 10}${spec.unit} · 1끼 권장 ${target}${spec.unit} (${state})` });
  });
  negativeNutrientKeys.forEach((key) => {
    const raw = per100[key];
    const spec = specByKey[key];
    if (raw == null || !spec) return;
    const target = spec.max;
    const sub = 100 * (1 - Math.min(1, target > 0 ? raw / target : 1));
    subScores[key] = sub;
    const state = raw <= target * 0.5 ? '여유' : raw <= target ? '상한 근접' : '상한 초과';
    rows.push({ key, label: spec.label, unit: spec.unit, score: Math.round(sub * 10) / 10, total: Math.round(raw * 10) / 10, target, basis: '100g', state, reason: `100g당 ${spec.label} ${Math.round(raw * 10) / 10}${spec.unit} · 1끼 상한 ${target}${spec.unit} (${state})` });
  });

  const subValues = Object.values(subScores);
  if (!subValues.length) {
    return { score: null, label: 'pending', ingredientTags, avoidMatches, features: {} };
  }
  let score = subValues.reduce((sum, value) => sum + value, 0) / subValues.length;
  const sodiumCapped = per100.sodium != null && per100.sodium > 600;
  // 캡이 실제로 점수를 끌어내렸는지 구분한다 — 이미 50점 미만인 제품에 "50점 상한 적용"이라고 쓰면 오해를 준다.
  const sodiumCapApplied = sodiumCapped && score > 50;
  if (sodiumCapped) score = Math.min(score, 50); // 「고열량·저영양 식품 영양성분 기준」 식사대용 나트륨 컷(600mg)
  score = Math.round(score * 10) / 10;

  const reasons = rows
    .filter((row) => row.score != null)
    .sort((a, b) => a.score - b.score)
    .slice(0, 3)
    .filter((row) => row.score < 70)
    .map((row) => row.reason);
  if (sodiumCapApplied) reasons.unshift('나트륨 600mg/100g 초과 — 점수 50점 상한 적용');

  return {
    score,
    label: getHealthScoreLabel(score),
    ingredientTags,
    avoidMatches,
    features: {
      subScores,
      per100,
      basisAmount,
      referenceAmount,
      sodiumCapped,
      sodiumCapApplied,
      guidelineComparison: { rows, reasons, score },
    },
  };
}

export function summarizeCart(items = []) {
  return items.reduce((totals, product) => {
    if (!product?.nutrients) return totals;
    const calculated = getCalculatedNutrients(product);
    Object.entries(calculated.nutrients).forEach(([key, value]) => {
      if (value == null) return; // 결측은 0으로 합산하지 않는다
      totals[key] = (totals[key] || 0) + Number(value);
    });
    return totals;
  }, {});
}

// 장바구니 키별로 값을 표기한 상품 수를 센다 — 일부만 표기된 키의 하한(부족) 판정을 막는 데 쓴다.
export function summarizeCartCoverage(items = []) {
  return items.reduce((coverage, product) => {
    if (!product?.nutrients) return coverage;
    const calculated = getCalculatedNutrients(product);
    Object.entries(calculated.nutrients).forEach(([key, value]) => {
      const entry = coverage[key] || (coverage[key] = { present: 0, total: 0 });
      entry.total += 1;
      if (value != null) entry.present += 1;
    });
    return coverage;
  }, {});
}

export function distributeCartTotals(totals, settings = defaultAnalysisSettings) {
  const units = getNutritionDistributionUnits(settings);
  return Object.fromEntries(Object.entries(totals || {}).map(([key, value]) => [key, value == null ? null : toNumber(value) / units]));
}


export function buildNutritionRiskMatrix(totals, rawProfile, metrics, analysisSettings = defaultAnalysisSettings, productAverage = null, personalizedWeights = null, coverage = null) {
  const profile = normalizeScoringProfile(rawProfile);
  const comparisonTotals = distributeCartTotals(totals, analysisSettings);
  const comparison = buildGuidelineComparison(comparisonTotals, profile, metrics, 'cart', analysisSettings, personalizedWeights);
  const rows = comparison.rows;
  // 일부 상품만 값을 표기한 키(예: 식이섬유 표기 상품 1개 + 미표기 다수)는 합계가 실제보다 작아
  // '부족'으로 오판된다. 부족 방향 판정만 정보 부족으로 강등한다 — 초과 방향은 실제 총량이 더 크므로 유효하다.
  if (coverage) {
    rows.forEach((row) => {
      const entry = coverage[row.key];
      if (!entry || entry.present === 0 || entry.present === entry.total) return;
      if (row.direction === 'range' && row.score !== null && row.total < row.min) {
        row.score = null;
        row.level = 'unknown';
        row.state = '정보 부족';
        row.reason = `${row.scopeLabel} ${row.label} 일부 상품 정보 없음`;
      }
    });
  }
  // 최종보고서 v2 8장 「권고 구조 — 두 축을 명시적으로 분리」를 그대로 따른다.
  // 장바구니 점수 = 담은 식품들의 질(식품 점수 평균)만. 단일 식품과 같은 0~100 척도다.
  // 양이 내 예산에 맞는지는 아래 rows(누적 영양량 게이지)와 reasons가 따로 보여준다.
  //
  // 옛 구조는 이 둘을 0.65:0.35로 섞고 위험보정·40점 캡까지 얹어서, 담은 개수가 늘면
  // 예산 축이 점수를 먹어버렸다 — 매우좋음 식품만 담아도 6개면 80점 → 40점.
  // 40점 캡은 무작위 장바구니의 65.6%(6개 담으면 95.8%)에 발동했고 위험보정은 100% 발동해
  // (측정 프로필 34세 여성 163cm 59kg 저활동 유지)
  // 판별자가 아니라 상수 오프셋이었다. 예산 축은 식품 질과 순서도 맞지 않았다(보통 45 < 안좋음 48).
  const baseScore = averageScoredRows(rows).score;
  // 폴백(productAverage 없음)은 현재 도달하지 않는다 — analyzeCart가 채점된 항목이 1개 이상일 때만 호출한다.
  // 살려두되 주의: baseScore는 rows와 같은 0~95 척도라 0~100 등급 컷을 그대로 적용하면 어긋난다.
  const score = Number.isFinite(productAverage) ? Math.round(productAverage * 10) / 10 : baseScore;
  const reasons = rows
    .filter((row) => row.score !== null) // 결측 영양소는 위험 사유가 아니다
    // H2 — 동일가중(16.67) 이후 'impact > 2'는 'score !== 95'와 등가라, 반올림으로 95가 된
    // level='watch' 행(초과·부족 판정을 받은 행)을 사유에서만 조용히 지웠다. 상태로 직접 거른다.
    .filter((row) => row.level !== 'stable')
    .map((row) => ({ row, impact: healthScoreMax - row.score }))
    .sort((a, b) => b.impact - a.impact)
    .slice(0, 3)
    .map(({ row }) => row.reason);
  return { rows, comparisonTotals, totalNutrients: totals, baseScore, score, label: getHealthScoreLabel(score), reasons: reasons.length ? reasons : ['주요 영양소가 체중조절 기준 안에 있습니다.'] };
}
