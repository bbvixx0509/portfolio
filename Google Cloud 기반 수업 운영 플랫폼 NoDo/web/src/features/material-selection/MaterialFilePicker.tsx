import {
  CircleCheckBig,
  FileText,
  FileUp,
  LoaderCircle,
  Presentation,
  TriangleAlert,
  X,
} from "lucide-react";
import {
  type ChangeEvent,
  type DragEvent,
  type KeyboardEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import {
  MATERIAL_FILE_ACCEPT,
  MATERIAL_FORMAT_LABELS,
  type MaterialFileMetadata,
  type MaterialFormat,
  type MaterialValidationStatus,
} from "./materialTypes";
import { validateMaterialFile } from "./materialValidation";
import styles from "./MaterialFilePicker.module.css";

export type MaterialFilePickerProps = {
  initialFile?: MaterialFileMetadata | null;
  onSelectionChange?: (metadata: MaterialFileMetadata | null) => void;
  disabled?: boolean;
  selectLabel?: string;
};

type DroppedEntry = {
  isDirectory?: boolean;
};

type EntryAwareDataTransferItem = DataTransferItem & {
  webkitGetAsEntry?: () => DroppedEntry | null;
};

const MULTIPLE_FILES_MESSAGE = "한 번에 파일 하나만 선택할 수 있습니다.";
const FOLDER_MESSAGE = "폴더는 선택할 수 없습니다. 파일 하나를 선택해 주세요.";
const UNEXPECTED_ERROR_MESSAGE =
  "파일 형식을 확인하지 못했습니다. 파일을 다시 선택해 주세요.";

function MaterialTypeIcon({ format }: { format: MaterialFormat }) {
  const iconProps = {
    "aria-label": `${format} 파일`,
    role: "img",
  } as const;

  switch (format) {
    case "PPTX":
      return <Presentation {...iconProps} />;
    case "PDF":
      return <FileText {...iconProps} />;
  }
}

function hasDirectory(dataTransfer: DataTransfer) {
  const files = Array.from(dataTransfer.files);
  if (
    files.some(
      (file) =>
        typeof file.webkitRelativePath === "string" &&
        file.webkitRelativePath.includes("/"),
    )
  ) {
    return true;
  }

  return Array.from(dataTransfer.items ?? []).some((item) => {
    if (item.kind && item.kind !== "file") return false;

    try {
      const entry = (item as EntryAwareDataTransferItem).webkitGetAsEntry?.();
      return entry?.isDirectory === true;
    } catch {
      return false;
    }
  });
}

export function MaterialFilePicker({
  initialFile = null,
  onSelectionChange,
  disabled = false,
  selectLabel = "파일 선택하기",
}: MaterialFilePickerProps) {
  const dropHelpId = useId();
  const sizeHelpId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);
  const isMountedRef = useRef(true);
  const isValidatingRef = useRef(false);
  const validationRunRef = useRef(0);
  const [selectedFile, setSelectedFile] =
    useState<MaterialFileMetadata | null>(initialFile);
  const [validationStatus, setValidationStatus] =
    useState<MaterialValidationStatus>(initialFile ? "VALID" : "IDLE");
  const [validationMessage, setValidationMessage] = useState(
    initialFile?.validationMessage ?? "",
  );
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      validationRunRef.current += 1;
    };
  }, []);

  const isValidating = validationStatus === "VALIDATING";

  function openFileDialog() {
    if (!disabled && !isValidatingRef.current) {
      inputRef.current?.click();
    }
  }

  function showSelectionError(message: string) {
    setValidationStatus("INVALID");
    setValidationMessage(message);
  }

  async function inspectFile(file: File) {
    if (isValidatingRef.current) return;

    isValidatingRef.current = true;
    const validationRun = validationRunRef.current + 1;
    validationRunRef.current = validationRun;
    setValidationStatus("VALIDATING");
    setValidationMessage("파일 형식을 확인하고 있습니다.");

    try {
      const result = await validateMaterialFile(file);
      if (
        !isMountedRef.current ||
        validationRunRef.current !== validationRun
      ) {
        return;
      }

      if (!result.valid) {
        showSelectionError(result.message);
        return;
      }

      setSelectedFile(result.metadata);
      setValidationStatus("VALID");
      setValidationMessage(result.metadata.validationMessage);
      onSelectionChange?.(result.metadata);
    } catch {
      if (
        isMountedRef.current &&
        validationRunRef.current === validationRun
      ) {
        showSelectionError(UNEXPECTED_ERROR_MESSAGE);
      }
    } finally {
      if (validationRunRef.current === validationRun) {
        isValidatingRef.current = false;
      }
    }
  }

  function handleInputChange(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const files = input.files ? Array.from(input.files) : [];
    input.value = "";

    if (disabled || isValidatingRef.current || files.length === 0) return;
    if (files.length !== 1) {
      showSelectionError(MULTIPLE_FILES_MESSAGE);
      return;
    }

    void inspectFile(files[0]);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    const isActivationKey =
      event.key === "Enter" ||
      event.key === " " ||
      event.key === "Spacebar" ||
      event.code === "Space";
    if (!isActivationKey) return;
    event.preventDefault();
    openFileDialog();
  }

  function handleDragEnter(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (disabled || isValidatingRef.current) return;
    dragDepthRef.current += 1;
    setIsDragging(true);
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (disabled || isValidatingRef.current) return;
    event.dataTransfer.dropEffect = "copy";
    setIsDragging(true);
  }

  function handleDragLeave(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setIsDragging(false);
    }
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current = 0;
    setIsDragging(false);

    if (disabled || isValidatingRef.current) return;
    if (hasDirectory(event.dataTransfer)) {
      showSelectionError(FOLDER_MESSAGE);
      return;
    }

    const files = Array.from(event.dataTransfer.files);
    if (files.length !== 1) {
      showSelectionError(MULTIPLE_FILES_MESSAGE);
      return;
    }

    void inspectFile(files[0]);
  }

  function removeSelectedFile() {
    if (isValidatingRef.current) return;
    validationRunRef.current += 1;
    setSelectedFile(null);
    setValidationStatus("IDLE");
    setValidationMessage("");
    setIsDragging(false);
    dragDepthRef.current = 0;
    if (inputRef.current) inputRef.current.value = "";
    onSelectionChange?.(null);
  }

  const dropHeading = isDragging
    ? "파일을 놓아 확인하세요"
    : isValidating
      ? "파일 형식을 확인하고 있어요"
      : selectedFile
        ? "다른 파일로 교체할 수 있어요"
        : "파일을 여기로 끌어다 놓으세요";

  return (
    <section className={styles.picker} aria-label="강의 자료 파일 선택">
      <div
        className={styles.dropArea}
        data-drag-active={isDragging ? "true" : "false"}
        data-validation-state={validationStatus.toLowerCase()}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <button
          type="button"
          className={styles.dropButton}
          aria-label={selectLabel}
          aria-describedby={`${dropHelpId} ${sizeHelpId}`}
          aria-busy={isValidating}
          disabled={isValidating || disabled}
          onClick={openFileDialog}
          onKeyDown={handleKeyDown}
        >
          <span className={styles.dropIcon} aria-hidden="true">
            {isValidating ? (
              <LoaderCircle className={styles.spinner} />
            ) : validationStatus === "INVALID" ? (
              <TriangleAlert />
            ) : validationStatus === "VALID" ? (
              <CircleCheckBig />
            ) : (
              <FileUp />
            )}
          </span>
          <strong>{dropHeading}</strong>
          <span id={dropHelpId}>
            파일을 끌어 놓거나 아래 버튼을 눌러 선택하세요.
          </span>
          <span className={styles.fileButtonCopy} aria-hidden="true">
            {selectLabel}
          </span>
          <small id={sizeHelpId}>
            PPTX 또는 PDF · 최대 30MB · 한 번에 한 파일
          </small>
        </button>

        <input
          ref={inputRef}
          className={styles.fileInput}
          type="file"
          accept={MATERIAL_FILE_ACCEPT}
          aria-label="자료 파일 선택"
          tabIndex={-1}
          disabled={isValidating || disabled}
          onChange={handleInputChange}
        />
      </div>

      <div className={styles.formats} aria-label="지원 파일 형식">
        {MATERIAL_FORMAT_LABELS.map((format) => (
          <span key={format}>{format}</span>
        ))}
      </div>

      <div className={styles.messageRegion}>
        {validationStatus === "VALIDATING" ? (
          <p className={styles.validatingMessage} role="status">
            파일 형식을 확인하고 있습니다.
          </p>
        ) : validationStatus === "INVALID" ? (
          <p className={styles.errorMessage} role="alert">
            {validationMessage}
          </p>
        ) : validationStatus === "VALID" ? (
          <p className={styles.successMessage} role="status">
            <CircleCheckBig aria-hidden="true" />
            {validationMessage}
          </p>
        ) : null}
      </div>

      {selectedFile ? (
        <section className={styles.selectedFile} aria-label="선택한 파일">
          <span className={styles.fileTypeIcon}>
            <MaterialTypeIcon format={selectedFile.detectedType} />
          </span>
          <div className={styles.fileDetails}>
            <strong className={styles.fileName} title={selectedFile.fileName}>
              {selectedFile.fileName}
            </strong>
            <span>
              {selectedFile.detectedType} · {selectedFile.formattedSize}
            </span>
            <span className={styles.verifiedLabel}>
              <CircleCheckBig aria-hidden="true" /> 검증 완료
            </span>
          </div>
          <button
            type="button"
            className={styles.removeButton}
            aria-label="선택한 파일 제거"
            title="선택한 파일을 목록에서 제거합니다."
            disabled={isValidating || disabled}
            onClick={removeSelectedFile}
          >
            <X aria-hidden="true" />
          </button>
        </section>
      ) : null}
    </section>
  );
}
