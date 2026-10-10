export const MATERIAL_FORMAT_LABELS = [
  "PPTX",
  "PDF",
] as const;

export const SUPPORTED_MATERIAL_EXTENSIONS = [
  ".pptx",
  ".pdf",
] as const;

export const MATERIAL_FILE_ACCEPT = SUPPORTED_MATERIAL_EXTENSIONS.join(",");

export type MaterialFormat = (typeof MATERIAL_FORMAT_LABELS)[number];

export type SupportedMaterialExtension =
  (typeof SUPPORTED_MATERIAL_EXTENSIONS)[number];

export type MaterialValidationStatus =
  | "IDLE"
  | "VALIDATING"
  | "VALID"
  | "INVALID";

export type MaterialValidationErrorKind =
  | "EMPTY_FILE"
  | "FILE_TOO_LARGE"
  | "FILE_NAME_TOO_LONG"
  | "INVALID_FILE_NAME"
  | "MISSING_EXTENSION"
  | "UNSUPPORTED_EXTENSION"
  | "PPT_CONVERSION_REQUIRED"
  | "MIME_MISMATCH"
  | "SIGNATURE_MISMATCH"
  | "READ_ERROR";

export type MaterialFileMetadata = {
  file: File;
  fileName: string;
  extension: SupportedMaterialExtension;
  detectedType: MaterialFormat;
  mimeType: string;
  sizeBytes: number;
  formattedSize: string;
  validationStatus: "VALID";
  validationMessage: string;
};

export type MaterialValidationSuccess = {
  valid: true;
  metadata: MaterialFileMetadata;
};

export type MaterialValidationFailure = {
  valid: false;
  errorKind: MaterialValidationErrorKind;
  message: string;
};

export type MaterialValidationResult =
  | MaterialValidationSuccess
  | MaterialValidationFailure;
