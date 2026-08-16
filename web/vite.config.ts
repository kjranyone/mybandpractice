import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { songsPlugin } from "./vite-plugin-songs";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const songsDir = path.resolve(rootDir, "../songs");

export default defineConfig({
  plugins: [react(), songsPlugin(songsDir)],
  server: {
    port: 5173,
    fs: {
      allow: [path.resolve(rootDir, "..")],
    },
  },
  preview: {
    port: 4173,
  },
});
