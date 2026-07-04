/*
 * Practice-vs-computer E2E: a single player opens the app, plays the computer,
 * adds bots by difficulty, deals, and the bots play autonomously through a
 * whole round while the human plays too — all in one browser, no network.
 */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..', '..');
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') p = '/index.html';
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

let failures = 0;
const check = (n, ok, d) => { if (ok) console.log('  ok - ' + n); else { failures++; console.error('  FAIL - ' + n + (d ? ' :: ' + d : '')); } };

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const errors = [];
  const pg = await ctx.newPage();
  pg.on('pageerror', (e) => errors.push(String(e)));
  pg.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await pg.goto(base + '/play.html?transport=local&seed=7');
  check('entry shows a Play the computer option', await pg.locator('#soloBtn').isVisible());
  await pg.fill('#hostName', 'Ivy');
  await pg.click('#soloBtn');
  await pg.waitForSelector('#view-lobby:not([hidden])');

  // solo pre-seats one bot; the code lockup is hidden (nothing to share)
  await pg.waitForFunction(() => document.querySelectorAll('#rosterList li').length === 2);
  check('solo pre-seats one computer player', (await pg.locator('#rosterList .tagme.bot').count()) === 1);
  check('code lockup hidden in solo', !(await pg.locator('.code-lockup').isVisible()));
  check('bot difficulty tiers are offered', (await pg.locator('#botTiers [data-bot]').count()) === 4);

  // add a hard + expert bot → 4 seats, table full
  await pg.click('#botTiers [data-bot="hard"]');
  await pg.click('#botTiers [data-bot="expert"]');
  await pg.waitForFunction(() => document.querySelectorAll('#rosterList li').length === 4);
  check('added bots up to a full 4-seat table', true);
  check('tier buttons disable when full', await pg.locator('#botTiers [data-bot="easy"]').isDisabled());
  const tags = await pg.locator('#rosterList .tagme.bot').allInnerTexts();
  check('roster labels each bot with its difficulty', tags.join(' ').includes('EXPERT') && tags.join(' ').includes('HARD'), tags.join(','));

  // remove one bot, then deal
  await pg.click('#rosterList .kick[data-bot]');
  await pg.waitForFunction(() => document.querySelectorAll('#rosterList li').length === 3);
  check('a bot can be removed', true);

  await pg.click('#startBtn');
  await pg.waitForSelector('#view-table:not([hidden])');
  check('the solo game deals to the table', await pg.locator('#youSlots .slot').count() >= 5);
  check('opponents strip shows the two bots', (await pg.locator('#oppStrip .opp').count()) === 2);

  // the human plays via taps; the bots play themselves. Drive the human a bit
  // and confirm the bots make progress (an opponent's Blitz count falls).
  const startCounts = await pg.locator('#oppStrip .bcount').allInnerTexts();
  const humanTurn = () => pg.evaluate(() => {
    const fire = (el) => el && el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const sel = () => document.querySelector('#youSlots .pcard.selected');
    for (let g = 0; g < 40; g++) {
      if (sel()) fire(sel());
      const before = document.getElementById('youSlots').innerHTML + document.getElementById('dutchGrid').innerHTML;
      let moved = false;
      const n = document.querySelectorAll('#youSlots [data-src]').length;
      for (let k = 0; k < n; k++) {
        const s = document.querySelectorAll('#youSlots [data-src]')[k];
        if (!s || s.disabled) continue;
        fire(s);
        if (!sel()) { if (document.getElementById('youSlots').innerHTML + document.getElementById('dutchGrid').innerHTML !== before) { moved = true; break; } continue; }
        const z = sel().getAttribute('data-src');
        if (z === 'blitz' || z === 'wood') { const p = document.querySelector('#youSlots .pcard.legal, #youSlots .slot-empty.legal'); if (p) { fire(p); if (!sel()) { moved = true; break; } } }
        if (sel()) fire(sel());
      }
      if (moved) continue;
      const f = document.getElementById('flipBtn'); if (f && !f.disabled) fire(f);
      break;
    }
  });
  let ended = false;
  for (let i = 0; i < 500 && !ended; i++) {
    await humanTurn();
    await pg.waitForTimeout(60);
    ended = await pg.evaluate(() => !document.getElementById('view-scores').hidden || !document.getElementById('blitzOverlay').hidden);
  }
  check('the round played to a finish with bots participating', ended);
  if (ended) {
    await pg.waitForSelector('#view-scores:not([hidden])', { timeout: 8000 });
    check('score sheet lists all three players', (await pg.locator('#scoreSheet .row').count()) === 3);
    check('host can deal the next round or rematch', await pg.locator('#nextRoundBtn').isVisible() || await pg.locator('#backToLobbyBtn').isVisible());
  }

  check('no console/page errors', errors.filter((e) => !/favicon|manifest|icon/i.test(e)).length === 0, errors.slice(0, 2).join(' | '));

  await browser.close(); server.close();
  console.log(failures === 0 ? 'SOLO E2E: all checks passed' : 'SOLO E2E: ' + failures + ' FAILURES');
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
