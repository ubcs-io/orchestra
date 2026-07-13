import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The SPA is built into ../server/public and served as static assets by
// Fastify in production. In dev, Vite runs on :5173 and proxies /api to the
// Fastify daemon on :5001 (so SSE + REST work without CORS).
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "../server/public",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:5001",
        changeOrigin: true,
      },
    },
  },
});
