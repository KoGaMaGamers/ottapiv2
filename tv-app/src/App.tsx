import { onMount, Show, createSignal } from "solid-js";
import { Router, Route, Navigate } from "@solidjs/router";
import { authToken, authUser } from "./stores/auth";
import { bootstrap, logout } from "./api/auth";
import Login from "./routes/Login";

/**
 * Top-level router shell.
 *
 * On mount we run `bootstrap()` which, if a cached token exists, hits
 * /api/v1/me to verify it. A 401 there clears the auth signal so any
 * /home route re-renders into a redirect-to-login. Other errors leave
 * the cached token alone.
 *
 * Real screens (Home, Movies, Series, Live, Search, Profile, Player)
 * land in subsequent steps. The placeholder Home below proves auth
 * roundtrips end-to-end.
 */

function HomePlaceholder() {
  const user = authUser();
  return (
    <div class="min-h-screen flex items-center justify-center text-zinc-300 px-6">
      <div class="text-center max-w-lg">
        <h1 class="text-3xl font-semibold mb-2">Signed in.</h1>
        <Show when={user}>
          {(u) => (
            <p class="text-zinc-400 mb-6">
              {u().username} · provider {u().provider_id} · view mode{" "}
              <span class="text-violet-400">{u().view_mode}</span>
            </p>
          )}
        </Show>
        <p class="text-zinc-500 text-sm mb-6">
          Real Home, Movies, Series, Live, Search and Player screens land in
          steps 5–14 of the rewrite plan.
        </p>
        <button
          class="rounded-md bg-zinc-800 hover:bg-zinc-700 px-4 py-2 ring-1 ring-zinc-700 outline-none focus:ring-violet-400"
          onClick={() => {
            logout();
            location.assign("/login");
          }}
        >
          Sign out
        </button>
      </div>
    </div>
  );
}

function ProtectedHome() {
  if (!authToken()) return <Navigate href="/login" />;
  return <HomePlaceholder />;
}

function RootRedirect() {
  return <Navigate href={authToken() ? "/home" : "/login"} />;
}

export default function App() {
  const [ready, setReady] = createSignal(false);

  onMount(async () => {
    await bootstrap();
    setReady(true);
  });

  return (
    <Show
      when={ready()}
      fallback={
        <div class="min-h-screen flex items-center justify-center text-zinc-500 text-sm">
          Loading…
        </div>
      }
    >
      <Router>
        <Route path="/" component={RootRedirect} />
        <Route path="/login" component={Login} />
        <Route path="/home" component={ProtectedHome} />
      </Router>
    </Show>
  );
}
