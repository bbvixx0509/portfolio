import type {
  MaterialFormat,
  MaterialValidationErrorKind,
  MaterialValidationFailure,
  MaterialValidationResult,
  SupportedMaterialExtension,
} from "./materialTypes";
import { SUPPORTED_MATERIAL_EXTENSIONS } from "./materialTypes";

export const DOCUMENT_MAX_SIZE_BYTES = 30 * 1024 * 1024;
export const MAX_MATERIAL_FILE_NAME_LENGTH = 255;

const SIGNATURE_READ_BYTES = 8;
const GENERIC_BINARY_MIME = "application/octet-stream";
const OFFICE_ZIP_MIMES = new Set([
  "application/zip",
  "application/x-zip-compressed",
  GENERIC_BINARY_MIME,
]);

const formatByExtension: Record<SupportedMaterialExtension, MaterialFormat> = {
  ".pptx": "PPTX",
  ".pdf": "PDF",
};

const expectedMimeByFormat: Record<MaterialFormat, string> = {
  PPTX:
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  PDF: "application/pdf",
};

function failure(
  errorKind: MaterialValidationErrorKind,
  message: string,
): MaterialValidationFailure {
  return { valid: false, errorKind, message };
}

function fileNameLength(fileName: string) {
  return Array.from(fileName).length;
}

function isSupportedExtension(
  extension: string,
): extension is SupportedMaterialExtension {
  return (SUPPORTED_MATERIAL_EXTENSIONS as readonly string[]).includes(
    extension,
  );
}

function extensionFailure(extension: string | null) {
  if (extension === null) {
    return failure(
      "MISSING_EXTENSION",
      "파일 확장자를 확인해 주세요. 지원 형식은 PPTX와 PDF입니다.",
    );
  }
  if (extension === ".ppt") {
    return failure(
      "PPT_CONVERSION_REQUIRED",
      "구형 PPT 파일은 아직 지원하지 않습니다. PPTX 또는 PDF로 변환해 주세요.",
    );
  }
  return failure("UNSUPPORTED_EXTENSION", "PPTX 또는 PDF 파일만 선택해 주세요.");
}

function normalizeMimeType(mimeType: string) {
  return mimeType.trim().toLowerCase();
}

function isMimeCompatible(format: MaterialFormat, mimeType: string) {
  const normalizedMime = normalizeMimeType(mimeType);
  if (normalizedMime === "" || normalizedMime === GENERIC_BINARY_MIME) {
    return true;
  }
  if (normalizedMime === expectedMimeByFormat[format]) {
    return true;
  }
  return (
    format === "PPTX" && OFFICE_ZIP_MIMES.has(normalizedMime)
  );
}

function mimeMismatchMessage(format: MaterialFormat) {
  if (format === "PDF") {
    return "PDF 파일 형식을 확인할 수 없습니다.";
  }
  return `${format} 파일의 확장자와 형식을 확인해 주세요.`;
}

function startsWith(bytes: Uint8Array, signature: readonly number[]) {
  return (
    bytes.length >= signature.length &&
    signature.every((byte, index) => bytes[index] === byte)
  );
}

function hasExpectedSignature(format: MaterialFormat, bytes: Uint8Array) {
  switch (format) {
    case "PDF":
      return startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]);
    case "PPTX":
      return startsWith(bytes, [0x50, 0x4b]);
  }
}

function signatureMismatchMessage(format: MaterialFormat) {
  if (format === "PDF") {
    return "PDF 파일 형식을 확인할 수 없습니다.";
  }
  return `${format} 파일 형식을 확인할 수 없습니다.`;
}

export function getMaterialExtension(fileName: string): string | null {
  if (fileName.includes("/") || fileName.includes("\\")) {
    return null;
  }

  const lastDotIndex = fileName.lastIndexOf(".");
  if (lastDotIndex <= 0 || lastDotIndex === fileName.length - 1) {
    return null;
  }
  return fileName.slice(lastDotIndex).toLowerCase();
}

export function formatFileSize(sizeBytes: number) {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"] as const;
  let value = sizeBytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const roundedValue = Number(value.toFixed(1));
  return `${roundedValue} ${units[unitIndex]}`;
}

export async function validateMaterialFile(
  file: File,
): Promise<MaterialValidationResult> {
  if (fileNameLength(file.name) > MAX_MATERIAL_FILE_NAME_LENGTH) {
    return failure(
      "FILE_NAME_TOO_LONG",
      "파일 이름은 255자 이하로 사용해 주세요.",
    );
  }
  if (
    file.name.length === 0 ||
    file.name.includes("/") ||
    file.name.includes("\\")
  ) {
    return failure("INVALID_FILE_NAME", "파일 이름을 확인해 주세요.");
  }

  const extension = getMaterialExtension(file.name);
  if (!extension || !isSupportedExtension(extension)) {
    return extensionFailure(extension);
  }

  const format = formatByExtension[extension];
  if (file.size === 0) {
    return failure("EMPTY_FILE", "내용이 없는 파일은 사용할 수 없습니다.");
  }

  if (file.size > DOCUMENT_MAX_SIZE_BYTES) {
    return failure(
      "FILE_TOO_LARGE",
      "이 파일은 허용 용량을 초과했습니다.",
    );
  }

  if (!isMimeCompatible(format, file.type)) {
    return failure("MIME_MISMATCH", mimeMismatchMessage(format));
  }

  let signatureBytes: Uint8Array;
  try {
    const signatureBuffer = await file
      .slice(0, SIGNATURE_READ_BYTES)
      .arrayBuffer();
    signatureBytes = new Uint8Array(signatureBuffer);
  } catch {
    return failure(
      "READ_ERROR",
      "파일 형식을 확인하지 못했습니다. 파일을 다시 선택해 주세요.",
    );
  }

  if (!hasExpectedSignature(format, signatureBytes)) {
    return failure(
      "SIGNATURE_MISMATCH",
      signatureMismatchMessage(format),
    );
  }

  return {
    valid: true,
    metadata: {
      file,
      fileName: file.name,
      extension,
      detectedType: format,
      mimeType: file.type,
      sizeBytes: file.size,
      formattedSize: formatFileSize(file.size),
      validationStatus: "VALID",
      validationMessage: "파일 형식을 확인했습니다.",
    },
  };
}
