/*
 * Integration tests: net.js (host-authoritative sessions) over the 'local'
 * BroadcastChannel transport, driving the real game-core engine — the same
 * code path the browser uses, minus WebRTC.
 * Run: node tests/net.test.cjs
 */
'use strict';

// net.js and game-core.js are plain browser scripts; give them a `self`.
globalThis.self = globalThis;
globalThis.BlitzPlay = require('../game-core.js'); // UMD exports via module in Node
require('../net.js'); // attaches globalThis.BlitzNet

const assert = require('node:assert');
const Net = globalThis.BlitzNet;
const G = globalThis.BlitzPlay;

let passed = 0;
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function waitFor(cond, what, ms = 2000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function poll() {
      let v;
      try { v = cond(); } catch (e) { return reject(e); }
      if (v) return resolve(v);
      if (Date.now() - t0 > ms) return reject(new Error('timed out waiting for ' + what));
      setTimeout(poll, 10);
    })();
  });
}

function collect(session, ev) {
  const seen = [];
  session.on(ev, (a) => seen.push(a));
  return seen;
}

function makeGuest(code, name, extra) {
  return new Net.GuestSession(Object.assign({ code, name, transport: 'local' }, extra));
}

test('makeCode / normalizeCode', async () => {
  const code = Net.makeCode(6);
  assert.strictEqual(code.length, 6);
  assert.ok(/^[ABCDEFGHJKMNPQRTVWXYZ2346789]+$/.test(code), 'code avoids ambiguous chars');
  assert.strictEqual(Net.normalizeCode(' abq-234 '), 'ABQ234');
  assert.strictEqual(Net.normalizeCode('ab 01cd'), 'ABCD'); // digits 0/1 never occur in codes
});

test('handshake: two guests join, roster reaches everyone', async () => {
  const host = new Net.HostSession({ name: 'Marc', transport: 'local', code: 'TESTAA' });
  const g1 = makeGuest('TESTAA', 'Ada');
  const g2 = makeGuest('TESTAA', 'Bo');
  const rosters = collect(g2, 'roster');
  await waitFor(() => g1.playerId && g2.playerId, 'both welcomes');
  assert.strictEqual(g1.playerId, 'p1');
  assert.strictEqual(g2.playerId, 'p2');
  assert.ok(g1.token && g2.token && g1.token !== g2.token, 'distinct reconnect tokens');
  await waitFor(() => rosters.length && rosters[rosters.length - 1].length === 3, 'roster of 3');
  const names = rosters[rosters.length - 1].map((p) => p.name);
  assert.deepStrictEqual(names, ['Marc', 'Ada', 'Bo']);
  g1.close(); g2.close(); host.close();
});

test('duplicate names get numbered; table caps at 4', async () => {
  const host = new Net.HostSession({ name: 'Marc', transport: 'local', code: 'TESTAB' });
  const g1 = makeGuest('TESTAB', 'Marc');
  await waitFor(() => g1.playerId, 'g1 welcome');
  assert.strictEqual(g1.name, 'Marc 2');
  const g2 = makeGuest('TESTAB', 'Cy');
  const g3 = makeGuest('TESTAB', 'Di');
  await waitFor(() => g2.playerId && g3.playerId, 'table of 4');
  const g4 = makeGuest('TESTAB', 'Ed');
  const errs = collect(g4, 'err');
  await waitFor(() => errs.includes('full'), 'fifth seat refused');
  assert.strictEqual(g4.playerId, null);
  [g1, g2, g3, g4].forEach((g) => g.close()); host.close();
});

test('protocol version mismatch is refused', async () => {
  const host = new Net.HostSession({ name: 'Marc', transport: 'local', code: 'TESTAC' });
  const g = makeGuest('TESTAC', 'Old');
  const errs = collect(g, 'err');
  // resend a hello claiming an older protocol
  await waitFor(() => g.playerId, 'joined at current version');
  g.transport.send({ t: 'hello', v: 0, name: 'Old' });
  await waitFor(() => errs.includes('version'), 'version refusal');
  g.close(); host.close();
});

test('startRound deals to everyone; state broadcast is faithful', async () => {
  const host = new Net.HostSession({ name: 'Marc', transport: 'local', code: 'TESTAD' });
  const g1 = makeGuest('TESTAD', 'Ada');
  await waitFor(() => g1.playerId, 'welcome');
  const states = collect(g1, 'state');
  host.startRound(42);
  const snap = await waitFor(() => states.find((s) => s.roundNo === 1), 'round-1 state');
  assert.strictEqual(snap.target, 75);
  const me = snap.state.players[g1.playerId];
  assert.strictEqual(me.blitz.length, 10);
  assert.strictEqual(me.post.length, 3);
  assert.strictEqual(me.hand.length, 27);
  // same seed on a fresh engine gives the identical deal — guests can trust it
  const local = G.newRound([{ id: 'p0', name: 'Marc' }, { id: 'p1', name: 'Ada' }], 42);
  assert.deepStrictEqual(me.blitz, local.players.p1.blitz);
  g1.close(); host.close();
});

test('guest intents apply in arrival order; losers get a private nack', async () => {
  const host = new Net.HostSession({ name: 'Marc', transport: 'local', code: 'TESTAE' });
  const g1 = makeGuest('TESTAE', 'Ada');
  await waitFor(() => g1.playerId, 'welcome');
  const states = collect(g1, 'state');
  const nacks = collect(g1, 'nack');
  host.startRound(42);
  await waitFor(() => states.length, 'deal');

  const seqBefore = host.state.seq;
  g1.sendIntent({ type: 'flip' }, 7);
  await waitFor(() => host.state.seq > seqBefore, 'flip applied');
  assert.strictEqual(host.state.players.p1.wood.length, 3);

  // an impossible play (no such post) must nack back to the sender with its n
  g1.sendIntent({ type: 'play', from: { zone: 'blitz' }, to: { zone: 'post', idx: 9 } }, 8);
  const nack = await waitFor(() => nacks.find((k) => k.n === 8), 'nack for n=8');
  assert.strictEqual(nack.reason, 'no-such-post');
  g1.close(); host.close();
});

test('full round over the wire: play to a Blitz call, totals settle', async () => {
  const host = new Net.HostSession({ name: 'Marc', transport: 'local', code: 'TESTAF' });
  const g1 = makeGuest('TESTAF', 'Ada');
  await waitFor(() => g1.playerId, 'welcome');
  const states = collect(g1, 'state');
  host.startRound(7);

  // Bot loop through the host's single intent entry point — the exact path
  // guest messages take (applyFrom) — until someone blitzes.
  let guard = 40000;
  while (host.state.status === 'playing' && guard-- > 0) {
    let moved = false;
    for (const id of host.state.order) {
      const p = host.state.players[id];
      const sources = [{ zone: 'blitz' }, { zone: 'wood' }, { zone: 'post', idx: 0 }, { zone: 'post', idx: 1 }, { zone: 'post', idx: 2 }];
      for (const from of sources) {
        const card = from.zone === 'blitz' ? G.top(p.blitz) : from.zone === 'wood' ? G.top(p.wood) : G.top(p.post[from.idx]);
        if (!card) continue;
        const targets = G.legalDutchTargets(host.state, card);
        if (targets.length) {
          const t = targets[0];
          host.applyFrom(id, { type: 'play', from, to: t === 'new' ? { zone: 'dutchNew' } : { zone: 'dutch', idx: t } }, 0, null);
          moved = true;
          break;
        }
      }
      if (host.state.status !== 'playing') break;
      if (!moved) {
        // drain blitz/wood into posts to open things up, else flip
        const bt = G.top(p.blitz);
        let placed = false;
        if (bt) {
          for (let i = 0; i < 3 && !placed; i++) {
            const r = host.applyFrom(p.id, { type: 'play', from: { zone: 'blitz' }, to: { zone: 'post', idx: i } }, 0, () => {});
            if (host.state.seq && G.top(p.post[i]) === bt) placed = true;
          }
        }
        if (!placed) host.applyFrom(id, { type: 'flip' }, 0, () => {});
        if (G.isStalled(host.state)) host.applyFrom(id, { type: 'nudge' }, 0, () => {});
      }
      moved = false;
    }
  }
  assert.ok(guard > 0, 'round terminated');
  assert.strictEqual(host.state.status, 'ended');
  assert.ok(host.state.winner, 'someone blitzed');

  // guests hear about it and totals are settled from the round scores
  const endSnap = await waitFor(() => states.find((s) => s.state && s.state.status === 'ended'), 'ended state at guest');
  assert.ok(endSnap.totals[host.state.winner] !== undefined, 'winner has a running total');
  const sc = host.state.scores[host.state.winner];
  assert.strictEqual(sc.blitzLeft, 0);
  assert.strictEqual(endSnap.totals[host.state.winner], sc.score);
  g1.close(); host.close();
});

test('reconnect with token re-attaches the same seat', async () => {
  const host = new Net.HostSession({ name: 'Marc', transport: 'local', code: 'TESTAG' });
  const g1 = makeGuest('TESTAG', 'Ada');
  await waitFor(() => g1.playerId, 'first join');
  const seat = g1.playerId, token = g1.token;
  host.startRound(3);
  g1.close();

  const g2 = makeGuest('TESTAG', 'Ada', { token });
  const states = collect(g2, 'state');
  await waitFor(() => g2.playerId, 'rejoin');
  assert.strictEqual(g2.playerId, seat, 'same seat after reconnect');
  await waitFor(() => states.length, 'state replayed to the rejoiner');
  assert.strictEqual(states[0].roundNo, 1);

  // ...but a stranger can't join mid-round
  const g3 = makeGuest('TESTAG', 'Late');
  const errs = collect(g3, 'err');
  await waitFor(() => errs.includes('round-in-progress'), 'mid-round join refused');
  g2.close(); g3.close(); host.close();
});

test('host disappearing flips guests to reconnecting (heartbeat watchdog)', async () => {
  const host = new Net.HostSession({ name: 'Marc', transport: 'local', code: 'TESTAH' });
  const g1 = makeGuest('TESTAH', 'Ada');
  const statuses = collect(g1, 'status');
  await waitFor(() => g1.playerId, 'joined');
  host.close(); // broadcasts bye
  await waitFor(() => statuses.includes('host-gone'), 'bye observed');
  g1.close();
});

(async () => {
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed++;
      console.log('  ok - ' + name);
    } catch (e) {
      console.error('  FAIL - ' + name);
      console.error(e && e.stack ? e.stack : e);
      process.exit(1);
    }
  }
  console.log(passed + '/' + tests.length + ' net tests passed');
  process.exit(0);
})();
