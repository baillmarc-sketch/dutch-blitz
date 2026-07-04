/*
 * Headless E2E of play.html: host + guest in two tabs of one Chromium
 * context, talking over the real BroadcastChannel transport
 * (?transport=local) — everything except WebRTC is the production path.
 */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..', '..');
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') p = '/index.html';
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('nope'); return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

let failures = 0;
function check(name, ok, detail) {
  if (ok) console.log('  ok - ' + name);
  else { failures++; console.error('  FAIL - ' + name + (detail ? ' :: ' + detail : '')); }
}

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  const errors = [];
  const mkPage = async () => {
    const pg = await ctx.newPage();
    pg.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    pg.on('pageerror', (e) => errors.push(String(e)));
    return pg;
  };

  // ---- home page links to the live table ----
  const home = await mkPage();
  await home.goto(base + '/index.html');
  check('home page has a Play online link', await home.locator('a[href="play.html"]').count() === 1);
  await home.close();

  // ---- host creates a table ----
  const host = await mkPage();
  // fixed seed → a deal the two bots can always drive to a real Blitz call
  await host.goto(base + '/play.html?transport=local&seed=7');
  check('entry view shows on load', await host.locator('#view-entry').isVisible());
  check('table view is truly hidden at load', !(await host.locator('#view-table').isVisible()));
  await host.fill('#hostName', 'Marc');
  await host.click('#createBtn');
  await host.waitForSelector('#view-lobby:not([hidden])');
  const code = (await host.locator('#codeText').innerText()).replace(/\s/g, '');
  check('lobby shows a 6-char code', /^[A-Z2-9]{6}$/.test(code), code);
  check('host sees start disabled solo', await host.locator('#startBtn').isDisabled());

  // ---- guest joins with the code ----
  const guest = await mkPage();
  await guest.goto(base + '/play.html?transport=local&seed=7');
  await guest.fill('#joinName', 'Ada');
  await guest.fill('#joinCode', code);
  await guest.click('#joinBtn');
  await guest.waitForSelector('#view-lobby:not([hidden])');
  await guest.waitForFunction(() => document.querySelectorAll('#rosterList li').length === 2);
  await host.waitForFunction(() => document.querySelectorAll('#rosterList li').length === 2);
  check('both lobbies list 2 players', true);
  const names = await host.locator('#rosterList .nm').allInnerTexts();
  check('roster names are Marc + Ada', names.join(',') === 'Marc,Ada', names.join(','));
  check('guest sees waiting note', (await guest.locator('#guestLobbyNote').innerText()).includes('Marc'));

  // ---- bad code is refused with a friendly error ----
  const late = await mkPage();
  await late.goto(base + '/play.html?transport=local&room=QQQQQQ');
  await late.fill('#joinName', 'Zed');
  await late.click('#joinBtn');
  // local transport has no room-existence check; guests just never get a
  // welcome. Assert the deep link prefilled the code instead.
  check('deep link ?room= prefills the code', (await late.inputValue('#joinCode')) === 'QQQQQQ');
  await late.close();

  // ---- host deals; both land on the table ----
  await host.click('#startBtn');
  await host.waitForSelector('#view-table:not([hidden])');
  await guest.waitForSelector('#view-table:not([hidden])');
  check('lobby hides once playing (host)', !(await host.locator('#view-lobby').isVisible()));
  const hostBlitz = await host.locator('#youSlots .slot').first().locator('.lbl').innerText();
  check('host sees Blitz · 10', hostBlitz.includes('10'), hostBlitz);
  check('guest sees one opponent chip', await guest.locator('#oppStrip .opp').count() === 1);
  const oppCount = await guest.locator('#oppStrip .bcount').innerText();
  check('opponent blitz badge starts at 10', oppCount.trim() === '10', oppCount);
  check('dutch grid renders 8 empty slots', await host.locator('#dutchGrid .pile').count() === 8);

  // ---- guest flips; wood card appears; flip label counts down ----
  const flipBefore = await guest.locator('#flipBtn').innerText();
  await guest.tap('#flipBtn');
  await guest.waitForFunction(() => {
    const slots = document.querySelectorAll('#youSlots .slot');
    return slots[4] && slots[4].querySelector('.pcard:not(.back)');
  });
  const flipAfter = await guest.locator('#flipBtn').innerText();
  check('flip revealed a wood card and counted down', flipBefore.includes('27') && flipAfter.includes('24'), flipBefore + ' -> ' + flipAfter);

  // ---- drive both seats to a real Blitz call through the UI ----
  // Bot: tap cards that have a legal play; flip otherwise. All through
  // dispatched taps, exactly like thumbs would.
  // One evaluate = one whole "turn" of taps (drain every legal move, then a
  // flip) so the round completes in a handful of browser round-trips, not
  // thousands. Returns true if it made any progress this turn.
  const botTurn = async (pg) => {
    return pg.evaluate(() => {
      const fire = (el) => el && el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      const selected = () => document.querySelector('#youSlots .pcard.selected');
      const board = () => document.getElementById('youSlots').innerHTML + document.getElementById('dutchGrid').innerHTML;
      let progressed = false;
      for (let guard = 0; guard < 60; guard++) {
        if (selected()) fire(selected());
        const before = board();
        let movedThisPass = false;
        const total = document.querySelectorAll('#youSlots [data-src]').length;
        for (let k = 0; k < total; k++) {
          const s = document.querySelectorAll('#youSlots [data-src]')[k];
          if (!s || s.disabled) continue;
          fire(s); // auto-plays to a Dutch pile when legal, else selects
          if (!selected()) { if (board() !== before) { movedThisPass = true; break; } continue; }
          const zone = selected().getAttribute('data-src');
          if (zone === 'blitz' || zone === 'wood') {
            const post = document.querySelector('#youSlots .pcard.legal, #youSlots .slot-empty.legal');
            if (post) { fire(post); if (!selected()) { movedThisPass = true; break; } }
          }
          if (selected()) fire(selected());
        }
        if (movedThisPass) { progressed = true; continue; }
        const flip = document.getElementById('flipBtn');
        if (flip && !flip.disabled) { fire(flip); progressed = true; }
        break; // one flip per turn, then yield so the host state broadcasts
      }
      return progressed;
    });
  };
  let ended = false;
  for (let i = 0; i < 4000 && !ended; i++) {
    await Promise.all([botTurn(host), botTurn(guest)]);
    ended = await host.evaluate(() => !document.getElementById('view-scores').hidden || !document.getElementById('blitzOverlay').hidden);
    if (i % 40 === 0) {
      const dutch = await host.locator('#dutchGrid').innerText().catch(() => '?');
      console.log(`    [i=${i}] dutch: ${dutch.replace(/\s+/g, ' ').slice(0, 80)}`);
    }
  }
  check('a full round played to a Blitz call through taps', ended);
  if (ended) {
    await host.waitForSelector('#view-scores:not([hidden])', { timeout: 8000 });
    await guest.waitForSelector('#view-scores:not([hidden])', { timeout: 8000 });
    const sheet = await host.locator('#scoreSheet .row').count();
    check('score sheet lists both players', sheet === 2, String(sheet));
    const title = await host.locator('#scoresTitle').innerText();
    check('scores title names the round/target', /75/.test(title), title);
    check('host can deal the next round', await host.locator('#nextRoundBtn').isVisible());
    // rounds logged into the score tracker
    const logged = await host.evaluate((c) => {
      const raw = localStorage.getItem('dutch-blitz-sidecar/v1') || '';
      return raw.includes('Online · ' + c);
    }, code);
    check('round logged into local score tracker', logged);
  }

  // ---- console noise ----
  const realErrors = errors.filter((e) => !/favicon|manifest|icon/i.test(e));
  check('no console/page errors anywhere', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));

  await browser.close();
  server.close();
  console.log(failures === 0 ? 'E2E: all checks passed' : 'E2E: ' + failures + ' FAILURES');
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
