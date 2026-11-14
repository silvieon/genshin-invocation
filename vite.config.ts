// Builds the client (client/ → dist/client). In development, Vite serves the
// client on :5173 and forwards /api and /ws to the game server, so the browser
// sees a single origin exactly as in production.

import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

const serverPort = Number(process.env.PORT ?? 8787);

export default defineConfig({
  root: "client",
  plugins: [solid()],
  build: {
    outDir: "../dist/client",
    emptyOutDir: true,
    target: "es2022",
    chunkSizeWarningLimit: 2000,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": `http://localhost:${serverPort}`,
      "/ws": { target: `ws://localhost:${serverPort}`, ws: true },
    },
  },
});
