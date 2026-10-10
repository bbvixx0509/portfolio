import { describe, expect, it, vi } from "vitest";
import {
  DOCUMENT_MAX_SIZE_BYTES,
  MAX_MATERIAL_FILE_NAME_LENGTH,
  formatFileSize,
  getMaterialExtension,
  validateMaterialFile,
} from "./materialValidation";

const pdfSignature = [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37];
const zipSignature = [0x50, 0x4b, 0x03, 0x04];

function makeFile(bytes: readonly number[], name: string, type = "") {
  return new File([Uint8Array.from(bytes)], name, { type });
}

async function expectFailure(file: File, errorKind: string) {
  const result = await validateMaterialFile(file);
  expect(result.valid).toBe(false);
  if (!result.valid) expect(result.errorKind).toBe(errorKind);
}

describe("NoDo 자료 선택 사전 검사", () => {
  it("PPTX와 PDF만 허용한다", async () => {
    expect((await validateMaterialFile(makeFile(pdfSignature, "lesson.pdf", "application/pdf"))).valid).toBe(true);
    expect((await validateMaterialFile(makeFile(zipSignature, "lesson.pptx", "application/zip"))).valid).toBe(true);
    await expectFailure(makeFile(pdfSignature, "lesson.docx"), "UNSUPPORTED_EXTENSION");
    await expectFailure(makeFile(pdfSignature, "lesson.png"), "UNSUPPORTED_EXTENSION");
  });

  it("빈 파일, 30MB 초과, 긴 파일명과 경로 파일명을 차단한다", async () => {
    await expectFailure(makeFile([], "empty.pdf"), "EMPTY_FILE");
    const large = makeFile(pdfSignature, "large.pdf");
    Object.defineProperty(large, "size", { value: DOCUMENT_MAX_SIZE_BYTES + 1 });
    await expectFailure(large, "FILE_TOO_LARGE");
    await expectFailure(makeFile(pdfSignature, `x${"a".repeat(MAX_MATERIAL_FILE_NAME_LENGTH)}.pdf`), "FILE_NAME_TOO_LONG");
    await expectFailure(makeFile(pdfSignature, "folder/lesson.pdf"), "INVALID_FILE_NAME");
  });

  it("PDF와 PPTX의 기본 시그니처를 확인하고 MIME은 힌트로만 사용한다", async () => {
    await expectFailure(makeFile([0x00, 0x01], "bad.pdf", "application/pdf"), "SIGNATURE_MISMATCH");
    await expectFailure(makeFile([0x00, 0x01], "bad.pptx", "application/zip"), "SIGNATURE_MISMATCH");
    await expectFailure(makeFile(pdfSignature, "spoof.pdf", "image/jpeg"), "MIME_MISMATCH");
    expect((await validateMaterialFile(makeFile(pdfSignature, "binary.pdf", "application/octet-stream"))).valid).toBe(true);
  });

  it("파일 전체가 아니라 시작 바이트만 브라우저에서 읽는다", async () => {
    const file = makeFile([...pdfSignature, ...new Array(128).fill(0x41)], "small-read.pdf", "application/pdf");
    const sliceSpy = vi.spyOn(file, "slice");
    expect((await validateMaterialFile(file)).valid).toBe(true);
    expect(sliceSpy).toHaveBeenCalledWith(0, 8);
  });

  it("확장자와 파일 크기 표시는 안정적으로 처리한다", () => {
    expect(getMaterialExtension("LESSON.PDF")).toBe(".pdf");
    expect(formatFileSize(30 * 1024 * 1024)).toBe("30 MB");
  });
});
