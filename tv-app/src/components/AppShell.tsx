import { type JSX, Show } from "solid-js";
import { Navigate } from "@solidjs/router";
import { authToken } from "../stores/auth";
import { playerOpen } from "../stores/player";
import { isNativePlayerAvailable } from "../lib/nativePlayer";
import TopNav from "./TopNav";
import MediaPlayer from "./MediaPlayer";
import NativePlayerHost from "./NativePlayerHost";

/**
 * Layout for all authed pages: persistent TopNav + a slot for the
 * matched child route, plus the player overlay when open.
 *
 * On Android (Tauri context) playback is delegated to the native
 * ExoPlayer plugin via `NativePlayerHost`; everywhere else (browser
 * dev, desktop Tauri) the WebView `<video>` path in `MediaPlayer`
 * handles it. Both write to the same playbackStore / historyStore so
 * the rest of the UI is identical regardless of which one ran.
 *
 * The native check is a runtime constant (UA + Tauri globals) so it's
 * evaluated once per session — no need to gate it behind a memo.
 */
export default function AppShell(props: { children?: JSX.Element }) {
  const native = isNativePlayerAvailable();
  return (
    <Show when={authToken()} fallback={<Navigate href="/login" />}>
      <div class="min-h-screen bg-[#0b0b0b]">
        <TopNav />
        <main>{props.children}</main>
        <Show when={playerOpen()}>
          {native ? <NativePlayerHost /> : <MediaPlayer />}
        </Show>
      </div>
    </Show>
  );
}
