import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    fileParallelism: false,
    hookTimeout: 30_000,
    include: ["emulator-tests/**/*.test.ts"],
    testTimeout: 20_000,
  },
});

