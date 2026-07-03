# Dutch Blitz Sidecar

A phone-first companion you keep open while playing **physical Dutch Blitz** — quick rules, a beginner cheat-sheet, and a fast score tracker that survives negative rounds and mid-game corrections.

It's a **sidecar, not the game**: it lives next to the real deck, works fully offline, and is built for the one high-stress moment when someone yells *"Blitz!"* and scores need logging fast.

## Run locally

No build, no dependencies. Any of these works:

```bash
# option 1: just open it
open index.html            # runs straight from file://

# option 2: serve it (enables the service worker / installable PWA)
python3 -m http.server 8000
# → http://localhost:8000
```

On a phone (Chrome/Android): open the deployed URL once, and it works offline afterward. "Add to home screen" installs it as an app.

## Features

- **Score tracker** — the core:
  - Two entry modes: **Simple** (type each round score) and **Calculator** (cards played to Dutch piles + cards left in Blitz pile → auto-computed).
  - Negative scores, leaderboard with leader/target flags (non-color cues included), undo last round, edit or delete any past round, reset scores while keeping players.
  - **Corrections**: explicit adjustment entries (per round or standalone), always labeled in history, never hidden.
  - Add / rename / remove players mid-game; duplicate names auto-deduped; mid-game target changes handled.
  - Export / copy the full history as plain text.
- **Rules hub** — plain-English summary verified against the official rules (with a visible "check the official rules for disputes" note).
- **Beginner guide** — a seven-point cheat sheet.
- **Dashboard** — resume the last game, see live standings, one-tap Add Round, previous games list.
- **PWA** — offline-first service worker, installable, dark mode (warm, not gray), game-night big-type mode, optional sound (off by default), confetti on win (respects reduced-motion).

## Scoring formula

Per round, per player (official Dutch Blitz scoring):

```
score = cardsPlayedToDutchPiles − 2 × cardsLeftInBlitzPile
```

Totals accumulate across rounds (negatives allowed); first to the target (default **75**) wins.

## Data safety

- Everything autosaves to `localStorage` on every change — no save buttons, no backend, no account.
- **Merge-not-clobber**: writes go through a monotonic revision guard, so a stale tab can add its work but can never overwrite newer scores.
- **Corrupted saves are never wiped silently**: unreadable data is backed up under a timestamped key and the app tells you.

## Seed data = regression test

On first run the app loads a sample game (also the engine's test fixture):
R1: Ryan −2, Jessica 8, Anna 16, Marc 9 · R2: Ryan 13, Jessica 18, Anna −10, Marc 14 · Correction: Anna +3 after R2.
Expected totals: **Jessica 26 · Marc 23 · Ryan 11 · Anna 9** — the test suite fails if the engine ever disagrees.

## Tests

```bash
node tests/engine.test.cjs   # engine + storage unit tests (pure Node, no deps)
```

Headless end-to-end verification (seed totals in the DOM, round entry through the real UI, persistence across reload, corrupted-save recovery) runs via Playwright against real Chromium; see the PR that introduced the app for pasted results.

## Architecture

| File | Role |
|---|---|
| `engine.js` | Pure scoring/game logic (no DOM, no storage) — shared verbatim by browser and tests |
| `storage.js` | localStorage persistence: autosave, revision-guarded merge, corruption fail-safe |
| `app.js` | UI wiring (tabs, dialogs, rendering) |
| `sw.js` | Offline cache-first service worker |
| `tests/engine.test.cjs` | Unit tests incl. the seed regression |

Vanilla HTML/CSS/JS by design: a rules page plus a score table doesn't need a framework, and no build step means it runs from a clean checkout and deploys as static files.

## Future ideas

- Quick round presets (e.g. "+10", "blitzed with N left")
- Round timer for the timed variation
- Share standings as an image
- Per-player stats across games (best round, blitz rate)
