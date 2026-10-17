import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  root: "ui",
  plugins: [react()],
  build: { outDir: "../ui-dist", emptyOutDir: true },
  server: { host: "127.0.0.1", allowedHosts: ["127.0.0.1"], strictPort: true },
});
