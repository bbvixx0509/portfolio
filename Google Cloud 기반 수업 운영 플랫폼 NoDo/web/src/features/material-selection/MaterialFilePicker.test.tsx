import {
  act,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  MaterialFileMetadata,
  MaterialValidationResult,
} from "./materialTypes";
import { MaterialFilePicker } from "./MaterialFilePicker";

const { validateMaterialFileMock } = vi.hoisted(() => ({
  validateMaterialFileMock: vi.fn(),
}));

vi.mock("./materialValidation", () => ({
  validateMaterialFile: validateMaterialFileMock,
}));

function createFile(name = "lesson.pdf", type = "application/pdf") {
  return new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])], name, {
    type,
  });
}

function createMetadata(file: File, formattedSize = "5 B"): MaterialFileMetadata {
  const lowerName = file.name.toLowerCase();
  const detectedType = lowerName.endsWith(".pptx") ? "PPTX" : "PDF";
  const extension = lowerName.endsWith(".pptx") ? ".pptx" : ".pdf";

  return {
    file,
    fileName: file.name,
    extension,
    detectedType,
    mimeType: file.type || "application/pdf",
    sizeBytes: file.size,
    formattedSize,
    validationStatus: "VALID",
    validationMessage: "파일 형식을 확인했습니다.",
  };
}

function success(file: File, formattedSize?: string): MaterialValidationResult {
  return { valid: true, metadata: createMetadata(file, formattedSize) };
}

function failure(message: string): MaterialValidationResult {
  return { valid: false, errorKind: "UNSUPPORTED_EXTENSION", message };
}

function chooseFile(file: File) {
  const input = screen.getByLabelText("자료 파일 선택") as HTMLInputElement;
  fireEvent.change(input, { target: { files: [file] } });
  return input;
}

describe("MaterialFilePicker", () => {
  beforeEach(() => {
    validateMaterialFileMock.mockReset();
  });

  it("단일 파일 입력과 지원 형식 배지를 표시한다", () => {
    render(<MaterialFilePicker />);

    expect(
      screen.getByRole("button", { name: "파일 선택하기" }),
    ).toBeInTheDocument();
    const input = screen.getByLabelText("자료 파일 선택");
    expect(input).toHaveAttribute("type", "file");
    expect(input).not.toHaveAttribute("multiple");
    expect(input).toHaveAttribute("tabindex", "-1");
    expect(input).toHaveAttribute(
      "accept",
      ".pptx,.pdf",
    );

    const formats = screen.getByLabelText("지원 파일 형식");
    for (const format of ["PPTX", "PDF"]) {
      expect(within(formats).getByText(format)).toBeInTheDocument();
    }
  });

  it("클릭과 Enter·Space 키로 파일 선택 창을 연다", () => {
    render(<MaterialFilePicker />);
    const button = screen.getByRole("button", { name: "파일 선택하기" });
    const input = screen.getByLabelText("자료 파일 선택") as HTMLInputElement;
    const inputClick = vi.spyOn(input, "click");

    fireEvent.click(button);
    fireEvent.keyDown(button, { key: "Enter" });
    fireEvent.keyDown(button, { key: " " });

    expect(inputClick).toHaveBeenCalledTimes(3);
    const describedBy = button.getAttribute("aria-describedby")?.split(" ");
    expect(describedBy).toHaveLength(2);
    for (const id of describedBy ?? []) {
      expect(document.getElementById(id)).toBeInTheDocument();
    }
  });

  it("드래그 진입과 이탈 상태를 표시한다", () => {
    const { container } = render(<MaterialFilePicker />);
    const button = screen.getByRole("button", { name: "파일 선택하기" });
    const dropArea = container.querySelector("[data-drag-active]");

    fireEvent.dragEnter(button, { dataTransfer: { files: [], items: [] } });
    expect(dropArea).toHaveAttribute("data-drag-active", "true");
    expect(screen.getByText("파일을 놓아 확인하세요")).toBeInTheDocument();

    fireEvent.dragLeave(button, { dataTransfer: { files: [], items: [] } });
    expect(dropArea).toHaveAttribute("data-drag-active", "false");
  });

  it("드래그 기본 파일 열기를 막고 여러 파일 드롭을 거부한다", () => {
    const { container } = render(<MaterialFilePicker />);
    const dropArea = container.querySelector("[data-drag-active]");
    if (!dropArea) throw new Error("드롭 영역이 필요합니다.");
    const files = [createFile("one.pdf"), createFile("two.pdf")];
    const dragOverEvent = createEvent.dragOver(dropArea, {
      dataTransfer: { files, items: [], dropEffect: "none" },
    });
    const dropEvent = createEvent.drop(dropArea, {
      dataTransfer: { files, items: [] },
    });

    fireEvent(dropArea, dragOverEvent);
    fireEvent(dropArea, dropEvent);

    expect(dragOverEvent.defaultPrevented).toBe(true);
    expect(dropEvent.defaultPrevented).toBe(true);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "한 번에 파일 하나만 선택할 수 있습니다.",
    );
    expect(validateMaterialFileMock).not.toHaveBeenCalled();
  });

  it("드롭한 파일을 검증하고 성공 정보와 제거 tooltip을 표시한다", async () => {
    const file = createFile();
    validateMaterialFileMock.mockResolvedValueOnce(success(file, "1.2 MB"));
    render(<MaterialFilePicker />);

    fireEvent.drop(
      screen.getByRole("button", { name: "파일 선택하기" }).parentElement!,
      {
      dataTransfer: { files: [file], items: [] },
      },
    );

    const selected = await screen.findByRole("region", { name: "선택한 파일" });
    expect(selected).toHaveTextContent("lesson.pdf");
    expect(within(selected).getByText("lesson.pdf")).toHaveAttribute(
      "title",
      "lesson.pdf",
    );
    expect(selected).toHaveTextContent("PDF · 1.2 MB");
    expect(selected).toHaveTextContent("검증 완료");
    expect(within(selected).getByRole("img", { name: "PDF 파일" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "파일 형식을 확인했습니다.",
    );
    expect(
      within(selected).getByRole("button", { name: "선택한 파일 제거" }),
    ).toHaveAttribute("title", "선택한 파일을 목록에서 제거합니다.");
  });

  it("검증 중 상태에서 중복 선택을 막는다", async () => {
    const firstFile = createFile("first.pdf");
    const secondFile = createFile("second.pdf");
    let finishValidation: (result: MaterialValidationResult) => void = () => {};
    validateMaterialFileMock.mockReturnValueOnce(
      new Promise<MaterialValidationResult>((resolve) => {
        finishValidation = resolve;
      }),
    );
    render(<MaterialFilePicker />);

    chooseFile(firstFile);
    const button = screen.getByRole("button", { name: "파일 선택하기" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("status")).toHaveTextContent(
      "파일 형식을 확인하고 있습니다.",
    );

    fireEvent.change(screen.getByLabelText("자료 파일 선택"), {
      target: { files: [secondFile] },
    });
    expect(validateMaterialFileMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      finishValidation(success(firstFile));
    });
    expect(await screen.findByText("first.pdf")).toBeInTheDocument();
  });

  it("여러 파일을 선택하면 접근 가능한 오류를 표시한다", () => {
    render(<MaterialFilePicker />);
    const input = screen.getByLabelText("자료 파일 선택");

    fireEvent.change(input, {
      target: { files: [createFile("one.pdf"), createFile("two.pdf")] },
    });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "한 번에 파일 하나만 선택할 수 있습니다.",
    );
    expect(validateMaterialFileMock).not.toHaveBeenCalled();
  });

  it("폴더 드롭을 차단한다", () => {
    render(<MaterialFilePicker />);

    fireEvent.drop(
      screen.getByRole("button", { name: "파일 선택하기" }).parentElement!,
      {
      dataTransfer: {
        files: [],
        items: [
          {
            kind: "file",
            webkitGetAsEntry: () => ({ isDirectory: true }),
          },
        ],
      },
      },
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "폴더는 선택할 수 없습니다.",
    );
    expect(validateMaterialFileMock).not.toHaveBeenCalled();
  });

  it("정상 파일을 새 정상 파일로 교체한다", async () => {
    const onSelectionChange = vi.fn();
    const firstFile = createFile("first.pdf");
    const nextFile = createFile("next.pdf");
    validateMaterialFileMock
      .mockResolvedValueOnce(success(firstFile))
      .mockResolvedValueOnce(success(nextFile));
    render(<MaterialFilePicker onSelectionChange={onSelectionChange} />);

    chooseFile(firstFile);
    expect(await screen.findByText("first.pdf")).toBeInTheDocument();
    chooseFile(nextFile);
    expect(await screen.findByText("next.pdf")).toBeInTheDocument();

    expect(screen.queryByText("first.pdf")).not.toBeInTheDocument();
    expect(onSelectionChange).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ fileName: "first.pdf" }),
    );
    expect(onSelectionChange).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ fileName: "next.pdf" }),
    );
  });

  it("교체 파일 검증이 실패하면 기존 정상 파일을 유지한다", async () => {
    const onSelectionChange = vi.fn();
    const validFile = createFile("kept.pdf");
    const invalidFile = createFile("invalid.exe", "application/octet-stream");
    validateMaterialFileMock
      .mockResolvedValueOnce(success(validFile))
      .mockResolvedValueOnce(failure("지원하지 않는 파일 형식입니다."));
    render(<MaterialFilePicker onSelectionChange={onSelectionChange} />);

    chooseFile(validFile);
    expect(await screen.findByText("kept.pdf")).toBeInTheDocument();
    chooseFile(invalidFile);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "지원하지 않는 파일 형식입니다.",
    );
    expect(screen.getByText("kept.pdf")).toBeInTheDocument();
    expect(onSelectionChange).toHaveBeenCalledTimes(1);
  });

  it("같은 파일을 다시 선택할 수 있도록 input 값을 매번 초기화한다", async () => {
    const file = createFile();
    validateMaterialFileMock
      .mockResolvedValueOnce(success(file))
      .mockResolvedValueOnce(success(file));
    render(<MaterialFilePicker />);

    const input = chooseFile(file);
    expect(input.value).toBe("");
    await screen.findByText("lesson.pdf");

    chooseFile(file);
    await waitFor(() => expect(validateMaterialFileMock).toHaveBeenCalledTimes(2));
    expect(input.value).toBe("");
  });

  it("제거 버튼으로 메모리 선택 상태만 초기화한다", async () => {
    const onSelectionChange = vi.fn();
    const file = createFile();
    validateMaterialFileMock.mockResolvedValueOnce(success(file));
    render(<MaterialFilePicker onSelectionChange={onSelectionChange} />);

    chooseFile(file);
    const removeButton = await screen.findByRole("button", {
      name: "선택한 파일 제거",
    });
    fireEvent.click(removeButton);

    expect(screen.queryByText("lesson.pdf")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(onSelectionChange).toHaveBeenLastCalledWith(null);
  });

  it("파일 선택 과정에서 네트워크나 브라우저 저장소를 사용하지 않는다", async () => {
    const file = createFile();
    validateMaterialFileMock.mockResolvedValueOnce(success(file));
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const storageSetSpy = vi.spyOn(Storage.prototype, "setItem");
    render(<MaterialFilePicker />);

    chooseFile(file);
    await screen.findByText("lesson.pdf");

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(storageSetSpy).not.toHaveBeenCalled();
  });
});
