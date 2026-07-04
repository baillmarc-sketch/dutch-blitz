/*
 * Two live-table features over the local transport:
 *  - table talk: quick-reacts + typed messages relay to every seat, escaped
 *  - rejoin: a guest who reloads / hits back slides straight back into its seat
 *    (?resume=1 opts the local transport into the auto-resume the peer
 *    transport does by default)
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
  const errors = [];

  // Two seats must share a context (BroadcastChannel is per-context), so they
  // share localStorage too — fine for chat. For rejoin we test the guest that
  // talks to a RAW host (no play.js, no localStorage), so only one play.js
  // client touches storage and there's no cross-tab clobber.

  // ---------- chat ----------
  const ctxA = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const host = await ctxA.newPage();
  const guest = await ctxA.newPage();
  [host, guest].forEach((pg) => { pg.on('pageerror', (e) => errors.push(String(e))); pg.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); }); });
  await host.goto(base + '/play.html?transport=local');
  await host.fill('#hostName', 'Marc');
  await host.click('#createBtn');
  await host.waitForSelector('#view-lobby:not([hidden])');
  const code = (await host.locator('#codeText').innerText()).replace(/\s/g, '');
  await guest.goto(base + '/play.html?transport=local');
  await guest.fill('#joinName', 'Ada');
  await guest.fill('#joinCode', code);
  await guest.click('#joinBtn');
  await guest.waitForSelector('#view-lobby:not([hidden])');

  check('chat dock is visible in the lobby', await host.locator('#chatDock').isVisible());
  check('three quick-reacts are present', await host.locator('.chat-reacts .react').count() === 3);

  // guest taps whatever quick-react is showing (they're random each round) → host sees exactly it
  const reactText = (await guest.locator('.chat-reacts .react').first().innerText()).trim();
  await guest.locator('.chat-reacts .react').first().click();
  await host.waitForFunction(() => document.querySelectorAll('#chatLog .chat-line').length >= 1);
  const hostSaw = await host.locator('#chatLog .chat-line').last().innerText();
  check('quick-react relays to the host verbatim', /Ada/.test(hostSaw) && hostSaw.includes(reactText), hostSaw + ' :: sent ' + reactText);

  // host types a message → guest sees it, attributed to the host
  await host.fill('#chatText', 'good luck all');
  await host.click('#chatSend');
  await guest.waitForFunction(() => [...document.querySelectorAll('#chatLog .chat-line')].some((l) => /good luck all/.test(l.textContent)));
  check('typed host message relays to the guest', true);

  // an HTML payload in a chat message is escaped, not executed
  let alerted = false; guest.on('dialog', (d) => { alerted = true; d.dismiss(); });
  await guest.fill('#chatText', '<img src=x onerror="window.__c=1">hi');
  await guest.click('#chatSend');
  await host.waitForFunction(() => [...document.querySelectorAll('#chatLog .chat-line')].some((l) => /hi/.test(l.textContent)));
  await host.waitForTimeout(150);
  check('chat HTML is escaped (no injected img)', await host.evaluate(() => !document.querySelector('#chatLog img')));
  check('chat script payload did not execute', !(await host.evaluate(() => window.__c)) && !alerted);
  await ctxA.close();

  // ---------- rejoin after reload ----------
  const ctxB = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const evil = await ctxB.newPage(); // benign raw host — persists across the guest reload
  await evil.goto(base + '/play.html');
  await evil.evaluate(() => {
    const ch = new BroadcastChannel('pileon-REJOIN');
    const down = (to, msg) => ch.postMessage({ dir: 'down', to, msg });
    const seats = {}; // token -> playerId
    let n = 0;
    window.__hellos = 0;
    ch.onmessage = (e) => {
      const m = e.data; if (!m || m.dir !== 'up') return;
      if (m.msg && m.msg.t === 'hello') {
        window.__hellos++;
        let id = m.msg.token && seats[m.msg.token];
        let token = m.msg.token;
        if (!id) { id = 'p' + (++n); token = 'tok-' + n; seats[token] = id; }
        down(m.from, { t: 'welcome', playerId: id, name: 'Ada', token, code: 'REJOIN',
          roster: [{ id: 'p0', name: 'Marc', connected: true }, { id, name: 'Ada', connected: true }] });
      }
    };
  });

  const player = await ctxB.newPage();
  player.on('pageerror', (e) => errors.push(String(e)));
  await player.goto(base + '/play.html?transport=local&resume=1');
  await player.fill('#joinName', 'Ada');
  await player.fill('#joinCode', 'REJOIN');
  await player.click('#joinBtn');
  await player.waitForSelector('#view-lobby:not([hidden])', { timeout: 8000 });
  const token1 = await player.evaluate(() => JSON.parse(localStorage.getItem('pileon.session')).token);
  check('guest joined and stored a resume token', !!token1, token1);

  // the accidental reload — the guest should rejoin WITHOUT re-typing the code
  await player.reload();
  const rejoined = await player.waitForSelector('#view-lobby:not([hidden])', { timeout: 8000 }).then(() => true).catch(() => false);
  check('guest auto-rejoined its table after a reload', rejoined);
  check('rejoin reused the saved seat token (no re-entry)', await player.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('pileon.session') || '{}'); return s.code === 'REJOIN';
  }));
  const hellos = await evil.evaluate(() => window.__hellos);
  check('host received a second hello (the reconnect)', hellos >= 2, 'hellos=' + hellos);
  check('the entry form was never shown on reload', !(await player.locator('#view-entry').isVisible()));

  check('no console/page errors', errors.filter((e) => !/favicon|manifest|icon/i.test(e)).length === 0, errors.slice(0, 2).join(' | '));

  await browser.close();
  server.close();
  console.log(failures === 0 ? 'CHAT+REJOIN E2E: all checks passed' : 'CHAT+REJOIN E2E: ' + failures + ' FAILURES');
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
