import { onMount, Show, createSignal } from "solid-js";
import { Router, Route, Navigate } from "@solidjs/router";
import { authToken } from "./stores/auth";
import { bootstrap } from "./api/auth";
import AppShell from "./components/AppShell";
import Login from "./routes/Login";
import Home from "./routes/Home";
import MoviesPage from "./routes/Movies";
import MovieDetail from "./routes/MovieDetail";
import SeriesPage from "./routes/Series";
import SeriesDetail from "./routes/SeriesDetail";

/**
 * Top-level router shell.
 *
 * On mount we run `bootstrap()` which, if a cached token exists, hits
 * /api/v1/me to verify it. A 401 there clears the auth signal so any
 * /home route re-renders into a redirect-to-login. Other errors leave
 * the cached token alone.
 *
 * AppShell layout (TopNav + content) wraps every authed route. The
 * /login route is intentionally OUTSIDE the shell — no nav while
 * unauthenticated.
 */

function RootRedirect() {
  return <Navigate href={authToken() ? "/home" : "/login"} />;
}

/** Placeholder for routes whose real components land in later steps. */
function StubScreen(props: { title: string; nextStep: number }) {
  return (
    <div class="min-h-[60vh] flex items-center justify-center text-zinc-500 px-6">
      <div class="text-center">
        <h1 class="text-2xl font-semibold mb-2 text-zinc-300">{props.title}</h1>
        <p class="text-sm">Lands in step {props.nextStep}.</p>
      </div>
    </div>
  );
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

        {/* All authed routes share the AppShell (TopNav + page outlet). */}
        <Route path="/" component={AppShell}>
          <Route path="/home" component={Home} />
          <Route path="/movies" component={MoviesPage} />
          <Route path="/movies/:id" component={MovieDetail} />
          <Route path="/series" component={SeriesPage} />
          <Route path="/series/:id" component={SeriesDetail} />
          <Route path="/live" component={() => <StubScreen title="Live TV" nextStep={13} />} />
          <Route path="/search" component={() => <StubScreen title="Search" nextStep={9} />} />
          <Route path="/profile" component={() => <StubScreen title="Profile" nextStep={10} />} />
        </Route>
      </Router>
    </Show>
  );
}
