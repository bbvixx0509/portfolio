import { ChevronLeft } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError } from "../lib/api/apiClient";
import { useAuth } from "../features/auth/AuthContext";
import { loadInstructorStorageUsage, storageLabel, updateInstructorStorageLimit, type InstructorStorageUsage } from "../features/material-selection/storageQuotaApi";
import styles from "./OrganizationStoragePage.module.css";

const GIB = 1024 ** 3;
function saveMessage(error: unknown) {
  if (error instanceof ApiError) {
    if (error.status === 401) return "로그인 상태를 다시 확인해 주세요.";
    if (error.status === 403) return "한도 변경은 관리자만 할 수 있습니다.";
    if (error.status === 404) return "해당 강사를 찾을 수 없습니다. 목록을 새로고침해 주세요.";
    if (error.status === 409) return "현재 사용량보다 낮은 한도로 변경할 수 없습니다.";
    if (error.status === 422) return "한도는 1GB부터 100GB 사이의 정수로 입력해 주세요.";
  }
  return "한도 변경을 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.";
}

export function OrganizationStoragePage() {
  const { profile } = useAuth();
  const [items, setItems] = useState<InstructorStorageUsage[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => { try { setError(null); const next = await loadInstructorStorageUsage(); setItems(next); setDrafts((current) => Object.fromEntries(next.map((item) => [item.memberKey, current[item.memberKey] ?? String(item.limitBytes / GIB)]))); } catch { setError("자료 용량 정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요."); } }, []);
  useEffect(() => { void load(); }, [load]);
  async function save(item: InstructorStorageUsage) { const gb = Number(drafts[item.memberKey]); if (!Number.isInteger(gb) || gb < 1 || gb > 100 || gb * GIB === item.limitBytes || busy) return; setBusy(item.memberKey); setError(null); try { const next = await updateInstructorStorageLimit(item.memberKey, gb * GIB); setItems((current) => current.map((row) => row.memberKey === item.memberKey ? { ...row, ...next } : row)); setDrafts((current) => ({ ...current, [item.memberKey]: String(gb) })); } catch (cause) { setError(saveMessage(cause)); } finally { setBusy(null); } }
  if (profile?.organizationRole !== "ADMIN") return <main className={styles.page}><p>조직 관리 권한이 없습니다.</p></main>;
  return <main className={styles.page}><div className={styles.backRow}><Link to="/organization/members"><ChevronLeft aria-hidden="true" />구성원 관리로</Link></div><h1>자료 용량 관리</h1><p>강사별 사용량, 현재 한도, 남은 용량만 표시합니다.</p>{error ? <section className={styles.errorState} role="alert"><p>{error}</p><button type="button" onClick={() => void load()}>다시 시도</button></section> : null}<ul>{items.map((item) => { const draft = drafts[item.memberKey] ?? String(item.limitBytes / GIB); const gb = Number(draft); const valid = Number.isInteger(gb) && gb >= 1 && gb <= 100; return <li key={item.memberKey}><strong>{item.displayName}</strong><span>사용량 {storageLabel(item.usedBytes)}</span><span>현재 한도 {storageLabel(item.limitBytes)} · 남은 {storageLabel(item.remainingBytes)}</span><div>{[10, 20, 50].map((value) => <button key={value} type="button" onClick={() => setDrafts((current) => ({ ...current, [item.memberKey]: String(value) }))} disabled={busy === item.memberKey}>{value}GB</button>)}<input aria-label={`${item.displayName} 직접 한도`} type="number" min="1" max="100" step="1" value={draft} onChange={(event) => setDrafts((current) => ({ ...current, [item.memberKey]: event.target.value }))} />GB<button type="button" onClick={() => void save(item)} disabled={!valid || gb * GIB === item.limitBytes || busy === item.memberKey}>{busy === item.memberKey ? "저장 중..." : "저장"}</button></div></li>; })}</ul></main>;
}
