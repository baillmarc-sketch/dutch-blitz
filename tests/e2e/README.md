# Browser E2E tests (live tables)

These drive `play.html` in a real headless Chromium via Playwright. They are
**not** part of the zero-dependency CI battery (`engine`/`game-core`/`net`
tests, which run under plain `node`); run them locally when touching the
multiplayer client.

```sh
npm install playwright          # one-time; installs its own Chromium
node tests/e2e/play.e2e.cjs     # host+guest play a full round through real taps
node tests/e2e/xss.e2e.cjs      # a malicious host cannot XSS a guest
```

- `play.e2e.cjs` — two tabs over the `?transport=local` BroadcastChannel path
  (the production code path minus WebRTC). Uses `?seed=7` for a deterministic
  deal that always reaches a Blitz call. Verifies the full flow: home link,
  entry, lobby, join, roster, deal, opponent strip, Dutch grid, flip, a
  complete round, score sheet, next-round controls, score-tracker logging, and
  zero console errors under the page's strict CSP.
- `xss.e2e.cjs` — a bare page speaks the wire protocol by hand as a **hostile
  host**, feeding a real guest client a state whose card colors, values, and
  player names are HTML/script payloads. Asserts nothing executes and no
  attacker markup lands in the DOM (colors whitelisted, numbers coerced, names
  escaped).

If Playwright's bundled Chromium isn't used, point `PW_CHROMIUM` at a browser
binary: `PW_CHROMIUM=/path/to/chrome node tests/e2e/play.e2e.cjs`.
