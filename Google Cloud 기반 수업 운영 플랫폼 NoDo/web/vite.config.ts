import react from "@vitejs/plugin-react";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  server:
    mode === "cloud-auth"
      ? {
          proxy: {
            "/api": {
              target: "http://127.0.0.1:8082",
            },
            "/health": {
              target: "http://127.0.0.1:8082",
            },
          },
        }
      : undefined,
  test: {
    clearMocks: true,
    environment: "jsdom",
    exclude: [...configDefaults.exclude, "emulator-tests/**"],
    setupFiles: "./src/test/setup.ts",
  },
}));
