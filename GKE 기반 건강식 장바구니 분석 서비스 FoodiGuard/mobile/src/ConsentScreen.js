import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Ionicons from '@expo/vector-icons/Ionicons';

import { fetchConsentDocuments, submitConsents } from './api';

const colors = {
  ink: '#173B2A',
  deep: '#176B46',
  green: '#3F8F55',
  mint: '#E9F6E8',
  cream: '#FAF7F0',
  paper: '#FFFFFF',
  line: '#E4ECE1',
  muted: '#73847A',
  danger: '#C74B45',
  notice: '#B4741F',
};

const typeface = {
  fontFamily: Platform.select({
    web: '-apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Pretendard Variable", Pretendard, Roboto, "Noto Sans KR", sans-serif',
    ios: 'Apple SD Gothic Neo',
    android: 'sans-serif',
    default: 'sans-serif',
  }),
};

// 비의료 안내는 동의가 아니라 '읽고 이해했음'을 확인받는 항목이라, 다른 동의와 색으로 구분해
// 사용자가 습관적으로 넘기지 않게 한다.
const noticeType = 'NON_MEDICAL_NOTICE';

function CheckBox({ checked, tone = 'green' }) {
  return (
    <View style={[styles.checkbox, checked && (tone === 'notice' ? styles.checkboxNotice : styles.checkboxChecked)]}>
      {checked ? <Ionicons name="checkmark" size={14} color="#FFFFFF" /> : null}
    </View>
  );
}

function DocumentBody({ document }) {
  return (
    <View style={styles.docBody}>
      {document.sections.map((section) => (
        <View key={section.heading} style={styles.docSection}>
          <Text style={styles.docHeading}>{section.heading}</Text>
          {section.body ? <Text style={styles.docText}>{section.body}</Text> : null}
          {(section.rows || []).map((row) => (
            <View key={row.label} style={styles.docRow}>
              <Text style={styles.docRowLabel}>{row.label}</Text>
              <Text style={styles.docRowValue}>{row.value}</Text>
            </View>
          ))}
          {(section.bullets || []).map((bullet) => (
            <View key={bullet} style={styles.docBullet}>
              <View style={styles.docDot} />
              <Text style={styles.docBulletText}>{bullet}</Text>
            </View>
          ))}
        </View>
      ))}
      <Text style={styles.docFooter}>{document.footer}</Text>
    </View>
  );
}

export default function ConsentScreen({ user, onComplete, onRequireLogin }) {
  const [documents, setDocuments] = useState([]);
  const [agreed, setAgreed] = useState([]);
  const [expanded, setExpanded] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [message, setMessage] = useState('');
  const [authExpired, setAuthExpired] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const payload = await fetchConsentDocuments();
      setDocuments(Array.isArray(payload.documents) ? payload.documents : []);
    } catch (error) {
      setLoadError(error.message || '동의 문서를 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const requiredTypes = useMemo(
    () => documents.filter((document) => document.required).map((document) => document.type),
    [documents],
  );
  const allAgreed = documents.length > 0 && documents.every((document) => agreed.includes(document.type));
  const requiredSatisfied = requiredTypes.every((type) => agreed.includes(type));

  const toggle = (type) => {
    setMessage('');
    // 연속으로 눌러도 최신 상태에서 이어지도록 갱신 함수를 쓴다.
    setAgreed((previous) => (previous.includes(type)
      ? previous.filter((item) => item !== type)
      : [...previous, type]));
  };

  const toggleAll = () => {
    setMessage('');
    setAgreed(allAgreed ? [] : documents.map((document) => document.type));
  };

  const toggleExpanded = (type) => {
    setExpanded((previous) => (previous.includes(type)
      ? previous.filter((item) => item !== type)
      : [...previous, type]));
  };

  const submit = async () => {
    if (!requiredSatisfied) {
      setMessage('필수 항목에 모두 동의해야 다음으로 넘어갈 수 있어요.');
      return;
    }
    setSaving(true);
    setMessage('');
    setAuthExpired(false);
    try {
      const payload = await submitConsents(
        user.id,
        documents
          .filter((document) => agreed.includes(document.type))
          .map((document) => ({ type: document.type, version: document.version })),
      );
      onComplete(payload.user);
    } catch (error) {
      if (error.status === 401) {
        setAuthExpired(true);
        setMessage('로그인 정보가 유효하지 않아요. 다시 로그인한 뒤 동의를 진행해 주세요.');
      } else {
        setMessage(error.message || '동의 내용을 저장하지 못했습니다. 다시 시도해주세요.');
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <SafeAreaView style={styles.page}>
      <StatusBar barStyle="dark-content" backgroundColor={colors.cream} />
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <LinearGradient colors={['#0D4029', '#176B46', '#2E8A52']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.hero}>
          <View style={styles.heroOrb} />
          <View style={styles.heroBrand}>
            <View style={styles.brandIcon}><Ionicons name="leaf" size={18} color="#D7EEB2" /></View>
            <Text style={styles.brandText}>푸디가드</Text>
          </View>
          <View style={styles.heroCopy}>
            <View style={styles.stepIcon}><Ionicons name="shield-checkmark-outline" size={24} color="#F5FBEE" /></View>
            <Text style={styles.heroTitle}>시작하기 전에{`\n`}확인해 주세요</Text>
            <Text style={styles.heroDescription}>
              푸디가드가 어떤 정보를 받아 어디에 쓰는지 알려 드립니다. 동의하신 내용은 기록으로 남습니다.
            </Text>
          </View>
        </LinearGradient>

        <View style={styles.content}>
          {loading ? (
            <View style={styles.loadingBox}>
              <ActivityIndicator color={colors.green} />
              <Text style={styles.loadingText}>동의 문서를 불러오고 있어요…</Text>
            </View>
          ) : null}

          {loadError ? (
            <View style={styles.errorBox}>
              <Ionicons name="alert-circle-outline" size={18} color={colors.danger} />
              <Text style={styles.errorText}>{loadError}</Text>
              <Pressable accessibilityRole="button" onPress={load} style={({ pressed }) => [styles.retry, pressed && styles.pressed]}>
                <Text style={styles.retryText}>다시 시도</Text>
              </Pressable>
            </View>
          ) : null}

          {!loading && !loadError && documents.length > 0 ? (
            <>
              {/* react-native-web 0.21 은 accessibilityState 를 DOM 으로 옮기지 않는다.
                  동의 여부를 스크린리더가 읽지 못하면 동의 화면으로서 성립하지 않으므로,
                  네이티브용 accessibilityState 와 웹용 aria-* 를 함께 준다. */}
              <Pressable
                accessibilityRole="checkbox"
                accessibilityLabel="약관 전체 동의"
                accessibilityState={{ checked: allAgreed }}
                aria-checked={allAgreed}
                onPress={toggleAll}
                style={({ pressed }) => [styles.allRow, allAgreed && styles.allRowChecked, pressed && styles.pressed]}
              >
                <CheckBox checked={allAgreed} />
                <View style={styles.flexCopy}>
                  <Text style={[styles.allLabel, allAgreed && styles.allLabelChecked]}>전체 동의하기</Text>
                  <Text style={styles.allHint}>아래 항목에 한 번에 동의합니다. 항목별로 따로 고르셔도 됩니다.</Text>
                </View>
              </Pressable>

              {documents.map((document) => {
                const checked = agreed.includes(document.type);
                const open = expanded.includes(document.type);
                const notice = document.type === noticeType;
                return (
                  <View key={document.type} style={[styles.card, checked && styles.cardChecked, notice && styles.cardNotice]}>
                    <Pressable
                      accessibilityRole="checkbox"
                      accessibilityLabel={document.checkboxLabel}
                      accessibilityState={{ checked }}
                      aria-checked={checked}
                      onPress={() => toggle(document.type)}
                      style={({ pressed }) => [styles.cardHead, pressed && styles.pressed]}
                    >
                      <CheckBox checked={checked} tone={notice ? 'notice' : 'green'} />
                      <View style={styles.flexCopy}>
                        <Text style={[styles.cardLabel, checked && styles.cardLabelChecked, notice && checked && styles.cardLabelNotice]}>
                          {document.checkboxLabel}
                        </Text>
                        <Text style={styles.cardSummary}>{document.summary}</Text>
                      </View>
                    </Pressable>

                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`${document.title} 전문 ${open ? '접기' : '보기'}`}
                      accessibilityState={{ expanded: open }}
                      aria-expanded={open}
                      onPress={() => toggleExpanded(document.type)}
                      style={({ pressed }) => [styles.moreRow, pressed && styles.pressed]}
                    >
                      <Text style={styles.moreText}>{open ? '전문 접기' : '전문 보기'}</Text>
                      <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={15} color={colors.muted} />
                    </Pressable>

                    {open ? <DocumentBody document={document} /> : null}
                  </View>
                );
              })}

              {message ? (
                <View style={styles.errorBox}>
                  <Ionicons name="alert-circle-outline" size={18} color={colors.danger} />
                  <Text style={styles.errorText}>{message}</Text>
                  {authExpired ? (
                    <Pressable accessibilityRole="button" accessibilityLabel="다시 로그인" onPress={onRequireLogin} style={styles.retry}>
                      <Text style={styles.retryText}>다시 로그인</Text>
                    </Pressable>
                  ) : null}
                </View>
              ) : null}

              <View style={styles.footer}>
                {/* 선택 항목이 없을 때 "선택 항목은 동의하지 않아도 됩니다"라고 적으면 화면에
                    없는 선택지를 안내하는 셈이 된다. 문서 구성에 맞춰 문장을 고른다. */}
                <Text style={styles.footerHint}>
                  {documents.some((document) => !document.required)
                    ? '선택 항목은 동의하지 않으셔도 모든 기능을 그대로 이용하실 수 있어요.'
                    : '모두 서비스 이용에 필요한 항목이에요. 각 항목의 전문을 확인하신 뒤 동의해 주세요.'}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ disabled: saving || !requiredSatisfied }}
                  aria-disabled={saving || !requiredSatisfied}
                  disabled={saving || !requiredSatisfied}
                  onPress={submit}
                  style={({ pressed }) => [styles.actionWrap, pressed && requiredSatisfied && styles.pressed, (!requiredSatisfied || saving) && styles.disabled]}
                >
                  <LinearGradient colors={['#176B46', '#2E8A52']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.actionButton}>
                    {saving
                      ? <ActivityIndicator size="small" color="#FFFFFF" />
                      : <Text style={styles.actionText}>동의하고 시작하기</Text>}
                  </LinearGradient>
                </Pressable>
              </View>
            </>
          ) : null}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.cream },
  scroll: { flexGrow: 1, backgroundColor: colors.cream },
  hero: { minHeight: 236, paddingHorizontal: 20, paddingTop: 22, paddingBottom: 24, overflow: 'hidden' },
  heroOrb: { position: 'absolute', width: 230, height: 230, borderRadius: 115, right: -82, top: -72, borderWidth: 1, borderColor: 'rgba(255,255,255,0.22)', backgroundColor: 'rgba(255,255,255,0.06)' },
  heroBrand: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  brandIcon: { width: 30, height: 30, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.14)' },
  brandText: { ...typeface, color: '#F4FAEF', fontSize: 13, fontWeight: '900', letterSpacing: -0.2 },
  heroCopy: { marginTop: 20, zIndex: 1 },
  stepIcon: { width: 42, height: 42, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(214,238,178,0.18)', marginBottom: 11 },
  heroTitle: { ...typeface, color: '#FFFFFF', fontSize: 26, lineHeight: 33, fontWeight: '900', letterSpacing: -1.2 },
  heroDescription: { ...typeface, color: '#C8E1C4', marginTop: 8, fontSize: 12, lineHeight: 18, fontWeight: '600', maxWidth: '92%' },
  content: { flex: 1, paddingHorizontal: 20, paddingTop: 22, paddingBottom: 36 },
  flexCopy: { flex: 1 },
  loadingBox: { alignItems: 'center', gap: 10, paddingVertical: 40 },
  loadingText: { ...typeface, color: colors.muted, fontSize: 12, fontWeight: '700' },
  allRow: { minHeight: 66, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 14, borderRadius: 18, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.paper },
  allRowChecked: { borderColor: '#78AE76', backgroundColor: colors.mint },
  allLabel: { ...typeface, color: '#3E5648', fontSize: 15, fontWeight: '900', letterSpacing: -0.3 },
  allLabelChecked: { color: colors.deep },
  allHint: { ...typeface, color: colors.muted, marginTop: 3, fontSize: 11, lineHeight: 16, fontWeight: '600' },
  card: { marginTop: 12, borderRadius: 18, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.paper, overflow: 'hidden' },
  cardChecked: { borderColor: '#9CC79A' },
  cardNotice: { borderColor: '#EBDCC0', backgroundColor: '#FFFCF5' },
  cardHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingHorizontal: 16, paddingTop: 16, paddingBottom: 12 },
  cardLabel: { ...typeface, color: '#3E5648', fontSize: 14, lineHeight: 20, fontWeight: '800', letterSpacing: -0.2 },
  cardLabelChecked: { color: colors.deep },
  cardLabelNotice: { color: '#8A5A12' },
  cardSummary: { ...typeface, color: colors.muted, marginTop: 4, fontSize: 11.5, lineHeight: 17, fontWeight: '600' },
  checkbox: { width: 22, height: 22, borderRadius: 11, borderWidth: 1.5, borderColor: '#B8C8BB', alignItems: 'center', justifyContent: 'center', backgroundColor: colors.paper },
  checkboxChecked: { borderColor: colors.green, backgroundColor: colors.green },
  checkboxNotice: { borderColor: colors.notice, backgroundColor: colors.notice },
  moreRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 4, paddingHorizontal: 16, paddingBottom: 13 },
  moreText: { ...typeface, color: colors.muted, fontSize: 12, fontWeight: '800' },
  docBody: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 18, borderTopWidth: 1, borderTopColor: '#EFF3EC', backgroundColor: '#FBFDF9' },
  docSection: { marginBottom: 16 },
  docHeading: { ...typeface, color: colors.deep, marginBottom: 7, fontSize: 12.5, fontWeight: '900', letterSpacing: -0.2 },
  docText: { ...typeface, color: '#43584A', fontSize: 12, lineHeight: 19, fontWeight: '600' },
  docRow: { flexDirection: 'row', gap: 9, marginTop: 6 },
  docRowLabel: { ...typeface, width: 74, color: colors.muted, fontSize: 11.5, lineHeight: 18, fontWeight: '800' },
  docRowValue: { ...typeface, flex: 1, color: '#43584A', fontSize: 11.5, lineHeight: 18, fontWeight: '600' },
  docBullet: { flexDirection: 'row', gap: 8, marginTop: 6, alignItems: 'flex-start' },
  docDot: { width: 3, height: 3, borderRadius: 2, marginTop: 8, backgroundColor: '#9BB3A2' },
  docBulletText: { ...typeface, flex: 1, color: '#43584A', fontSize: 11.5, lineHeight: 18, fontWeight: '600' },
  docFooter: { ...typeface, color: '#5C6F62', fontSize: 11.5, lineHeight: 18, fontWeight: '700', paddingTop: 12, borderTopWidth: 1, borderTopColor: '#EFF3EC' },
  errorBox: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 18, padding: 13, borderRadius: 14, backgroundColor: '#FFF3F1', borderWidth: 1, borderColor: '#F5D2CD' },
  errorText: { ...typeface, flex: 1, color: colors.danger, fontSize: 12, lineHeight: 18, fontWeight: '800' },
  retry: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 10, backgroundColor: '#F7DCD8' },
  retryText: { ...typeface, color: colors.danger, fontSize: 12, fontWeight: '900' },
  footer: { marginTop: 26 },
  footerHint: { ...typeface, color: colors.muted, marginBottom: 12, fontSize: 11, lineHeight: 17, fontWeight: '600', textAlign: 'center' },
  actionWrap: { borderRadius: 17, overflow: 'hidden' },
  actionButton: { minHeight: 54, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 20, borderRadius: 17 },
  actionText: { ...typeface, color: '#FFFFFF', fontSize: 15, fontWeight: '900' },
  pressed: { opacity: 0.84, transform: [{ scale: 0.985 }] },
  disabled: { opacity: 0.55 },
});
