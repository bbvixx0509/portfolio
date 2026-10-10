import type { User } from "firebase/auth";
import { requestApi, requestBlobApi } from "../../lib/api/apiClient";

export type CourseItem = {
  id: string;
  title: string;
  description: string;
  position: number;
  sourcePageOrSlideNumbers?: number[];
};
export type CourseChapter = { id: string; title: string; position: number; items: CourseItem[] };
export type CourseSummary = {
  id: string;
  title: string;
  description: string;
  createdByDisplayNameSnapshot: string | null;
  chapterCount: number;
  itemCount: number;
  updatedAt: string | null;
  archivedAt: string | null;
  status: "ACTIVE" | "ARCHIVED";
  isMine: boolean;
  revision: number;
  latestAccessibleRoom?: {
    roomId: string;
    status: "READY" | "LIVE" | "ENDED";
    downloadAvailableUntil?: string | null;
    endedAt?: string | null;
  };
};
export type CourseRecord = CourseSummary & { chapters: CourseChapter[] };
export type CourseDraft = { title: string; description: string; chapters: CourseChapter[] };
export type CloudCourseItemInput = {
  id: string;
  title: string;
  description: string;
  sourcePageOrSlideNumbers: number[];
};
export type CloudCourseChapterInput = {
  id: string;
  title: string;
  items: CloudCourseItemInput[];
};
export type CloudCourseInput = {
  title: string;
  description: string;
  chapters: CloudCourseChapterInput[];
};
export type CloudCourseUpdateInput = CloudCourseInput & { expectedRevision: number };
export type CourseMaterial = {
  id: string;
  filename: string;
  normalizedExtension: "pdf" | "pptx";
  sizeBytes: number;
};
export type CourseMaterialList = {
  materials: CourseMaterial[];
  unavailableMaterialCount: number;
};

function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" ? value as Record<string, unknown> : {}; }
function text(value: unknown) { return typeof value === "string" ? value : ""; }
function number(value: unknown) { return typeof value === "number" ? value : 0; }
function displayPosition(value: unknown, fallback: number) {
  return typeof value === "number" ? value : fallback;
}
function chapter(value: unknown, fallbackPosition: number): CourseChapter {
  const data=record(value); const items=Array.isArray(data.items) ? data.items : [];
  return { id:text(data.id), title:text(data.title), position:displayPosition(data.position, fallbackPosition), items:items.map((item,index)=>{const next=record(item); return {id:text(next.id),title:text(next.title),description:text(next.description),position:displayPosition(next.position, index),sourcePageOrSlideNumbers:Array.isArray(next.sourcePageOrSlideNumbers) ? next.sourcePageOrSlideNumbers.filter((value): value is number => Number.isInteger(value) && value >= 1) : []};}) };
}
function course(value: unknown): CourseRecord {
  const data=record(value); const chapters=Array.isArray(data.chapters) ? data.chapters.map(chapter) : [];
  let latestAccessibleRoom: CourseSummary["latestAccessibleRoom"];
  const rawRoom = record(data.latestAccessibleRoom);
  if (rawRoom && typeof rawRoom.roomId === "string" && (rawRoom.status === "READY" || rawRoom.status === "LIVE" || rawRoom.status === "ENDED")) {
    latestAccessibleRoom = {
      roomId: rawRoom.roomId,
      status: rawRoom.status as "READY" | "LIVE" | "ENDED",
      downloadAvailableUntil: typeof rawRoom.downloadAvailableUntil === "string" ? rawRoom.downloadAvailableUntil : null,
      endedAt: typeof rawRoom.endedAt === "string" ? rawRoom.endedAt : null,
    };
  }
  return {id:text(data.id),title:text(data.title),description:text(data.description),createdByDisplayNameSnapshot:typeof data.createdByDisplayNameSnapshot === "string" ? data.createdByDisplayNameSnapshot : null,chapterCount:number(data.chapterCount),itemCount:number(data.itemCount),updatedAt:typeof data.updatedAt === "string" ? data.updatedAt : null,archivedAt:typeof data.archivedAt === "string" ? data.archivedAt : null,status:data.status === "ARCHIVED" ? "ARCHIVED" : "ACTIVE",isMine:data.isMine===true,revision:number(data.revision),chapters,latestAccessibleRoom};
}
function courseMaterial(value: unknown): CourseMaterial | null {
  const data = record(value);
  const normalizedExtension = data.normalizedExtension;
  if (
    !text(data.id)
    || !text(data.filename)
    || (normalizedExtension !== "pdf" && normalizedExtension !== "pptx")
    || !Number.isInteger(data.sizeBytes)
    || Number(data.sizeBytes) < 1
  ) return null;
  return {
    id: text(data.id),
    filename: text(data.filename),
    normalizedExtension,
    sizeBytes: number(data.sizeBytes),
  };
}
export function toCloudCourseInput(draft: CourseDraft): CloudCourseInput {
  return {
    title: draft.title,
    description: draft.description,
    chapters: draft.chapters.map((chapter) => ({
      id: chapter.id,
      title: chapter.title,
      items: chapter.items.map((item) => ({
        id: item.id,
        title: item.title,
        description: item.description,
        sourcePageOrSlideNumbers: item.sourcePageOrSlideNumbers ?? [],
      })),
    })),
  };
}
export async function listCloudCourses(user: User | null) { const payload=record(await requestApi<unknown>("/api/cloud/courses",{authUser:user})); return (Array.isArray(payload.courses) ? payload.courses : []).map(course); }
export async function getCloudCourse(user: User | null,id:string) { return course(await requestApi<unknown>(`/api/cloud/courses/${encodeURIComponent(id)}`,{authUser:user})); }
export async function createCloudCourse(user: User | null,draft: CourseDraft, materialIds: string[] = []) { return course(await requestApi<unknown>("/api/cloud/courses",{method:"POST",body:{...toCloudCourseInput(draft), materialIds},authUser:user})); }
export async function updateCloudCourse(user: User | null,id:string,draft: CourseDraft,expectedRevision:number) { const body: CloudCourseUpdateInput = {...toCloudCourseInput(draft),expectedRevision}; return course(await requestApi<unknown>(`/api/cloud/courses/${encodeURIComponent(id)}`,{method:"PUT",body,authUser:user})); }
export async function duplicateCloudCourse(user: User | null,id:string) { return course(await requestApi<unknown>(`/api/cloud/courses/${encodeURIComponent(id)}/duplicate`,{method:"POST",authUser:user})); }
export async function archiveCloudCourse(user: User | null,id:string,expectedRevision:number) { await requestApi(`/api/cloud/courses/${encodeURIComponent(id)}/archive`,{method:"POST",body:{expectedRevision},authUser:user}); }
export async function listCloudCourseMaterials(user: User | null, courseId: string) {
  const payload = record(await requestApi<unknown>(`/api/cloud/courses/${encodeURIComponent(courseId)}/materials`, { authUser: user }));
  return {
    materials: (Array.isArray(payload.materials) ? payload.materials : [])
      .map(courseMaterial)
      .filter((material): material is CourseMaterial => material !== null),
    unavailableMaterialCount: Number.isInteger(payload.unavailableMaterialCount) && Number(payload.unavailableMaterialCount) > 0
      ? Number(payload.unavailableMaterialCount)
      : 0,
  } satisfies CourseMaterialList;
}
export async function attachCloudCourseMaterial(user: User | null, courseId: string, materialId: string) {
  const payload = record(await requestApi<unknown>(`/api/cloud/courses/${encodeURIComponent(courseId)}/materials`, { method: "POST", body: { materialId }, authUser: user }));
  return (Array.isArray(payload.materials) ? payload.materials : [])
    .map(courseMaterial)
    .filter((material): material is CourseMaterial => material !== null);
}
export async function detachCloudCourseMaterial(user: User | null, courseId: string, materialId: string) {
  const payload = record(await requestApi<unknown>(`/api/cloud/courses/${encodeURIComponent(courseId)}/materials/${encodeURIComponent(materialId)}`, { method: "DELETE", authUser: user }));
  return (Array.isArray(payload.materials) ? payload.materials : [])
    .map(courseMaterial)
    .filter((material): material is CourseMaterial => material !== null);
}
export function loadCloudCourseMaterialContent(user: User | null, courseId: string, materialId: string) {
  return requestBlobApi(`/api/cloud/courses/${encodeURIComponent(courseId)}/materials/${encodeURIComponent(materialId)}/content`, { authUser: user });
}
