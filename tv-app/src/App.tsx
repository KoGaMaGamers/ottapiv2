import { onMount, Show, createSignal } from "solid-js";
import { Router, Route, Navigate, useParams } from "@solidjs/router";
import { authToken } from "./stores/auth";
import { bootstrap } from "./api/auth";
import Login from "./routes/Login";
import Home from "./routes/Home";

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

function ProtectedHome() {
  if (!authToken()) return <Navigate href="/login" />;
  return <Home />;
}

/** Placeholder detail route; replaced in step 7 (Movies) and step 8 (Series). */
function DetailPlaceholder(props: { kind: "movie" | "series" }) {
  const params = useParams<{ id: string }>();
  if (!authToken()) return <Navigate href="/login" />;
  return (
    <div class="min-h-screen flex items-center justify-center text-zinc-300 px-6">
      <div class="text-center max-w-lg">
        <h1 class="text-2xl font-semibold mb-2">
          {props.kind} #{params.id}
        </h1>
        <p class="text-zinc-500 text-sm mb-6">
          Detail page lands in step {props.kind === "movie" ? "7" : "8"}.
        </p>
        <button
          class="rounded-md bg-zinc-800 hover:bg-zinc-700 px-4 py-2 ring-1 ring-zinc-700 outline-none focus:ring-violet-400"
          onClick={() => history.back()}
        >
          Back
        </button>
      </div>
    </div>
  );
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
        <Route path="/movies/:id" component={() => <DetailPlaceholder kind="movie" />} />
        <Route path="/series/:id" component={() => <DetailPlaceholder kind="series" />} />
      </Router>
    </Show>
  );
}
