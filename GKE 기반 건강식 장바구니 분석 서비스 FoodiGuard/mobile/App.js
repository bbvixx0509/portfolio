import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  Easing,
  Image,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { BlurView } from 'expo-blur';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import Ionicons from '@expo/vector-icons/Ionicons';
import { scoreThresholds, supportedReduceTargets } from './src/nutritionScoring';

import {
  explainCart,
  fetchAlternatives,
  fetchApiHealth,
  fetchProductIngredients,
  fetchProducts,
  login,
  saveOnboardingProfile,
  setAuthToken,
  signup,
} from './src/api';
import ConsentScreen from './src/ConsentScreen';
import SignupOnboarding from './src/SignupOnboarding';
import { reconcileCartWithProfile, replaceCartItemOnce } from './src/cartState';
import { formatBirthDate } from './src/profileInput';
import {
  analyzeCart,
  buildPairingSuggestions,
  buildReliability,
  buildThemeRecommendations,
  calculateProfileMetrics,
  categories,
  createRiceItem,
  defaultProfile,
  enrichProduct,
  selectReplacements,
  foodEmoji,
  formatNumber,
  getNutritionView,
  isAllowedForProfile,
  recommendationThemes,
  sortProducts,
  uniqueProducts,
} from './src/domain';

// 동의 여부를 모르는 세션은 '받지 않은 것'으로 본다. consent 필드가 생기기 전에 저장된
// 세션이 그대로 복원되면 동의 없이 건강정보를 다루는 화면으로 들어가 버린다.
function needsConsent(candidate) {
  return candidate?.consent?.completed !== true;
}

function needsOnboarding(candidate) {
  return candidate?.profile?.onboardingCompleted === false;
}

const coachImage = require('./assets/foodiguard-coach.png');
const heroCoachImage = require('./assets/foodiguard-coach-cutout.png');
const storageKey = '@foodiguard/mobile-state-v3';

function sanitizeProfile(profile = {}) {
  const sanitized = { ...profile };
  delete sanitized.foodTypes;
  delete sanitized.preferredFoods;
  delete sanitized.dislikedFoods;
  if (sanitized.activity === 'low') sanitized.activity = 'none';
  if (sanitized.activity === 'veryHigh') sanitized.activity = 'high';
  // 저장돼 있던 옛 저감 목표(열량·정제탄수화물·카페인)를 지운다. 점수에 반영되지 않는데
  // '관리 목표' 개수에는 잡히고, 칩이 없어 해제할 수도 없는 유령 항목이 되기 때문.
  if (Array.isArray(sanitized.reduceTargets)) sanitized.reduceTargets = sanitized.reduceTargets.filter((key) => supportedReduceTargets.includes(key));
  // 1회성 마이그레이션 — defaultProfile에서 기본값을 지우는 것만으로는 부족하다. 앱을 한 번이라도
  // 실행한 기기의 AsyncStorage에는 병합된 프로필이 통째로 저장돼 있고, 복원 시 저장값이 이긴다.
  // 그대로 두면 신규 설치에만 적용돼 참여자 간 채점 기준이 오히려 갈린다.
  // 사용자가 실제로 고른 값과 구분할 수 없으므로, 옛 기본값과 정확히 같은 조합일 때만 지운다.
  if (Array.isArray(sanitized.reduceTargets) && sanitized.reduceTargets.length === 2
      && sanitized.reduceTargets.includes('sugar') && sanitized.reduceTargets.includes('saturatedFat')
      && !sanitized.reduceTargetsTouched) {
    sanitized.reduceTargets = [];
  }
  return sanitized;
}

function profileFromUser(userProfile = {}) {
  const saved = sanitizeProfile(userProfile);
  return {
    ...defaultProfile,
    ...saved,
    age: String(saved.age || defaultProfile.age),
    height: String(saved.height || defaultProfile.height),
    weight: String(saved.weight || defaultProfile.weight),
    sex: saved.sex || defaultProfile.sex,
  };
}

const activityOptions = [
  { key: 'none', label: '운동 거의 안함' },
  { key: 'light', label: '주 1~3회 걷기&가벼운 운동' },
  { key: 'normal', label: '주3~5회 운동' },
  { key: 'high', label: '육체활동 많은 직업&거의 매일 고강도 운동' },
];
const dietaryGoalOptions = [
  { label: '감량·근육 보존 목표', profile: { goal: 'loss', weightGoal: 'lossProtein', intensity: 'gentle', goalIntensity: 'gentle', reduceTargets: [] } },
  { label: '단백질 우선 목표', profile: { goal: 'maintain', weightGoal: 'preserve', intensity: 'gentle', goalIntensity: 'gentle', reduceTargets: [], recommendationTheme: 'protein' } },
  { label: '체중 유지 목표', profile: { goal: 'maintain', weightGoal: 'maintain', intensity: 'gentle', goalIntensity: 'gentle', reduceTargets: [] } },
  { label: '적극적 감량 목표', profile: { goal: 'loss', weightGoal: 'loss', intensity: 'aggressive', goalIntensity: 'aggressive', reduceTargets: [] } },
  { label: '열량 저감', profile: { goal: 'maintain', weightGoal: 'maintain', intensity: 'gentle', goalIntensity: 'gentle', reduceTargets: [] } },
  { label: '당류 저감', profile: { goal: 'maintain', weightGoal: 'maintain', intensity: 'gentle', goalIntensity: 'gentle', reduceTargets: ['sugar'], recommendationTheme: 'sugar' } },
  { label: '포화지방 저감', profile: { goal: 'maintain', weightGoal: 'maintain', intensity: 'gentle', goalIntensity: 'gentle', reduceTargets: ['saturatedFat'], recommendationTheme: 'saturatedFat' } },
  { label: '나트륨 저감', profile: { goal: 'maintain', weightGoal: 'maintain', intensity: 'gentle', goalIntensity: 'gentle', reduceTargets: ['sodium'], recommendationTheme: 'sodium' } },
];
const allergyGroups = [
  { title: '알·유제품', items: ['알류(가금류)', '우유'] },
  { title: '곡물·콩·견과류', items: ['메밀', '땅콩', '대두', '밀', '호두', '잣'] },
  { title: '수산물', items: ['고등어', '게', '새우', '오징어', '조개류'] },
  { title: '육류', items: ['돼지고기', '닭고기', '쇠고기'] },
  { title: '과채류', items: ['복숭아', '토마토'] },
  { title: '기타', items: ['아황산류'] },
];
const officialAllergies = new Set(allergyGroups.flatMap((group) => group.items));
const colors = {
  ink: '#173B2A',
  inkSoft: '#385444',
  deep: '#176B46',
  green: '#3F8F55',
  lime: '#A9D46F',
  mint: '#E9F6E8',
  cream: '#FAF7F0',
  paper: '#FFFFFF',
  line: '#E7EDE4',
  muted: '#7B8B81',
  apricot: '#F4B85F',
  yellow: '#FFF3C9',
  danger: '#D24D49',
  shadow: '#173B2A',
};

// A friendly system-first Korean type stack keeps the interface crisp on web
// previews while still using the platform's native font on phones.
const typeface = {
  fontFamily: Platform.select({
    web: '-apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Pretendard Variable", Pretendard, Roboto, "Noto Sans KR", "Segoe UI", "Malgun Gothic", sans-serif',
    ios: 'Apple SD Gothic Neo',
    android: 'sans-serif',
    default: 'sans-serif',
  }),
};

const layout = {
  pagePadding: 18,
  cardPadding: 18,
  sectionGap: 14,
  safeBottom: 104,
  touchTarget: 44,
};

const tabs = [
  { key: 'home', icon: 'home-outline', activeIcon: 'home', label: '홈' },
  { key: 'explore', icon: 'search-outline', activeIcon: 'search', label: '탐색' },
  { key: 'theme', icon: 'sparkles-outline', activeIcon: 'sparkles', label: '테마' },
  { key: 'insight', icon: 'analytics-outline', activeIcon: 'analytics', label: '분석' },
  { key: 'profile', icon: 'person-circle-outline', activeIcon: 'person-circle', label: '마이' },
];

const themePresentation = {
  sodium: {
    eyebrow: '가볍게 고르는 기준',
    title: '나트륨 부담을\n먼저 살펴봐요',
    copy: '전체 영양 점수가 좋은 식품 중 나트륨 점수가 높은 순으로 보여드려요.',
    colors: ['#DCEFD9', '#9FCC8D'],
    icon: 'water',
  },
  protein: {
    eyebrow: '든든하게 채우는 기준',
    title: '단백질을\n먼저 챙겨봐요',
    copy: '전체 균형을 통과한 식품 중 단백질을 충분히 담은 식품을 골라드려요.',
    colors: ['#E3EAF7', '#A9C5E6'],
    icon: 'barbell',
  },
  sugar: {
    eyebrow: '달지 않게 고르는 기준',
    title: '당류가 낮은 식품을\n먼저 비교해요',
    copy: '전체 영양 점수가 좋은 식품 안에서 당류 부담이 낮은 순으로 살펴봐요.',
    colors: ['#FFF0D8', '#F2C47D'],
    icon: 'ice-cream',
  },
  saturatedFat: {
    eyebrow: '균형 있게 고르는 기준',
    title: '포화지방을\n먼저 확인해요',
    copy: '전체 균형과 포화지방 기준을 함께 통과한 식품만 추천해요.',
    colors: ['#F1E4EE', '#D6A9C9'],
    icon: 'heart',
  },
};

const quickCategoryIcons = [
  { name: 'fast-food', gradient: ['#FFB45E', '#EF7F3A'] },
  { name: 'barbell', gradient: ['#82B1E2', '#4D7DAB'] },
  { name: 'leaf', gradient: ['#7ECB8F', '#37945B'] },
  { name: 'restaurant', gradient: ['#F3C35C', '#D8992B'] },
  { name: 'nutrition', gradient: ['#DE9BC0', '#A4618A'] },
];

// Web-only: CSS transitions make every Pressable's pressed state (scale/opacity/
// color changes) glide instead of snapping. Native gets its feedback from haptics.
if (Platform.OS === 'web' && typeof document !== 'undefined') {
  const smoothPressStyle = document.createElement('style');
  smoothPressStyle.textContent =
    'div[tabindex="0"], [role="button"], [role="checkbox"], [role="radio"] {' +
    ' transition: transform 170ms cubic-bezier(0.2, 0.8, 0.4, 1), opacity 170ms ease,' +
    ' background-color 170ms ease, border-color 170ms ease; }';
  document.head.appendChild(smoothPressStyle);
}

function DevicePreview({ children }) {
  if (Platform.OS !== 'web') return children;

  return (
    <LinearGradient colors={['#F0F4ED', '#D8E2D5']} start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }} style={styles.previewStage}>
      <View style={styles.phoneFrame}>
        <View style={styles.phoneSpeaker} />
        <View style={styles.phoneScreen}>{children}</View>
      </View>
      <Text style={styles.previewHint}>Mobile preview · tap the app to test it</Text>
    </LinearGradient>
  );
}

function haptic(type = 'selection') {
  if (Platform.OS === 'web') return;
  if (type === 'success') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
  else Haptics.selectionAsync().catch(() => {});
}

function useReduceMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceMotionEnabled().then((value) => mounted && setReduced(value));
    const subscription = AccessibilityInfo.addEventListener?.('reduceMotionChanged', setReduced);
    return () => { mounted = false; subscription?.remove?.(); };
  }, []);
  return reduced;
}

function HologramOverlay({ strong = false }) {
  const reduced = useReduceMotion();
  const travel = useRef(new Animated.Value(0)).current;
  const float = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduced) return undefined;
    const shimmer = Animated.loop(Animated.sequence([
      Animated.timing(travel, { toValue: 1, duration: 4200, useNativeDriver: Platform.OS !== 'web' }),
      Animated.timing(travel, { toValue: 0, duration: 200, useNativeDriver: Platform.OS !== 'web' }),
      Animated.delay(900),
    ]));
    const hovering = Animated.loop(Animated.sequence([
      Animated.timing(float, { toValue: 1, duration: 2600, useNativeDriver: Platform.OS !== 'web' }),
      Animated.timing(float, { toValue: 0, duration: 2600, useNativeDriver: Platform.OS !== 'web' }),
    ]));
    shimmer.start(); hovering.start();
    return () => { shimmer.stop(); hovering.stop(); };
  }, [float, reduced, travel]);
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <Animated.View style={[styles.holoBeam, strong && styles.holoBeamStrong, { transform: [{ translateX: travel.interpolate({ inputRange: [0, 1], outputRange: [-180, 430] }) }, { rotate: '18deg' }] }]} />
      <Animated.View style={[styles.holoOrb, { transform: [{ translateY: float.interpolate({ inputRange: [0, 1], outputRange: [-8, 10] }) }, { translateX: float.interpolate({ inputRange: [0, 1], outputRange: [3, -9] }) }] }]} />
      <Animated.View style={[styles.holoSpark, { opacity: float.interpolate({ inputRange: [0, 1], outputRange: [0.35, 0.9] }), transform: [{ scale: float.interpolate({ inputRange: [0, 1], outputRange: [0.8, 1.25] }) }] }]}><Ionicons name="sparkles" size={16} color="rgba(255,255,255,0.82)" /></Animated.View>
    </View>
  );
}

function Pill({ children, tone = 'sage', style }) {
  return (
    <View style={[styles.pill, styles[`pill_${tone}`], style]}>
      <Text style={[styles.pillText, styles[`pillText_${tone}`]]}>{children}</Text>
    </View>
  );
}

function AppButton({ children, variant = 'primary', onPress, style, disabled = false, compact = false }) {
  const gradient = variant === 'primary' ? ['#125C39', '#2E9560'] : ['#F0F7EA', '#E8F3DF'];
  return (
    <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress} style={({ pressed }) => [pressed && !disabled && styles.pressed, disabled && styles.disabled, style]}>
      <LinearGradient colors={gradient} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={[styles.button, compact && styles.buttonCompact, variant === 'outline' && styles.buttonOutline]}>
        <Text style={[styles.buttonText, variant !== 'primary' && styles.buttonTextSecondary]}>{children}</Text>
      </LinearGradient>
    </Pressable>
  );
}

function Field({ label, style, ...props }) {
  return (
    <View style={[styles.field, style]}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput {...props} autoCapitalize="none" style={styles.input} placeholderTextColor="#A5B0A8" />
    </View>
  );
}

function AuthScreen({ onAuthenticated, onSignupCreated }) {
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({ name: '', email: 'test@foodiguard.kr', password: '' });
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (testAccount = false) => {
    const email = testAccount ? 'test@foodiguard.kr' : form.email.trim();
    const password = testAccount ? 'test1234' : form.password;
    if (!email || !password || (mode === 'signup' && !form.name.trim())) {
      setMessage('필수 정보를 모두 입력해 주세요.');
      return;
    }
    setLoading(true);
    setMessage('');
    try {
      const createdAccount = mode === 'signup' && !testAccount;
      const payload = createdAccount
        ? await signup(form.name.trim(), email, password)
        : await login(email, password);
      if (createdAccount) onSignupCreated(payload.user, payload.token);
      else onAuthenticated(payload.user, payload.token);
    } catch (error) {
      setMessage(error.message || '로그인에 실패했습니다.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <DevicePreview>
      <SafeAreaView style={styles.authPage}>
      <StatusBar barStyle="dark-content" />
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.select({ ios: 'padding', default: undefined })}>
        <ScrollView contentContainerStyle={styles.authScroll} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <LinearGradient colors={['#0C3B26', '#17613E', '#2E8A52']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.authBrandPanel}>
            <View style={styles.authBrandOrb} />
            <View style={styles.authGlowOrb} />
            <HologramOverlay />
            <View style={styles.authBrandCopyBlock}>
              <View style={styles.authBrandRow}>
                <View style={styles.authLogoBadge}><Ionicons name="leaf" size={17} color="#D7EEB2" /></View>
                <Text style={styles.authLogoText}>푸디가드</Text>
              </View>
              <Pill tone="glass" style={styles.authKicker}>맞춤 식품 선택 도우미</Pill>
              <Text style={styles.authTitle}>오늘의 식사를{`\n`}더 가볍게</Text>
              <Text style={styles.authCopy}>내 생활에 맞는 간편식만{`\n`}쉽게 비교해 드릴게요.</Text>
            </View>
            <View style={styles.authCoachFrame}>
              <View style={styles.authCoachGlow} />
              <Image source={heroCoachImage} style={styles.authCoach} resizeMode="contain" />
            </View>
          </LinearGradient>

          <View style={styles.authCard}>
            <Text style={styles.authEyebrow}>반가워요</Text>
            <Text style={styles.authCardTitle}>건강한 선택을 시작해볼까요?</Text>
            <Text style={styles.authCardSubtitle}>내 몸에 맞는 식품 9천여 개를 바로 비교해요.</Text>

            <View style={styles.segmented}>
              {['signup', 'login'].map((item) => (
                <Pressable accessibilityRole="tab" accessibilityState={{ selected: mode === item }} key={item} onPress={() => { setMode(item); setMessage(''); }} style={[styles.segmentButton, mode === item && styles.segmentButtonActive]}>
                  <Text style={[styles.segmentText, mode === item && styles.segmentTextActive]}>{item === 'signup' ? '회원가입' : '로그인'}</Text>
                </Pressable>
              ))}
            </View>

            {mode === 'signup' && <Field label="이름" value={form.name} placeholder="이름을 입력하세요" onChangeText={(name) => setForm({ ...form, name })} />}
            <Field label="이메일" value={form.email} placeholder="test@foodiguard.kr" keyboardType="email-address" onChangeText={(email) => setForm({ ...form, email })} />
            <Field label="비밀번호" value={form.password} placeholder="6자 이상" secureTextEntry onChangeText={(password) => setForm({ ...form, password })} />
            {message ? <Text style={styles.authError}>{message}</Text> : null}
            <AppButton onPress={() => submit(false)} disabled={loading}>{loading ? '확인하고 있어요…' : mode === 'login' ? '로그인' : '계정 만들고 계속하기'}</AppButton>
            <Pressable accessibilityRole="button" disabled={loading} onPress={() => submit(true)} style={({ pressed }) => [styles.testLogin, pressed && styles.pressed]}>
              <View style={styles.testLoginIcon}><Ionicons name="arrow-forward" size={17} color="#FFFFFF" /></View>
              <View style={styles.flex}><Text style={styles.testLoginTitle}>테스트 계정으로 바로 시작</Text><Text style={styles.testLoginSub}>복잡한 입력 없이 앱을 둘러보세요</Text></View>
            </Pressable>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
      </SafeAreaView>
    </DevicePreview>
  );
}

function AppHeader({ user, onProfile, cartCount }) {
  const displayName = user?.name && !user.name.includes('?') ? user.name : '푸디가드 친구';
  return (
    <View style={styles.header}>
      <View style={styles.flex}>
        <Text style={styles.headerTitle}>{displayName}님, 좋은 하루예요 👋</Text>
      </View>
      <Pressable accessibilityRole="button" accessibilityLabel="내 정보 열기" onPress={onProfile} style={({ pressed }) => [styles.headerAvatar, pressed && styles.pressed]}>
        <Ionicons name="person-outline" size={22} color={colors.deep} />
        {cartCount > 0 && <View style={styles.avatarBadge}><Text style={styles.avatarBadgeText}>{cartCount}</Text></View>}
      </Pressable>
    </View>
  );
}

function SectionHeader({ title, copy, action, onPress }) {
  return (
    <View style={styles.sectionHeader}>
      <View style={styles.flex}><Text style={styles.sectionTitle}>{title}</Text>{copy ? <Text style={styles.sectionCopy}>{copy}</Text> : null}</View>
      {action ? <Pressable accessibilityRole="button" onPress={onPress} style={styles.sectionActionButton}><Text style={styles.sectionAction}>{action}</Text><Ionicons name="arrow-forward" size={14} color={colors.green} /></Pressable> : null}
    </View>
  );
}

function Metric({ label, value, unit, accent = false }) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={[styles.metricValue, accent && styles.metricValueAccent]}>{value}<Text style={styles.metricUnit}> {unit}</Text></Text>
    </View>
  );
}

// 점수 표기는 소수 한 자리로 통일한다. 엔진이 소수 한 자리로 반올림해 주는데(84.0 → 84),
// 그대로 쓰면 화면에 '84점'과 '39.1점'이 섞여 나온다. 등급 컷 자체가 소수(79.9/73.9/51.6/38.4)라
// 정수로 뭉개면 '80점인데 좋음' 같은 설명 불가능한 조합이 생긴다. (최종보고서 v2 15장 8번)
function formatScore(score) {
  return Number.isFinite(Number(score)) ? Number(score).toFixed(1) : score;
}

function ScoreBadge({ score, hero = false }) {
  return (
    <View accessibilityLabel={`건강 점수 ${formatScore(score)}점`} style={[styles.scoreBadge, hero && styles.scoreBadgeHero]}>
      <Text style={[styles.scoreBadgeValue, hero && styles.scoreBadgeValueHero]}>{formatScore(score)}</Text>
      <Text style={[styles.scoreBadgeUnit, hero && styles.scoreBadgeUnitHero]}>점</Text>
    </View>
  );
}

function ProductCard({ product, profile, inCart, onToggle, onDetail, compact = false }) {
  const enriched = product.analysis ? product : enrichProduct(product, profile);
  const calories = enriched.nutrients?.calories;
  const restricted = (enriched.analysis.avoidMatches || []).length > 0;
  return (
    <View style={[styles.productCard, compact && styles.productCardCompact, restricted && styles.productCardRestricted]}>
      <Pressable accessibilityRole="button" accessibilityLabel={`${enriched.name} 상세 보기`} onPress={() => onDetail(enriched)} style={({ pressed }) => [styles.productMainPressable, pressed && styles.cardPressed]}>
        <LinearGradient colors={enriched.analysis.tone === 'crimson' ? ['#FFECE8', '#FFDDD6'] : enriched.analysis.tone === 'apricot' ? ['#FFF4D7', '#FFEBC0'] : ['#EFF7E8', '#E5F2DB']} style={[styles.productVisual, compact && styles.productVisualCompact]}>
          <Text style={[styles.productEmoji, compact && styles.productEmojiCompact]}>{foodEmoji(enriched)}</Text>
          <View style={styles.visualDot} />
        </LinearGradient>
        <View style={styles.productBody}>
          <View style={styles.productTopline}>
            <Pill tone={enriched.analysis.tone}>{enriched.analysis.label}</Pill>
            {enriched.analysis.score != null && <Text style={styles.productScore}>{formatScore(enriched.analysis.score)}점</Text>}
            {restricted && <View style={styles.restrictedBadge}><Ionicons name="alert-circle" size={13} color="#A95F21" /><Text numberOfLines={1} style={styles.restrictedBadgeText}>제한 성분</Text></View>}
            {!restricted && enriched.ingredientStatus === 'matched' && <View style={styles.verified}><Ionicons name="checkmark-circle" size={13} color={colors.green} /><Text style={styles.verifiedText}>원재료 분석</Text></View>}
          </View>
          <Text numberOfLines={2} style={styles.productName}>{enriched.name}</Text>
          <Text numberOfLines={1} style={styles.productMeta}>{calories != null ? `${formatNumber(calories, 1)} kcal` : '열량 정보 확인 중'} · {enriched.store || enriched.maker || '식품 데이터'}</Text>
        </View>
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel={restricted ? `${enriched.name}에는 제한 성분이 있어요` : inCart ? `${enriched.name} 장바구니에서 빼기` : `${enriched.name} 장바구니에 담기`} hitSlop={8} onPress={() => onToggle(enriched)} style={({ pressed }) => [styles.addButton, inCart && styles.addButtonActive, pressed && styles.pressed]}>
        <Ionicons name={restricted ? 'ban' : inCart ? 'checkmark' : 'add'} size={restricted ? 18 : inCart ? 19 : 22} color={restricted ? '#A95F21' : inCart ? '#FFFFFF' : colors.deep} />
      </Pressable>
    </View>
  );
}

function HomeScreen({ user, profile, cart, productPool, onExplore, onTheme, onAnalysis, onProfile, onToggleCart, onDetail, onProductsLoaded }) {
  const [products, setProducts] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const metrics = useMemo(() => calculateProfileMetrics(profile), [profile]);
  const cartAnalysis = useMemo(() => analyzeCart(cart, profile, { mode: 'meals', units: 1 }, productPool), [cart, productPool, profile]);
  const primaryAction = useMemo(() => {
    if (!cart.length) {
      return {
        eyebrow: '오늘의 첫 행동',
        title: '첫 식품을\n골라볼까요?',
        description: '한 개만 담아도 내 건강 기준으로 분석해드려요.',
        button: '식품 찾기',
        query: '',
        destination: 'explore',
      };
    }

    const priority = cartAnalysis.riskRows.find((item) => item.score !== null && (item.level === 'danger' || item.level === 'caution' || item.level === 'watch'));
    const proteinGap = Math.max(0, Math.round((metrics.protein * cartAnalysis.targetScale) - (cartAnalysis.totals.protein || 0)));
    const actions = {
      protein: {
        title: `단백질 ${proteinGap || 1}g을\n더 채워보세요`,
        description: '지금 식사에 부담 없이 더할 식품을 골라드릴게요.',
        button: '단백질 식품 찾기',
        query: '닭가슴살',
      },
      calories: {
        title: '오늘 식사를\n조금 더 채워볼까요?',
        description: '내 권장량에 맞는 간편한 한 끼를 찾아드릴게요.',
        button: '간편식 찾기',
        query: '즉석',
      },
      sugar: {
        title: '당류 부담을\n낮춰볼까요?',
        description: '건강 조건에 맞는 가벼운 대안을 찾아드릴게요.',
        button: '저당 식품 찾기',
        query: '저당',
      },
      sodium: {
        title: '나트륨을\n조절해볼까요?',
        description: '더 가벼운 식품으로 바꿔볼 수 있어요.',
        button: '저염 식품 찾기',
        query: '저염',
      },
      fiber: {
        title: '식이섬유를\n더해볼까요?',
        description: '채소와 곡물을 더한 식품을 추천해드릴게요.',
        button: '샐러드 찾기',
        query: '샐러드',
      },
      carbs: {
        title: '탄수화물 균형을\n맞춰볼까요?',
        description: '든든하게 채울 수 있는 식사를 찾아드릴게요.',
        button: '밥·죽 찾기',
        query: '밥',
      },
    };

    return {
      eyebrow: '오늘의 한 가지',
      ...(actions[priority?.key] || {
        title: '장바구니 건강 상태를\n확인해볼까요?',
        description: '선택한 식품의 영양 구성과 주의 항목을 바로 확인하세요.',
        button: '영양 분석 보기',
        destination: 'analysis',
      }),
      destination: actions[priority?.key] ? 'explore' : 'analysis',
    };
  }, [cart.length, cartAnalysis, metrics.protein]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    Promise.all([fetchProducts({ display: 36 }), fetchApiHealth()])
      .then(([payload, health]) => {
        if (!active) return;
        const nextProducts = sortProducts(uniqueProducts(payload.products || []), 'score', profile);
        setProducts(nextProducts.filter((item) => !item.analysis.avoidMatches.length).slice(0, 3));
        onProductsLoaded(nextProducts);
        setTotal(health.searchableProducts || payload.total || 0);
      })
      .catch(() => {})
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [profile, onProductsLoaded]);

  const handlePrimaryAction = () => {
    if (primaryAction.destination === 'analysis') onAnalysis();
    else onExplore(primaryAction.query);
  };

  return (
    <ScrollView contentContainerStyle={styles.pageContent} showsVerticalScrollIndicator={false}>
      <AppHeader user={user} onProfile={onProfile} cartCount={cart.length} />
      <LinearGradient colors={['#EDF7E2', '#B5DA9C']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.homeHero}>
        <View style={styles.heroOrb} />
        <View style={styles.heroAura} />
        <View style={styles.heroCopy}>
          <View style={styles.heroKicker}><Text style={styles.heroKickerText}>{primaryAction.eyebrow}</Text><Ionicons name="sparkles" size={12} color="#5E9D4D" /></View>
          <Text style={styles.heroTitle}>{primaryAction.title}</Text>
          <Text style={styles.heroDescription}>{primaryAction.description}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel={primaryAction.button} onPress={handlePrimaryAction} style={({ pressed }) => [styles.heroButton, pressed && styles.pressed]}><Text style={styles.heroButtonText}>{primaryAction.button}</Text><Ionicons name="arrow-forward" size={16} color="#DDF1CF" /></Pressable>
        </View>
        <View style={styles.heroCoachFrame}>
          <View style={styles.heroCoachGlow} />
          <Image source={heroCoachImage} style={styles.heroCoach} resizeMode="contain" />
        </View>
      </LinearGradient>

      <LinearGradient colors={['#1C6A42', '#2E8A52', '#43A263']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.goalCard}>
        <View style={styles.goalCardTop}><View style={styles.goalCardCopy}><Text style={styles.goalTitle}>장바구니 영양 점수</Text><Text style={styles.goalSubtitle}>{cart.length ? '선택한 식품을 기준으로 실시간 계산했어요' : '첫 식품을 담으면 맞춤 점수가 시작돼요'}</Text></View><ScoreBadge score={cartAnalysis.score || '--'} /></View>
        <View style={styles.progressTrack}><LinearGradient colors={['#8CCF68', '#DCF2A4']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={[styles.progressBar, { width: `${Math.min(100, Math.max(12, cartAnalysis.score || 12))}%` }]} /></View>
        <View style={styles.goalMetrics}>
          <Metric label="하루 권장량" value={formatNumber(metrics.calories)} unit="kcal" />
          <Metric label="장바구니" value={cart.length} unit="개" />
          <Metric label="식생활 목표" value={1} unit="개" accent />
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel="영양 분석 전체 보기" onPress={onAnalysis} style={({ pressed }) => [styles.goalAction, pressed && styles.pressed]}><Text style={styles.goalActionText}>영양 분석 전체 보기</Text><Ionicons name="arrow-forward" size={18} color="#DDF1C0" /></Pressable>
      </LinearGradient>

      <LinearGradient colors={['#F4FAEC', '#E4F2D8']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.focusCard}>
        <View style={styles.focusHead}><View><Text style={styles.focusTitle}>영양 테마로 찾기</Text><Text style={styles.focusCopy}>기존 영양 점수에서 원하는 기준만 먼저 살펴봐요</Text></View></View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.focusChips}>{recommendationThemes.map((item) => <Pressable accessibilityRole="button" key={item.key} onPress={() => { haptic(); onTheme(item.key); }} style={styles.focusChip}><Ionicons name={item.icon} size={17} color={colors.deep} /><Text style={styles.focusChipText}>{item.shortLabel}</Text><Ionicons name="chevron-forward" size={14} color="#A9B6AC" /></Pressable>)}</ScrollView>
      </LinearGradient>

      <SectionHeader title="빠른 탐색" copy={`${formatNumber(total)}개 식품을 조건별로 살펴보세요`} />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.quickRow}>
        {categories.slice(1).map((category, index) => (
          <Pressable key={category.key} accessibilityRole="button" accessibilityLabel={`${category.label} 탐색`} onPress={() => onExplore(category.query)} style={({ pressed }) => [styles.quickCard, index % 2 && styles.quickCardWarm, pressed && styles.cardPressed]}>
            <LinearGradient colors={quickCategoryIcons[index]?.gradient || ['#5EAE6F', '#2E8A52']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.quickIconBubble}>
              <Ionicons name={quickCategoryIcons[index]?.name || 'nutrition'} size={21} color="#FFFFFF" />
            </LinearGradient>
            <Text style={styles.quickLabel}>{category.label}</Text>
            <Ionicons name="arrow-forward" size={15} color="#9AAA9F" style={styles.quickArrow} />
          </Pressable>
        ))}
      </ScrollView>

      <SectionHeader title="오늘의 추천" copy="내 건강 조건으로 다시 계산했어요" action="전체 보기" onPress={() => onExplore('')} />
      {loading ? <View style={styles.loadingPanel}><ActivityIndicator color={colors.deep} /><Text style={styles.loadingText}>식품 데이터를 불러오고 있어요</Text></View> : (
        <View style={styles.productList}>{products.map((product) => <ProductCard key={product.id} product={product} profile={profile} compact inCart={cart.some((item) => String(item.id) === String(product.id))} onToggle={onToggleCart} onDetail={onDetail} />)}</View>
      )}

      <Pressable accessibilityRole="button" onPress={cart.length ? onAnalysis : () => onExplore('')} style={({ pressed }) => pressed && styles.cardPressed}>
        <LinearGradient colors={['#1C6A42', '#2E8A52']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.coachBanner}>
          <View style={styles.coachBannerBadge}><Text style={styles.coachBannerBadgeText}>{cart.length ? '분석 준비 완료' : '첫 단계'}</Text></View>
          <View style={styles.flex}><Text style={styles.coachBannerTitle}>{cart.length ? '내 선택, 지금 확인해볼까요?' : '첫 식품을 가볍게 골라볼까요?'}</Text><Text style={styles.coachBannerCopy}>{cart.length ? '영양 구성과 주의 항목을 한눈에 보여드려요.' : '한 개만 담아도 맞춤 분석이 바로 시작돼요.'}</Text></View>
          <View style={styles.coachBannerArrow}><Ionicons name="arrow-forward" size={18} color={colors.deep} /></View>
        </LinearGradient>
      </Pressable>
    </ScrollView>
  );
}

function ExploreScreen({ presetQuery, profile, cart, onToggleCart, onDetail, onProductsLoaded }) {
  const [query, setQuery] = useState(presetQuery || '');
  const [activeQuery, setActiveQuery] = useState(presetQuery || '');
  const [category, setCategory] = useState(presetQuery ? 'all' : 'all');
  const [sortMode, setSortMode] = useState('score');
  const [products, setProducts] = useState([]);
  const [total, setTotal] = useState(0);
  // 검색 결과는 서버가 총계를 세지 않는다. 다음 쪽이 있는지만 받아 더보기를 판단한다.
  const [exactTotal, setExactTotal] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [nextStart, setNextStart] = useState(1);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [filterOpen, setFilterOpen] = useState(false);
  const [excludeAllergensOn, setExcludeAllergensOn] = useState(false);
  const [minScore, setMinScore] = useState(0);
  const avoidAllergens = useMemo(() => (profile.avoidIngredients || []).map((item) => item.trim()).filter(Boolean), [profile.avoidIngredients]);

  const load = async ({ reset = true, search = activeQuery, excludeOn = excludeAllergensOn } = {}) => {
    reset ? setLoading(true) : setLoadingMore(true);
    setError('');
    try {
      const start = reset ? 1 : nextStart;
      const payload = await fetchProducts({ query: search.trim(), start, display: 30, excludeAllergens: excludeOn ? avoidAllergens : [] });
      const next = uniqueProducts(payload.products || []);
      setProducts((current) => reset ? next : uniqueProducts([...current, ...next]));
      setNextStart(start + (payload.products || []).length);
      onProductsLoaded(next);
      setTotal(payload.total || 0);
      setExactTotal(payload.exactTotal !== false);
      setHasMore(payload.hasMore ?? (start + (payload.products || []).length <= (payload.total || 0)));
      setActiveQuery(search.trim());
    } catch (loadError) {
      setError(loadError.message || '식품을 불러오지 못했습니다.');
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  };

  useEffect(() => {
    setQuery(presetQuery || '');
    load({ reset: true, search: presetQuery || '' });
  }, [presetQuery]);

  const ranked = useMemo(() => sortProducts(products, sortMode, profile, activeQuery)
    .filter((product) => product.analysis.score >= minScore),
  [activeQuery, minScore, products, profile, sortMode]);

  const chooseCategory = (item) => {
    setCategory(item.key);
    setQuery(item.query);
    load({ reset: true, search: item.query });
  };

  const submitSearch = () => {
    setCategory('all');
    load({ reset: true, search: query });
  };

  return (
    <ScrollView contentContainerStyle={styles.pageContent} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
      <View style={styles.screenTitleRow}><View><Text style={styles.screenTitle}>식품 탐색</Text><Text style={styles.screenSubtitle}>이름·브랜드·원재료까지 한 번에 검색해요.</Text></View><LinearGradient colors={['#5EAE6F', '#2E8A52']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.screenIcon}><Ionicons name="search" size={21} color="#FFFFFF" /></LinearGradient></View>

      <View style={styles.searchBox}>
        <Ionicons name="search-outline" size={20} color={colors.green} style={styles.searchIcon} />
        <TextInput value={query} onChangeText={setQuery} onSubmitEditing={submitSearch} returnKeyType="search" placeholder="닭가슴살, 샐러드, 요거트…" placeholderTextColor="#9EABA2" style={styles.searchInput} />
        {query ? <Pressable accessibilityRole="button" accessibilityLabel="검색어 지우기" onPress={() => setQuery('')}><Text style={styles.clearIcon}>×</Text></Pressable> : null}
        <Pressable accessibilityRole="button" accessibilityLabel="식품 검색" onPress={submitSearch} style={styles.searchSubmit}><Text style={styles.searchSubmitText}>검색</Text></Pressable>
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterRow}>
        {categories.map((item) => (
          <Pressable accessibilityRole="button" accessibilityState={{ selected: category === item.key }} key={item.key} onPress={() => chooseCategory(item)} style={[styles.filterChip, category === item.key && styles.filterChipActive]}>
            <Text style={[styles.filterChipText, category === item.key && styles.filterChipTextActive]}>{item.label}</Text>
          </Pressable>
        ))}
      </ScrollView>

      <Pressable accessibilityRole="button" accessibilityState={{ expanded: filterOpen }} onPress={() => { haptic(); setFilterOpen((value) => !value); }} style={({ pressed }) => [styles.advancedFilterToggle, pressed && styles.pressed]}>
        <LinearGradient colors={['#F3C35C', '#D8992B']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.advancedFilterIcon}><Ionicons name="options" size={19} color="#FFFFFF" /></LinearGradient>
        <View style={styles.flex}><Text style={styles.advancedFilterTitle}>세부 필터</Text><Text style={styles.advancedFilterCopy}>알레르기 제외 · 최소 추천 점수</Text></View>
        <Ionicons name={filterOpen ? 'chevron-up' : 'chevron-down'} size={18} color={colors.green} style={styles.advancedFilterArrow} />
      </Pressable>
      {filterOpen && <View style={styles.advancedFilterPanel}>
        <View style={styles.filterSettingRow}><View style={styles.flex}><Text style={styles.filterSettingTitle}>알레르기 식품 제외</Text><Text style={styles.filterSettingCopy}>{avoidAllergens.length ? `제외: ${avoidAllergens.join(', ')} · 분석 완료 식품만 표시돼요` : '마이 탭에서 피할 성분을 먼저 선택하세요'}</Text></View><Pressable accessibilityRole="switch" accessibilityLabel="알레르기 식품 제외" accessibilityState={{ checked: excludeAllergensOn, disabled: !avoidAllergens.length }} disabled={!avoidAllergens.length} onPress={() => { haptic(); const next = !excludeAllergensOn; setExcludeAllergensOn(next); load({ reset: true, excludeOn: next }); }} style={[styles.toggle, excludeAllergensOn && styles.toggleActive, !avoidAllergens.length && styles.disabled]}><View style={[styles.toggleKnob, excludeAllergensOn && styles.toggleKnobActive]} /></Pressable></View>
        <Text style={styles.filterSettingLabel}>최소 추천 점수</Text>
        <View style={styles.compactChipRow}>{[{ value: 0, label: '전체' }, { value: scoreThresholds.fair, label: '보통 이상' }, { value: scoreThresholds.good, label: '좋음 이상' }, { value: scoreThresholds.excellent, label: '매우좋음' }].map((item) => <Pressable accessibilityRole="button" accessibilityState={{ selected: minScore === item.value }} key={item.value} onPress={() => setMinScore(item.value)} style={[styles.compactChip, minScore === item.value && styles.compactChipActive]}><Text style={[styles.compactChipText, minScore === item.value && styles.compactChipTextActive]}>{item.label}</Text></Pressable>)}</View>
      </View>}

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.sortControl}>{[{ key: 'score', label: '추천순' }, { key: 'match', label: '일치순' }, { key: 'name', label: '가나다순' }].map((item) => <Pressable accessibilityRole="button" accessibilityState={{ selected: sortMode === item.key }} key={item.key} onPress={() => { haptic(); setSortMode(item.key); }} style={[styles.sortButton, sortMode === item.key && styles.sortButtonActive]}><Text style={[styles.sortText, sortMode === item.key && styles.sortTextActive]}>{item.label}</Text></Pressable>)}</ScrollView>
      <Text style={[styles.scoreBasisNote, styles.scoreBasisNoteList]}>점수는 100g·1회 제공량 기준, 0~100점 척도예요.</Text>

      {error ? <View style={styles.errorPanel}><View style={styles.errorIcon}><Ionicons name="alert-circle" size={20} color="#FFFFFF" /></View><View style={styles.flex}><Text style={styles.errorTitle}>데이터를 불러오지 못했어요</Text><Text style={styles.errorCopy}>{error}</Text></View><Pressable accessibilityRole="button" onPress={() => load({ reset: true, search: activeQuery })}><Text style={styles.retryText}>다시 시도</Text></Pressable></View> : null}
      {loading ? <View style={styles.loadingPanelLarge}><ActivityIndicator size="large" color={colors.deep} /><Text style={styles.loadingText}>전체 식품 데이터에서 찾고 있어요</Text></View> : (
        <View style={styles.productList}>{ranked.map((product) => <ProductCard key={product.id} product={product} profile={profile} inCart={cart.some((item) => String(item.id) === String(product.id))} onToggle={onToggleCart} onDetail={onDetail} />)}</View>
      )}
      {!loading && hasMore && <AppButton variant="outline" onPress={() => load({ reset: false, search: activeQuery })} disabled={loadingMore} style={styles.loadMore}>{loadingMore ? '더 불러오는 중…' : `30개 더 보기 · ${formatNumber(products.length)}${exactTotal ? `/${formatNumber(total)}` : '개째'}`}</AppButton>}
      {!loading && !error && !products.length && <EmptyState icon="search-outline" title="검색 결과가 없어요" copy="다른 식품 이름이나 브랜드로 다시 검색해 보세요." />}
      {!loading && !error && products.length > 0 && !ranked.length && <EmptyState icon="filter-outline" title="조건에 맞는 식품이 없어요" copy="세부 필터의 최소 점수를 낮추면 더 많은 식품을 볼 수 있어요." />}
    </ScrollView>
  );
}

function ThemeScreen({ activeTheme, profile, cart, onThemeChange, onToggleCart, onDetail, onProductsLoaded }) {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const selected = recommendationThemes.find((item) => item.key === activeTheme) || recommendationThemes[0];
  const presentation = themePresentation[selected.key];
  const avoidKey = (profile.avoidIngredients || []).map((item) => item.trim()).filter(Boolean).join('|');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const payload = await fetchProducts({
        display: 200,
        theme: selected.key,
        excludeAllergens: avoidKey ? avoidKey.split('|') : [],
      });
      const next = uniqueProducts(payload.products || []);
      setProducts(next);
      onProductsLoaded(next);
    } catch (loadError) {
      setProducts([]);
      setError(loadError.message || '테마 추천을 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }, [avoidKey, onProductsLoaded, selected.key]);

  useEffect(() => { load(); }, [load]);

  const recommendations = useMemo(
    () => buildThemeRecommendations(products, selected.key, profile, 20),
    [products, profile, selected.key],
  );

  return (
    <ScrollView contentContainerStyle={styles.pageContent} showsVerticalScrollIndicator={false}>
      <View style={styles.screenTitleRow}>
        <View><Text style={styles.screenTitle}>식품 추천 테마</Text><Text style={styles.screenSubtitle}>한 가지 영양 기준을 먼저 골라 비교해요.</Text></View>
        <LinearGradient colors={['#7BBE79', '#2E8A52']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.screenIcon}><Ionicons name="sparkles" size={21} color="#FFFFFF" /></LinearGradient>
      </View>

      <LinearGradient colors={presentation.colors} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.themeHero}>
        <View style={styles.themeHeroOrb} />
        <View style={styles.themeHeroCopy}>
          <View style={styles.themeHeroKicker}><Ionicons name={presentation.icon} size={14} color={colors.deep} /><Text style={styles.themeHeroKickerText}>{presentation.eyebrow}</Text></View>
          <Text style={styles.themeHeroTitle}>{presentation.title}</Text>
          <Text style={styles.themeHeroDescription}>{presentation.copy}</Text>
        </View>
        <View style={styles.themeHeroBadge}><Text style={styles.themeHeroBadgeValue}>{loading ? '—' : recommendations.length}</Text><Text style={styles.themeHeroBadgeLabel}>추천</Text></View>
      </LinearGradient>

      <View style={styles.themeGrid}>
        {recommendationThemes.map((item) => {
          const active = item.key === selected.key;
          return (
            <Pressable accessibilityRole="button" accessibilityState={{ selected: active }} key={item.key} onPress={() => { haptic(); onThemeChange(item.key); }} style={({ pressed }) => [styles.themeTile, active && styles.themeTileActive, pressed && styles.cardPressed]}>
              <View style={[styles.themeTileIcon, active && styles.themeTileIconActive]}><Ionicons name={item.icon} size={18} color={active ? '#FFFFFF' : colors.deep} /></View>
              <Text style={[styles.themeTileLabel, active && styles.themeTileLabelActive]}>{item.shortLabel}</Text>
              <Ionicons name={active ? 'checkmark-circle' : 'chevron-forward'} size={15} color={active ? '#CDE8A7' : '#9AAA9F'} />
            </Pressable>
          );
        })}
      </View>

      <View style={styles.themeRuleNote}><Ionicons name="shield-checkmark" size={18} color={colors.deep} /><Text style={styles.themeRuleText}>전체 점수 ‘좋음’ 이상 · {selected.shortLabel} 점수 70점 이상 · 알레르기 제외</Text></View>

      <SectionHeader title={`${selected.shortLabel} 추천`} copy="제조사와 식품 분류가 한쪽에 치우치지 않게 골랐어요" />
      {error ? <View style={styles.errorPanel}><View style={styles.errorIcon}><Ionicons name="alert-circle" size={20} color="#FFFFFF" /></View><View style={styles.flex}><Text style={styles.errorTitle}>추천을 불러오지 못했어요</Text><Text style={styles.errorCopy}>{error}</Text></View><Pressable accessibilityRole="button" onPress={load}><Text style={styles.retryText}>다시 시도</Text></Pressable></View> : null}
      {loading ? <View style={styles.loadingPanelLarge}><ActivityIndicator size="large" color={colors.deep} /><Text style={styles.loadingText}>추천 기준으로 식품을 고르고 있어요</Text></View> : (
        <View style={styles.productList}>{recommendations.map((product) => <ProductCard key={product.id} product={product} profile={profile} inCart={cart.some((item) => String(item.id) === String(product.id))} onToggle={onToggleCart} onDetail={onDetail} />)}</View>
      )}
      {!loading && !error && !recommendations.length ? <EmptyState icon="sparkles-outline" title="추천할 식품이 없어요" copy="현재 알레르기 조건을 지키면서 이 기준을 통과한 식품을 찾지 못했어요." /> : null}
    </ScrollView>
  );
}

function AnimatedFill({ styleList, progress }) {
  const anim = useRef(new Animated.Value(progress)).current;
  useEffect(() => {
    Animated.timing(anim, { toValue: progress, duration: 500, easing: Easing.out(Easing.cubic), useNativeDriver: false }).start();
  }, [anim, progress]);
  return <Animated.View style={[...styleList, { width: anim.interpolate({ inputRange: [0, 100], outputRange: ['0%', '100%'] }) }]} />;
}

function NutritionMetric({ label, value, unit, target, progress = 0, tone = 'green' }) {
  const safeProgress = Number.isFinite(progress) ? progress : 0; // 전 상품 결측 키는 NaN이 될 수 있다
  return (
    <View style={styles.nutritionMetric}>
      <View style={styles.nutritionMetricTop}><Text style={styles.nutritionLabel}>{label}</Text><Text style={styles.nutritionValue}>{value}<Text style={styles.nutritionUnit}>{target ? ` / ${target}` : ''} {unit}</Text></Text></View>
      <View style={styles.nutritionTrack}><AnimatedFill styleList={[styles.nutritionFill, styles[`nutritionFill_${tone}`]]} progress={Math.min(100, Math.max(4, safeProgress))} /></View>
    </View>
  );
}

function InsightScreen({ cart, profile, productPool, onRemove, onReplace, onExplore }) {
  const [scopeMode, setScopeMode] = useState('meals');
  const [scopeUnits, setScopeUnits] = useState(1);
  const [riskOpen, setRiskOpen] = useState(false);
  const [riceEnabled, setRiceEnabled] = useState(false);
  const [riceType, setRiceType] = useState('현미밥');
  const [riceGrams, setRiceGrams] = useState(200);
  const [riceServings, setRiceServings] = useState(1);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiResult, setAiResult] = useState(null);
  const metrics = useMemo(() => calculateProfileMetrics(profile), [profile]);
  const riceItem = riceEnabled ? createRiceItem(riceType, riceGrams * riceServings) : null;
  const items = riceItem ? [...cart, riceItem] : cart;
  const scope = useMemo(() => ({ mode: scopeMode, units: scopeUnits }), [scopeMode, scopeUnits]);
  const analysis = useMemo(() => analyzeCart(items, profile, scope, productPool), [items, productPool, profile, scope]);
  const reliability = useMemo(() => buildReliability(items, profile), [items, profile]);
  // 대체 추천(감사보고서 R1~R13). 후보는 서버가 카테고리 단위로 좁혀 주고, 점수·1회 섭취량이
  // 필요한 판정은 selectReplacements가 한다. 서버는 점수를 모르므로 "게이트를 통과하는 후보가
  // 없다"를 판정할 수 없어, 폴백 단계를 클라이언트가 올려가며 다시 요청한다 —
  // 유탕면 869건 중 '좋음' 이상이 0건이라 같은 소분류 안에서는 대체가 원리적으로 불가능하다.
  const [replacements, setReplacements] = useState([]);
  const [replacementIndex, setReplacementIndex] = useState(0);
  const weakestId = analysis.weakest?.id ? String(analysis.weakest.id) : null;
  const weakestScore = analysis.weakest?.analysis?.score ?? null;
  const avoidKey = (profile.avoidIngredients || []).join(',');
  const cartKey = cart.map((item) => String(item.id)).join(',');

  useEffect(() => {
    setReplacementIndex(0);
    // R10 — 원본이 이미 '좋음' 이상이거나 합성 항목(밥)이면 요청하지 않는다.
    if (!weakestId || weakestScore == null || weakestScore >= scoreThresholds.good || weakestId.startsWith('rice-')) {
      setReplacements([]);
      return undefined;
    }
    let cancelled = false;
    const controller = new AbortController();
    (async () => {
      try {
        for (const level of [0, 1, 2]) {
          const payload = await fetchAlternatives(weakestId, {
            limit: 400,
            level,
            excludeAllergens: profile.avoidIngredients || [],
            signal: controller.signal,
          });
          if (cancelled) return;
          const picked = selectReplacements(analysis.weakest, payload.products || [], profile, cart, 3);
          if (picked.length) { setReplacements(picked); return; }
          // 후보가 0이어도 사다리를 멈추지 않는다. 파레토 프리필터가 정확 일치 단계에만 걸려서
          // 레벨 0이 비어도 레벨 1에는 후보가 많다 — 실측 200건 중 9건이 여기서 끊겼고
          // 그중 8건은 계속 내려갔다면 카드가 나왔다.
        }
        if (!cancelled) setReplacements([]);
      } catch {
        if (!cancelled) setReplacements([]);   // 타임아웃·오프라인이면 카드를 띄우지 않는다
      }
    })();
    return () => { cancelled = true; controller.abort(); };
    // analysis.weakest 객체는 매 렌더 새로 만들어지므로 id·점수만 의존성으로 쓴다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weakestId, weakestScore, avoidKey, cartKey]);

  const replacement = replacements[replacementIndex] || null;
  const attentionRows = useMemo(() => analysis.riskRows.filter((row) => row.score !== null && row.level !== 'stable'), [analysis.riskRows]);
  // 질 축(=장바구니 점수)을 설명하는 문구. 점수가 식품 점수의 평균이므로 평균을 끌어내리는
  // 최저점 식품을 지목하는 것이 점수와 같은 축의 설명이 된다.
  const qualityCaption = useMemo(() => {
    if (!items.length) return '식품을 담으면 조합의 질을 계산해요.';
    const weak = analysis.weakest;
    if (!weak || weak.analysis?.score == null) return '담은 식품의 점수를 평균해 계산했어요.';
    if (analysis.score >= scoreThresholds.good) return `담은 ${items.length}개 모두 좋은 선택이에요.`;
    return `${weak.name}이(가) ${formatScore(weak.analysis.score)}점으로 가장 낮아요.`;
  }, [analysis.weakest, analysis.score, items.length]);
  // 누적 영양량 게이지도 위험도 표와 같은 개인 상한을 쓴다 (BMI·저감 목표 반영값).
  const limitOf = (key, fallback) => {
    const row = analysis.riskRows.find((item) => item.key === key);
    return Number.isFinite(row?.max) && row.max > 0 ? row.max : fallback;
  };
  // H4 — 게이지 4개가 모두 같은 기준선(위험도 표의 개인 상한)을 쓰게 한다.
  // 이전에는 열량·단백질만 metrics 중앙값이라 같은 화면에서 '안정'(표)과 '초과'(게이지)가
  // 동시에 나왔다(stable 행의 73%). 폴백은 riskRows가 빈 프레임을 위해 남긴다.
  const calorieLimit = limitOf('calories', metrics.calories * analysis.targetScale);
  const proteinLimit = limitOf('protein', metrics.protein * analysis.targetScale);
  const sugarLimit = limitOf('sugar', 50 * analysis.targetScale);
  const sodiumLimit = limitOf('sodium', 2000 * analysis.targetScale);
  const riskSummary = useMemo(() => {
    if (!attentionRows.length) return '모든 영양 항목이 안정적이에요';
    const names = attentionRows.slice(0, 2).map((row) => row.label).join(' · ');
    const remaining = attentionRows.length - 2;
    return `보완 필요 · ${names}${remaining > 0 ? ` 외 ${remaining}개` : ''}`;
  }, [attentionRows]);

  useEffect(() => { setAiResult(null); }, [cart, scopeMode, scopeUnits, riceEnabled, riceType, riceGrams, riceServings, profile]);

  const requestAi = async () => {
    if (!items.length) return;
    setAiLoading(true);
    try {
      const payload = await explainCart({
        profile,
        goal: { key: profile.goal, label: profile.goal === 'loss' ? '체중 감량' : profile.goal === 'gain' ? '건강한 증량' : '건강 유지' },
        cart: { score: analysis.score, label: analysis.label, itemCount: items.length, scope: `${scopeUnits}${scopeMode === 'days' ? '일' : '끼'}`, totals: analysis.totals, warnings: analysis.reasons, items: analysis.scoredItems || items },
      });
      setAiResult(payload.explanation);
    } catch {
      setAiResult({ summary: `${analysis.label}이에요. ${analysis.reasons[0] || '현재 조합의 영양 구성을 유지해 보세요.'}`, cautions: analysis.reasons.slice(1) });
    } finally {
      setAiLoading(false);
    }
  };

  if (!cart.length && !riceEnabled) {
    return (
      <ScrollView contentContainerStyle={styles.pageContent} showsVerticalScrollIndicator={false}>
        <View style={styles.screenTitleRow}><View><Text style={styles.screenTitle}>영양 분석</Text><Text style={styles.screenSubtitle}>담은 식품의 영양 구성을 계산해요.</Text></View></View>
        <EmptyState icon="analytics-outline" title="아직 담은 식품이 없어요" copy="식품을 담으면 열량·당류·나트륨과 맞춤 점수를 바로 계산해 드려요." action="식품 둘러보기" onPress={onExplore} />
      </ScrollView>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.pageContent} showsVerticalScrollIndicator={false}>
      <View style={styles.screenTitleRow}><View><Text style={styles.screenTitle}>영양 분석</Text><Text style={styles.screenSubtitle}>{items.length}개 식품의 영양 구성을 실시간으로 계산했어요.</Text></View><Pill tone="green">LIVE</Pill></View>

      <LinearGradient colors={analysis.score >= scoreThresholds.good ? ['#1C6A42', '#2E8A52', '#43A263'] : ['#A9752A', '#C68F38', '#D8A44E']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.analysisHero}>
        <HologramOverlay strong />
        <View style={styles.analysisHeroOrb} />
        <View style={styles.analysisHeroTop}>
          <View style={styles.analysisHeroCopyBlock}>
            <Text style={styles.analysisOverline}>장바구니 영양 점수</Text>
            <Text style={styles.analysisLabel}>{analysis.label}</Text>
            {/* H3 — 점수는 '담은 식품의 질'(질 축)인데 예전에는 여기에 누적 영양량 초과/부족
                문구(예산 축)를 넣었다. 98.9점 장바구니와 5.4점 장바구니의 캡션이 같아지는 문제.
                예산 축 문구는 아래 '누적 영양량'과 '영양 위험도'가 이미 전담한다. */}
            <Text style={styles.analysisCopy}>{qualityCaption}</Text>
          </View>
          <ScoreBadge score={analysis.score} hero />
        </View>
        <View style={styles.scopeControl}>{[{ key: 'meals', label: '끼니' }, { key: 'days', label: '일' }].map((item) => <Pressable accessibilityRole="button" accessibilityState={{ selected: scopeMode === item.key }} key={item.key} onPress={() => { haptic(); setScopeMode(item.key); setScopeUnits(1); }} style={[styles.scopeButton, scopeMode === item.key && styles.scopeButtonActive]}><Text style={[styles.scopeText, scopeMode === item.key && styles.scopeTextActive]}>{item.label}</Text></Pressable>)}</View>
        <View style={styles.scopeStepper}><Pressable accessibilityRole="button" accessibilityLabel="누적 기준 줄이기" onPress={() => setScopeUnits((value) => Math.max(1, value - 1))} style={styles.scopeStepButton}><Text style={styles.scopeStepText}>−</Text></Pressable><Text style={styles.scopeStepValue}>누적 {scopeUnits}{scopeMode === 'days' ? '일' : '끼'} 기준</Text><Pressable accessibilityRole="button" accessibilityLabel="누적 기준 늘리기" onPress={() => setScopeUnits((value) => Math.min(scopeMode === 'days' ? 7 : 3, value + 1))} style={styles.scopeStepButton}><Text style={styles.scopeStepText}>＋</Text></Pressable></View>
      </LinearGradient>

      <View style={styles.analysisCard}>
        <SectionHeader title="누적 영양량" copy={`담은 총량 / ${scopeUnits}${scopeMode === 'days' ? '일' : '끼'} 권장량`} />
        <NutritionMetric label="열량" value={analysis.totals.calories == null ? '--' : formatNumber(analysis.totals.calories)} target={formatNumber(calorieLimit)} unit="kcal" progress={(analysis.totals.calories / Math.max(1, calorieLimit)) * 100} tone={analysis.totals.calories > calorieLimit ? 'apricot' : 'green'} />
        <NutritionMetric label="단백질" value={analysis.totals.protein == null ? '--' : formatNumber(analysis.totals.protein, 1)} target={formatNumber(proteinLimit)} unit="g" progress={(analysis.totals.protein / Math.max(1, proteinLimit)) * 100} />
        <NutritionMetric label="당류" value={analysis.totals.sugar == null ? '--' : formatNumber(analysis.totals.sugar, 1)} target={formatNumber(sugarLimit, 1)} unit="g" progress={(analysis.totals.sugar / Math.max(1, sugarLimit)) * 100} tone={analysis.totals.sugar > sugarLimit ? 'apricot' : 'green'} />
        <NutritionMetric label="나트륨" value={analysis.totals.sodium == null ? '--' : formatNumber(analysis.totals.sodium)} target={formatNumber(sodiumLimit)} unit="mg" progress={(analysis.totals.sodium / Math.max(1, sodiumLimit)) * 100} tone={analysis.totals.sodium > sodiumLimit ? 'apricot' : 'green'} />
      </View>

      <View style={styles.riskCard}>
        <Pressable accessibilityRole="button" accessibilityLabel="영양 위험도 상세 보기" accessibilityState={{ expanded: riskOpen }} onPress={() => setRiskOpen((value) => !value)} style={({ pressed }) => [styles.riskHeaderButton, pressed && styles.pressed]}>
          <View style={styles.riskHead}><View style={styles.flex}><Text style={styles.riskTitle}>영양 위험도 한눈에 보기</Text></View></View>
          <View style={styles.riskSummary}><Text numberOfLines={1} style={styles.riskSummaryValue}>{riskSummary}</Text><Text style={styles.riskToggleText}>{riskOpen ? '접기  ↑' : '자세히 보기  ↓'}</Text></View>
        </Pressable>
        {riskOpen && <View style={styles.riskDetail}>
          <View style={styles.riskLegend}><Text style={styles.riskLegendText}>● 안정</Text><Text style={[styles.riskLegendText, styles.riskLegendWatch]}>● 보완</Text><Text style={[styles.riskLegendText, styles.riskLegendDanger]}>● 주의</Text></View>
          {analysis.riskRows.map((row) => <View key={row.key} style={styles.riskRow}><View style={styles.riskRowTop}><Text style={styles.riskName}>{row.label}</Text><Text style={[styles.riskStatus, styles[`riskStatus_${row.level}`]]}>{row.score === null ? '미확인' : row.level === 'stable' ? '안정' : row.level === 'watch' ? '보완' : '주의'}</Text><Text style={styles.riskValue}>{row.score === null ? '정보 없음' : `${formatNumber(row.value, 1)} ${row.unit}`}</Text></View><View style={styles.riskTrack}><AnimatedFill styleList={[styles.riskFill, styles[`riskFill_${row.level}`]]} progress={row.score === null ? 5 : Math.min(100, Math.max(5, row.ratio * 100))} /></View><Text style={styles.riskReason}>{row.reason}</Text></View>)}
          <Text style={styles.reliabilityCopy}>{reliability.reasons.join(' · ')}</Text>
        </View>}
      </View>

      <View style={styles.riceCard}>
        <View style={styles.riceTop}><View><Text style={styles.riceEyebrow}>한국형 식사 옵션</Text><Text style={styles.riceTitle}>밥도 함께 계산할까요?</Text><Text style={styles.riceCopy}>선택한 밥의 열량과 영양을 분석에 더해요.</Text></View><Pressable accessibilityRole="switch" accessibilityLabel="밥 포함" accessibilityState={{ checked: riceEnabled }} onPress={() => setRiceEnabled((value) => !value)} style={[styles.toggle, riceEnabled && styles.toggleActive]}><View style={[styles.toggleKnob, riceEnabled && styles.toggleKnobActive]} /></Pressable></View>
        {riceEnabled && <View style={styles.riceControlStack}><View style={styles.riceControls}><View style={styles.riceSegment}>{['현미밥', '백미밥'].map((item) => <Pressable accessibilityRole="button" accessibilityState={{ selected: riceType === item }} key={item} onPress={() => setRiceType(item)} style={[styles.riceChoice, riceType === item && styles.riceChoiceActive]}><Text style={[styles.riceChoiceText, riceType === item && styles.riceChoiceTextActive]}>{item}</Text></Pressable>)}</View><View style={styles.stepper}><Pressable accessibilityRole="button" accessibilityLabel="밥 양 줄이기" onPress={() => setRiceGrams((value) => Math.max(100, value - 50))} style={styles.stepButton}><Text style={styles.stepText}>−</Text></Pressable><Text style={styles.stepValue}>{riceGrams}g</Text><Pressable accessibilityRole="button" accessibilityLabel="밥 양 늘리기" onPress={() => setRiceGrams((value) => Math.min(400, value + 50))} style={styles.stepButton}><Text style={styles.stepText}>＋</Text></Pressable></View></View><View style={styles.riceServingRow}><Text style={styles.riceServingLabel}>밥 끼니 수</Text><View style={styles.stepper}><Pressable accessibilityRole="button" accessibilityLabel="밥 끼니 수 줄이기" onPress={() => setRiceServings((value) => Math.max(1, value - 1))} style={styles.stepButton}><Text style={styles.stepText}>−</Text></Pressable><Text style={styles.stepValue}>{riceServings}끼</Text><Pressable accessibilityRole="button" accessibilityLabel="밥 끼니 수 늘리기" onPress={() => setRiceServings((value) => Math.min(7, value + 1))} style={styles.stepButton}><Text style={styles.stepText}>＋</Text></Pressable></View></View></View>}
      </View>

      <SectionHeader title="담은 식품" copy={`${cart.length}개 식품`} />
      <View style={styles.cartList}>{cart.map((item) => { const product = enrichProduct(item, profile, { productPool }); return <View key={item.id} style={styles.cartItem}><View style={styles.cartEmoji}><Text>{foodEmoji(item)}</Text></View><View style={styles.flex}><Text numberOfLines={1} style={styles.cartName}>{item.name}</Text><Text style={styles.cartMeta}>{product.analysis.score != null ? `${formatScore(product.analysis.score)}점 · ` : ''}{formatNumber(item.nutrients?.calories, 1)} kcal</Text></View><Pressable accessibilityRole="button" accessibilityLabel={`${item.name} 삭제`} onPress={() => onRemove(item)} style={styles.removeButton}><Ionicons name="close" size={20} color="#7D8B82" /></Pressable></View>; })}</View>

      {/* R10 — 원본이 이미 좋거나 조건을 만족하는 대안이 없으면 카드를 띄우지 않는다. */}
      {analysis.weakest && replacement && <View style={styles.replacementCard}>
        <View style={styles.replacementHead}><LinearGradient colors={['#5EAE6F', '#2E8A52']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.replacementIcon}><Ionicons name="swap-horizontal" size={21} color="#FFFFFF" /></LinearGradient><View style={styles.flex}><Text style={styles.replacementTitle}>더 나은 선택으로 바꿔볼까요?</Text><Text style={styles.replacementWhy}>같은 분류의 식품 중에서 점수가 '좋음' 이상이고 지금 고른 것보다 높은 순으로 골랐어요.</Text></View></View>
        <View style={styles.replacementCompare}><View style={styles.replacementFood}><Text style={styles.replacementTag}>현재</Text><Text numberOfLines={2} style={styles.replacementName}>{analysis.weakest.name}</Text><Text style={styles.replacementScore}>{formatScore(analysis.weakest.analysis.score)}점</Text></View><Ionicons name="arrow-forward" size={17} color={colors.green} style={styles.replacementArrow} /><View style={[styles.replacementFood, styles.replacementFoodBetter]}><Text style={[styles.replacementTag, styles.replacementTagBetter]}>추천</Text><Text numberOfLines={2} style={styles.replacementName}>{replacement?.name || '비슷한 대체 식품 탐색 중'}</Text><Text style={styles.replacementScore}>{replacement ? `${formatScore(replacement.analysis.score)}점` : '조건을 넓혀보세요'}</Text></View></View>
        {replacement ? <View style={styles.replacementActions}><AppButton variant="outline" onPress={() => { haptic('success'); onReplace(analysis.weakest, replacement); }}>추천 식품으로 교체하기</AppButton>{replacements.length > 1 && <Pressable accessibilityRole="button" onPress={() => { haptic(); setReplacementIndex((v) => (v + 1) % replacements.length); }} style={styles.replacementCycle}><Ionicons name="refresh" size={14} color={colors.deep} /><Text style={styles.replacementCycleText}>다른 대안 보기 {replacementIndex + 1}/{replacements.length}</Text></Pressable>}</View> : <Text style={styles.replacementEmpty}>탐색 탭에서 식품을 더 불러오면 대체 추천이 더 정확해져요.</Text>}
      </View>}

      <View style={styles.aiCard}>
        <View style={styles.aiHead}><LinearGradient colors={['#8E6BC0', '#5E4494']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.aiIcon}><Ionicons name="sparkles" size={21} color="#FFFFFF" /></LinearGradient><View style={styles.flex}><Text style={styles.aiTitle}>푸디 AI 코치</Text><Text style={styles.aiSub}>이 조합이 나에게 어떤지 쉽게 설명해요</Text></View></View>
        {aiResult ? <View style={styles.aiResult}><Text style={styles.aiResultSummary}>{aiResult.summary}</Text>{(aiResult.cartReasons || aiResult.cautions || []).slice(0, 3).map((item) => <Text key={item} style={styles.aiReason}>• {item}</Text>)}</View> : null}
        <AppButton onPress={requestAi} disabled={aiLoading}>{aiLoading ? 'AI가 분석하고 있어요…' : aiResult ? '다시 설명받기' : 'AI 추천 설명 받기'}</AppButton>
      </View>
    </ScrollView>
  );
}

function EmptyState({ icon, title, copy, action, onPress }) {
  return (
    <View style={styles.emptyState}>
      <LinearGradient colors={['#EEF7E7', '#FFF1CF']} style={styles.emptyIcon}><Ionicons name={icon} size={38} color={colors.deep} /></LinearGradient>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptyCopy}>{copy}</Text>
      {action ? <AppButton compact onPress={onPress} style={styles.emptyAction}>{action}</AppButton> : null}
    </View>
  );
}

function resolveActivityLevel(profile = {}) {
  if (activityOptions.some((item) => item.label === profile.activityLevel)) return profile.activityLevel;
  return activityOptions.find((item) => item.key === profile.activity)?.label || activityOptions[0].label;
}

function resolveDietaryGoal(profile = {}) {
  if (dietaryGoalOptions.some((item) => item.label === profile.dietaryGoal)) return profile.dietaryGoal;

  const targetGoal = {
    sugar: '당류 저감',
    saturatedFat: '포화지방 저감',
    sodium: '나트륨 저감',
  }[(profile.reduceTargets || [])[0]];
  if (targetGoal) return targetGoal;
  if (profile.weightGoal === 'lossProtein') return '감량·근육 보존 목표';
  if (profile.weightGoal === 'loss' || profile.intensity === 'aggressive') return '적극적 감량 목표';
  if (profile.goal === 'loss') return '감량·근육 보존 목표';
  return '체중 유지 목표';
}

function buildSettingsDraft(profile = {}) {
  const next = { ...defaultProfile, ...sanitizeProfile(profile) };
  const sourceAllergies = Array.isArray(next.allergies) ? next.allergies : next.avoidIngredients || [];
  const allergies = [...new Set(sourceAllergies.filter((item) => officialAllergies.has(item)))];
  const gender = next.gender || (next.sex === 'female' ? '녀' : '남');

  return {
    ...next,
    gender,
    birthDate: String(next.birthDate || '').replaceAll('-', '.'),
    activityLevel: resolveActivityLevel(next),
    dietaryGoal: resolveDietaryGoal(next),
    allergies,
    reduceTargets: (Array.isArray(next.reduceTargets) ? next.reduceTargets : []).filter((key) => supportedReduceTargets.includes(key)),
  };
}

function ProfileScreen({ user, profile, cartCount, onEdit, onLogout }) {
  const metrics = useMemo(() => calculateProfileMetrics(profile), [profile]);
  const displayName = user?.name && !user.name.includes('?') ? user.name : '푸디가드 친구';
  const dietaryGoal = resolveDietaryGoal(profile);
  const activityLevel = resolveActivityLevel(profile);
  const allergyCount = [...new Set((Array.isArray(profile.allergies) ? profile.allergies : profile.avoidIngredients || []).filter((item) => officialAllergies.has(item)))].length;
  return (
    <ScrollView contentContainerStyle={styles.pageContent} showsVerticalScrollIndicator={false}>
      <LinearGradient colors={['#0C3B26', '#17613E', '#2E8A52']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.profileHero}>
        <View style={styles.profileHeroOrb} />
        <View style={styles.profileHeroGlow} />
        <HologramOverlay />
        <View style={styles.profileAvatar}><Ionicons name="person" size={34} color={colors.deep} /></View>
        <Pill tone="glass" style={styles.profileGreetingPill}>건강한 선택을 이어가는 중</Pill>
        <Text style={styles.profileName}>{displayName}님</Text>
        <Text style={styles.profileEmail}>{user?.email}</Text>
      </LinearGradient>

      <Pressable accessibilityRole="button" accessibilityLabel="내 조건 설정 열기" onPress={onEdit} style={({ pressed }) => [styles.conditionCard, pressed && styles.cardPressed]}>
        <LinearGradient colors={['#5EAE6F', '#2E8A52']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.conditionIcon}><Ionicons name="shield-checkmark" size={24} color="#FFFFFF" /></LinearGradient>
        <View style={styles.flex}><Text style={styles.conditionLabel}>내 조건</Text><Text style={styles.conditionValue}>{dietaryGoal}</Text><Text style={styles.conditionSub}>{activityLevel} · 알레르기 {allergyCount}개</Text></View>
        <Ionicons name="chevron-forward" size={22} color="#8F9B93" />
      </Pressable>

      <SectionHeader title="나의 기준" copy="입력한 신체 정보로 계산했어요" />
      <View style={styles.profileMetricGrid}>
        <View style={styles.profileMetric}><LinearGradient colors={['#FFB45E', '#EF7F3A']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.profileMetricBubble}><Ionicons name="flame" size={18} color="#FFFFFF" /></LinearGradient><Text style={styles.profileMetricValue}>{formatNumber(metrics.calories)}</Text><Text style={styles.profileMetricLabel}>하루 권장 kcal</Text></View>
        <View style={styles.profileMetric}><LinearGradient colors={['#82B1E2', '#4D7DAB']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.profileMetricBubble}><Ionicons name="barbell" size={18} color="#FFFFFF" /></LinearGradient><Text style={styles.profileMetricValue}>{metrics.protein}g</Text><Text style={styles.profileMetricLabel}>단백질 목표</Text></View>
        <View style={styles.profileMetric}><LinearGradient colors={['#DE9BC0', '#A4618A']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.profileMetricBubble}><Ionicons name="heart" size={18} color="#FFFFFF" /></LinearGradient><Text style={styles.profileMetricValue}>{cartCount}개</Text><Text style={styles.profileMetricLabel}>선택한 식품</Text></View>
        <View style={styles.profileMetric}><LinearGradient colors={['#7ECB8F', '#37945B']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.profileMetricBubble}><Ionicons name="speedometer" size={18} color="#FFFFFF" /></LinearGradient><Text style={styles.profileMetricValue}>{metrics.bmi}</Text><Text style={styles.profileMetricLabel}>현재 BMI</Text></View>
      </View>

      <View style={styles.promiseCard}><View style={styles.promiseIcon}><Ionicons name="sunny-outline" size={22} color="#A07828" /></View><View style={styles.flex}><Text style={styles.promiseTitle}>오늘의 작은 약속</Text><Text style={styles.promiseCopy}>식품 라벨을 한 번 더 보고, 물 한 잔을 함께 챙겨보세요.</Text></View></View>
      <Pressable accessibilityRole="button" onPress={onLogout} style={styles.logoutButton}><Text style={styles.logoutText}>로그아웃</Text></Pressable>
    </ScrollView>
  );
}

function ProfileSheet({ profile, onSave, onClose }) {
  const [draft, setDraft] = useState(() => buildSettingsDraft(profile));
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const metrics = useMemo(() => calculateProfileMetrics(draft), [draft]);
  const change = (key, value) => setDraft((current) => ({ ...current, [key]: value }));
  const toggleList = (key, value) => setDraft((current) => {
    const list = current[key] || [];
    return { ...current, [key]: list.includes(value) ? list.filter((item) => item !== value) : [...list, value] };
  });
  const selectGender = (gender) => setDraft((current) => ({ ...current, gender, sex: gender === '남' ? 'male' : 'female' }));
  const selectActivity = (item) => setDraft((current) => ({ ...current, activityLevel: item.label, activity: item.key }));
  const selectDietaryGoal = (item) => setDraft((current) => ({ ...current, ...item.profile, dietaryGoal: item.label, reduceTargets: [...item.profile.reduceTargets] }));
  const save = async () => {
    if (!/^\d{4}\.\d{2}\.\d{2}$/.test(draft.birthDate)) {
      setMessage('생년월일을 YYYY.MM.DD 형식으로 입력해주세요.');
      return;
    }
    if (!draft.activityLevel || !draft.dietaryGoal) {
      setMessage('활동량과 식생활 목표를 선택해주세요.');
      return;
    }

    setSaving(true);
    setMessage('');
    try {
      await onSave({
        gender: draft.gender,
        birthDate: draft.birthDate.replaceAll('.', '-'),
        height: draft.height,
        weight: draft.weight,
        activityLevel: draft.activityLevel,
        dietaryGoal: draft.dietaryGoal,
        allergies: draft.allergies,
      });
    } catch (error) {
      setMessage(error.message || '내 조건을 저장하지 못했습니다.');
    } finally {
      setSaving(false);
    }
  };
  return (
    <View style={styles.sheetBackdrop}>
      <SafeAreaView style={styles.sheetSafe}>
        <View style={styles.sheet}>
          <View style={styles.sheetHandle} />
          <View style={styles.sheetHeader}><View><Text style={styles.sheetTitle}>내 조건 설정</Text></View><Pressable accessibilityRole="button" accessibilityLabel="설정 닫기" onPress={onClose} style={styles.closeButton}><Ionicons name="close" size={23} color={colors.ink} /></Pressable></View>
          <ScrollView contentContainerStyle={styles.sheetContent} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
            <LinearGradient colors={['#E9F6E3', '#F4F1D2']} style={styles.sheetSummary}><Text style={styles.sheetSummaryLabel}>현재 식생활 목표</Text><Text style={styles.sheetSummaryTitle}>{draft.dietaryGoal}</Text><Text style={styles.sheetSummaryCopy}>하루 {formatNumber(metrics.calories)} kcal · 단백질 {metrics.protein}g</Text></LinearGradient>

            <View style={styles.sheetBlock}><Text style={styles.sheetBlockTitle}>기본 정보</Text><Text style={styles.sheetBlockCopy}>가입 때 입력한 정보로 맞춤 기준을 계산해요.</Text><View style={styles.sheetGrid}><View style={styles.sheetField}><Text style={styles.fieldLabel}>성별</Text><View style={styles.miniSegment}>{['남', '녀'].map((item) => <Pressable accessibilityRole="radio" accessibilityState={{ checked: draft.gender === item }} key={item} onPress={() => selectGender(item)} style={[styles.miniChoice, draft.gender === item && styles.miniChoiceActive]}><Text style={[styles.miniChoiceText, draft.gender === item && styles.miniChoiceTextActive]}>{item}</Text></Pressable>)}</View></View><Field style={styles.sheetField} label="생년월일" value={draft.birthDate} placeholder="2000.01.01" keyboardType="number-pad" onChangeText={(value) => change('birthDate', formatBirthDate(value))} /><Field style={styles.sheetField} label="키 (cm)" value={String(draft.height || '')} keyboardType="decimal-pad" onChangeText={(value) => change('height', value)} /><Field style={styles.sheetField} label="체중 (kg)" value={String(draft.weight || '')} keyboardType="decimal-pad" onChangeText={(value) => change('weight', value)} /></View></View>

            <View style={styles.sheetBlock}><Text style={styles.sheetBlockTitle}>활동량</Text><Text style={styles.sheetBlockCopy}>평소 생활 패턴에 맞춰 하루 기준을 계산해요.</Text><View style={styles.optionList}>{activityOptions.map((item) => <Pressable accessibilityRole="radio" accessibilityState={{ checked: draft.activityLevel === item.label }} key={item.key} onPress={() => selectActivity(item)} style={[styles.optionRow, draft.activityLevel === item.label && styles.optionRowActive]}><View style={[styles.radio, draft.activityLevel === item.label && styles.radioActive]}>{draft.activityLevel === item.label && <View style={styles.radioDot} />}</View><Text style={styles.optionTitle}>{item.label}</Text></Pressable>)}</View></View>

            <View style={styles.sheetBlock}><Text style={styles.sheetBlockTitle}>식생활 목표</Text><Text style={styles.sheetBlockCopy}>한 가지 목표를 선택해 하루 영양 기준과 탐색에 반영해요.</Text><View style={styles.optionList}>{dietaryGoalOptions.map((item) => <Pressable accessibilityRole="radio" accessibilityState={{ checked: draft.dietaryGoal === item.label }} key={item.label} onPress={() => selectDietaryGoal(item)} style={[styles.optionRow, draft.dietaryGoal === item.label && styles.optionRowActive]}><View style={[styles.radio, draft.dietaryGoal === item.label && styles.radioActive]}>{draft.dietaryGoal === item.label && <View style={styles.radioDot} />}</View><Text style={styles.optionTitle}>{item.label}</Text></Pressable>)}</View></View>

            <View style={styles.sheetBlock}><Text style={styles.sheetBlockTitle}>알레르기 정보</Text><Text style={styles.sheetBlockCopy}>선택한 항목은 식품 검색과 추천에서 제외 기준으로 사용돼요.</Text>{allergyGroups.map((group) => <View key={group.title}><Text style={styles.filterSettingLabel}>{group.title}</Text><View style={styles.healthChips}>{group.items.map((item) => { const active = draft.allergies.includes(item); return <Pressable key={item} accessibilityRole="checkbox" accessibilityState={{ checked: active }} onPress={() => toggleList('allergies', item)} style={[styles.healthChip, active && styles.healthChipDanger]}><Text style={[styles.healthChipText, active && styles.healthChipDangerText]}>{active ? '× ' : ''}{item}</Text></Pressable>; })}</View></View>)}</View>

            <View style={styles.sheetMetricRow}><View style={styles.sheetMetric}><Text style={styles.sheetMetricLabel}>BMI</Text><Text style={styles.sheetMetricValue}>{metrics.bmi}</Text><Text style={styles.sheetMetricCopy}>체질량지수</Text></View><View style={styles.sheetMetric}><Text style={styles.sheetMetricLabel}>BMR</Text><Text style={styles.sheetMetricValue}>{formatNumber(metrics.bmr)}</Text><Text style={styles.sheetMetricCopy}>기초대사량</Text></View></View>
            {message ? <Text style={styles.sheetSaveError}>{message}</Text> : null}
          </ScrollView>
          <View style={styles.sheetFooter}><AppButton disabled={saving} onPress={save}>{saving ? '저장 중…' : '저장하고 적용하기'}</AppButton></View>
        </View>
      </SafeAreaView>
    </View>
  );
}

function ProductDetailSheet({ product, profile, pool, inCart, onToggle, onClose }) {
  const [nutritionMode, setNutritionMode] = useState('per100');
  const [ingredientDetail, setIngredientDetail] = useState(null);
  const [ingredientLoading, setIngredientLoading] = useState(false);
  const enriched = enrichProduct(product, profile, { productPool: pool });
  const restricted = (enriched.analysis.avoidMatches || []).length > 0;
  const nutritionView = useMemo(() => getNutritionView(enriched, nutritionMode), [enriched, nutritionMode]);
  const nutrients = nutritionView.nutrients || {};
  const reliability = useMemo(() => buildReliability([enriched], profile), [enriched, profile]);
  const pairings = useMemo(() => buildPairingSuggestions(enriched, pool, profile), [enriched, pool, profile]);

  useEffect(() => {
    if (!product?.dbId) return undefined;
    let alive = true;
    setIngredientLoading(true);
    setIngredientDetail(null);
    fetchProductIngredients(product.dbId)
      .then((payload) => { if (alive) setIngredientDetail(payload); })
      .catch(() => {})
      .finally(() => { if (alive) setIngredientLoading(false); });
    return () => { alive = false; };
  }, [product?.dbId]);

  const flagChips = useMemo(() => {
    const flags = ingredientDetail?.flags || product?.flags || {};
    return [
      flags.addedSugar && '첨가당',
      flags.sweetener && '감미료',
      flags.refinedCarb && '정제 탄수화물',
      flags.sodiumAdditive && '나트륨 첨가물',
      flags.preservative && '보존료',
    ].filter(Boolean);
  }, [ingredientDetail, product]);
  const detailAllergens = ingredientDetail?.allergens ?? product?.allergens ?? null;
  return (
    <View style={styles.sheetBackdrop}>
      <SafeAreaView style={styles.sheetSafe}>
        <View style={styles.detailSheet}>
          <View style={styles.sheetHandle} />
          <View style={styles.detailHeader}><LinearGradient colors={['#ECF7E6', '#FFF0CF']} style={styles.detailVisual}><HologramOverlay /><Text style={styles.detailEmoji}>{foodEmoji(product)}</Text></LinearGradient><Pressable accessibilityRole="button" accessibilityLabel="상세 닫기" onPress={onClose} style={[styles.closeButton, styles.detailCloseButton]}><Ionicons name="close" size={23} color={colors.ink} /></Pressable></View>
          <ScrollView contentContainerStyle={styles.detailContent} showsVerticalScrollIndicator={false}>
            <View style={styles.productTopline}><Pill tone={enriched.analysis.tone}>{enriched.analysis.label}</Pill>{enriched.analysis.score != null && <Text style={styles.detailScore}>{formatScore(enriched.analysis.score)}점</Text>}<Pill tone="neutral">신뢰도 {reliability.score}%</Pill>{restricted && <View style={styles.restrictedBadge}><Ionicons name="alert-circle" size={13} color="#A95F21" /><Text numberOfLines={1} style={styles.restrictedBadgeText}>제한 성분</Text></View>}</View>
            <Text style={styles.scoreBasisNote}>100g·1회 제공량 기준 · 0~100점 척도</Text>
            <Text style={styles.detailTitle}>{product.name}</Text>
            <Text style={styles.detailStore}>{product.store || product.maker || '식품 데이터'}{product.price ? ` · ${formatNumber(product.price)}원` : ''}</Text>
            <View style={styles.reasonCard}>{enriched.analysis.reasons.map((reason, index) => <View key={reason} style={styles.reasonRow}><Text style={styles.reasonNumber}>{index + 1}</Text><Text style={styles.reasonText}>{reason}</Text></View>)}</View>
            <View style={styles.detailSectionHead}><View><Text style={styles.detailSectionTitle}>영양성분</Text><Text style={styles.detailSectionCopy}>{nutritionView.label}</Text></View><View style={styles.nutritionModeControl}>{[{ key: 'per100', label: '100g' }, { key: 'meal', label: '한 끼' }, { key: 'total', label: '전체' }].map((item) => <Pressable accessibilityRole="button" accessibilityState={{ selected: nutritionMode === item.key }} key={item.key} onPress={() => setNutritionMode(item.key)} style={[styles.nutritionModeButton, nutritionMode === item.key && styles.nutritionModeButtonActive]}><Text style={[styles.nutritionModeText, nutritionMode === item.key && styles.nutritionModeTextActive]}>{item.label}</Text></Pressable>)}</View></View>
            <View style={styles.detailNutritionGrid}>{[
              ['열량', nutrients.calories, 'kcal'], ['탄수화물', nutrients.carbs, 'g'], ['단백질', nutrients.protein, 'g'], ['당류', nutrients.sugar, 'g'], ['나트륨', nutrients.sodium, 'mg'], ['포화지방', nutrients.saturatedFat, 'g'],
            ].map(([label, value, unit]) => <View key={label} style={styles.detailNutrition}><Text style={styles.detailNutritionLabel}>{label}</Text><Text style={styles.detailNutritionValue}>{value == null ? '--' : formatNumber(value, 1)}<Text style={styles.detailNutritionUnit}> {unit}</Text></Text></View>)}</View>
            <View style={styles.reliabilityCard}><View style={styles.reliabilityCardTop}><Text style={styles.reliabilityCardTitle}>데이터 신뢰도</Text><Text style={styles.reliabilityCardScore}>{reliability.score}%</Text></View><View style={styles.reliabilityTrack}><View style={[styles.reliabilityFill, { width: `${reliability.score}%` }]} /></View><Text style={styles.reliabilityCardCopy}>{reliability.reasons.join(' · ')}</Text></View>
            {pairings.length > 0 && <View><Text style={styles.detailSectionTitle}>함께 먹기 좋은 조합</Text><Text style={styles.detailSectionCopy}>부족한 영양소를 채워주는 실제 식품이에요.</Text><View style={styles.pairingList}>{pairings.map((item) => <Pressable accessibilityRole="button" accessibilityLabel={`${item.product.name} 장바구니에 담기`} key={`${item.label}-${item.product.id}`} onPress={() => onToggle(item.product)} style={({ pressed }) => [styles.pairingItem, pressed && styles.cardPressed]}><View style={styles.pairingEmoji}><Text>{foodEmoji(item.product)}</Text></View><View style={styles.flex}><Text style={styles.pairingLabel}>{item.label} 보완</Text><Text numberOfLines={1} style={styles.pairingName}>{item.product.name}</Text></View><Text style={styles.pairingScore}>{formatScore(item.product.analysis.score)}점</Text><Ionicons name="add-circle" size={20} color={colors.deep} /></Pressable>)}</View></View>}
            <View>
              <Text style={styles.detailSectionTitle}>원재료</Text>
              {ingredientLoading ? <Text style={styles.detailSectionCopy}>원재료 정보를 불러오는 중…</Text> : null}
              {!ingredientLoading && ingredientDetail?.ingredients?.length ? (
                <View>
                  <Text style={styles.detailSectionCopy}>표시 순서 그대로 {ingredientDetail.ingredients.length}개</Text>
                  <View style={styles.ingredientChipWrap}>
                    {ingredientDetail.ingredients.map((item) => (
                      <View key={`${item.ordinal}-${item.name}`} style={styles.ingredientChip}><Text style={styles.ingredientChipOrder}>{item.ordinal}</Text><Text style={styles.ingredientChipText}>{item.name}</Text></View>
                    ))}
                  </View>
                </View>
              ) : null}
              {!ingredientLoading && !ingredientDetail?.ingredients?.length ? (
                <Text style={styles.ingredientsText}>{product.ingredients || '이 식품은 아직 원재료 분석 전이에요. 영양성분 기반 분석만 제공돼요.'}</Text>
              ) : null}
              {detailAllergens?.length ? (
                <View style={styles.allergenRow}>{detailAllergens.map((code) => <View key={code} style={styles.allergenChip}><Ionicons name="alert-circle" size={12} color="#B34C43" /><Text style={styles.allergenChipText}>{code}</Text></View>)}</View>
              ) : null}
              {flagChips.length ? (
                <View style={styles.allergenRow}>{flagChips.map((label) => <View key={label} style={styles.flagChip}><Text style={styles.flagChipText}>{label}</Text></View>)}</View>
              ) : null}
              {ingredientDetail?.versions?.length ? (
                <Text style={styles.versionHistoryText}>데이터 이력 {ingredientDetail.versions.length}건 · 기준일 {String(ingredientDetail.versions[0].sourceUpdatedOn || ingredientDetail.versions[0].createdAt || '').slice(0, 10)}</Text>
              ) : null}
            </View>
            {product.link ? <Pressable accessibilityRole="link" onPress={() => Linking.openURL(product.link)} style={styles.externalLink}><Text style={styles.externalLinkText}>판매 정보 보러가기</Text><Ionicons name="open-outline" size={15} color={colors.deep} /></Pressable> : null}
          </ScrollView>
          <View style={styles.sheetFooter}>{restricted && !inCart ? <View style={styles.restrictedFooter}><Ionicons name="alert-circle" size={16} color="#A95F21" /><Text style={styles.restrictedFooterText}>제한 성분이 포함되어 담을 수 없어요</Text></View> : <AppButton onPress={() => onToggle(enriched)}>{inCart ? '장바구니에서 빼기' : '분석 장바구니에 담기'}</AppButton>}</View>
        </View>
      </SafeAreaView>
    </View>
  );
}

function LaunchScreen() {
  return (
    <DevicePreview>
      <SafeAreaView style={styles.launchPage}>
      <LinearGradient colors={['#0D4029', '#2E8A52', '#A9D46F']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.launchGradient}>
        <HologramOverlay strong />
        <View style={styles.launchLogo}><Ionicons name="leaf" size={39} color={colors.deep} /></View>
        <Text style={styles.launchTitle}>푸디가드</Text>
        <Text style={styles.launchCopy}>나에게 맞는 건강한 선택을 준비하고 있어요</Text>
        <ActivityIndicator color="#FFFFFF" style={styles.launchSpinner} />
      </LinearGradient>
      </SafeAreaView>
    </DevicePreview>
  );
}

export default function MobileApp() {
  const [user, setUser] = useState(null);
  // 세션 토큰. 프로필 수정 요청의 본인 확인에 쓰이므로 재실행 후에도 살아 있어야 한다.
  const [sessionToken, setSessionToken] = useState('');
  const [onboardingUser, setOnboardingUser] = useState(null);
  const [tab, setTab] = useState('home');
  const [profile, setProfile] = useState(defaultProfile);
  const [profileOpen, setProfileOpen] = useState(false);
  const [detailProduct, setDetailProduct] = useState(null);
  const [cart, setCart] = useState([]);
  const [explorePreset, setExplorePreset] = useState('');
  const [themePreset, setThemePreset] = useState(recommendationThemes[0].key);
  const [toast, setToast] = useState('');
  const [productPool, setProductPool] = useState([]);
  const [hydrated, setHydrated] = useState(false);
  const fade = useRef(new Animated.Value(1)).current;
  const slide = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    let active = true;
    AsyncStorage.getItem(storageKey)
      .then((raw) => {
        if (!active || !raw) return;
        const saved = JSON.parse(raw);
        const savedUser = saved.user || null;
        const savedToken = saved.token || '';
        setSessionToken(savedToken);
        setAuthToken(savedToken);
        if (savedUser && !savedToken) {
          // 토큰이 도입되기 전에 저장된 세션이다. 그대로 복원하면 로그인한 것처럼 보이지만
          // 프로필 저장이 401 로 막히므로 로그인 화면으로 되돌린다.
          setUser(null);
          setOnboardingUser(null);
        } else if (savedUser && (needsConsent(savedUser) || needsOnboarding(savedUser))) {
          setUser(null);
          setOnboardingUser(savedUser);
        } else {
          setUser(savedUser);
        }
        setProfile({ ...defaultProfile, ...sanitizeProfile(saved.profile || {}) });
        setCart(Array.isArray(saved.cart) ? saved.cart : []);
        if (tabs.some((item) => item.key === saved.tab)) setTab(saved.tab);
      })
      .catch(() => {})
      .finally(() => active && setHydrated(true));
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    AsyncStorage.setItem(storageKey, JSON.stringify({ user, token: sessionToken, profile, cart, tab })).catch(() => {});
  }, [cart, hydrated, profile, sessionToken, tab, user]);

  useEffect(() => {
    if (!hydrated) return;
    const reconciled = reconcileCartWithProfile(cart, profile);
    if (!reconciled.removed.length) return;

    setCart(reconciled.cart);
    const firstName = reconciled.removed[0]?.name || '제한 식품';
    const suffix = reconciled.removed.length > 1 ? ` 외 ${reconciled.removed.length - 1}개` : '';
    setToast(`${firstName}${suffix}를 새 알레르기 조건에 따라 장바구니에서 제외했어요.`);
  }, [cart, hydrated, profile]);


  useEffect(() => {
    fade.setValue(0);
    slide.setValue(16);
    Animated.parallel([
      Animated.timing(fade, { toValue: 1, duration: 260, easing: Easing.out(Easing.cubic), useNativeDriver: Platform.OS !== 'web' }),
      Animated.timing(slide, { toValue: 0, duration: 300, easing: Easing.out(Easing.cubic), useNativeDriver: Platform.OS !== 'web' }),
    ]).start();
  }, [tab, fade, slide]);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(() => setToast(''), toast.includes('제외') ? 4200 : 1700);
    return () => clearTimeout(timer);
  }, [toast]);

  // 토큰은 api 모듈(요청 헤더)과 화면 상태(저장·복원) 양쪽에 반영해야 한다.
  const rememberToken = useCallback((next) => {
    const value = next ? String(next) : '';
    setSessionToken(value);
    setAuthToken(value);
  }, []);

  const clearSession = useCallback(() => {
    rememberToken('');
    setUser(null);
    setOnboardingUser(null);
    setProfile(defaultProfile);
    setCart([]);
    setProductPool([]);
    setExplorePreset('');
    setThemePreset(recommendationThemes[0].key);
    setTab('home');
  }, [rememberToken]);

  const authenticate = (nextUser, nextToken) => {
    // 동의·온보딩 화면은 사용자만 넘기고 토큰은 넘기지 않는다. 여기서 무조건 덮어쓰면 가입 직후
    // 받아 둔 토큰이 빈 문자열로 지워져, 이어지는 프로필 저장이 401 로 막힌다.
    if (nextToken !== undefined) rememberToken(nextToken);
    haptic('success');
    setTab('home');
    setExplorePreset('');
    fade.stopAnimation();
    slide.stopAnimation();
    fade.setValue(1);
    slide.setValue(0);

    if (needsConsent(nextUser) || needsOnboarding(nextUser)) {
      setUser(null);
      setOnboardingUser(nextUser);
      return;
    }

    const nextProfile = profileFromUser(nextUser?.profile || {});
    setOnboardingUser(null);
    setUser(nextUser);
    setProfile(nextProfile);
    setThemePreset(nextProfile.recommendationTheme || recommendationThemes[0].key);
  };

  // 동의를 마친 뒤 갈 곳은 둘이다. 신규 가입이면 프로필 온보딩으로, 프로필을 이미 채운
  // 기존 회원이 동의만 새로 받은 것이면 바로 앱으로 들어간다.
  const completeConsent = (nextUser) => {
    if (needsOnboarding(nextUser)) {
      setOnboardingUser(nextUser);
      return;
    }
    authenticate(nextUser);
  };

  const toggleCart = (product) => {
    const isInCart = cart.some((item) => String(item.id) === String(product.id));
    if (!isInCart && !isAllowedForProfile(product, profile)) {
      haptic();
      setToast('알레르기/제한 성분이 포함된 식품은 장바구니에 담을 수 없어요.');
      return;
    }

    haptic('success');
    setCart((current) => {
      const exists = current.some((item) => String(item.id) === String(product.id));
      setToast(exists ? '장바구니에서 뺐어요' : '분석 장바구니에 담았어요');
      return exists ? current.filter((item) => String(item.id) !== String(product.id)) : [...current, product];
    });
  };

  const goExplore = (preset = '') => {
    haptic();
    setExplorePreset(preset);
    setTab('explore');
  };

  const goTheme = (theme = themePreset) => {
    haptic();
    if (theme) setThemePreset(theme);
    setTab('theme');
  };

  const mergeProductPool = useCallback((nextProducts = []) => {
    if (!nextProducts.length) return;
    // H9 — 최신 결과를 앞에 둔다. [...current, ...next]는 180건이 차면 이후 검색 결과가
    // 영구히 못 들어와 buildPairingSuggestions가 초기 홈 블록에만 갇힌다.
    setProductPool((current) => uniqueProducts([...nextProducts, ...current]).slice(0, 180));
  }, []);

  const replaceCartItem = (from, to) => {
    if (!from?.id || !to?.id || !isAllowedForProfile(to, profile)) return;
    setCart((current) => {
      const next = replaceCartItemOnce(current, from, to);
      if (next !== current) setToast('더 나은 추천 식품으로 교체했어요');
      return next;
    });
  };

  const updateProfile = useCallback((next) => setProfile({ ...defaultProfile, ...sanitizeProfile(next) }), []);

  const saveProfileSettings = useCallback(async (next) => {
    if (!user?.id) throw new Error('회원 정보를 찾을 수 없습니다.');
    const payload = await saveOnboardingProfile(user.id, next);
    const nextProfile = { ...defaultProfile, ...sanitizeProfile(payload.user.profile) };
    const reconciled = reconcileCartWithProfile(cart, nextProfile);
    haptic('success');
    setUser(payload.user);
    updateProfile(nextProfile);
    if (reconciled.removed.length) setCart(reconciled.cart);
    setProfileOpen(false);
    if (reconciled.removed.length) {
      const firstName = reconciled.removed[0]?.name || '제한 식품';
      const suffix = reconciled.removed.length > 1 ? ` 외 ${reconciled.removed.length - 1}개` : '';
      setToast(`${firstName}${suffix}를 새 알레르기 조건에 따라 장바구니에서 제외했어요.`);
    } else {
      setToast('내 조건을 새로 적용했어요');
    }
  }, [cart, user, updateProfile]);

  if (!hydrated) return <LaunchScreen />;

  // 동의가 먼저다. 개인정보 보호법 제23조는 민감정보를 '수집하기 전에' 별도 동의를 받으라고
  // 하므로, 키·체중·알레르기를 묻는 온보딩보다 앞에 세운다.
  if (!user && onboardingUser && needsConsent(onboardingUser)) {
    return (
      <DevicePreview>
        <ConsentScreen user={onboardingUser} onComplete={completeConsent} onRequireLogin={clearSession} />
      </DevicePreview>
    );
  }

  if (!user && onboardingUser) {
    return (
      <DevicePreview>
        <SignupOnboarding
          user={onboardingUser}
          onComplete={authenticate}
        />
      </DevicePreview>
    );
  }

  if (!user) {
    return (
      <AuthScreen
        onAuthenticated={authenticate}
        onSignupCreated={(createdUser, createdToken) => { rememberToken(createdToken); setOnboardingUser(createdUser); }}
      />
    );
  }

  let screen = <HomeScreen user={user} profile={profile} cart={cart} productPool={productPool} onExplore={goExplore} onTheme={goTheme} onAnalysis={() => { haptic(); setTab('insight'); }} onProfile={() => setTab('profile')} onToggleCart={toggleCart} onDetail={setDetailProduct} onProductsLoaded={mergeProductPool} />;
  if (tab === 'explore') screen = <ExploreScreen presetQuery={explorePreset} profile={profile} cart={cart} onToggleCart={toggleCart} onDetail={setDetailProduct} onProductsLoaded={mergeProductPool} />;
  if (tab === 'theme') screen = <ThemeScreen activeTheme={themePreset} profile={profile} cart={cart} onThemeChange={setThemePreset} onToggleCart={toggleCart} onDetail={setDetailProduct} onProductsLoaded={mergeProductPool} />;
  if (tab === 'insight') screen = <InsightScreen cart={cart} profile={profile} productPool={productPool} onRemove={toggleCart} onReplace={replaceCartItem} onExplore={() => goExplore('')} />;
  if (tab === 'profile') screen = <ProfileScreen user={user} profile={profile} cartCount={cart.length} onEdit={() => setProfileOpen(true)} onLogout={() => { haptic(); clearSession(); }} />;

  const tabBarContent = tabs.map((item) => {
    const active = tab === item.key;
    const iconInner = (<>
      <Ionicons name={active ? item.activeIcon : item.icon} size={20} color={active ? '#FFFFFF' : '#89968E'} style={styles.tabIcon} />
      {item.key === 'insight' && cart.length > 0 && <View style={styles.tabBadge}><Text style={styles.tabBadgeText}>{cart.length}</Text></View>}
    </>);
    return <Pressable accessibilityRole="button" accessibilityLabel={`${item.label} 탭`} accessibilityState={{ selected: active }} key={item.key} onPress={() => { haptic(); setTab(item.key); }} style={({ pressed }) => [styles.tabItem, pressed && styles.pressed]}>{active ? <LinearGradient colors={['#1C6A42', '#2E8A52']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={[styles.tabIconWrap, styles.tabIconWrapActive]}>{iconInner}</LinearGradient> : <View style={styles.tabIconWrap}>{iconInner}</View>}<Text style={[styles.tabLabel, active && styles.tabLabelActive]}>{item.label}</Text></Pressable>;
  });

  return (
    <DevicePreview>
      <SafeAreaView style={styles.appPage}>
      <StatusBar barStyle="dark-content" backgroundColor={colors.cream} />
      <Animated.View style={[styles.flex, { opacity: fade, transform: [{ translateY: slide }] }]}>{screen}</Animated.View>
      {Platform.OS === 'web' ? <View style={styles.tabBar}>{tabBarContent}</View> : <BlurView intensity={84} tint="light" style={styles.tabBar}>{tabBarContent}</BlurView>}
      {toast ? <View accessibilityLiveRegion="polite" style={[styles.toast, toast.includes('제외') && styles.toastWarning]}><Ionicons name={toast.includes('제외') ? 'alert-circle' : 'checkmark-circle'} size={18} color={toast.includes('제외') ? '#FFE0A3' : '#C4E59F'} /><Text style={styles.toastText}>{toast}</Text></View> : null}
      {profileOpen && <ProfileSheet profile={profile} onClose={() => setProfileOpen(false)} onSave={saveProfileSettings} />}
      {detailProduct && <ProductDetailSheet product={detailProduct} profile={profile} pool={productPool} inCart={cart.some((item) => String(item.id) === String(detailProduct.id))} onToggle={(product) => { toggleCart(product); if (isAllowedForProfile(product, profile)) setDetailProduct(null); }} onClose={() => setDetailProduct(null)} />}
      </SafeAreaView>
    </DevicePreview>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  previewStage: { flex: 1, minHeight: '100vh', alignItems: 'center', justifyContent: 'center', gap: 12, padding: 12 },
  phoneFrame: { width: 402, maxWidth: 'calc(100vw - 24px)', height: 846, maxHeight: 'calc(100vh - 74px)', padding: 7, paddingTop: 28, borderRadius: 54, backgroundColor: '#18201C', borderWidth: 2, borderColor: '#445047', shadowColor: '#102017', shadowOpacity: 0.28, shadowRadius: 28, shadowOffset: { width: 0, height: 16 }, elevation: 16 },
  phoneSpeaker: { position: 'absolute', zIndex: 3, top: 12, left: '50%', width: 82, height: 5, marginLeft: -41, borderRadius: 99, backgroundColor: '#07100B' },
  phoneScreen: { flex: 1, overflow: 'hidden', borderRadius: 43, backgroundColor: '#F7F8F5' },
  previewHint: { ...typeface, color: '#607067', fontSize: 12, fontWeight: '700' },
  appPage: { flex: 1, backgroundColor: '#F7F8F5' },
  authPage: { flex: 1, backgroundColor: '#F7F8F5' },
  authScroll: { flexGrow: 1, width: '100%', maxWidth: 520, alignSelf: 'center', padding: 16, paddingBottom: 28, justifyContent: 'center', gap: 12 },
  authOrbOne: { position: 'absolute', width: 280, height: 280, borderRadius: 140, backgroundColor: '#E9F3D7', top: -90, left: -120 },
  authOrbTwo: { position: 'absolute', width: 210, height: 210, borderRadius: 105, backgroundColor: '#FFE7B9', right: -90, top: 160, opacity: 0.6 },
  authBrandPanel: { minHeight: 258, borderRadius: 28, padding: 19, overflow: 'hidden', shadowColor: '#0B2E1D', shadowOpacity: 0.24, shadowRadius: 18, shadowOffset: { width: 0, height: 10 }, elevation: 5 },
  authBrandOrb: { position: 'absolute', width: 224, height: 224, borderRadius: 112, right: -70, top: -90, backgroundColor: 'rgba(255,255,255,0.06)', borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.2)' },
  authGlowOrb: { position: 'absolute', width: 190, height: 190, borderRadius: 95, left: -70, bottom: -80, backgroundColor: 'rgba(169,212,111,0.22)' },
  authBrandRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 13 },
  authLogoBadge: { width: 32, height: 32, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.14)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.28)' },
  authLogoText: { ...typeface, color: '#F2FAEC', fontSize: 15, fontWeight: '900', letterSpacing: -0.4 },
  authBrandCopyBlock: { width: '57%', zIndex: 2 },
  authKicker: { marginTop: 0 },
  authTitle: { ...typeface, color: '#F7FCF2', marginTop: 9, fontSize: 27, lineHeight: 33, fontWeight: '900', letterSpacing: -1.5 },
  authCopy: { ...typeface, color: '#B9DEC3', marginTop: 7, fontSize: 12, lineHeight: 18, fontWeight: '700' },
  authCoachFrame: { position: 'absolute', width: '56%', height: 226, right: -6, bottom: -10, alignItems: 'flex-end', justifyContent: 'flex-end' },
  authCoachGlow: { position: 'absolute', width: 196, height: 196, right: -34, bottom: -40, borderRadius: 98, backgroundColor: 'rgba(255,255,255,0.12)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.3)' },
  authCoach: { width: 238, height: 250, marginRight: -13, marginBottom: -13 },
  authCard: { padding: 20, borderRadius: 26, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#E2EAE1', shadowColor: colors.shadow, shadowOpacity: 0.055, shadowRadius: 13, shadowOffset: { width: 0, height: 6 }, elevation: 2 },
  authEyebrow: { ...typeface, color: colors.green, fontSize: 11, fontWeight: '900', letterSpacing: 0.8 },
  authCardTitle: { ...typeface, color: colors.ink, marginTop: 6, fontSize: 24, lineHeight: 31, fontWeight: '900', letterSpacing: -1.25 },
  authCardSubtitle: { ...typeface, color: colors.muted, marginTop: 6, marginBottom: 16, fontSize: 12, lineHeight: 18, fontWeight: '600' },
  segmented: { flexDirection: 'row', padding: 4, borderRadius: 17, backgroundColor: '#EEF3EC', marginBottom: 16 },
  segmentButton: { flex: 1, minHeight: 43, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  segmentButtonActive: { backgroundColor: '#FFFFFF', shadowColor: colors.shadow, shadowOpacity: 0.06, shadowRadius: 7, shadowOffset: { width: 0, height: 3 }, elevation: 1 },
  segmentText: { ...typeface, color: '#839087', fontSize: 14, fontWeight: '800' },
  segmentTextActive: { color: colors.deep },
  field: { gap: 6, marginBottom: 11 },
  fieldLabel: { ...typeface, color: colors.inkSoft, fontSize: 13, fontWeight: '800' },
  input: { ...typeface, minHeight: 52, borderRadius: 15, paddingHorizontal: 14, borderWidth: 1, borderColor: '#DCE6DC', backgroundColor: '#FBFCFA', color: colors.ink, fontSize: 15 },
  authError: { ...typeface, color: colors.danger, marginBottom: 6, fontSize: 12, fontWeight: '700' },
  button: { minHeight: 53, borderRadius: 17, paddingHorizontal: 18, alignItems: 'center', justifyContent: 'center', shadowColor: colors.deep, shadowOpacity: 0.14, shadowRadius: 10, shadowOffset: { width: 0, height: 5 }, elevation: 2 },
  buttonCompact: { minHeight: 42, alignSelf: 'flex-start', borderRadius: 14, paddingHorizontal: 15 },
  buttonOutline: { borderWidth: 1, borderColor: '#D8E7D1', shadowOpacity: 0 },
  buttonText: { ...typeface, color: '#FFFFFF', fontSize: 15, fontWeight: '900' },
  buttonTextSecondary: { color: colors.deep },
  pressed: { opacity: 0.9, transform: [{ scale: 0.98 }] },
  disabled: { opacity: 0.55 },
  cardPressed: { opacity: 0.92, transform: [{ scale: 0.99 }] },
  testLogin: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 13, padding: 13, borderRadius: 16, backgroundColor: '#F1F8EC', borderWidth: 1, borderColor: '#D9EBCF' },
  testLoginIcon: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.deep },
  testLoginTitle: { ...typeface, color: colors.ink, fontSize: 13, fontWeight: '900' },
  testLoginSub: { ...typeface, color: colors.muted, marginTop: 2, fontSize: 11, fontWeight: '600' },
  pageContent: { width: '100%', maxWidth: 520, alignSelf: 'center', paddingHorizontal: layout.pagePadding, paddingTop: layout.pagePadding, paddingBottom: layout.safeBottom },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 16 },
  headerTitle: { ...typeface, color: '#172D21', marginTop: 0, fontSize: 21, fontWeight: '900', letterSpacing: -1.05 },
  headerAvatar: { width: 44, height: 44, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: '#EEF5E9', borderWidth: 1, borderColor: '#D7E8D2', shadowColor: colors.shadow, shadowOpacity: 0.04, shadowRadius: 6, shadowOffset: { width: 0, height: 3 }, elevation: 1 },
  avatarBadge: { position: 'absolute', right: -4, top: -5, minWidth: 19, height: 19, paddingHorizontal: 4, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.apricot, borderWidth: 2, borderColor: colors.cream },
  avatarBadgeText: { color: '#5E4516', fontSize: 9, fontWeight: '900' },
  homeHero: { minHeight: 296, borderRadius: 30, overflow: 'hidden', padding: 21, paddingTop: 22, marginBottom: 0, shadowColor: '#14412D', shadowOpacity: 0.14, shadowRadius: 18, shadowOffset: { width: 0, height: 10 }, elevation: 4 },
  heroOrb: { position: 'absolute', width: 260, height: 260, borderRadius: 130, backgroundColor: 'rgba(18,94,64,0.12)', right: -82, top: -124 },
  heroAura: { position: 'absolute', width: 230, height: 230, borderRadius: 115, right: -63, bottom: -75, backgroundColor: 'rgba(255,255,255,0.2)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.42)' },
  heroCopy: { width: '54%', zIndex: 3 },
  heroKicker: { alignSelf: 'flex-start', minHeight: 26, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, borderRadius: 99, backgroundColor: 'rgba(255,255,255,0.66)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.82)' },
  heroKickerText: { ...typeface, color: '#236C48', fontSize: 10, fontWeight: '900' },
  heroTitle: { ...typeface, color: '#163D2B', marginTop: 15, fontSize: 27, lineHeight: 33, fontWeight: '900', letterSpacing: -1.65 },
  heroDescription: { ...typeface, color: '#3D6650', marginTop: 9, marginBottom: 14, fontSize: 12, lineHeight: 18, fontWeight: '800' },
  heroButton: { alignSelf: 'flex-start', minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, borderRadius: 15, backgroundColor: '#135F3B', shadowColor: '#0E4229', shadowOpacity: 0.22, shadowRadius: 10, shadowOffset: { width: 0, height: 5 } },
  heroButtonText: { ...typeface, color: '#FFFFFF', fontSize: 12, fontWeight: '900' },
  heroCoachFrame: { position: 'absolute', width: '56%', top: 26, right: -8, bottom: 0, zIndex: 1, overflow: 'hidden', alignItems: 'flex-end', justifyContent: 'flex-end' },
  heroCoachGlow: { position: 'absolute', width: 214, height: 214, right: -44, bottom: -46, borderRadius: 107, backgroundColor: 'rgba(255,255,255,0.3)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.52)' },
  heroCoach: { width: 258, height: 290, marginRight: -14, marginBottom: -17 },
  pill: { alignSelf: 'flex-start', minHeight: 23, paddingHorizontal: 8, borderRadius: 99, alignItems: 'center', justifyContent: 'center' },
  pill_green: { backgroundColor: colors.deep }, pill_leaf: { backgroundColor: '#CFE7BC' }, pill_crimson: { backgroundColor: '#FBDDD9' }, pill_sage: { backgroundColor: '#E6F0DC' }, pill_apricot: { backgroundColor: '#FFF0CF' }, pill_neutral: { backgroundColor: '#F0F3EF' }, pill_white: { backgroundColor: 'rgba(255,255,255,0.76)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.92)' }, pill_glass: { backgroundColor: 'rgba(255,255,255,0.16)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.24)' },
  pillText: { ...typeface, fontSize: 10, fontWeight: '900' }, pillText_green: { color: '#FFFFFF' }, pillText_leaf: { color: '#2C5E22' }, pillText_crimson: { color: '#A33227' }, pillText_sage: { color: colors.deep }, pillText_apricot: { color: '#93621C' }, pillText_neutral: { color: '#68786E' }, pillText_white: { color: colors.deep }, pillText_glass: { color: '#F4FAEF', fontSize: 10, letterSpacing: 0.6 },
  goalCard: { padding: 19, marginTop: 14, marginBottom: 22, borderRadius: 26, overflow: 'hidden', shadowColor: '#113C2B', shadowOpacity: 0.16, shadowRadius: 16, shadowOffset: { width: 0, height: 8 }, elevation: 4 },
  goalCardTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  cardEyebrow: { ...typeface, color: colors.green, fontSize: 10, fontWeight: '900', letterSpacing: 1 },
  goalCardCopy: { flex: 1, paddingRight: 12 },
  goalTitle: { ...typeface, color: '#FFFFFF', fontSize: 17, fontWeight: '900' },
  goalSubtitle: { ...typeface, color: '#DCEEDD', marginTop: 4, fontSize: 11, lineHeight: 16, fontWeight: '700' },
  scoreBadge: { width: 64, height: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', borderRadius: 18, backgroundColor: 'rgba(255,255,255,0.16)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.13)' },
  scoreBadgeValue: { ...typeface, color: '#FFFFFF', fontSize: 20, lineHeight: 23, fontWeight: '900', letterSpacing: -0.8 },
  scoreBadgeUnit: { ...typeface, color: '#D5EDBF', marginLeft: 2, fontSize: 10, lineHeight: 14, fontWeight: '900' },
  scoreBadgeHero: { width: 98, height: 98, borderRadius: 29, backgroundColor: 'rgba(255,255,255,0.16)', borderColor: 'rgba(255,255,255,0.25)' },
  scoreBadgeValueHero: { fontSize: 43, lineHeight: 49, letterSpacing: -2.2 },
  scoreBadgeUnitHero: { color: '#EFF8E8', marginLeft: 3, fontSize: 15, lineHeight: 21 },
  progressTrack: { height: 6, marginTop: 16, borderRadius: 9, backgroundColor: 'rgba(255,255,255,0.16)', overflow: 'hidden' },
  progressBar: { height: '100%', borderRadius: 9 },
  goalMetrics: { flexDirection: 'row', marginTop: 15 },
  metric: { flex: 1 }, metricLabel: { ...typeface, color: '#D6EAD7', fontSize: 11, fontWeight: '700' }, metricValue: { ...typeface, color: '#FFFFFF', marginTop: 4, fontSize: 15, fontWeight: '900' }, metricValueAccent: { color: '#E4F5C9' }, metricUnit: { ...typeface, color: '#DCEEDD', fontSize: 11, fontWeight: '700' },
  goalAction: { minHeight: 38, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 14, paddingTop: 12, borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.16)' },
  goalActionText: { ...typeface, color: '#FFFFFF', fontSize: 12, fontWeight: '900' },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 13 },
  sectionTitle: { ...typeface, color: '#172D21', fontSize: 20, fontWeight: '900', letterSpacing: -0.9 },
  sectionCopy: { ...typeface, color: colors.muted, marginTop: 3, fontSize: 11, fontWeight: '600' },
  sectionActionButton: { minHeight: 32, flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 6, borderRadius: 10, backgroundColor: '#EEF6E9' },
  sectionAction: { ...typeface, color: colors.green, fontSize: 12, fontWeight: '900' },
  quickRow: { gap: 10, paddingBottom: 26 },
  quickCard: { width: 114, minHeight: 112, padding: 13, borderRadius: 24, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#E7ECE3', shadowColor: colors.shadow, shadowOpacity: 0.04, shadowRadius: 9, shadowOffset: { width: 0, height: 4 }, elevation: 1 },
  quickCardWarm: { backgroundColor: '#FFF9EE', borderColor: '#F0E8D8' },
  quickIconBubble: { width: 46, height: 46, borderRadius: 16, alignItems: 'center', justifyContent: 'center', shadowColor: '#233F2E', shadowOpacity: 0.22, shadowRadius: 8, shadowOffset: { width: 0, height: 4 }, elevation: 3 },
  quickLabel: { ...typeface, color: colors.ink, marginTop: 10, fontSize: 12, fontWeight: '900' }, quickArrow: { position: 'absolute', right: 12, bottom: 11 },
  productList: { gap: 10 },
  productCard: { minHeight: 112, flexDirection: 'row', alignItems: 'center', padding: 12, borderRadius: 21, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: colors.line, shadowColor: colors.shadow, shadowOpacity: 0.035, shadowRadius: 8, shadowOffset: { width: 0, height: 4 }, elevation: 1 },
  productCardCompact: { minHeight: 100, borderWidth: 0, borderRadius: 22, shadowOpacity: 0.05, shadowRadius: 12, shadowOffset: { width: 0, height: 6 }, elevation: 2 },
  productMainPressable: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center' },
  productVisual: { width: 70, height: 76, borderRadius: 18, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  productVisualCompact: { width: 64, height: 70 },
  productEmoji: { fontSize: 31 }, productEmojiCompact: { fontSize: 28 }, visualDot: { position: 'absolute', width: 28, height: 28, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.4)', right: -7, top: -7 },
  productBody: { flex: 1, minWidth: 0, marginLeft: 11 },
  productTopline: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  productScore: { ...typeface, color: colors.green, fontSize: 11, fontWeight: '900' }, verified: { flexShrink: 1, flexDirection: 'row', alignItems: 'center', gap: 3 }, verifiedText: { ...typeface, color: '#77877D', fontSize: 10, fontWeight: '700' },
  productCardRestricted: { opacity: 0.78 },
  restrictedBadge: { flexShrink: 1, flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 999, backgroundColor: '#FFE5CE' },
  restrictedBadgeText: { ...typeface, color: '#A95F21', fontSize: 10, fontWeight: '800' },
  scoreBasisNote: { ...typeface, color: colors.muted, marginTop: 6, fontSize: 11, fontWeight: '600' },
  scoreBasisNoteList: { marginTop: 0, marginBottom: 12 },
  restrictedFooter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, paddingVertical: 15, borderRadius: 18, backgroundColor: '#FFF1E2' },
  restrictedFooterText: { ...typeface, color: '#A95F21', fontSize: 13, fontWeight: '800' },
  productName: { ...typeface, color: colors.ink, marginTop: 5, fontSize: 14, lineHeight: 20, fontWeight: '900' },
  productMeta: { ...typeface, color: colors.muted, marginTop: 4, fontSize: 12, lineHeight: 16, fontWeight: '600' },
  addButton: { width: layout.touchTarget, height: layout.touchTarget, marginLeft: 8, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: '#ECF5E5', borderWidth: 1, borderColor: '#D8E9CE' },
  addButtonActive: { backgroundColor: colors.deep, borderColor: colors.deep },
  loadingPanel: { minHeight: 110, alignItems: 'center', justifyContent: 'center', gap: 9 }, loadingPanelLarge: { minHeight: 260, alignItems: 'center', justifyContent: 'center', gap: 12 }, loadingText: { color: colors.muted, fontSize: 11, fontWeight: '700' },
  coachBanner: { minHeight: 106, marginTop: 20, padding: 17, borderRadius: 24, flexDirection: 'row', alignItems: 'center', gap: 11, overflow: 'hidden' },
  coachBannerBadge: { alignSelf: 'stretch', minWidth: 47, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 7, borderRadius: 15, backgroundColor: 'rgba(255,255,255,0.12)' },
  coachBannerBadgeText: { ...typeface, maxWidth: 38, color: '#CDE8A7', textAlign: 'center', fontSize: 10, lineHeight: 14, fontWeight: '900' }, coachBannerTitle: { ...typeface, color: '#FFFFFF', fontSize: 16, fontWeight: '900' }, coachBannerCopy: { ...typeface, maxWidth: 235, color: '#CFE3D5', marginTop: 5, fontSize: 11, lineHeight: 16, fontWeight: '600' }, coachBannerArrow: { width: 40, height: 40, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFFFFF' },
  screenTitleRow: { minHeight: 62, flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10, marginBottom: 16 },
  screenTitle: { ...typeface, color: colors.ink, marginTop: 0, fontSize: 28, fontWeight: '900', letterSpacing: -1.5 }, screenSubtitle: { ...typeface, color: colors.muted, marginTop: 5, fontSize: 13, lineHeight: 18, fontWeight: '600' }, screenIcon: { width: 45, height: 45, borderRadius: 16, alignItems: 'center', justifyContent: 'center', shadowColor: '#1A3B28', shadowOpacity: 0.2, shadowRadius: 7, shadowOffset: { width: 0, height: 4 }, elevation: 3 },
  themeHero: { minHeight: 204, flexDirection: 'row', alignItems: 'flex-end', padding: 20, marginBottom: 13, borderRadius: 28, overflow: 'hidden', shadowColor: '#214832', shadowOpacity: 0.12, shadowRadius: 14, shadowOffset: { width: 0, height: 7 }, elevation: 3 },
  themeHeroOrb: { position: 'absolute', width: 190, height: 190, right: -52, top: -76, borderRadius: 95, backgroundColor: 'rgba(255,255,255,0.26)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.42)' },
  themeHeroCopy: { flex: 1, maxWidth: '72%', zIndex: 1 },
  themeHeroKicker: { alignSelf: 'flex-start', minHeight: 27, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, borderRadius: 99, backgroundColor: 'rgba(255,255,255,0.62)' },
  themeHeroKickerText: { ...typeface, color: colors.deep, fontSize: 10, fontWeight: '900' },
  themeHeroTitle: { ...typeface, color: colors.ink, marginTop: 13, fontSize: 24, lineHeight: 30, fontWeight: '900', letterSpacing: -1.25 },
  themeHeroDescription: { ...typeface, color: colors.inkSoft, marginTop: 8, fontSize: 11, lineHeight: 17, fontWeight: '700' },
  themeHeroBadge: { minWidth: 66, minHeight: 66, alignItems: 'center', justifyContent: 'center', marginLeft: 10, borderRadius: 21, backgroundColor: 'rgba(255,255,255,0.74)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.86)', zIndex: 1 },
  themeHeroBadgeValue: { ...typeface, color: colors.deep, fontSize: 22, lineHeight: 25, fontWeight: '900' },
  themeHeroBadgeLabel: { ...typeface, color: colors.muted, marginTop: 1, fontSize: 10, fontWeight: '800' },
  themeGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 10 },
  themeTile: { width: '48.8%', minHeight: 58, flexDirection: 'row', alignItems: 'center', gap: 8, padding: 9, borderRadius: 17, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#DFE9DB' },
  themeTileActive: { backgroundColor: colors.deep, borderColor: colors.deep, shadowColor: '#123F29', shadowOpacity: 0.18, shadowRadius: 7, shadowOffset: { width: 0, height: 4 }, elevation: 2 },
  themeTileIcon: { width: 36, height: 36, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: '#EAF4E4' },
  themeTileIconActive: { backgroundColor: 'rgba(255,255,255,0.15)' },
  themeTileLabel: { ...typeface, flex: 1, color: colors.inkSoft, fontSize: 11, fontWeight: '900' },
  themeTileLabelActive: { color: '#FFFFFF' },
  themeRuleNote: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 13, marginBottom: 22, borderRadius: 15, backgroundColor: '#EDF6E8', borderWidth: 1, borderColor: '#DCEAD5' },
  themeRuleText: { ...typeface, flex: 1, color: colors.inkSoft, fontSize: 10.5, lineHeight: 15, fontWeight: '800' },
  searchBox: { minHeight: 56, flexDirection: 'row', alignItems: 'center', paddingLeft: 14, paddingRight: 5, borderRadius: 18, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#DFE7DF', shadowColor: colors.shadow, shadowOpacity: 0.04, shadowRadius: 8, shadowOffset: { width: 0, height: 4 }, elevation: 1 },
  searchIcon: { marginRight: 8 }, searchInput: { ...typeface, flex: 1, minWidth: 0, height: 52, color: colors.ink, fontSize: 15 }, clearIcon: { color: '#8D9A91', paddingHorizontal: 7, fontSize: 20 }, searchSubmit: { minWidth: 62, minHeight: layout.touchTarget, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.deep }, searchSubmitText: { ...typeface, color: '#FFFFFF', fontSize: 13, fontWeight: '900' },
  filterRow: { gap: 8, paddingVertical: 14 }, filterChip: { minHeight: 40, paddingHorizontal: 15, borderRadius: 99, justifyContent: 'center', backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#E0EAD9', shadowColor: '#2E5B3F', shadowOpacity: 0.05, shadowRadius: 5, shadowOffset: { width: 0, height: 2 }, elevation: 1 }, filterChipActive: { backgroundColor: '#17613E', borderColor: '#17613E', shadowColor: '#0E4229', shadowOpacity: 0.26, shadowRadius: 7, shadowOffset: { width: 0, height: 4 }, elevation: 3 }, filterChipText: { ...typeface, color: '#748178', fontSize: 12, fontWeight: '800' }, filterChipTextActive: { color: '#FFFFFF' },
  sortControl: { flexDirection: 'row', gap: 4, padding: 4, marginTop: 4, marginBottom: 14, borderRadius: 15, backgroundColor: '#EDF1EC' }, sortButton: { minWidth: 76, paddingHorizontal: 12, minHeight: 38, borderRadius: 11, alignItems: 'center', justifyContent: 'center' }, sortButtonActive: { backgroundColor: '#FFFFFF', shadowColor: colors.shadow, shadowOpacity: 0.05, shadowRadius: 5, shadowOffset: { width: 0, height: 2 } }, sortText: { ...typeface, color: '#88938C', fontSize: 11, fontWeight: '800' }, sortTextActive: { color: colors.deep },
  errorPanel: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 14, marginBottom: 12, borderRadius: 17, backgroundColor: '#FFF1EF' }, errorIcon: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.danger }, errorTitle: { ...typeface, color: '#713F3B', fontSize: 13, fontWeight: '900' }, errorCopy: { ...typeface, color: '#986862', marginTop: 2, fontSize: 11, lineHeight: 15 }, retryText: { ...typeface, color: colors.danger, fontSize: 12, fontWeight: '900' }, loadMore: { marginTop: 16 },
  analysisHero: { minHeight: 264, padding: 21, borderRadius: 29, overflow: 'hidden', marginBottom: 13 }, analysisHeroOrb: { position: 'absolute', width: 210, height: 210, borderRadius: 105, backgroundColor: 'rgba(255,255,255,0.08)', right: -60, top: -65 }, analysisHeroTop: { minHeight: 104, flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' }, analysisHeroCopyBlock: { flex: 1, paddingTop: 2, paddingRight: 12 }, analysisOverline: { ...typeface, color: '#C6E4B0', fontSize: 11, fontWeight: '900', letterSpacing: 0.9 }, analysisLabel: { ...typeface, color: '#F2F8EC', marginTop: 9, fontSize: 20, lineHeight: 26, fontWeight: '900' }, analysisCopy: { ...typeface, color: '#D7E9D4', marginTop: 5, fontSize: 12, lineHeight: 17, fontWeight: '600' }, scopeControl: { flexDirection: 'row', alignSelf: 'flex-start', gap: 4, marginTop: 16, padding: 4, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.13)' }, scopeButton: { minHeight: 32, paddingHorizontal: 13, borderRadius: 11, alignItems: 'center', justifyContent: 'center' }, scopeButtonActive: { backgroundColor: '#FFFFFF' }, scopeText: { ...typeface, color: '#E6F0E1', fontSize: 11, fontWeight: '800' }, scopeTextActive: { color: colors.deep },
  analysisCard: { padding: 18, borderRadius: 23, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: colors.line, marginBottom: 13 }, nutritionMetric: { marginTop: 13 }, nutritionMetricTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }, nutritionLabel: { ...typeface, color: colors.inkSoft, fontSize: 12, fontWeight: '800' }, nutritionValue: { ...typeface, color: colors.ink, fontSize: 13, fontWeight: '900' }, nutritionUnit: { ...typeface, color: colors.muted, fontSize: 10 }, nutritionTrack: { height: 7, marginTop: 6, borderRadius: 6, backgroundColor: '#EDF1EC', overflow: 'hidden' }, nutritionFill: { height: '100%', borderRadius: 6 }, nutritionFill_green: { backgroundColor: '#65A75B' }, nutritionFill_apricot: { backgroundColor: '#E8A94A' },
  riceCard: { padding: layout.cardPadding, borderRadius: 23, backgroundColor: '#FFF8E8', borderWidth: 1, borderColor: '#F0E4C9', marginBottom: 20 }, riceTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }, riceEyebrow: { ...typeface, color: '#A17831', fontSize: 11, fontWeight: '900' }, riceTitle: { ...typeface, color: colors.ink, marginTop: 4, fontSize: 18, fontWeight: '900' }, riceCopy: { ...typeface, color: '#8A806D', marginTop: 4, fontSize: 11, lineHeight: 16, fontWeight: '600' }, toggle: { width: 50, height: 30, padding: 3, borderRadius: 15, backgroundColor: '#D9DED7' }, toggleActive: { backgroundColor: colors.deep }, toggleKnob: { width: 24, height: 24, borderRadius: 12, backgroundColor: '#FFFFFF' }, toggleKnobActive: { marginLeft: 20 }, riceControls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 14 }, riceSegment: { flexDirection: 'row', padding: 3, borderRadius: 12, backgroundColor: '#EEE4CF' }, riceChoice: { minHeight: 36, paddingHorizontal: 11, borderRadius: 10, alignItems: 'center', justifyContent: 'center' }, riceChoiceActive: { backgroundColor: '#FFFFFF' }, riceChoiceText: { ...typeface, color: '#88795E', fontSize: 11, fontWeight: '800' }, riceChoiceTextActive: { color: colors.deep }, stepper: { flexDirection: 'row', alignItems: 'center', gap: 9 }, stepButton: { width: 36, height: 36, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#E6D9BD' }, stepText: { color: colors.deep, fontSize: 18, fontWeight: '900' }, stepValue: { ...typeface, minWidth: 46, color: colors.ink, textAlign: 'center', fontSize: 12, fontWeight: '900' },
  cartList: { gap: 8, marginBottom: 18 }, cartItem: { minHeight: 70, flexDirection: 'row', alignItems: 'center', gap: 11, padding: 10, borderRadius: 17, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: colors.line }, cartEmoji: { width: 46, height: 46, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: '#EEF6E8' }, cartName: { ...typeface, color: colors.ink, fontSize: 13, fontWeight: '900' }, cartMeta: { ...typeface, color: colors.muted, marginTop: 3, fontSize: 11, fontWeight: '600' }, removeButton: { width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: '#F3F5F2' },
  aiCard: { padding: layout.cardPadding, borderRadius: 23, backgroundColor: '#EEF6E9', borderWidth: 1, borderColor: '#DCEAD5' }, aiHead: { flexDirection: 'row', alignItems: 'center', gap: 11, marginBottom: 11 }, aiIcon: { width: layout.touchTarget, height: layout.touchTarget, borderRadius: 15, alignItems: 'center', justifyContent: 'center', shadowColor: '#3E2A66', shadowOpacity: 0.24, shadowRadius: 7, shadowOffset: { width: 0, height: 4 }, elevation: 3 }, aiTitle: { ...typeface, color: colors.ink, fontSize: 16, fontWeight: '900' }, aiSub: { ...typeface, color: colors.muted, marginTop: 2, fontSize: 11, lineHeight: 15, fontWeight: '600' }, aiResult: { padding: 14, marginBottom: 7, borderRadius: 15, backgroundColor: '#FFFFFF' }, aiResultSummary: { ...typeface, color: colors.ink, fontSize: 13, lineHeight: 19, fontWeight: '800' }, aiReason: { ...typeface, color: colors.inkSoft, marginTop: 6, fontSize: 11, lineHeight: 16 },
  emptyState: { minHeight: 430, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 30 }, emptyIcon: { width: 92, height: 92, borderRadius: 32, alignItems: 'center', justifyContent: 'center' }, emptyTitle: { ...typeface, color: colors.ink, marginTop: 20, fontSize: 21, fontWeight: '900' }, emptyCopy: { ...typeface, maxWidth: 280, color: colors.muted, marginTop: 8, textAlign: 'center', fontSize: 13, lineHeight: 19, fontWeight: '600' }, emptyAction: { marginTop: 18 },
  profileHero: { minHeight: 232, borderRadius: 29, alignItems: 'center', justifyContent: 'center', paddingVertical: 26, marginBottom: 14, overflow: 'hidden', shadowColor: '#0B2E1D', shadowOpacity: 0.22, shadowRadius: 16, shadowOffset: { width: 0, height: 9 }, elevation: 5 }, profileHeroOrb: { position: 'absolute', width: 200, height: 200, borderRadius: 100, right: -60, top: -70, backgroundColor: 'rgba(255,255,255,0.06)', borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.2)' }, profileHeroGlow: { position: 'absolute', width: 180, height: 180, borderRadius: 90, left: -60, bottom: -70, backgroundColor: 'rgba(169,212,111,0.2)' }, profileAvatar: { width: 74, height: 74, borderRadius: 26, alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFFFFF', borderWidth: 4, borderColor: 'rgba(255,255,255,0.32)', shadowColor: '#08291B', shadowOpacity: 0.24, shadowRadius: 14, shadowOffset: { width: 0, height: 7 }, elevation: 4 }, profileGreetingPill: { alignSelf: 'center', marginTop: 14 }, profileName: { ...typeface, color: '#FFFFFF', marginTop: 8, fontSize: 24, fontWeight: '900', letterSpacing: -0.8 }, profileEmail: { ...typeface, color: '#BFE0C8', marginTop: 4, fontSize: 12, fontWeight: '600' },
  replacementWhy: { ...typeface, color: colors.muted, fontSize: 11.5, fontWeight: '600', lineHeight: 17, marginTop: 3 },
  replacementActions: { gap: 9 }, replacementCycle: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 8 }, replacementCycleText: { ...typeface, color: colors.deep, fontSize: 12, fontWeight: '700' },
  conditionCard: { minHeight: 106, flexDirection: 'row', alignItems: 'center', gap: 13, padding: 15, borderRadius: 22, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: colors.line, marginBottom: 24, shadowColor: colors.shadow, shadowOpacity: 0.05, shadowRadius: 9, shadowOffset: { width: 0, height: 4 }, elevation: 1 }, conditionIcon: { width: 50, height: 50, borderRadius: 17, alignItems: 'center', justifyContent: 'center', shadowColor: '#1A3B28', shadowOpacity: 0.2, shadowRadius: 7, shadowOffset: { width: 0, height: 4 }, elevation: 3 }, conditionLabel: { ...typeface, color: colors.green, fontSize: 11, fontWeight: '900' }, conditionValue: { ...typeface, color: colors.ink, marginTop: 4, fontSize: 14, fontWeight: '900' }, conditionSub: { ...typeface, color: colors.muted, marginTop: 3, fontSize: 11, fontWeight: '600' }, conditionArrow: { color: '#8F9B93', fontSize: 29 },
  profileMetricGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 16 }, profileMetric: { width: '48.4%', minHeight: 128, padding: 16, borderRadius: 21, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: colors.line, shadowColor: colors.shadow, shadowOpacity: 0.04, shadowRadius: 8, shadowOffset: { width: 0, height: 4 }, elevation: 1 }, profileMetricBubble: { width: 40, height: 40, borderRadius: 14, alignItems: 'center', justifyContent: 'center', shadowColor: '#233F2E', shadowOpacity: 0.2, shadowRadius: 7, shadowOffset: { width: 0, height: 4 }, elevation: 3 }, profileMetricValue: { ...typeface, color: colors.ink, marginTop: 12, fontSize: 21, fontWeight: '900', letterSpacing: -0.6 }, profileMetricLabel: { ...typeface, color: colors.muted, marginTop: 3, fontSize: 11, fontWeight: '700' },
  promiseCard: { flexDirection: 'row', gap: 12, padding: 17, borderRadius: 20, backgroundColor: '#FFF4D9', borderWidth: 1, borderColor: '#F1E5C9' }, promiseIcon: { width: 40, height: 40, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFF9E8' }, promiseTitle: { ...typeface, color: colors.ink, fontSize: 14, fontWeight: '900' }, promiseCopy: { ...typeface, color: '#807761', marginTop: 4, fontSize: 11, lineHeight: 16, fontWeight: '600' }, logoutButton: { minHeight: layout.touchTarget, marginTop: 18, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: '#F0F2EF' }, logoutText: { ...typeface, color: '#758179', fontSize: 13, fontWeight: '800' },
  tabBar: { minHeight: 72, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 6, paddingBottom: Platform.select({ ios: 4, default: 7 }), borderTopWidth: 1, borderTopColor: '#E2E8E1', backgroundColor: 'rgba(255,255,255,0.97)', shadowColor: colors.shadow, shadowOpacity: 0.08, shadowRadius: 15, shadowOffset: { width: 0, height: -4 }, elevation: 10 }, tabItem: { flex: 1, minWidth: 0, alignItems: 'center', gap: 3 }, tabIconWrap: { width: 42, height: 34, borderRadius: 13, alignItems: 'center', justifyContent: 'center' }, tabIconWrapActive: { shadowColor: '#0E4229', shadowOpacity: 0.28, shadowRadius: 8, shadowOffset: { width: 0, height: 4 }, elevation: 3 }, tabIcon: {}, tabLabel: { ...typeface, color: '#89968E', fontSize: 10.5, fontWeight: '700' }, tabLabelActive: { color: colors.deep, fontWeight: '900' }, tabBadge: { position: 'absolute', right: -3, top: -5, minWidth: 18, height: 18, paddingHorizontal: 4, borderRadius: 9, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.apricot, borderWidth: 2, borderColor: '#FFFFFF' }, tabBadgeText: { ...typeface, color: '#5E4516', fontSize: 10, fontWeight: '900' },
  toast: { position: 'absolute', left: 26, right: 26, bottom: 86, minHeight: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 16, borderRadius: 17, backgroundColor: 'rgba(24,57,40,0.95)', shadowColor: colors.shadow, shadowOpacity: 0.2, shadowRadius: 14, shadowOffset: { width: 0, height: 7 }, elevation: 12 }, toastWarning: { backgroundColor: 'rgba(101,66,20,0.97)' }, toastText: { ...typeface, flexShrink: 1, color: '#FFFFFF', fontSize: 13, lineHeight: 18, fontWeight: '800' },
  sheetBackdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(20,44,30,0.34)', justifyContent: 'flex-end', zIndex: 30 }, sheetSafe: { width: '100%', maxWidth: 560, maxHeight: '95%', alignSelf: 'center' }, sheet: { width: '100%', maxHeight: '100%', borderTopLeftRadius: 31, borderTopRightRadius: 31, backgroundColor: colors.cream, overflow: 'hidden' }, detailSheet: { width: '100%', maxHeight: '92%', borderTopLeftRadius: 31, borderTopRightRadius: 31, backgroundColor: colors.cream, overflow: 'hidden' }, sheetHandle: { width: 40, height: 5, borderRadius: 5, alignSelf: 'center', marginTop: 9, backgroundColor: '#CED5CF' }, sheetHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 19, paddingVertical: 14 }, sheetTitle: { ...typeface, color: colors.ink, marginTop: 0, fontSize: 24, fontWeight: '900', letterSpacing: -1.2 }, closeButton: { width: layout.touchTarget, height: layout.touchTarget, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: '#EEF2EC' }, closeText: { color: colors.ink, fontSize: 25, lineHeight: 27 }, sheetContent: { paddingHorizontal: 18, paddingBottom: 24, gap: 13 }, sheetSummary: { padding: 18, borderRadius: 21, borderWidth: 1, borderColor: '#DCE8D2' }, sheetSummaryLabel: { ...typeface, color: colors.green, fontSize: 11, fontWeight: '900' }, sheetSummaryTitle: { ...typeface, color: colors.ink, marginTop: 5, fontSize: 18, fontWeight: '900' }, sheetSummaryCopy: { ...typeface, color: colors.muted, marginTop: 4, fontSize: 12, lineHeight: 17, fontWeight: '600' }, sheetBlock: { padding: 17, borderRadius: 21, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: colors.line }, sheetBlockTitle: { ...typeface, color: colors.ink, fontSize: 17, fontWeight: '900' }, sheetBlockCopy: { ...typeface, color: colors.muted, marginTop: 4, marginBottom: 14, fontSize: 11, lineHeight: 16, fontWeight: '600' }, sheetGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', gap: 10 }, sheetField: { width: '48%' }, miniSegment: { minHeight: 52, flexDirection: 'row', padding: 3, borderRadius: 15, backgroundColor: '#F0F3EF' }, miniChoice: { flex: 1, borderRadius: 12, alignItems: 'center', justifyContent: 'center' }, miniChoiceActive: { backgroundColor: '#FFFFFF' }, miniChoiceText: { ...typeface, color: colors.muted, fontSize: 12, fontWeight: '800' }, miniChoiceTextActive: { color: colors.deep }, optionList: { gap: 8, marginTop: 13 }, optionRow: { flexDirection: 'row', alignItems: 'center', gap: 11, minHeight: 64, paddingHorizontal: 13, borderRadius: 16, backgroundColor: '#F7F8F6', borderWidth: 1, borderColor: 'transparent' }, optionRowActive: { backgroundColor: '#EDF6E7', borderColor: '#D6E8CA' }, radio: { width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: '#B8C3BB' }, radioActive: { borderColor: colors.deep }, radioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.deep }, optionTitle: { ...typeface, color: colors.ink, fontSize: 13, fontWeight: '900' }, optionCopy: { ...typeface, color: colors.muted, marginTop: 2, fontSize: 11, lineHeight: 15 }, healthChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginTop: 13, marginBottom: 14 }, healthChip: { minHeight: 40, paddingHorizontal: 12, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: '#F1F3F0' }, healthChipActive: { backgroundColor: colors.deep }, healthChipText: { ...typeface, color: '#77847B', fontSize: 11, fontWeight: '800' }, healthChipTextActive: { color: '#FFFFFF' }, sheetMetricRow: { flexDirection: 'row', gap: 10 }, sheetMetric: { flex: 1, padding: 16, borderRadius: 19, backgroundColor: '#EAF4E3' }, sheetMetricLabel: { ...typeface, color: colors.green, fontSize: 11, fontWeight: '900' }, sheetMetricValue: { ...typeface, color: colors.ink, marginTop: 5, fontSize: 20, fontWeight: '900' }, sheetMetricCopy: { ...typeface, color: colors.muted, marginTop: 2, fontSize: 10 }, sheetFooter: { padding: 12, paddingHorizontal: 18, borderTopWidth: 1, borderTopColor: colors.line, backgroundColor: '#FFFFFF' },
  detailHeader: { minHeight: 175, alignItems: 'center', justifyContent: 'center' }, detailCloseButton: { position: 'absolute', right: 18, top: 10 }, detailVisual: { width: 130, height: 130, borderRadius: 40, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }, detailEmoji: { fontSize: 59 }, detailContent: { paddingHorizontal: 18, paddingBottom: 24 }, detailScore: { ...typeface, color: colors.green, fontSize: 12, fontWeight: '900' }, detailTitle: { ...typeface, color: colors.ink, marginTop: 10, fontSize: 23, lineHeight: 31, fontWeight: '900', letterSpacing: -0.9 }, detailStore: { ...typeface, color: colors.muted, marginTop: 6, fontSize: 12, fontWeight: '600' }, reasonCard: { gap: 9, padding: 15, marginTop: 16, borderRadius: 18, backgroundColor: '#EAF4E4' }, reasonRow: { flexDirection: 'row', alignItems: 'center', gap: 9 }, reasonNumber: { ...typeface, width: 24, height: 24, borderRadius: 8, color: '#FFFFFF', backgroundColor: colors.deep, textAlign: 'center', lineHeight: 23, fontSize: 11, fontWeight: '900' }, reasonText: { ...typeface, flex: 1, color: colors.inkSoft, fontSize: 12, lineHeight: 17, fontWeight: '700' }, detailSectionTitle: { ...typeface, color: colors.ink, marginTop: 22, marginBottom: 6, fontSize: 17, fontWeight: '900' }, detailNutritionGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 }, detailNutrition: { width: '31.7%', minHeight: 78, padding: 11, borderRadius: 16, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: colors.line }, detailNutritionLabel: { ...typeface, color: colors.muted, fontSize: 10, fontWeight: '700' }, detailNutritionValue: { ...typeface, color: colors.ink, marginTop: 7, fontSize: 15, fontWeight: '900' }, detailNutritionUnit: { ...typeface, color: colors.muted, fontSize: 10 }, ingredientsText: { ...typeface, color: colors.inkSoft, fontSize: 12, lineHeight: 18, fontWeight: '600' }, externalLink: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: 5, marginTop: 18 }, externalLinkText: { ...typeface, color: colors.deep, fontSize: 13, fontWeight: '900' },
  ingredientChipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 },
  ingredientChip: { flexDirection: 'row', alignItems: 'center', gap: 5, minHeight: 30, paddingHorizontal: 9, borderRadius: 10, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: colors.line },
  ingredientChipOrder: { ...typeface, minWidth: 15, color: colors.green, textAlign: 'center', fontSize: 10, fontWeight: '900' },
  ingredientChipText: { ...typeface, color: colors.inkSoft, fontSize: 11, fontWeight: '700' },
  allergenRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 },
  allergenChip: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 28, paddingHorizontal: 9, borderRadius: 99, backgroundColor: '#FFF0ED', borderWidth: 1, borderColor: '#F0C9C2' },
  allergenChipText: { ...typeface, color: '#B34C43', fontSize: 11, fontWeight: '900' },
  flagChip: { minHeight: 28, paddingHorizontal: 10, borderRadius: 99, alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFF4DC', borderWidth: 1, borderColor: '#EEDDB4' },
  flagChipText: { ...typeface, color: '#96701F', fontSize: 11, fontWeight: '900' },
  versionHistoryText: { ...typeface, color: colors.muted, marginTop: 10, fontSize: 10, fontWeight: '600' },
  launchPage: { flex: 1, backgroundColor: '#176B46' },
  launchGradient: { flex: 1, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  launchLogo: { width: 82, height: 82, borderRadius: 27, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.95)', shadowColor: '#08291B', shadowOpacity: 0.2, shadowRadius: 22, shadowOffset: { width: 0, height: 10 } },
  launchLogoText: { color: colors.deep, fontSize: 42, fontWeight: '900' },
  launchTitle: { color: '#FFFFFF', marginTop: 20, fontSize: 30, fontWeight: '900', letterSpacing: -1.8 },
  launchCopy: { color: '#E5F4DC', marginTop: 7, fontSize: 11, fontWeight: '700' },
  launchSpinner: { marginTop: 25 },
  holoBeam: { position: 'absolute', top: -100, bottom: -100, width: 78, backgroundColor: 'rgba(255,255,255,0.12)' },
  holoBeamStrong: { width: 112, backgroundColor: 'rgba(223,255,242,0.17)' },
  holoOrb: { position: 'absolute', right: -54, bottom: -76, width: 180, height: 180, borderRadius: 90, backgroundColor: 'rgba(176,255,211,0.10)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.22)' },
  holoSpark: { position: 'absolute', right: 22, top: 20 },
  holoSparkText: { color: 'rgba(255,255,255,0.75)', fontSize: 17, fontWeight: '900' },
  focusCard: { padding: layout.cardPadding, marginBottom: 28, borderRadius: 26, borderWidth: 1, borderColor: '#DCEBD2', shadowColor: '#2E5B3F', shadowOpacity: 0.07, shadowRadius: 12, shadowOffset: { width: 0, height: 6 }, elevation: 2 },
  focusHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  focusTitle: { ...typeface, color: '#172D21', fontSize: 20, fontWeight: '900', letterSpacing: -0.8 },
  focusCopy: { ...typeface, color: colors.muted, marginTop: 4, fontSize: 12, lineHeight: 17, fontWeight: '600' },
  focusHint: { ...typeface, color: '#FFFFFF', paddingHorizontal: 11, paddingVertical: 7, borderRadius: 99, backgroundColor: colors.deep, fontSize: 10, fontWeight: '900', overflow: 'hidden', shadowColor: '#0E4229', shadowOpacity: 0.22, shadowRadius: 6, shadowOffset: { width: 0, height: 3 }, elevation: 2 },
  focusChips: { flexDirection: 'row', gap: 8, paddingTop: 14, paddingBottom: 4, paddingRight: 18 },
  focusChip: { minHeight: layout.touchTarget, flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 14, borderRadius: 22, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#E0EAD9', shadowColor: '#2E5B3F', shadowOpacity: 0.06, shadowRadius: 6, shadowOffset: { width: 0, height: 3 }, elevation: 1 },
  focusChipActive: { backgroundColor: '#17613E', borderColor: '#17613E', shadowColor: '#0E4229', shadowOpacity: 0.28, shadowRadius: 8, shadowOffset: { width: 0, height: 4 }, elevation: 3 },
  focusChipEmoji: { fontSize: 14 },
  focusChipIcon: { color: '#8B998F', fontSize: 12, fontWeight: '900' },
  focusChipIconActive: { color: '#D7EEB2' },
  focusChipText: { ...typeface, color: colors.inkSoft, fontSize: 12, fontWeight: '800' },
  focusChipTextActive: { color: '#FFFFFF' },
  advancedFilterToggle: { minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: 11, padding: 11, marginBottom: 8, borderRadius: 18, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: colors.line },
  advancedFilterIcon: { width: 38, height: 38, borderRadius: 13, alignItems: 'center', justifyContent: 'center', shadowColor: '#8A6420', shadowOpacity: 0.2, shadowRadius: 6, shadowOffset: { width: 0, height: 3 }, elevation: 2 },
  advancedFilterTitle: { ...typeface, color: colors.ink, fontSize: 13, fontWeight: '900' },
  advancedFilterCopy: { ...typeface, color: colors.muted, marginTop: 3, fontSize: 11, lineHeight: 15, fontWeight: '600' },
  advancedFilterArrow: { paddingHorizontal: 8 },
  advancedFilterPanel: { padding: 14, marginBottom: 6, borderRadius: 20, backgroundColor: '#F3F8EF', borderWidth: 1, borderColor: '#DDEAD6' },
  filterSettingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  filterSettingTitle: { ...typeface, color: colors.ink, fontSize: 13, fontWeight: '900' },
  filterSettingCopy: { ...typeface, color: colors.muted, marginTop: 3, fontSize: 11, lineHeight: 15, fontWeight: '600' },
  filterSettingLabel: { ...typeface, color: colors.inkSoft, marginTop: 14, marginBottom: 8, fontSize: 11, fontWeight: '900' },
  compactChipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  compactChip: { minHeight: 38, paddingHorizontal: 12, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#E0E8DD' },
  compactChipActive: { backgroundColor: colors.deep, borderColor: colors.deep },
  compactChipText: { ...typeface, color: colors.muted, fontSize: 11, fontWeight: '800' },
  compactChipTextActive: { color: '#FFFFFF' },
  scopeStepper: { position: 'absolute', right: 18, bottom: 20, minHeight: 38, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 5, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.14)' },
  scopeStepButton: { width: 29, height: 29, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.92)' },
  scopeStepText: { color: colors.deep, fontSize: 15, fontWeight: '900' },
  scopeStepValue: { ...typeface, minWidth: 68, color: '#FFFFFF', textAlign: 'center', fontSize: 11, fontWeight: '900' },
  riskCard: { padding: 18, marginBottom: 13, borderRadius: 23, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: colors.line },
  riskHeaderButton: { borderRadius: 16 },
  riskHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  riskTitle: { ...typeface, color: colors.ink, marginTop: 0, fontSize: 18, fontWeight: '900' },
  reliabilityBadge: { minWidth: 62, minHeight: 54, alignItems: 'center', justifyContent: 'center', borderRadius: 18, backgroundColor: '#EAF4E3' },
  reliabilityScore: { ...typeface, color: colors.deep, fontSize: 16, fontWeight: '900' },
  reliabilityLabel: { ...typeface, color: colors.muted, marginTop: 1, fontSize: 10, fontWeight: '700' },
  riskSummary: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 14, paddingHorizontal: 12, borderRadius: 14, backgroundColor: '#F4F8F1' },
  riskSummaryLabel: { ...typeface, color: colors.green, fontSize: 10, fontWeight: '900' },
  riskSummaryValue: { ...typeface, flex: 1, color: colors.ink, fontSize: 12, fontWeight: '800' },
  riskToggleText: { ...typeface, color: colors.deep, fontSize: 11, fontWeight: '900' },
  riskDetail: { marginTop: 1 },
  riskLegend: { flexDirection: 'row', gap: 12, marginTop: 14, paddingBottom: 11, borderBottomWidth: 1, borderBottomColor: colors.line },
  riskLegendText: { ...typeface, color: '#51A06A', fontSize: 10, fontWeight: '800' },
  riskLegendWatch: { color: '#D9A341' },
  riskLegendDanger: { color: colors.danger },
  riskRow: { paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: '#F0F2EE' },
  riskRowTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  riskName: { ...typeface, width: 54, color: colors.ink, fontSize: 12, fontWeight: '900' },
  riskStatus: { ...typeface, minWidth: 40, paddingVertical: 4, borderRadius: 8, textAlign: 'center', fontSize: 10, fontWeight: '900' },
  riskStatus_stable: { color: '#247949', backgroundColor: '#E5F4E6' },
  riskStatus_watch: { color: '#9A6C16', backgroundColor: '#FFF1CE' },
  riskStatus_caution: { color: '#A95F21', backgroundColor: '#FFE5CE' },
  riskStatus_unknown: { color: '#77877D', backgroundColor: '#EEF1EC' },
  riskStatus_danger: { color: '#B23D3A', backgroundColor: '#FFE0DE' },
  riskValue: { ...typeface, flex: 1, color: colors.inkSoft, textAlign: 'right', fontSize: 11, fontWeight: '900' },
  riskTrack: { height: 5, marginTop: 7, borderRadius: 5, backgroundColor: '#EDF1EC', overflow: 'hidden' },
  riskFill: { height: '100%', borderRadius: 5 },
  riskFill_stable: { backgroundColor: '#55A264' },
  riskFill_watch: { backgroundColor: '#DDB04E' },
  riskFill_caution: { backgroundColor: '#E78D45' },
  riskFill_danger: { backgroundColor: '#D95852' },
  riskFill_unknown: { backgroundColor: '#C8CFC9' },
  riskReason: { ...typeface, color: colors.muted, marginTop: 5, fontSize: 11, lineHeight: 16, fontWeight: '600' },
  reliabilityCopy: { ...typeface, color: colors.muted, marginTop: 11, fontSize: 11, lineHeight: 16, fontWeight: '600' },
  riceControlStack: { gap: 9, marginTop: 14 },
  riceServingRow: { minHeight: 42, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 8, borderTopWidth: 1, borderTopColor: '#E9DCC1' },
  riceServingLabel: { ...typeface, color: colors.inkSoft, fontSize: 11, fontWeight: '900' },
  replacementCard: { padding: 17, marginBottom: 13, borderRadius: 23, backgroundColor: '#F0F7EB', borderWidth: 1, borderColor: '#D9E8D1' },
  replacementHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  replacementIcon: { width: 38, height: 38, borderRadius: 13, alignItems: 'center', justifyContent: 'center', shadowColor: '#1A3B28', shadowOpacity: 0.2, shadowRadius: 6, shadowOffset: { width: 0, height: 3 }, elevation: 2 },
  replacementIconText: { color: '#FFFFFF', fontSize: 17, fontWeight: '900' },
  replacementTitle: { ...typeface, color: colors.ink, marginTop: 0, fontSize: 15, fontWeight: '900' },
  replacementCompare: { flexDirection: 'row', alignItems: 'stretch', gap: 7, marginVertical: 13 },
  replacementFood: { flex: 1, minHeight: 92, padding: 11, borderRadius: 15, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#E5EAE2' },
  replacementFoodBetter: { borderColor: '#BFD9B1', backgroundColor: '#F9FFF5' },
  replacementTag: { ...typeface, alignSelf: 'flex-start', color: colors.muted, paddingHorizontal: 7, paddingVertical: 4, borderRadius: 7, backgroundColor: '#EEF1ED', fontSize: 10, fontWeight: '900' },
  replacementTagBetter: { color: colors.deep, backgroundColor: '#DDEFD2' },
  replacementName: { ...typeface, color: colors.ink, marginTop: 8, fontSize: 11, lineHeight: 16, fontWeight: '900' },
  replacementScore: { ...typeface, color: colors.green, marginTop: 5, fontSize: 11, fontWeight: '900' },
  replacementArrow: { alignSelf: 'center', color: colors.green, fontSize: 16, fontWeight: '900' },
  replacementEmpty: { ...typeface, color: colors.muted, fontSize: 11, lineHeight: 16, fontWeight: '600' },
  profileChoiceGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  profileChoice: { minHeight: 35, paddingHorizontal: 11, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: '#F1F3F0', borderWidth: 1, borderColor: 'transparent' },
  profileChoiceActive: { backgroundColor: '#E8F4E1', borderColor: '#BED9B1' },
  profileChoiceText: { ...typeface, color: colors.muted, fontSize: 11, fontWeight: '800' },
  profileChoiceTextActive: { color: colors.deep },
  healthChipDanger: { backgroundColor: '#FFF0ED', borderWidth: 1, borderColor: '#F0C9C2' },
  healthChipDangerText: { color: '#B34C43' },
  sheetSaveError: { ...typeface, color: colors.danger, paddingHorizontal: 4, fontSize: 12, fontWeight: '800' },
  detailSectionHead: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: 8, marginTop: 3, marginBottom: 9 },
  detailSectionCopy: { color: colors.muted, marginBottom: 5, fontSize: 8, fontWeight: '600' },
  nutritionModeControl: { flexDirection: 'row', padding: 3, borderRadius: 11, backgroundColor: '#EDF1EC' },
  nutritionModeButton: { minWidth: 45, minHeight: 29, paddingHorizontal: 7, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  nutritionModeButtonActive: { backgroundColor: '#FFFFFF' },
  nutritionModeText: { color: colors.muted, fontSize: 8, fontWeight: '800' },
  nutritionModeTextActive: { color: colors.deep },
  reliabilityCard: { padding: 13, marginTop: 12, borderRadius: 17, backgroundColor: '#F1F7ED', borderWidth: 1, borderColor: '#DFEBDC' },
  reliabilityCardTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  reliabilityCardTitle: { color: colors.ink, fontSize: 10, fontWeight: '900' },
  reliabilityCardScore: { color: colors.deep, fontSize: 12, fontWeight: '900' },
  reliabilityTrack: { height: 6, marginTop: 8, borderRadius: 6, overflow: 'hidden', backgroundColor: '#DEE7DA' },
  reliabilityFill: { height: '100%', borderRadius: 6, backgroundColor: '#55A264' },
  reliabilityCardCopy: { color: colors.muted, marginTop: 7, fontSize: 7, lineHeight: 11, fontWeight: '600' },
  pairingList: { gap: 7, marginTop: 10 },
  pairingItem: { minHeight: 57, flexDirection: 'row', alignItems: 'center', gap: 8, padding: 8, borderRadius: 16, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: colors.line },
  pairingEmoji: { width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: '#EEF6E8' },
  pairingLabel: { color: colors.green, fontSize: 7, fontWeight: '900' },
  pairingName: { color: colors.ink, marginTop: 3, fontSize: 9, fontWeight: '800' },
  pairingScore: { color: colors.green, fontSize: 9, fontWeight: '900' },
  pairingAdd: { color: colors.deep, fontSize: 17, fontWeight: '900' },
});
