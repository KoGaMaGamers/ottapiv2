import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";

// During dev, the Solid app calls the live backend through Vite's proxy so
// the frontend can use relative paths (`/api/v1/...`, `/auth/login`). In the
// Tauri production build, VITE_API_BASE in `.env.production` makes those
// paths absolute against the public hostname.
const BACKEND = "https://ottapi.smartbunker.fr";

// Tauri Android sets TAURI_DEV_HOST to the dev box's LAN IP so the
// device's WebView can reach the Vite dev server directly. When unset
// (plain browser dev / desktop Tauri), bind to 127.0.0.1 only.
const host = process.env.TAURI_DEV_HOST ?? "127.0.0.1";

export default defineConfig({
  plugins: [solid(), tailwindcss()],
  // Don't clear the terminal — `cargo tauri dev` interleaves Vite +
  // Rust output, and clearing wipes Rust errors mid-build.
  clearScreen: false,
  server: {
    host,
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target: BACKEND, changeOrigin: true, secure: true },
      "/auth": { target: BACKEND, changeOrigin: true, secure: true },
    },
  },
  // Tauri exposes its own env vars; let Vite surface them to the app.
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target: "es2020",
    sourcemap: true,
  },
});
