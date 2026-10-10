import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(process.cwd(), "..");
describe("NoDo 전용 Firebase 배포 설정", () => {
  it("(default) 데이터베이스·NoDo Rules·NoDo Indexes만 명시한다", () => {
    const config = JSON.parse(
      readFileSync(resolve(root, "firebase.nodo.json"), "utf8"),
    ) as {
      firestore: Array<{ database: string; rules: string; indexes: string }>;
    };

    expect(config.firestore).toEqual([
      {
        database: "(default)",
        rules: "firestore.nodo.rules",
        indexes: "firestore.nodo.indexes.json",
      },
    ]);
    expect(
      JSON.parse(
        readFileSync(resolve(root, "firestore.nodo.indexes.json"), "utf8"),
      ),
    ).toEqual({ indexes: [], fieldOverrides: [] });
  });

  it("NoDo의 명시된 Firestore 파일만 배포 대상으로 둔다", () => {
    const configuration = [
      readFileSync(resolve(root, "firebase.nodo.json"), "utf8"),
      readFileSync(resolve(root, "firestore.nodo.rules"), "utf8"),
      readFileSync(resolve(root, "firestore.nodo.indexes.json"), "utf8"),
      readFileSync(resolve(root, "backend/.env.example"), "utf8"),
    ].join("\n");

    expect(configuration).toContain("NODO_FIRESTORE_DATABASE_ID=(default)");
    expect(configuration).toContain("organizations/{orgId}");
    expect(configuration).toContain("Every path outside NoDo's organization root");
  });
});
