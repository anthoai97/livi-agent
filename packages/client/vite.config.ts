import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api/bootstrap": "http://127.0.0.1:3001",
      "/health": "http://127.0.0.1:3001",
      "/ws": { target: "ws://127.0.0.1:3001", ws: true },
    },
  },
});
