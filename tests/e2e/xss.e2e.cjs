/*
 * Adversarial XSS regression: a MALICIOUS HOST (raw BroadcastChannel, not the
 * real client) feeds a real guest client a state whose card colors, card
 * values, and player names are HTML/script payloads. The hardened client must
 * whitelist colors, coerce numbers, and escape names — so nothing executes and
 * no attacker markup lands in the DOM.
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

  let alertFired = false;
  ctx.on('page', (pg) => pg.on('dialog', (d) => { alertFired = true; d.dismiss(); }));

  // Evil host: a bare page on the same origin speaking the wire protocol by
  // hand. Its BroadcastChannel listener must be live BEFORE the victim's hello,
  // so we start it first. It answers hello, then pushes a poisoned state.
  const evil = await ctx.newPage();
  await evil.goto(base + '/play.html'); // same origin; we don't use its client
  await evil.evaluate(() => {
    const C = '"><img src=x onerror="window.__XSS=(window.__XSS||0)+1">';
    const NAME = '<img src=x onerror="window.__XSS=(window.__XSS||0)+1">';
    const ch = new BroadcastChannel('pileon-HACKED');
    const down = (to, msg) => ch.postMessage({ dir: 'down', to, msg });
    const poisoned = {
      status: 'playing', seq: 1, winner: null, scores: null, completedPiles: 0,
      order: ['pV', 'pE'],
      dutch: [{ color: C, top: '5"><script>window.__XSS=1<\/script>', done: false }],
      players: {
        pV: { id: 'pV', name: 'Victim', identity: 'red', dutchCount: 0,
          blitz: [{ color: C, value: '3"><b>x', owner: 'pV' }],
          post: [[], [], []], hand: new Array(5).fill(0).map(() => ({})), wood: [] },
        pE: { id: 'pE', name: NAME, identity: 'blue', dutchCount: 0,
          blitz: new Array(10), post: [[], [], []], hand: new Array(27), wood: [] },
      },
    };
    ch.onmessage = (e) => {
      const m = e.data;
      if (!m || m.dir !== 'up') return;
      const from = m.from;
      if (m.msg && m.msg.t === 'hello') {
        down(from, { t: 'welcome', playerId: 'pV', name: 'Victim', token: 'x', code: 'HACKED',
          roster: [{ id: 'pE', name: NAME, connected: true }, { id: 'pV', name: 'Victim', connected: true }] });
        down('*', { t: 'state', roundNo: 1, target: 75, totals: {}, state: poisoned });
      }
    };
  });

  // Victim: a real guest client joining code HACKED over the local transport.
  const victim = await ctx.newPage();
  victim.on('dialog', (d) => { alertFired = true; d.dismiss(); });
  await victim.goto(base + '/play.html?transport=local');
  await victim.fill('#joinName', 'Victim');
  await victim.fill('#joinCode', 'HACKED');
  await victim.click('#joinBtn');

  const reached = await victim.waitForSelector('#view-table:not([hidden])', { timeout: 8000 }).then(() => true).catch(() => false);
  check('victim rendered the poisoned table', reached);
  // let any async onerror fire
  await victim.waitForTimeout(300);

  const xssV = await victim.evaluate(() => window.__XSS);
  const xssE = await evil.evaluate(() => window.__XSS);
  check('no onerror/script payload executed on the victim', !xssV, 'window.__XSS=' + xssV);
  check('no dialog/alert fired', !alertFired);
  const imgInfo = await victim.evaluate(() => { const im = document.querySelector('img'); return im ? (im.parentElement ? im.parentElement.className + '#' + im.parentElement.id : '?') + ' :: ' + im.outerHTML.slice(0, 100) : null; });
  check('no injected <img> anywhere in the victim DOM', !imgInfo, imgInfo || '');
  const dutchColor = await victim.evaluate(() => { const b = document.querySelector('#dutchGrid .pile.live'); return b ? b.getAttribute('data-c') : null; });
  check('malicious color coerced to a safe whitelist value', ['red', 'blue', 'green', 'yellow'].includes(dutchColor), String(dutchColor));
  const oppName = await victim.evaluate(() => { const n = document.querySelector('#oppStrip .nm'); return n ? n.innerHTML : ''; });
  check('opponent name is HTML-escaped', oppName.includes('&lt;img') && !oppName.includes('<img'), oppName.slice(0, 40));

  await browser.close();
  server.close();
  console.log(failures === 0 ? 'XSS E2E: all checks passed' : 'XSS E2E: ' + failures + ' FAILURES');
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
