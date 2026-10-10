import { requestApi } from "../../lib/api/apiClient";

export type StorageUsage = { usedBytes: number; reservedBytes: number; limitBytes: number; remainingBytes: number; baselineState: "READY" | "BASELINED" | "PENDING_BASELINE" };
export type InstructorStorageUsage = { memberKey: string; displayName: string; usedBytes: number; reservedBytes: number; limitBytes: number; remainingBytes: number };
function validNumber(value: unknown) { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
export function normalizeStorageUsage(value: unknown): StorageUsage {
  if (!value || typeof value !== "object") throw new Error("자료 사용량을 확인할 수 없습니다."); const item = value as Record<string, unknown>;
  if (![item.usedBytes, item.reservedBytes, item.limitBytes, item.remainingBytes].every(validNumber) || !["READY", "BASELINED", "PENDING_BASELINE"].includes(String(item.baselineState))) throw new Error("자료 사용량을 확인할 수 없습니다.");
  return item as StorageUsage;
}
export async function loadOwnStorageUsage() { return normalizeStorageUsage(await requestApi<unknown>("/api/cloud/material-storage/usage")); }
export async function loadInstructorStorageUsage() {
  const value = await requestApi<unknown>("/api/cloud/organization/storage/instructors");
  if (!value || typeof value !== "object" || !Array.isArray((value as { instructors?: unknown }).instructors)) throw new Error("강사별 자료 사용량을 확인할 수 없습니다.");
  return (value as { instructors: unknown[] }).instructors.map((item) => { if (!item || typeof item !== "object") throw new Error("강사별 자료 사용량을 확인할 수 없습니다."); const row = item as Record<string, unknown>; if (typeof row.memberKey !== "string" || typeof row.displayName !== "string" || ![row.usedBytes,row.reservedBytes,row.limitBytes,row.remainingBytes].every(validNumber)) throw new Error("강사별 자료 사용량을 확인할 수 없습니다."); return row as unknown as InstructorStorageUsage; });
}
export function normalizeInstructorStorageLimit(value: unknown) {
  if (!value || typeof value !== "object") throw new Error("강사 한도 변경 결과를 확인할 수 없습니다.");
  const item = value as Record<string, unknown>;
  if (![item.usedBytes, item.reservedBytes, item.limitBytes, item.remainingBytes].every(validNumber)) throw new Error("강사 한도 변경 결과를 확인할 수 없습니다.");
  return { usedBytes: item.usedBytes as number, reservedBytes: item.reservedBytes as number, limitBytes: item.limitBytes as number, remainingBytes: item.remainingBytes as number };
}
export async function updateInstructorStorageLimit(memberKey: string, limitBytes: number) { return normalizeInstructorStorageLimit(await requestApi<unknown>(`/api/cloud/organization/storage/instructors/${encodeURIComponent(memberKey)}`, { method: "PATCH", body: { limitBytes } })); }
export function storageLabel(bytes: number) { const gb = bytes / 1024 ** 3; return gb >= 1 ? `${gb.toFixed(gb >= 10 ? 0 : 1)}GB` : `${Math.round(bytes / 1024 ** 2)}MB`; }
