import { type JSX, Show } from "solid-js";
import { Navigate } from "@solidjs/router";
import { authToken } from "../stores/auth";
import TopNav from "./TopNav";

/**
 * Layout for all authed pages: persistent TopNav + a slot for the
 * matched child route.
 *
 * Routed via @solidjs/router's nested-route children — the parent
 * Route in App.tsx receives `props.children` which is whichever
 * sub-route matched.
 */
export default function AppShell(props: { children?: JSX.Element }) {
  return (
    <Show when={authToken()} fallback={<Navigate href="/login" />}>
      <div class="min-h-screen bg-[#0b0b0b]">
        <TopNav />
        <main>{props.children}</main>
      </div>
    </Show>
  );
}
