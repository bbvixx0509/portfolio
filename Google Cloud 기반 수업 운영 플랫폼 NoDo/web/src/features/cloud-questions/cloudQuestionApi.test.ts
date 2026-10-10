import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requestBlobApiResponse: vi.fn() }));

vi.mock("../../lib/api/apiClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/api/apiClient")>()),
  requestBlobApiResponse: mocks.requestBlobApiResponse,
}));

import {
  csvExportFilename,
  exportCloudRoomQuestionsCsv,
} from "./cloudQuestionApi";

afterEach(() => {
  mocks.requestBlobApiResponse.mockReset();
});

describe("cloud question CSV export API", () => {
  it("인증된 CSV 요청과 서버 attachment 파일명을 사용한다", async () => {
    const blob = new Blob(["csv"], { type: "text/csv" });
    mocks.requestBlobApiResponse.mockResolvedValue({
      blob,
      contentDisposition: "attachment; filename=ended-room-questions.csv",
    });
    const user = { uid: "masked-staff" } as never;

    await expect(exportCloudRoomQuestionsCsv(user, "room/1")).resolves.toEqual({
      blob,
      filename: "ended-room-questions.csv",
    });
    expect(mocks.requestBlobApiResponse).toHaveBeenCalledWith(
      "/api/cloud/rooms/room%2F1/questions/export",
      { authUser: user, headers: { Accept: "text/csv, application/json" } },
    );
  });

  it("잘못된 attachment 이름은 안전한 CSV 기본값으로 바꾼다", () => {
    expect(csvExportFilename("attachment; filename*=UTF-8''%EC%B1%84%ED%8C%85.csv")).toBe("채팅.csv");
    expect(csvExportFilename("attachment; filename=../../secret.csv")).toBe("nodo-chat-history.csv");
    expect(csvExportFilename(null)).toBe("nodo-chat-history.csv");
  });
});
