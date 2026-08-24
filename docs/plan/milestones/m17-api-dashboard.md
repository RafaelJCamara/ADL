# M17 — HTTP API Completeness & Web Dashboard

**Status:** 🔒 Blocked on M12 (dogfood gate)
**Depends on:** M12
**Requirements:** OBS-06, OBS-07 (2)
**Has UI:** yes — the only frontend work in v1

**Goal:** everything the CLI can do is available over HTTP, and a browser dashboard over
that same API proves the API is **complete** rather than merely present.

---

## Done when

- [ ] Every operation the CLI performs is available over the HTTP API — verified by **the
      CLI itself being nothing but a client of that API**.
- [ ] The maintainer opens the dashboard in a browser and sees every feature's live state,
      streaming transcripts and spend, served from the same origin as the API.
- [ ] The maintainer can pause and kill from the dashboard, and the dashboard requires **no
      endpoint the CLI cannot also use**.

---

## Step sketch

- [ ] **17.1** — Audit CLI verbs against HTTP routes; close every gap.
- [ ] **17.2** — Assert structurally that the CLI is a pure API client (M03 already made it
      unable to resolve `@adl/db` / `@adl/manager` — extend that into a completeness proof).
- [ ] **17.3** — Vite + React SPA scaffold under `apps/dashboard`.
- [ ] **17.4** — Feature list with live state (polling + `@tanstack/react-query`).
- [ ] **17.5** — Streaming transcripts over SSE (reuse `GET /stages/:id/logs`).
- [ ] **17.6** — Spend view.
- [ ] **17.7** — Pause / kill controls.
- [ ] **17.8** — Static build served by the manager from the same origin.
- [ ] **17.9** — Assert the dashboard added no endpoint the CLI cannot use.

## Notes

**The dashboard is deliberately last, and this is the one milestone most likely to be
pulled forward by temptation.** The documented failure shape for a nights-and-weekends
project is exactly this: the dashboard is the most fun and most visible piece, so it gets
built early while the loop's ambiguous, unrewarding parts stay unsolved.

Its real value is **proving the API is complete**. If it needs an endpoint the CLI cannot
use, the API was wrong. Building it earlier means building it twice.

- Static SPA bundled into the npm package and served by the manager. **Not Next.js** — a
  second server process and SSR that fight being served as static files.
- **SSE, not WebSocket.** Direction needed is server→client only; SSE survives corporate
  proxies, reconnects per spec via `Last-Event-ID`, and is `curl`-able.
- React is chosen for contributor familiarity, not technical superiority.
