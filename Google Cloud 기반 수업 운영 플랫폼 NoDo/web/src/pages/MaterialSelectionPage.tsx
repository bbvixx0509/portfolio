import { CircleCheckBig, FileCheck2, LoaderCircle, ShieldCheck, Sparkles, Upload } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useEffect, useState } from "react";
import { MaterialFilePicker } from "../features/material-selection/MaterialFilePicker";
import {
  applyMaterialCourseDraft,
  createMaterialCourseDraft,
  getMaterialCourseDraft,
  loadLatestStoredMaterial,
  startMaterialExtraction,
  uploadMaterialFile,
  type MaterialCourseDraftApplyInput,
  type MaterialCourseDraftResult,
  type MaterialExtractionResult,
  type MaterialUploadResult,
} from "../features/material-selection/materialUploadApi";
import type { MaterialFileMetadata } from "../features/material-selection/materialTypes";
import { loadOwnStorageUsage, storageLabel, type StorageUsage } from "../features/material-selection/storageQuotaApi";
import { ApiError } from "../lib/api/apiClient";
import styles from "./MaterialSelectionPage.module.css";

export function MaterialSelectionPage() {
  const navigate = useNavigate();
  const [selectedFile, setSelectedFile] = useState<MaterialFileMetadata | null>(null);
  const [uploadState, setUploadState] = useState<"IDLE" | "UPLOADING" | "STORED" | "ERROR">("IDLE");
  const [storedMaterial, setStoredMaterial] = useState<MaterialUploadResult | MaterialExtractionResult | null>(null);
  const [draftState, setDraftState] = useState<"IDLE" | "GENERATING" | "GENERATED" | "ERROR">("IDLE");
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState("");
  const [draftMessage, setDraftMessage] = useState("");
  const [pendingDraft, setPendingDraft] = useState<MaterialCourseDraftResult | null>(null);
  const [storageUsage, setStorageUsage] = useState<StorageUsage | null>(null);
  useEffect(() => { void loadOwnStorageUsage().then(setStorageUsage).catch(() => setStorageUsage(null)); }, []);
  const storageWarning = storageUsageWarning(storageUsage);

  async function startUpload() {
    if (!selectedFile || uploadState === "UPLOADING") return;
    setUploadState("UPLOADING");
    setProgress(0);
    setMessage("파일을 안전하게 저장하고 있습니다.");
    try {
      const result = await uploadMaterialFile(selectedFile, setProgress);
      setStoredMaterial(result);
      setUploadState("STORED");
      setProgress(100);
      setMessage("자료를 저장했습니다. 로드맵 생성으로 수업 준비를 계속할 수 있습니다.");
    } catch (error) {
      setUploadState("ERROR");
      setMessage(uploadFailureMessage(error));
    }
  }

  function handleSelectionChange(metadata: MaterialFileMetadata | null) {
    setSelectedFile(metadata);
    setUploadState("IDLE");
    setStoredMaterial(null);
    setPendingDraft(null);
    setDraftState("IDLE");
    setProgress(0);
    setMessage("");
    setDraftMessage("");
  }

  async function loadStoredMaterial() {
    if (uploadState === "UPLOADING" || draftState === "GENERATING") return;
    setMessage("저장한 자료 정보를 확인하고 있습니다.");
    try {
      const result = await loadLatestStoredMaterial();
      setStoredMaterial(result);
      setUploadState("STORED");
      setPendingDraft(null);
      setDraftState("IDLE");
      setMessage("저장한 자료를 불러왔습니다. 자료 내용은 브라우저에 공개하지 않습니다.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "저장한 자료를 불러오지 못했습니다.");
      setUploadState("ERROR");
    }
  }

  async function createTodoList() {
    if (!storedMaterial || draftState === "GENERATING") return;
    let applyingExistingDraft = pendingDraft !== null;
    setDraftState("GENERATING");
    setDraftMessage("로드맵을 만드는 중입니다.");
    try {
      let material = storedMaterial;
      if (material.status !== "EXTRACTED") {
        const extraction = await startMaterialExtraction(material.uploadId);
        setStoredMaterial(extraction);
        material = extraction;
        if (extraction.status === "EXTRACTION_FAILED") {
          setDraftState("ERROR");
          setDraftMessage(extractionFailureMessage(extraction.failureCode));
          return;
        }
        if (extraction.status !== "EXTRACTED") {
          setDraftState("ERROR");
          setDraftMessage("자료를 읽는 중입니다. 잠시 후 로드맵 생성을 다시 시도해 주세요.");
          return;
        }
      }
      const result = pendingDraft ?? await createMaterialCourseDraft(material.uploadId);
      if (result.status === "APPLIED" && result.appliedCourseId) {
        setDraftState("GENERATED");
        navigate(`/courses/${encodeURIComponent(result.appliedCourseId)}/edit`, {
          state: selectedFile ? { materialPreview: { file: selectedFile.file, fileType: material.normalizedExtension } } : null,
        });
        return;
      }
      if (result.status === "GENERATED") {
        applyingExistingDraft = true;
        setPendingDraft(result);
        const courseId = await applyGeneratedDraft(result);
        setDraftState("GENERATED");
        navigate(`/courses/${encodeURIComponent(courseId)}/edit`, {
          state: selectedFile ? { materialPreview: { file: selectedFile.file, fileType: material.normalizedExtension } } : null,
        });
        return;
      }
      setDraftState("ERROR");
      setDraftMessage(draftFailureMessage(result.failureCode));
    } catch (error) {
      setDraftState("ERROR");
      setDraftMessage(
        applyingExistingDraft
          ? "로드맵을 정식 수업으로 준비하지 못했습니다. 다시 시도해 주세요."
          : error instanceof Error
            ? error.message
            : "AI 수업 흐름 초안을 만들지 못했습니다. 다시 시도해 주세요.",
      );
    }
  }

  async function applyGeneratedDraft(draft: MaterialCourseDraftResult): Promise<string> {
    if (draft.status === "APPLIED" && draft.appliedCourseId) {
      return draft.appliedCourseId;
    }
    const input = generatedDraftApplyInput(draft);
    try {
      const applied = await applyMaterialCourseDraft(draft.draftId, input);
      return applied.course.id;
    } catch (error) {
      // A transaction can commit before a transient HTTP failure reaches the
      // browser. Re-read only the draft state before presenting a retry.
      try {
        const latest = await getMaterialCourseDraft(draft.draftId);
        if (latest.status === "APPLIED" && latest.appliedCourseId) {
          return latest.appliedCourseId;
        }
      } catch {
        // Keep the original apply error and preserve the generated draft.
      }
      throw error;
    }
  }

  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <section className={styles.intro} aria-labelledby="material-selection-title">
          <div className={styles.iconBadge}><FileCheck2 aria-hidden="true" /></div>
          <p className={styles.eyebrow}>NODO MATERIAL · 02-13</p>
          <h1 id="material-selection-title">강의 자료 선택</h1>
          <p>PPTX 또는 PDF 한 개를 안전하게 저장하고, 서버에서 텍스트 구조만 읽어 다음 단계에 준비합니다.</p>
          <p className={styles.scopeNote}>
            <ShieldCheck aria-hidden="true" />
            자료는 NoDo 전용 비공개 저장소에서 서버만 읽습니다. 로드맵 생성 시 자료 구조 읽기와 수업 흐름 제안이 이어집니다.
          </p>
        </section>

        <section className={styles.uploadPanel} aria-label="자료 업로드">
          <MaterialFilePicker
            disabled={uploadState === "UPLOADING" || draftState === "GENERATING"}
            onSelectionChange={handleSelectionChange}
          />
          {storageUsage ? <p className={styles.storageUsage}>자료 사용량 {storageLabel(storageUsage.usedBytes)} / {storageLabel(storageUsage.limitBytes)} · 남은 용량 {storageLabel(storageUsage.remainingBytes)}</p> : null}
          {storageWarning ? <p className={styles.storageWarning} role="status">{storageWarning}</p> : null}
          <div className={styles.uploadActions}>
            <button
              type="button"
              className={styles.uploadButton}
              disabled={!selectedFile || uploadState === "UPLOADING" || uploadState === "STORED"}
              onClick={() => void startUpload()}
            >
              {uploadState === "UPLOADING" ? <LoaderCircle className={styles.spinner} aria-hidden="true" /> : uploadState === "STORED" ? <CircleCheckBig aria-hidden="true" /> : <Upload aria-hidden="true" />}
              {uploadState === "UPLOADING" ? `업로드 중 ${progress}%` : uploadState === "STORED" ? "저장 완료" : "자료 업로드"}
            </button>
            {uploadState === "ERROR" && selectedFile ? <button type="button" className={styles.retryButton} onClick={() => void startUpload()}>다시 시도</button> : null}
            {!storedMaterial ? <button type="button" className={styles.lookupButton} onClick={() => void loadStoredMaterial()}>저장한 자료 불러오기</button> : null}
          </div>
          {message ? <p className={uploadState === "ERROR" ? styles.uploadError : styles.uploadStatus} role={uploadState === "ERROR" ? "alert" : "status"}>{message}</p> : null}

          {storedMaterial ? (
            <section className={styles.extractionPanel} aria-label="로드맵 생성">
              <div className={styles.draftHeading}>
                <Sparkles aria-hidden="true" />
                <div>
                  <h2>강의 준비 로드맵</h2>
                  <p>자료 구조 읽기와 수업 흐름 제안은 서버에서 한 번에 처리합니다. 원문과 AI 입력 전문은 표시하지 않습니다.</p>
                </div>
              </div>
              <button
                type="button"
                className={styles.draftButton}
                disabled={draftState === "GENERATING"}
                onClick={() => void createTodoList()}
              >
                {draftState === "GENERATING" ? <LoaderCircle className={styles.spinner} aria-hidden="true" /> : <Sparkles aria-hidden="true" />}
                {draftState === "GENERATING" ? "로드맵을 만드는 중입니다" : draftState === "ERROR" ? "로드맵 생성 다시 시도" : "로드맵 생성"}
              </button>
              {draftMessage ? <p className={draftState === "ERROR" ? styles.uploadError : styles.uploadStatus} role={draftState === "ERROR" ? "alert" : "status"}>{draftMessage}</p> : null}
            </section>
          ) : null}
        </section>
      </main>
    </div>
  );
}

function generatedDraftApplyInput(draft: MaterialCourseDraftResult): MaterialCourseDraftApplyInput {
  if (
    draft.status !== "GENERATED"
    || draft.revision === null
    || !draft.suggestedTitle?.trim()
    || draft.chapters.length === 0
  ) {
    throw new Error("로드맵 생성 결과를 수업으로 준비하지 못했습니다. 다시 시도해 주세요.");
  }
  return {
    title: draft.suggestedTitle.trim(),
    description: draft.summary?.trim() ?? "",
    chapters: draft.chapters.map((chapter) => ({
      title: chapter.title.trim(),
      items: chapter.items.map((item) => ({
        title: item.title.trim(),
        description: item.description.trim(),
        sourcePageOrSlideNumbers: item.sourcePageOrSlideNumbers,
      })),
    })),
    expectedRevision: draft.revision,
  };
}

function extractionFailureMessage(code: string | null) {
  const guidance: Record<string, string> = {
    PDF_ENCRYPTED: "암호화된 PDF는 읽을 수 없습니다. 암호를 제거한 자료로 다시 시도해 주세요.",
    PDF_INVALID: "PDF 형식을 확인하지 못했습니다. 원본 자료를 확인해 주세요.",
    PPTX_INVALID: "PPTX 형식을 확인하지 못했습니다. 원본 자료를 확인해 주세요.",
    PAGE_LIMIT_EXCEEDED: "페이지 수가 허용 범위를 초과했습니다.",
    SLIDE_LIMIT_EXCEEDED: "슬라이드 수가 허용 범위를 초과했습니다.",
    CHARACTER_LIMIT_EXCEEDED: "추출 가능한 텍스트 양을 초과했습니다.",
  };
  return guidance[code ?? ""] ?? "자료를 읽지 못했습니다. 다시 시도해 주세요.";
}

function draftFailureMessage(code: string | null) {
  const guidance: Record<string, string> = {
    EXTRACTION_INVALID: "추출 자료를 확인하지 못했습니다. 자료 읽기 상태를 확인해 주세요.",
    MODEL_OUTPUT_INVALID: "AI 응답 형식을 확인하지 못했습니다. 다시 생성해 주세요.",
    MODEL_REFERENCE_INVALID: "AI가 참조한 페이지 또는 슬라이드 범위를 확인하지 못했습니다. 다시 생성해 주세요.",
  };
  return guidance[code ?? ""] ?? "AI 수업 흐름 초안을 만들지 못했습니다. 다시 시도해 주세요.";
}

function uploadFailureMessage(error: unknown) {
  if (!(error instanceof ApiError)) {
    return "자료를 저장하지 못했습니다. 다시 시도해 주세요.";
  }
  const record =
    error.details && typeof error.details === "object"
      ? (error.details as Record<string, unknown>)
      : null;
  if (record?.code === "storage_quota_exceeded") {
    if (record.quotaScope === "PERSONAL") return "자료 저장 공간이 가득 찼습니다. 사용하지 않는 자료를 삭제하거나 관리자에게 용량 상향을 요청해 주세요.";
    if (record.quotaScope === "SCOPE") return "이 수업에 올릴 수 있는 자료 용량을 초과했습니다. 파일 크기를 줄이거나 다른 자료를 선택해 주세요.";
    if (record.quotaScope === "ORGANIZATION") return "조직의 자료 저장 공간이 가득 찼습니다. 관리자에게 문의해 주세요.";
  }
  if (record?.code === "invalid_operation") {
    return "자료 용량 기준을 준비 중이거나 파일 상태를 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.";
  }
  if (error.status === 0 || record?.code === "UPLOAD_NETWORK_ERROR") {
    return "자료 파일 전송 연결을 확인하지 못했습니다. 네트워크 상태를 확인한 뒤 다시 시도해 주세요.";
  }
  if (error.status >= 500 || record?.code === "temporarily_unavailable") {
    return "자료 저장 서버가 일시적으로 응답하지 않습니다. 잠시 후 다시 시도해 주세요.";
  }
  return "자료를 저장하지 못했습니다. 다시 시도해 주세요.";
}

function storageUsageWarning(usage: StorageUsage | null) {
  if (!usage) return null;
  const occupiedBytes = usage.usedBytes + usage.reservedBytes;
  if (occupiedBytes >= usage.limitBytes) {
    return "자료 저장 공간이 가득 찼습니다. 사용하지 않는 자료를 삭제하거나 관리자에게 용량 상향을 요청해 주세요.";
  }
  if (occupiedBytes >= usage.limitBytes * 0.9) {
    return "저장 공간이 거의 찼습니다. 새 자료를 올리기 전에 사용량을 확인해 주세요.";
  }
  return null;
}
