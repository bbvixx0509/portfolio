import { requestApi, uploadFileApi } from "../../lib/api/apiClient";
import type { MaterialFileMetadata } from "./materialTypes";

export type MaterialUploadResult = {
  uploadId: string;
  status: "STORED";
  normalizedExtension: "pdf" | "pptx";
  sizeBytes: number;
  createdAt: string | null;
};

export type MaterialExtractionStatus =
  | "STORED"
  | "EXTRACTION_QUEUED"
  | "EXTRACTING"
  | "EXTRACTED"
  | "EXTRACTION_FAILED";

export type MaterialExtractionResult = {
  uploadId: string;
  status: MaterialExtractionStatus;
  normalizedExtension: "pdf" | "pptx";
  pageCount: number | null;
  slideCount: number | null;
  extractedCharacterCount: number | null;
  failureCode: string | null;
};

export type MaterialCourseDraftStatus =
  | "GENERATING"
  | "GENERATED"
  | "FAILED"
  | "APPLIED"
  | "DISCARDED";

export type MaterialCourseDraftItem = {
  title: string;
  description: string;
  sourcePageOrSlideNumbers: number[];
};

export type MaterialCourseDraftChapter = {
  title: string;
  items: MaterialCourseDraftItem[];
};

export type MaterialCourseDraftResult = {
  draftId: string;
  status: MaterialCourseDraftStatus;
  suggestedTitle: string | null;
  summary: string | null;
  chapters: MaterialCourseDraftChapter[];
  modelId: string | null;
  promptVersion: string | null;
  failureCode: string | null;
  revision: number | null;
  appliedCourseId: string | null;
};

export type MaterialCourseDraftApplyItem = {
  title: string;
  description: string;
  sourcePageOrSlideNumbers: number[];
};

export type MaterialCourseDraftApplyChapter = {
  title: string;
  items: MaterialCourseDraftApplyItem[];
};

export type MaterialCourseDraftApplyInput = {
  title: string;
  description: string;
  chapters: MaterialCourseDraftApplyChapter[];
  expectedRevision: number;
};

export type MaterialCourseDraftApplyResult = {
  draft: MaterialCourseDraftResult;
  course: { id: string; title: string; status: "ACTIVE"; revision: number };
};

export function uploadMaterialFile(
  metadata: MaterialFileMetadata,
  onProgress: (progress: number) => void,
) {
  return uploadFileApi<MaterialUploadResult>(
    "/api/cloud/material-uploads",
    metadata.file,
    {
      onProgress: ({ loadedBytes, totalBytes }) => {
        onProgress(totalBytes > 0 ? Math.round((loadedBytes / totalBytes) * 100) : 0);
      },
    },
  );
}

export function loadLatestStoredMaterial() {
  return requestApi<MaterialExtractionResult>("/api/cloud/material-uploads/latest");
}

export function startMaterialExtraction(uploadId: string) {
  return requestApi<MaterialExtractionResult>(
    `/api/cloud/material-uploads/${encodeURIComponent(uploadId)}/extract`,
    { method: "POST" },
  );
}

export function getMaterialExtractionStatus(uploadId: string) {
  return requestApi<MaterialExtractionResult>(
    `/api/cloud/material-uploads/${encodeURIComponent(uploadId)}/extraction`,
  );
}

export function createMaterialCourseDraft(materialId: string) {
  return requestApi<MaterialCourseDraftResult>(
    `/api/cloud/materials/${encodeURIComponent(materialId)}/course-drafts`,
    { method: "POST" },
  );
}

export function getMaterialCourseDraft(draftId: string) {
  return requestApi<MaterialCourseDraftResult>(
    `/api/cloud/material-course-drafts/${encodeURIComponent(draftId)}`,
  );
}

export function applyMaterialCourseDraft(
  draftId: string,
  body: MaterialCourseDraftApplyInput,
) {
  return requestApi<MaterialCourseDraftApplyResult>(
    `/api/cloud/material-course-drafts/${encodeURIComponent(draftId)}/apply`,
    { method: "POST", body },
  );
}

export function discardMaterialCourseDraft(draftId: string, expectedRevision: number) {
  return requestApi<MaterialCourseDraftResult>(
    `/api/cloud/material-course-drafts/${encodeURIComponent(draftId)}/discard`,
    { method: "POST", body: { expectedRevision } },
  );
}
