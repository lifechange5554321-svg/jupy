import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  root: resolve("apk-shell"),
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": resolve("src") } },
  build: { outDir: "dist", emptyOutDir: true, assetsDir: "assets" },
});
