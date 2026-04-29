# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Symbioplayer OTTAPIV2 is a multi-platform IPTV streaming application with:
- **FastAPI Python backend** — REST API server (root `src/`)
- **SolidJS TypeScript frontend** — reactive UI (`tv-app/src/`)
- **Tauri v2 shell** — desktop + Android wrapper (`tv-app/src-tauri/`)
- **Custom native-player plugin** — Android ExoPlayer via Kotlin (`tv-app/src-tauri/plugins/native-player/`)

## Build & Run Commands

### Backend (from repo root)
```bash
# Install
pip install -r requirements.txt

# Run dev server (port 8011)
uvicorn src.main:app --reload --host 127.0.0.1 --port 8011
```

### Frontend (from tv-app/)
```bash
npm install
npm run dev          # Vite dev server on :5173 (proxies /api/* to :8011)
npm run build        # TypeScript check + Vite production build
npm run tauri:dev    # Desktop dev (Rust + Vite)
npm run tauri:android:dev    # Android emulator + live reload
npm run tauri:build          # Production desktop bundle
npm run tauri:android:build  # Production APK/AAB
```

### Production backend
Deployed via systemd — see `deploy/ottapi-v2.service`. Runs uvicorn on port 8011.

## Architecture

### Authentication Flow
Login with Xtream credentials → backend validates against provider → issues JWT Bearer token → stored in localStorage (`ott_token_v1`) → attached to all API requests via `api/client.ts`.

### Stream Allocation
Playback requires a slot allocation (`POST /api/v1/play/{type}/{id}`) which returns a stream URL + allocation token. The client sends heartbeats every 120s; slots auto-release after 300s inactivity.

### Multi-Platform Playback
- **Web/Desktop**: HLS.js player in `MediaPlayer.tsx` with manual controls, audio/subtitle selection, buffered seek visualization
- **Android native**: `AppShell.tsx` detects platform → `NativePlayerHost.tsx` launches ExoPlayer Activity via Tauri plugin bridge → Kotlin `PlayerActivity.kt` handles full-screen playback with VOD/Live overlays

### Playback Progress
Resume position persisted in localStorage via `playbackStore.ts`. At ≥90% completion, content moves from continue-watching to history. Both web and native players read/write the same store.

### Catalog Sync
APScheduler background tasks periodically scrape Xtream provider catalogs (M3U + EPG), enrich with TMDB metadata (fuzzy title matching), and store in MySQL. Exposed via `/api/v1/catalog/*` endpoints.

## Tech Stack

| Layer | Stack |
|-------|-------|
| Frontend | SolidJS 1.9, TypeScript, Tailwind CSS 4, Solid Router, HLS.js, Vite |
| Shell | Tauri v2 (Rust 2021 edition) |
| Android native | Kotlin, ExoPlayer |
| Backend | FastAPI, SQLAlchemy 2, PyMySQL, APScheduler, python-dotenv |
| Database | MySQL |

## Key Entry Points

- `src/main.py` — FastAPI app + router registration
- `src/config.py` — env-based config (expects `.env` at root with DB creds, API keys)
- `src/services/catalog_sync.py` — largest backend file, Xtream catalog scraping
- `tv-app/src/App.tsx` — SolidJS router + auth gate
- `tv-app/src/api/client.ts` — HTTP client with Tauri detection, token injection, error handling
- `tv-app/src/components/AppShell.tsx` — layout shell, routes native vs web player
- `tv-app/src-tauri/src/lib.rs` — Tauri app setup + plugin registration
- `tv-app/src-tauri/plugins/native-player/src/mobile.rs` — Android JNI bridge

## CORS Origins

FastAPI allows: `tauri.localhost` (Android WebView), `localhost:5173` (Vite dev), `localhost:1420` (Tauri desktop). Vite dev proxy bypasses CORS for browser development.

## State Management

SolidJS signals and stores — no external state library. Key stores:
- `stores/auth.ts` — token + user signals, localStorage persistence
- `stores/player.ts` — playerOpen signal + closePlayer()
- `stores/shell.ts` — AppShell state
- `lib/playbackStore.ts` — resume position + continue watching
- `lib/contentPrefs.ts` — sorting/filtering preferences
