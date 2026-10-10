import { describe, expect, it } from "vitest";
import {
  buildFlowUpdatePayload,
  buildMaterialUpdatePayload,
  buildRoomJoinUrl,
} from "./LiveCourseFlowEditorPage";

describe("실제 강의 편집 FastAPI 계약", () => {
  it("flow payload에는 백엔드가 허용한 필드만 포함한다", () => {
    const payload = buildFlowUpdatePayload(
      [{ id: "chapter-1", title: "첫 챕터", order: 8 }],
      [
        {
          id: "item-1",
          chapterId: "chapter-1",
          title: "첫 항목",
          description: "클라이언트 표시용",
          materialLabel: "자료 표시용",
          kind: "SLIDE",
          order: 0,
          isCompleted: true,
        },
      ],
    );

    expect(payload).toEqual({
      chapters: [{ id: "chapter-1", title: "첫 챕터", order: 0 }],
      items: [{ id: "item-1", chapterId: "chapter-1", title: "첫 항목", order: 0 }],
    });
    expect(payload.items[0]).not.toHaveProperty("description");
    expect(payload.items[0]).not.toHaveProperty("materialLabel");
    expect(payload.items[0]).not.toHaveProperty("kind");
  });

  it("자료 metadata payload를 fileName/fileType/isShared 계약으로 만든다", () => {
    expect(buildMaterialUpdatePayload(" lesson.pdf ")).toEqual({
      fileName: "lesson.pdf",
      fileType: "PDF",
      isShared: true,
    });
    expect(buildMaterialUpdatePayload("dataset")).toEqual({
      fileName: "dataset",
      fileType: "DATA",
      isShared: true,
    });
    expect(buildMaterialUpdatePayload("private.pdf", false)).toEqual({
      fileName: "private.pdf",
      fileType: "PDF",
      isShared: false,
    });
  });

  it("참여 경로를 스캔 가능한 QR의 절대 URL로 변환한다", () => {
    expect(buildRoomJoinUrl("/join/NODO01", "http://127.0.0.1:5174")).toBe(
      "http://127.0.0.1:5174/join/NODO01",
    );
  });
});
