import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MaterialFileMetadata } from "../features/material-selection/materialTypes";
import { ApiError } from "../lib/api/apiClient";
import { MaterialSelectionPage } from "./MaterialSelectionPage";

const storageQuotaMocks = vi.hoisted(() => ({
  loadOwnStorageUsage: vi.fn(),
}));

vi.mock("../features/material-selection/storageQuotaApi", () => ({
  loadOwnStorageUsage: storageQuotaMocks.loadOwnStorageUsage,
  storageLabel: (bytes: number) => `${bytes / 1024 ** 3}GB`,
}));

const {
  applyMaterialCourseDraftMock,
  createMaterialCourseDraftMock,
  getMaterialCourseDraftMock,
  loadLatestStoredMaterialMock,
  startMaterialExtractionMock,
  uploadMaterialFileMock,
} = vi.hoisted(() => ({
  applyMaterialCourseDraftMock: vi.fn(),
  createMaterialCourseDraftMock: vi.fn(),
  getMaterialCourseDraftMock: vi.fn(),
  loadLatestStoredMaterialMock: vi.fn(),
  startMaterialExtractionMock: vi.fn(),
  uploadMaterialFileMock: vi.fn(),
}));

const uploadResult = { uploadId: "upload-1", status: "STORED" as const, normalizedExtension: "pdf" as const, sizeBytes: 8, createdAt: null };
const metadata: MaterialFileMetadata = {
  file: new File(["%PDF-1.7"], "lesson.pdf", { type: "application/pdf" }),
  fileName: "lesson.pdf", extension: ".pdf", detectedType: "PDF", mimeType: "application/pdf", sizeBytes: 8, formattedSize: "8 B", validationStatus: "VALID", validationMessage: "파일 형식을 확인했습니다.",
};
const generatedDraft = { draftId: "draft-1", status: "GENERATED" as const, suggestedTitle: "AI 제안 수업", summary: "요약", chapters: [{ title: "첫 챕터", items: [{ title: "첫 항목", description: "설명", sourcePageOrSlideNumbers: [1] }] }], modelId: null, promptVersion: null, failureCode: null, revision: 2, appliedCourseId: null };

vi.mock("../features/material-selection/MaterialFilePicker", () => ({
  MaterialFilePicker: ({ disabled, onSelectionChange }: { disabled?: boolean; onSelectionChange?: (value: MaterialFileMetadata | null) => void }) => <button type="button" disabled={disabled} onClick={() => onSelectionChange?.(metadata)}>테스트 파일 선택</button>,
}));
vi.mock("../features/material-selection/materialUploadApi", () => ({
  applyMaterialCourseDraft: applyMaterialCourseDraftMock,
  createMaterialCourseDraft: createMaterialCourseDraftMock,
  getMaterialCourseDraft: getMaterialCourseDraftMock,
  loadLatestStoredMaterial: loadLatestStoredMaterialMock,
  startMaterialExtraction: startMaterialExtractionMock,
  uploadMaterialFile: uploadMaterialFileMock,
}));

function Destination() {
  const location = useLocation();
  return <p data-testid="location">{location.pathname}</p>;
}

function renderPage() {
  return render(<MemoryRouter initialEntries={["/create/material"]}><Routes><Route path="/create/material" element={<MaterialSelectionPage />} /><Route path="/courses/:courseId/edit" element={<Destination />} /></Routes></MemoryRouter>);
}

describe("MaterialSelectionPage", () => {
  beforeEach(() => {
    uploadMaterialFileMock.mockReset();
    applyMaterialCourseDraftMock.mockReset();
    createMaterialCourseDraftMock.mockReset();
    getMaterialCourseDraftMock.mockReset();
    loadLatestStoredMaterialMock.mockReset();
    startMaterialExtractionMock.mockReset();
    storageQuotaMocks.loadOwnStorageUsage.mockReset().mockResolvedValue({ usedBytes: 0, reservedBytes: 0, limitBytes: 5 * 1024 ** 3, remainingBytes: 5 * 1024 ** 3, baselineState: "READY" });
  });

  it("자료 읽기 시작 단계 없이 로드맵 생성을 안내한다", async () => {
    uploadMaterialFileMock.mockResolvedValueOnce(uploadResult);
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "테스트 파일 선택" }));
    fireEvent.click(screen.getByRole("button", { name: "자료 업로드" }));
    expect(await screen.findByRole("button", { name: "로드맵 생성" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /자료 읽기 시작/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /AI 수업 흐름 초안 생성/ })).not.toBeInTheDocument();
  });

  it("자료 업로드는 업로드만 하고 이동하거나 로드맵을 만들지 않는다", async () => {
    uploadMaterialFileMock.mockResolvedValueOnce(uploadResult);
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "테스트 파일 선택" }));
    fireEvent.click(screen.getByRole("button", { name: "자료 업로드" }));

    expect(await screen.findByRole("button", { name: "로드맵 생성" })).toBeInTheDocument();
    expect(createMaterialCourseDraftMock).not.toHaveBeenCalled();
    expect(applyMaterialCourseDraftMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId("location")).not.toBeInTheDocument();
  });

  it("로드맵 생성 후 apply를 거쳐 course 편집 경로로 이동한다", async () => {
    uploadMaterialFileMock.mockResolvedValueOnce(uploadResult);
    startMaterialExtractionMock.mockResolvedValueOnce({ uploadId: "upload-1", status: "EXTRACTED", normalizedExtension: "pdf", pageCount: 3, slideCount: null, extractedCharacterCount: 120, failureCode: null });
    createMaterialCourseDraftMock.mockResolvedValueOnce(generatedDraft);
    applyMaterialCourseDraftMock.mockResolvedValueOnce({
      draft: { ...generatedDraft, status: "APPLIED", appliedCourseId: "course-1" },
      course: { id: "course-1", title: "AI 제안 수업", status: "ACTIVE", revision: 1 },
    });
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "테스트 파일 선택" }));
    fireEvent.click(screen.getByRole("button", { name: "자료 업로드" }));
    fireEvent.click(await screen.findByRole("button", { name: "로드맵 생성" }));
    await waitFor(() => expect(startMaterialExtractionMock).toHaveBeenCalledWith("upload-1"));
    await waitFor(() => expect(createMaterialCourseDraftMock).toHaveBeenCalledWith("upload-1"));
    expect(applyMaterialCourseDraftMock).toHaveBeenCalledWith("draft-1", expect.objectContaining({ expectedRevision: 2 }));
    expect(await screen.findByTestId("location")).toHaveTextContent("/courses/course-1/edit");
    expect(screen.queryByText(/material-course-drafts/)).not.toBeInTheDocument();
  });

  it("apply 실패 뒤에는 같은 draft만 다시 적용하고 AI 생성을 반복하지 않는다", async () => {
    loadLatestStoredMaterialMock.mockResolvedValueOnce({ uploadId: "upload-1", status: "EXTRACTED", normalizedExtension: "pdf", pageCount: 3, slideCount: null, extractedCharacterCount: 120, failureCode: null });
    createMaterialCourseDraftMock.mockResolvedValueOnce(generatedDraft);
    applyMaterialCourseDraftMock
      .mockRejectedValueOnce(new Error("apply failed"))
      .mockResolvedValueOnce({
        draft: { ...generatedDraft, status: "APPLIED", appliedCourseId: "course-1" },
        course: { id: "course-1", title: "AI 제안 수업", status: "ACTIVE", revision: 1 },
      });
    getMaterialCourseDraftMock.mockResolvedValueOnce(generatedDraft);
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "저장한 자료 불러오기" }));
    fireEvent.click(await screen.findByRole("button", { name: "로드맵 생성" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("로드맵을 정식 수업으로 준비하지 못했습니다.");
    fireEvent.click(screen.getByRole("button", { name: "로드맵 생성 다시 시도" }));

    expect(await screen.findByTestId("location")).toHaveTextContent("/courses/course-1/edit");
    expect(createMaterialCourseDraftMock).toHaveBeenCalledTimes(1);
    expect(applyMaterialCourseDraftMock).toHaveBeenCalledTimes(2);
  });

  it("이미 적용된 draft는 기존 courseId로 바로 이동한다", async () => {
    loadLatestStoredMaterialMock.mockResolvedValueOnce({ uploadId: "upload-1", status: "EXTRACTED", normalizedExtension: "pdf", pageCount: 3, slideCount: null, extractedCharacterCount: 120, failureCode: null });
    createMaterialCourseDraftMock.mockResolvedValueOnce({ ...generatedDraft, status: "APPLIED", appliedCourseId: "course-1" });
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "저장한 자료 불러오기" }));
    fireEvent.click(await screen.findByRole("button", { name: "로드맵 생성" }));

    expect(await screen.findByTestId("location")).toHaveTextContent("/courses/course-1/edit");
    expect(applyMaterialCourseDraftMock).not.toHaveBeenCalled();
  });

  it("추출 실패는 안전한 안내와 동일한 로드맵 생성 재시도를 제공한다", async () => {
    loadLatestStoredMaterialMock.mockResolvedValueOnce({ uploadId: "upload-1", status: "STORED", normalizedExtension: "pptx", pageCount: null, slideCount: null, extractedCharacterCount: null, failureCode: null });
    startMaterialExtractionMock.mockResolvedValueOnce({ uploadId: "upload-1", status: "EXTRACTION_FAILED", normalizedExtension: "pptx", pageCount: null, slideCount: null, extractedCharacterCount: null, failureCode: "PPTX_INVALID" });
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "저장한 자료 불러오기" }));
    fireEvent.click(await screen.findByRole("button", { name: "로드맵 생성" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("PPTX 형식을 확인하지 못했습니다.");
    expect(screen.getByRole("button", { name: "로드맵 생성 다시 시도" })).toBeEnabled();
  });

  it("초안 생성 실패는 원문 없이 안전한 재시도 상태를 표시한다", async () => {
    loadLatestStoredMaterialMock.mockResolvedValueOnce({ uploadId: "upload-1", status: "EXTRACTED", normalizedExtension: "pdf", pageCount: 3, slideCount: null, extractedCharacterCount: 120, failureCode: null });
    createMaterialCourseDraftMock.mockResolvedValueOnce({ ...generatedDraft, status: "FAILED", failureCode: "MODEL_OUTPUT_INVALID" });
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "저장한 자료 불러오기" }));
    fireEvent.click(await screen.findByRole("button", { name: "로드맵 생성" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("AI 응답 형식을 확인하지 못했습니다.");
    expect(screen.getByRole("button", { name: "로드맵 생성 다시 시도" })).toBeEnabled();
    expect(screen.queryByText("추출 원문")).not.toBeInTheDocument();
  });

  it("수업 용량 초과를 안전한 안내로 표시한다", async () => {
    uploadMaterialFileMock.mockRejectedValueOnce(
      new ApiError("internal", 409, {
        code: "storage_quota_exceeded",
        quotaScope: "SCOPE",
      }),
    );
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "테스트 파일 선택" }));
    fireEvent.click(screen.getByRole("button", { name: "자료 업로드" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "이 수업에 올릴 수 있는 자료 용량을 초과했습니다.",
    );
  });

  it("개인 사용량이 90% 이상이면 경고만 표시한다", async () => {
    storageQuotaMocks.loadOwnStorageUsage.mockResolvedValueOnce({ usedBytes: 4.5 * 1024 ** 3, reservedBytes: 0, limitBytes: 5 * 1024 ** 3, remainingBytes: 0.5 * 1024 ** 3, baselineState: "READY" });
    renderPage();
    expect(await screen.findByRole("status")).toHaveTextContent("저장 공간이 거의 찼습니다.");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("개인 한도 초과는 선택 파일을 유지한 채 재시도할 수 있다", async () => {
    uploadMaterialFileMock
      .mockRejectedValueOnce(new ApiError("internal", 409, { code: "storage_quota_exceeded", quotaScope: "PERSONAL" }))
      .mockResolvedValueOnce(uploadResult);
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "테스트 파일 선택" }));
    fireEvent.click(screen.getByRole("button", { name: "자료 업로드" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("자료 저장 공간이 가득 찼습니다.");
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    await waitFor(() => expect(uploadMaterialFileMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("button", { name: "저장 완료" })).toBeInTheDocument();
  });

  it("조직 한도 초과는 안전한 문구만 표시한다", async () => {
    uploadMaterialFileMock.mockRejectedValueOnce(
      new ApiError("internal", 409, { code: "storage_quota_exceeded", quotaScope: "ORGANIZATION", uid: "hidden", email: "hidden@example.test" }),
    );
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "테스트 파일 선택" }));
    fireEvent.click(screen.getByRole("button", { name: "자료 업로드" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("조직의 자료 저장 공간이 가득 찼습니다.");
    expect(screen.queryByText("hidden@example.test")).not.toBeInTheDocument();
    expect(screen.queryByText("hidden")).not.toBeInTheDocument();
  });

  it("업로드 네트워크 오류를 내부 정보 없이 안내한다", async () => {
    uploadMaterialFileMock.mockRejectedValueOnce(
      new ApiError("internal", 0, { code: "UPLOAD_NETWORK_ERROR" }),
    );
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "테스트 파일 선택" }));
    fireEvent.click(screen.getByRole("button", { name: "자료 업로드" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "자료 파일 전송 연결을 확인하지 못했습니다.",
    );
  });

  it("업로드 서버 오류는 네트워크 오류와 구분해 안전하게 안내한다", async () => {
    uploadMaterialFileMock.mockRejectedValueOnce(
      new ApiError("internal", 500, { code: "temporarily_unavailable" }),
    );
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "테스트 파일 선택" }));
    fireEvent.click(screen.getByRole("button", { name: "자료 업로드" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "자료 저장 서버가 일시적으로 응답하지 않습니다.",
    );
  });
});
