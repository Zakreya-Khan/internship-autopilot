import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    port: 5173,
    // In dev, the API runs on the local server; the token comes from localStorage (see api.ts).
    proxy: { "/api": "http://127.0.0.1:4317" },
  },
});
