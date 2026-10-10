import type { User } from "firebase/auth";
import { requestApi, requestBlobApi } from "../../lib/api/apiClient";

export type RoomMaterial = {
  displayTitle: string;
  fileType: "pdf" | "pptx";
  totalUnits: number;
  currentUnitNumber: number;
  materialRevision: number;
  canControl: boolean;
};

export type RoomMaterialAccess = {
  material: (RoomMaterial & {
    canManageDownloadPolicy: boolean;
    canViewDownloadPolicy: boolean;
    downloadPolicyLocked: boolean;
    downloadAllowed: boolean;
    downloadEnabled: boolean;
    downloadAvailableFrom: string | null;
    downloadAvailableUntil: string | null;
    downloadPolicyRevision: number;
  }) | null;
};

export type PptxUnitContent = {
  unitNumber: number;
  title: string | null;
  text: string;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function materialResponse(value: unknown): RoomMaterial | null {
  const material = record(record(value).material);
  if (Object.keys(material).length === 0) return null;
  const fileType = material.fileType;
  const totalUnits = material.totalUnits;
  const currentUnitNumber = material.currentUnitNumber;
  const materialRevision = material.materialRevision;
  if (
    typeof material.displayTitle !== "string" || !material.displayTitle.trim()
    || (fileType !== "pdf" && fileType !== "pptx")
    || typeof totalUnits !== "number" || !Number.isInteger(totalUnits) || totalUnits < 1
    || typeof currentUnitNumber !== "number" || !Number.isInteger(currentUnitNumber) || currentUnitNumber < 1 || currentUnitNumber > totalUnits
    || typeof materialRevision !== "number" || !Number.isInteger(materialRevision) || materialRevision < 1
  ) throw new Error("강의 자료 상태를 확인하지 못했습니다.");
  return {
    displayTitle: material.displayTitle,
    fileType,
    totalUnits,
    currentUnitNumber,
    materialRevision,
    canControl: material.canControl === true,
  };
}

function pptxContent(value: unknown): PptxUnitContent {
  const data = record(value);
  if (!Number.isInteger(data.unitNumber) || (typeof data.title !== "string" && data.title !== null) || typeof data.text !== "string") {
    throw new Error("슬라이드 내용을 확인하지 못했습니다.");
  }
  return { unitNumber: data.unitNumber as number, title: data.title as string | null, text: data.text as string };
}

function staffPath(roomId: string) {
  return `/api/cloud/rooms/${encodeURIComponent(roomId)}/material`;
}

function publicPath(orgId: string, roomCode: string) {
  return `/api/public/rooms/${encodeURIComponent(orgId)}/${encodeURIComponent(roomCode)}/material`;
}

export async function getCloudRoomMaterial(user: User | null, roomId: string) {
  return materialResponse(await requestApi<unknown>(staffPath(roomId), { authUser: user, cache: "no-store" }));
}

export async function getStudentRoomMaterial(user: User | null, orgId: string, roomCode: string) {
  return materialResponse(await requestApi<unknown>(publicPath(orgId, roomCode), { authUser: user, cache: "no-store" }));
}

export async function updateCloudRoomMaterialPosition(
  user: User | null,
  roomId: string,
  unitNumber: number,
  expectedMaterialRevision: number,
) {
  return materialResponse(await requestApi<unknown>(
    `/api/cloud/rooms/${encodeURIComponent(roomId)}/material-position`,
    { method: "PATCH", body: { unitNumber, expectedMaterialRevision }, authUser: user },
  ));
}

export async function getCloudRoomPdf(user: User | null, roomId: string) {
  return requestBlobApi(`${staffPath(roomId)}/content`, { authUser: user });
}

export async function getStudentRoomPdf(user: User | null, orgId: string, roomCode: string) {
  return requestBlobApi(`${publicPath(orgId, roomCode)}/content`, { authUser: user });
}

export async function getCloudRoomPptxUnit(user: User | null, roomId: string) {
  return pptxContent(await requestApi<unknown>(`${staffPath(roomId)}/content`, { authUser: user, cache: "no-store" }));
}

export async function getStudentRoomPptxUnit(user: User | null, orgId: string, roomCode: string) {
  return pptxContent(await requestApi<unknown>(`${publicPath(orgId, roomCode)}/content`, { authUser: user, cache: "no-store" }));
}

export function getCloudRoomMaterialAccess(user: User | null, roomId: string) {
  return requestApi<RoomMaterialAccess>(`${staffPath(roomId)}-access`, { authUser: user, cache: "no-store" });
}

export function getStudentRoomMaterialAccess(user: User | null, orgId: string, roomCode: string) {
  return requestApi<RoomMaterialAccess>(`${publicPath(orgId, roomCode)}-access`, { authUser: user, cache: "no-store" });
}

export function updateCloudRoomMaterialDownloadPolicy(user: User | null, roomId: string, body: { downloadEnabled: boolean; downloadAvailableUntil: string | null; expectedDownloadPolicyRevision: number }) {
  return requestApi<RoomMaterialAccess>(`/api/cloud/rooms/${encodeURIComponent(roomId)}/material-download-policy`, { method: "PATCH", body, authUser: user });
}

export function downloadCloudRoomMaterial(user: User | null, roomId: string) {
  return requestBlobApi(`${staffPath(roomId)}/download`, { authUser: user });
}

export function downloadStudentRoomMaterial(user: User | null, orgId: string, roomCode: string) {
  return requestBlobApi(`${publicPath(orgId, roomCode)}/download`, { authUser: user });
}
