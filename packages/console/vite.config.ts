import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
  base: "/_t3gw/",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@t3-docker/shared": path.resolve(__dirname, "../shared/src/index.ts"),
    },
  },
  build: {
    outDir: "dist",
    assetsDir: "assets",
    emptyOutDir: true,
    sourcemap: false,
  },
});
