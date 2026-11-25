import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@t3-docker/shared": path.resolve(__dirname, "packages/shared/src/index.ts"),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    environment: "node",
    globals: false,
    testTimeout: 15000,
  },
});
