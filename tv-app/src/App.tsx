import { onMount, Show, createSignal } from "solid-js";
import { Router, Route, Navigate } from "@solidjs/router";
import { authToken } from "./stores/auth";
import { bootstrap } from "./api/auth";
import AppShell from "./components/AppShell";
import Login from "./routes/Login";
import Home from "./routes/Home";
import Profile from "./routes/Profile";
import Movies from "./routes/Movies";

/**
 * Top-level router shell.
 *
 * Authed routes live under AppShell (TopNav + auth gate). Right now most
 * page components are stubs while we port them faithfully from
 * `/var/www/ottapi/tv_app_v2/src/pages/*`. Each one lands in its own
 * commit:
 *
 *   /home         HomePage.jsx   →  routes/Home.tsx
 *   /movies       MoviesPage.jsx →  routes/Movies.tsx (with detail modal)
 *   /series       SeriesPage.jsx →  routes/Series.tsx (detail = dedicated page)
 *   /series/:id   (new)         →  routes/SeriesDetail.tsx
 *   /live         LivePage.jsx   →  routes/Live.tsx
 *   /search       SearchPage.jsx →  routes/Search.tsx
 *   /profile      ProfilePage.jsx →  routes/Profile.tsx
 */

function RootRedirect() {
  return <Navigate href={authToken() ? "/home" : "/login"} />;
}

function PortPending(props: { source: string }) {
  return (
    <div class="min-h-[60vh] flex items-center justify-center text-zinc-500 px-6">
      <div class="text-center">
        <p class="text-zinc-300 text-sm">Port pending</p>
        <p class="text-zinc-600 text-xs mt-1">
          Legacy source: <code>{props.source}</code>
        </p>
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

        <Route path="/" component={AppShell}>
          <Route path="/home" component={Home} />
          <Route path="/movies" component={Movies} />
          <Route
            path="/series"
            component={() => <PortPending source="SeriesPage.jsx" />}
          />
          <Route
            path="/series/:id"
            component={() => <PortPending source="SeriesPage.jsx (detail)" />}
          />
          <Route
            path="/live"
            component={() => <PortPending source="LivePage.jsx" />}
          />
          <Route
            path="/search"
            component={() => <PortPending source="SearchPage.jsx" />}
          />
          <Route path="/profile" component={Profile} />
        </Route>
      </Router>
    </Show>
  );
}
