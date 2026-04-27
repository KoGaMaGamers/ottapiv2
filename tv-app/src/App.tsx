import { onMount, Show, createSignal } from "solid-js";
import { Router, Route, Navigate } from "@solidjs/router";
import { authToken } from "./stores/auth";
import { bootstrap } from "./api/auth";
import AppShell from "./components/AppShell";
import Login from "./routes/Login";
import Home from "./routes/Home";
import Profile from "./routes/Profile";
import Movies from "./routes/Movies";
import Series from "./routes/Series";
import SeriesDetail from "./routes/SeriesDetail";
import Live from "./routes/Live";
import Search from "./routes/Search";

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
          <Route path="/series" component={Series} />
          <Route path="/series/:id" component={SeriesDetail} />
          <Route path="/live" component={Live} />
          <Route path="/search" component={Search} />
          <Route path="/profile" component={Profile} />
        </Route>
      </Router>
    </Show>
  );
}
