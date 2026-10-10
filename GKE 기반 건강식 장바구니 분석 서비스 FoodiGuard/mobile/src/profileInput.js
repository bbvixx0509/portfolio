// 가입 온보딩과 '내 조건 설정'이 함께 쓰는 입력 규칙.
//
// 같은 생년월일 포매터가 App.js 와 SignupOnboarding.js 에 따로 있었다. 두 화면이
// 같은 프로필을 쓰는데 규칙이 갈라지면 한쪽만 고쳐지므로 여기로 모은다.
// react-native 를 import 하지 않는 순수 모듈이라 테스트에서 바로 부를 수 있다.

// 숫자만 남겨 YYYY.MM.DD 로 끊어 준다. 입력 중간 상태도 그대로 돌려준다.
export function formatBirthDate(value) {
  const digits = String(value || '').replace(/\D/g, '').slice(0, 8);
  if (digits.length <= 4) return digits;
  if (digits.length <= 6) return `${digits.slice(0, 4)}.${digits.slice(4)}`;
  return `${digits.slice(0, 4)}.${digits.slice(4, 6)}.${digits.slice(6)}`;
}

export function isValidBirthDate(value) {
  if (!/^\d{4}\.\d{2}\.\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('.').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day
    && parsed.getTime() <= Date.now();
}

export function validMetric(value, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > min && parsed <= max;
}

// 단계별로 다음으로 넘어갈 수 없는 이유. 통과하면 빈 문자열이다.
export function stepError(step, form) {
  if (step === 0) {
    if (!form.gender) return '성별을 선택해주세요.';
    if (!isValidBirthDate(form.birthDate)) return '생년월일을 YYYY.MM.DD 형식으로 입력해주세요.';
    if (!validMetric(form.height, 30, 300)) return '키를 소수점 둘째 자리까지 입력해주세요.';
    if (!validMetric(form.weight, 10, 500)) return '체중을 소수점 둘째 자리까지 입력해주세요.';
  }
  if (step === 1 && !form.activityLevel) return '활동량을 하나 선택해주세요.';
  if (step === 2 && !form.dietaryGoal) return '식생활 목표를 한 가지 선택해주세요.';
  return '';
}
