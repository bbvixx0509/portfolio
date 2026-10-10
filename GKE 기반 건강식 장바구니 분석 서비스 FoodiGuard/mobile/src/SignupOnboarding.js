import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  BackHandler,
  KeyboardAvoidingView,
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
import { LinearGradient } from 'expo-linear-gradient';
import Ionicons from '@expo/vector-icons/Ionicons';

import { saveOnboardingProfile } from './api';
import { formatBirthDate, stepError } from './profileInput';

const colors = {
  ink: '#173B2A',
  deep: '#176B46',
  green: '#3F8F55',
  lime: '#A9D46F',
  mint: '#E9F6E8',
  cream: '#FAF7F0',
  paper: '#FFFFFF',
  line: '#E4ECE1',
  muted: '#73847A',
  danger: '#C74B45',
};

const typeface = {
  fontFamily: Platform.select({
    web: '-apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Pretendard Variable", Pretendard, Roboto, "Noto Sans KR", sans-serif',
    ios: 'Apple SD Gothic Neo',
    android: 'sans-serif',
    default: 'sans-serif',
  }),
};

const steps = [
  { title: '기본 정보', copy: '신체 정보를 입력하면 개인 영양 기준을 계산할 수 있어요.', icon: 'person-outline' },
  { title: '활동량', copy: '평소 생활에 가장 가까운 활동량을 골라주세요.', icon: 'walk-outline' },
  { title: '식생활 목표', copy: '한 가지 우선 목표를 선택해주세요.', icon: 'flag-outline' },
  { title: '알레르기 정보', copy: '해당하는 식품은 검색과 추천에서 제외할 수 있어요.', icon: 'shield-checkmark-outline' },
];

const activityOptions = [
  '운동 거의 안함',
  '주 1~3회 걷기&가벼운 운동',
  '주3~5회 운동',
  '육체활동 많은 직업&거의 매일 고강도 운동',
];

const goalOptions = [
  '감량·근육 보존 목표',
  '단백질 우선 목표',
  '체중 유지 목표',
  '적극적 감량 목표',
  '열량 저감',
  '당류 저감',
  '포화지방 저감',
  '나트륨 저감',
];

const allergyGroups = [
  { title: '알·유제품', items: ['알류(가금류)', '우유'] },
  { title: '곡물·콩·견과류', items: ['메밀', '땅콩', '대두', '밀', '호두', '잣'] },
  { title: '수산물', items: ['고등어', '게', '새우', '오징어', '조개류'] },
  { title: '육류', items: ['돼지고기', '닭고기', '쇠고기'] },
  { title: '과채류', items: ['복숭아', '토마토'] },
  { title: '기타', items: ['아황산류'] },
];

const initialForm = {
  gender: '',
  birthDate: '',
  height: '',
  weight: '',
  activityLevel: '',
  dietaryGoal: '',
  allergies: [],
};

function SelectRow({ label, selected, onPress, description }) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [styles.selectRow, selected && styles.selectRowSelected, pressed && styles.pressed]}
    >
      <View style={[styles.radio, selected && styles.radioSelected]}>{selected ? <View style={styles.radioDot} /> : null}</View>
      <View style={styles.selectCopy}>
        <Text style={[styles.selectLabel, selected && styles.selectLabelSelected]}>{label}</Text>
        {description ? <Text style={styles.selectDescription}>{description}</Text> : null}
      </View>
      {selected ? <Ionicons name="checkmark" size={18} color={colors.green} /> : null}
    </Pressable>
  );
}

function ActionButton({ children, onPress, disabled = false, secondary = false }) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.actionWrap, pressed && !disabled && styles.pressed, disabled && styles.disabled]}>
      <LinearGradient
        colors={secondary ? ['#F1F7EC', '#E6F0DF'] : ['#176B46', '#2E8A52']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={[styles.actionButton, secondary && styles.actionButtonSecondary]}
      >
        <Text style={[styles.actionText, secondary && styles.actionTextSecondary]}>{children}</Text>
      </LinearGradient>
    </Pressable>
  );
}

export default function SignupOnboarding({ user, onComplete }) {
  const [step, setStep] = useState(0);
  const [form, setForm] = useState(initialForm);
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const selectedCount = useMemo(() => form.allergies.length, [form.allergies]);
  const current = steps[step];
  const lastStep = steps.length - 1;

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (step === 0) return true;
      setMessage('');
      setStep((currentStep) => Math.max(0, currentStep - 1));
      return true;
    });
    return () => subscription.remove();
  }, [step]);

  const update = (key, value) => {
    setForm((previous) => ({ ...previous, [key]: value }));
    setMessage('');
  };

  const toggleAllergy = (allergy) => {
    // Consecutive taps must compose from the latest state, not a stale render.
    setForm((previous) => ({
      ...previous,
      allergies: previous.allergies.includes(allergy)
        ? previous.allergies.filter((item) => item !== allergy)
        : [...previous.allergies, allergy],
    }));
    setMessage('');
  };

  const goNext = async () => {
    const error = stepError(step, form);
    if (error) {
      setMessage(error);
      return;
    }

    if (step < lastStep) {
      setStep((currentStep) => currentStep + 1);
      return;
    }

    setSaving(true);
    setMessage('');
    try {
      const result = await saveOnboardingProfile(user.id, {
        gender: form.gender,
        birthDate: form.birthDate.replaceAll('.', '-'),
        height: Number(form.height).toFixed(2),
        weight: Number(form.weight).toFixed(2),
        activityLevel: form.activityLevel,
        dietaryGoal: form.dietaryGoal,
        allergies: form.allergies,
      });
      onComplete(result.user);
    } catch (error) {
      setMessage(error.message || '프로필을 저장하지 못했습니다. 다시 시도해주세요.');
    } finally {
      setSaving(false);
    }
  };

  const goBack = () => {
    setMessage('');
    if (step > 0) setStep((currentStep) => currentStep - 1);
  };

  return (
    <SafeAreaView style={styles.page}>
      <StatusBar barStyle="dark-content" backgroundColor={colors.cream} />
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.select({ ios: 'padding', default: undefined })}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <LinearGradient colors={['#0D4029', '#176B46', '#2E8A52']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.hero}>
            <View style={styles.heroOrb} />
            <View style={styles.heroTop}>
              {step > 0 ? (
                <Pressable accessibilityRole="button" accessibilityLabel="이전 단계" onPress={goBack} style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}>
                  <Ionicons name="arrow-back" size={20} color="#FFFFFF" />
                </Pressable>
              ) : <View style={styles.backButtonPlaceholder} />}
              <Text style={styles.stepLabel}>{step + 1} / {steps.length}</Text>
            </View>
            <View style={styles.heroBrand}>
              <View style={styles.brandIcon}><Ionicons name="leaf" size={18} color="#D7EEB2" /></View>
              <Text style={styles.brandText}>푸디가드 프로필</Text>
            </View>
            <View style={styles.heroCopy}>
              <View style={styles.stepIcon}><Ionicons name={current.icon} size={24} color="#F5FBEE" /></View>
              <Text style={styles.heroTitle}>{current.title}</Text>
              <Text style={styles.heroDescription}>{current.copy}</Text>
            </View>
            <View style={styles.progressTrack}>
              {steps.map((item, index) => <View key={item.title} style={[styles.progressSegment, index <= step && styles.progressSegmentActive]} />)}
            </View>
          </LinearGradient>

          <View style={styles.content}>
            {step === 0 ? (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>기본 신체 정보</Text>
                <Text style={styles.sectionDescription}>입력값은 개인 영양 기준 계산과 식품 비교에만 사용합니다.</Text>

                <Text style={styles.fieldLabel}>성별</Text>
                <View style={styles.genderRow}>
                  {['남', '녀'].map((gender) => (
                    <Pressable key={gender} accessibilityRole="radio" accessibilityState={{ selected: form.gender === gender }} onPress={() => update('gender', gender)} style={({ pressed }) => [styles.genderButton, form.gender === gender && styles.genderButtonSelected, pressed && styles.pressed]}>
                      <Ionicons name={gender === '남' ? 'male-outline' : 'female-outline'} size={22} color={form.gender === gender ? colors.green : colors.muted} />
                      <Text style={[styles.genderText, form.gender === gender && styles.genderTextSelected]}>{gender}</Text>
                    </Pressable>
                  ))}
                </View>

                <Text style={styles.fieldLabel}>생년월일</Text>
                <View style={styles.inputWrap}>
                  <Ionicons name="calendar-outline" size={18} color={colors.muted} />
                  <TextInput value={form.birthDate} onChangeText={(value) => update('birthDate', formatBirthDate(value))} placeholder="2000.01.01" placeholderTextColor="#A5B0A8" keyboardType="number-pad" maxLength={10} style={styles.input} />
                </View>

                <View style={styles.metricRow}>
                  <View style={styles.metricField}>
                    <Text style={styles.fieldLabel}>키</Text>
                    <View style={styles.inputWrap}>
                      <Ionicons name="resize-outline" size={18} color={colors.muted} />
                      <TextInput value={form.height} onChangeText={(value) => update('height', value)} placeholder="175.00" placeholderTextColor="#A5B0A8" keyboardType="decimal-pad" style={styles.input} />
                      <Text style={styles.unit}>cm</Text>
                    </View>
                  </View>
                  <View style={styles.metricField}>
                    <Text style={styles.fieldLabel}>체중</Text>
                    <View style={styles.inputWrap}>
                      <Ionicons name="scale-outline" size={18} color={colors.muted} />
                      <TextInput value={form.weight} onChangeText={(value) => update('weight', value)} placeholder="65.00" placeholderTextColor="#A5B0A8" keyboardType="decimal-pad" style={styles.input} />
                      <Text style={styles.unit}>kg</Text>
                    </View>
                  </View>
                </View>
              </View>
            ) : null}

            {step === 1 ? (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>평소 활동량</Text>
                <Text style={styles.sectionDescription}>현재 생활 패턴과 가장 가까운 한 가지를 선택해주세요.</Text>
                <View style={styles.optionList}>
                  {activityOptions.map((option) => <SelectRow key={option} label={option} selected={form.activityLevel === option} onPress={() => update('activityLevel', option)} />)}
                </View>
              </View>
            ) : null}

            {step === 2 ? (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>식생활 목표</Text>
                <Text style={styles.sectionDescription}>하루 영양 기준과 탐색 우선순위에 반영됩니다.</Text>
                <View style={styles.optionList}>
                  {goalOptions.map((option) => <SelectRow key={option} label={option} selected={form.dietaryGoal === option} onPress={() => update('dietaryGoal', option)} />)}
                </View>
              </View>
            ) : null}

            {step === 3 ? (
              <View style={styles.section}>
                <View style={styles.allergyHeading}>
                  <View>
                    <Text style={styles.sectionTitle}>알레르기 정보</Text>
                    <Text style={styles.sectionDescription}>해당하는 항목을 모두 선택해주세요. 선택하지 않아도 계속할 수 있습니다.</Text>
                  </View>
                  <View style={styles.countBadge}><Text style={styles.countText}>{selectedCount}</Text></View>
                </View>
                {allergyGroups.map((group) => (
                  <View key={group.title} style={styles.allergyGroup}>
                    <Text style={styles.allergyGroupTitle}>{group.title}</Text>
                    <View style={styles.chipRow}>
                      {group.items.map((allergy) => {
                        const selected = form.allergies.includes(allergy);
                        return (
                          <Pressable key={allergy} accessibilityRole="checkbox" accessibilityState={{ checked: selected }} onPress={() => toggleAllergy(allergy)} style={({ pressed }) => [styles.chip, selected && styles.chipSelected, pressed && styles.pressed]}>
                            {selected ? <Ionicons name="checkmark" size={13} color={colors.green} /> : null}
                            <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{allergy}</Text>
                          </Pressable>
                        );
                      })}
                    </View>
                  </View>
                ))}
              </View>
            ) : null}

            {message ? <View style={styles.errorBox}><Ionicons name="alert-circle-outline" size={18} color={colors.danger} /><Text style={styles.errorText}>{message}</Text></View> : null}

            <View style={styles.footer}>
              <Text style={styles.footerHint}>{step === 3 ? '알레르기 정보는 나중에 마이 페이지에서 수정할 수 있어요.' : '입력한 정보는 다음 단계에서 이어집니다.'}</Text>
              <ActionButton onPress={goNext} disabled={saving}>
                {saving ? <ActivityIndicator size="small" color="#FFFFFF" /> : step === lastStep ? '완료' : '다음'}
              </ActionButton>
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.cream },
  flex: { flex: 1 },
  scroll: { flexGrow: 1, backgroundColor: colors.cream },
  hero: { minHeight: 252, paddingHorizontal: 20, paddingTop: 16, paddingBottom: 24, overflow: 'hidden' },
  heroOrb: { position: 'absolute', width: 230, height: 230, borderRadius: 115, right: -82, top: -72, borderWidth: 1, borderColor: 'rgba(255,255,255,0.22)', backgroundColor: 'rgba(255,255,255,0.06)' },
  heroTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  backButton: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.16)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.22)' },
  backButtonPlaceholder: { width: 38, height: 38 },
  stepLabel: { ...typeface, color: '#E4F3D8', fontSize: 12, fontWeight: '800', letterSpacing: 0.7 },
  heroBrand: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 22 },
  brandIcon: { width: 30, height: 30, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.14)' },
  brandText: { ...typeface, color: '#F4FAEF', fontSize: 13, fontWeight: '900', letterSpacing: -0.2 },
  heroCopy: { marginTop: 21, zIndex: 1 },
  stepIcon: { width: 42, height: 42, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(214,238,178,0.18)', marginBottom: 11 },
  heroTitle: { ...typeface, color: '#FFFFFF', fontSize: 28, lineHeight: 34, fontWeight: '900', letterSpacing: -1.3 },
  heroDescription: { ...typeface, color: '#C8E1C4', marginTop: 6, fontSize: 13, lineHeight: 19, fontWeight: '600', maxWidth: '84%' },
  progressTrack: { flexDirection: 'row', gap: 5, marginTop: 22 },
  progressSegment: { flex: 1, height: 5, borderRadius: 99, backgroundColor: 'rgba(255,255,255,0.22)' },
  progressSegmentActive: { backgroundColor: '#CBE69D' },
  content: { flex: 1, paddingHorizontal: 20, paddingTop: 27, paddingBottom: 36 },
  section: { flex: 1 },
  flexCopy: { flex: 1 },
  sectionTitle: { ...typeface, color: colors.ink, fontSize: 22, lineHeight: 29, fontWeight: '900', letterSpacing: -1.05 },
  sectionDescription: { ...typeface, color: colors.muted, marginTop: 7, fontSize: 13, lineHeight: 19, fontWeight: '600' },
  fieldLabel: { ...typeface, color: '#355444', marginTop: 23, marginBottom: 9, fontSize: 13, fontWeight: '800' },
  genderRow: { flexDirection: 'row', gap: 10 },
  genderButton: { flex: 1, minHeight: 64, borderWidth: 1, borderColor: colors.line, borderRadius: 17, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8, backgroundColor: colors.paper },
  genderButtonSelected: { borderColor: '#77AE74', backgroundColor: colors.mint },
  genderText: { ...typeface, color: colors.muted, fontSize: 15, fontWeight: '800' },
  genderTextSelected: { color: colors.deep },
  inputWrap: { minHeight: 52, borderWidth: 1, borderColor: colors.line, borderRadius: 16, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', gap: 9, backgroundColor: colors.paper },
  input: { ...typeface, flex: 1, color: colors.ink, paddingVertical: 13, fontSize: 15, fontWeight: '700' },
  unit: { ...typeface, color: colors.muted, fontSize: 12, fontWeight: '800' },
  metricRow: { flexDirection: 'row', gap: 10 },
  metricField: { flex: 1 },
  optionList: { gap: 10, marginTop: 22 },
  selectRow: { minHeight: 62, borderWidth: 1, borderColor: colors.line, borderRadius: 17, backgroundColor: colors.paper, paddingHorizontal: 15, paddingVertical: 13, flexDirection: 'row', alignItems: 'center', gap: 11 },
  selectRowSelected: { borderColor: '#78AE76', backgroundColor: colors.mint },
  radio: { width: 19, height: 19, borderWidth: 1.5, borderColor: '#B8C8BB', borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  radioSelected: { borderColor: colors.green, borderWidth: 5 },
  radioDot: { width: 3, height: 3, borderRadius: 2, backgroundColor: colors.green },
  selectCopy: { flex: 1 },
  selectLabel: { ...typeface, color: '#3E5648', fontSize: 14, lineHeight: 20, fontWeight: '800' },
  selectLabelSelected: { color: colors.deep },
  selectDescription: { ...typeface, color: colors.muted, marginTop: 2, fontSize: 11, lineHeight: 16, fontWeight: '600' },
  allergyHeading: { flexDirection: 'row', gap: 12, justifyContent: 'space-between' },
  countBadge: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', backgroundColor: '#EFF7E9' },
  countText: { ...typeface, color: colors.green, fontSize: 15, fontWeight: '900' },
  allergyGroup: { marginTop: 22 },
  allergyGroupTitle: { ...typeface, color: '#355444', marginBottom: 10, fontSize: 13, fontWeight: '900' },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { minHeight: 35, flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 11, borderWidth: 1, borderColor: colors.line, borderRadius: 18, backgroundColor: colors.paper },
  chipSelected: { borderColor: '#84B67F', backgroundColor: colors.mint },
  chipText: { ...typeface, color: colors.muted, fontSize: 12, fontWeight: '800' },
  chipTextSelected: { color: colors.deep },
  errorBox: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 24, padding: 13, borderRadius: 14, backgroundColor: '#FFF3F1', borderWidth: 1, borderColor: '#F5D2CD' },
  errorText: { ...typeface, flex: 1, color: colors.danger, fontSize: 12, lineHeight: 18, fontWeight: '800' },
  footer: { marginTop: 32 },
  footerHint: { ...typeface, color: colors.muted, marginBottom: 12, fontSize: 11, lineHeight: 17, fontWeight: '600', textAlign: 'center' },
  actionWrap: { borderRadius: 17, overflow: 'hidden' },
  actionButton: { minHeight: 54, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 20, borderRadius: 17 },
  actionButtonSecondary: { borderWidth: 1, borderColor: colors.line },
  actionText: { ...typeface, color: '#FFFFFF', fontSize: 15, fontWeight: '900' },
  actionTextSecondary: { color: colors.deep },
  pressed: { opacity: 0.84, transform: [{ scale: 0.985 }] },
  disabled: { opacity: 0.65 },
});
