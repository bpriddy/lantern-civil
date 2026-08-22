# The app session: Run means run the app

Companion to `docs/transpilation.md`; decided 2026-08-21. Step 2 of the client
story, and the redefinition of Civil's primary verb.

**Pressing Run runs the application** — boundary server up, the client's own
start script running (`next dev`, whatever the client node's `dev` field says),
the app itself alive in a preview pane inside the IDE. Development happens
against the running app. The module-level graph runs that M4 built remain as
the debugger view — one graph, one input, the event log — but the primary verb
is app-level. Run gains a meaning at the composition altitude for the first
time: composition Run starts or attaches the app session; graph Run stays the
module loop. (This supersedes the PRD's "Run has no meaning on the composition
canvas" — it had none *under interpretation*; under sessions it has the most
natural meaning there is.)

## The session

A runner-family service, heavier and longer-lived than a run, and that is fine —
the owner is client #1 and the bill is accepted knowingly:

1. **Materialise** the project — HEAD plus pending — onto the session's real
   filesystem.
2. **Transpile** the civil documents into it (the ephemeral transpile of
   transpilation.md, landing on session disk instead of in memory — because
   frontend tooling demands real files with real watchers, and "in-memory" was
   never the requirement; *don't churn the repo* was).
3. **Start the processes**: the boundary server, and each client's dev script.
4. **Proxy the preview** into the IDE pane; stream every process's output into
   the same drawer the event log taught us to build.

The filesystem is ephemeral-but-real: the scratch-dir principle grown into a
workspace. Losing the session container loses nothing (see the write-through
rule below), so CLAUDE.md's no-local-only-copy invariant holds unchanged.
Sessions start when Run is pressed or the preview opens, and are reaped on
idle.

## The two-tier editing rule

- **Code contexts edit files. Period.** A Monaco save lands in the session's
  filesystem immediately — the frontend's watcher fires HMR, the server
  reloads. The user is editing the files of their running app, because they
  are. Underneath, invisibly, the save also writes through to the pending
  store: durability, the diff panel, the commit flow, and pick-it-up-on-another-
  device all ride along without the user ever feeling "pending-ness". The
  session dying must never eat an hour of work; this is how it can't.
- **Graph edits edit the docs and the materialised files.** A canvas op updates
  the civil documents (as pending, as today) and hot re-transpiles the affected
  orchestration into the session, so the running app tracks the canvas without
  the user thinking about transpilation at all.

## The preview pane

Open/closeable, part of development rather than a viewing gallery: the place
the user runs, uses, and tests their application. The testing ladder grows
here — manual use first; then the repo's own tests (pytest, Playwright) run in
the session with results in the pane; then M5's fixtures and edge contract
tests. The repo's tests, not a Civil test format — supplement, not structure.

Explicitly not the goal: replacing local frontend tooling. Civil doesn't
innovate on the frontend and doesn't get in its way; serious frontend work can
always happen in the user's own editor against their own dev server. The
session simply means it doesn't have to.

## Build order for step 2

1. The transpiler (prerequisite, step 1 — the session materialises its output).
2. Session service: materialise + transpile + process supervision + reaping.
3. Preview pane + proxy, session logs into the drawer.
4. Write-through editing (code contexts), hot re-transpile (graph ops).
5. Run-semantics split by altitude; command registry entries.
6. The testing ladder, rung by rung.

## The substrate: an interface, decided 2026-08-21

Rule 2 of the emitted-code contract applied to Civil's own infrastructure:
the session substrate is anything conceivably configured per deployment, so
it lives behind a cleanly separated interface — the session service speaks a
small contract (create with files and process specs, write files, status,
logs, destroy) and substrates are adapters behind it, the same move as
`Engine`. The design dictates; the platform serves.

- **Local adapter first**: a session process in the dev stack supervising
  ordinary child processes on the developer's machine. Not a dodge — it is
  the dev loop, and every session semantic (materialize, supervise,
  write-through, reap) is identical code on any substrate. Locally the
  preview iframe points straight at the process's localhost port; the proxy
  problem belongs entirely to the deployed adapter.
- **Deployed adapter: pod-per-session on GKE Autopilot, in our own project.**
  One pod = one session = the real filesystem in the cloud. No new vendor,
  one bill, and user code never leaves our cloud — sandbox providers (E2B,
  Modal) were considered and declined on the PRD §12 data boundary; the
  adapter seam is where one could slot in later if pod cold-starts ever
  hurt. Ballpark at one user × 4h/day: ~$10/month of pod time (2 vCPU/4GB ≈
  $0.11/h), first-cluster management fee covered by GKE's free tier.
- **Sessions are runner-family and hold the model key.** The running app
  calls models through `civil_runtime.engines`, so the session machine
  carries the platform Anthropic key exactly as the runner does — the same
  documented exception, the same blast radius, no platform credentials
  beyond it.
- **The PORT convention**: a client node's dev script must bind the port the
  session hands it in `$PORT` (the Heroku convention). This is the one thing
  Civil asks of a frontend's tooling.

## Open items, recorded not resolved

- Deployed-adapter proxying: session URLs, auth (the session is the owner's
  only), websocket passthrough for HMR. Local sidesteps all three.
- Restart policy for crashed dev scripts; what "the app is up" means for a
  session with several processes.
- Session ⇄ pending write-through ordering and conflict with a concurrent
  editor elsewhere (same rule as everywhere: mine or theirs, no merging).
- Dependency warm-up for fast rematerialisation (prebuilt images, cached
  node_modules) — the local adapter's shared venv is the v1 shortcut.
