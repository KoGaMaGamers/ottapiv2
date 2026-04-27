import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";

// During dev, the Solid app calls the live backend through Vite's proxy so
// the frontend can use relative paths (`/api/v1/...`, `/auth/login`). In the
// Tauri production build, VITE_API_BASE in `.env.production` makes those
// paths absolute against the public hostname.
const BACKEND = "https://ottapi.smartbunker.fr";

export default defineConfig({
  plugins: [solid(), tailwindcss()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target: BACKEND, changeOrigin: true, secure: true },
      "/auth": { target: BACKEND, changeOrigin: true, secure: true },
    },
  },
  build: {
    target: "es2020",
    sourcemap: true,
  },
});
