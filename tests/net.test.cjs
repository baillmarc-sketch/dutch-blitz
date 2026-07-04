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
globalThis.BlitzBot = require('../bot.js'); // host uses this to drive bots
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

test('security: the host seat cannot be hijacked with a guessed token', async () => {
  const host = new Net.HostSession({ name: 'Marc', transport: 'local', code: 'SECAAA' });
  // a hostile guest tries the old fixed host token, then a fabricated one
  const g = makeGuest('SECAAA', 'Mallory', { token: 'host' });
  await waitFor(() => g.playerId, 'still gets a normal seat');
  assert.notStrictEqual(g.playerId, 'p0', 'never seated as the host');
  assert.ok(host.players[0].token !== 'host', 'host token is random, not the literal "host"');
  assert.ok(/^tk-[0-9a-f]{32}$/.test(g.token), 'guest token is 128-bit hex');
  g.close(); host.close();
});

test('security: malformed intents never crash the host or corrupt Array.prototype', async () => {
  const host = new Net.HostSession({ name: 'Marc', transport: 'local', code: 'SECBBB' });
  const g = makeGuest('SECBBB', 'Ada');
  await waitFor(() => g.playerId, 'welcome');
  host.startRound(9);
  await waitFor(() => host.state, 'dealt');
  const protoLenBefore = Array.prototype.length;
  // __proto__ / length / NaN indices and junk payloads
  ['__proto__', 'length', 'constructor', -1, 99, 1.5, null].forEach(function (idx) {
    g.sendIntent({ type: 'play', from: { zone: 'blitz' }, to: { zone: 'post', idx: idx } }, 1);
    g.sendIntent({ type: 'play', from: { zone: 'post', idx: idx }, to: { zone: 'dutch', idx: idx } }, 2);
  });
  g.transport.send({ t: 'intent', intent: null, n: 3 });
  g.transport.send({ t: 'intent', n: 4 });
  g.transport.send({ t: 'intent', intent: { type: 42 }, n: 5 });
  g.transport.send({ t: 'garbage' });
  g.transport.send('not-an-object');
  await new Promise((r) => setTimeout(r, 60));
  assert.strictEqual(Array.prototype.length, protoLenBefore, 'Array.prototype untouched');
  assert.ok(!Array.prototype.color, 'no card leaked onto Array.prototype');
  assert.strictEqual(host.state.status, 'playing', 'host still running');
  // a legit intent still works afterward
  const seq = host.state.seq;
  g.sendIntent({ type: 'flip' }, 6);
  await waitFor(() => host.state.seq > seq, 'host still accepts real intents');
  g.close(); host.close();
});

test('security: guests receive a redacted state — no opponent hands, no seed', async () => {
  const host = new Net.HostSession({ name: 'Marc', transport: 'local', code: 'SECCCC' });
  const g = makeGuest('SECCCC', 'Ada');
  await waitFor(() => g.playerId, 'welcome');
  const states = collect(g, 'state');
  host.startRound(1234);
  const snap = await waitFor(() => states.find((s) => s.state), 'state').then((s) => s.state);
  // own hand is real
  assert.ok(snap.players[g.playerId].hand.every((c) => c && c.color), 'own hand is dealt face cards');
  // the host (opponent) hand is length-preserved but contentless
  const opp = snap.players.p0;
  assert.strictEqual(opp.hand.length, 27, 'opponent hand count preserved');
  assert.ok(opp.hand.every((c) => c == null), 'opponent hand cards are hidden');
  assert.ok(opp.blitz.every((c) => c == null), 'opponent blitz hidden');
  assert.strictEqual(snap.seed, undefined, 'deal seed withheld from guests');
  g.close(); host.close();
});

test('security: intent floods are rate-limited', async () => {
  const host = new Net.HostSession({ name: 'Marc', transport: 'local', code: 'SECDDD' });
  const g = makeGuest('SECDDD', 'Ada');
  await waitFor(() => g.playerId, 'welcome');
  host.startRound(5);
  await waitFor(() => host.state, 'dealt');
  let accepted = 0;
  const seq0 = host.state.seq;
  for (let i = 0; i < 200; i++) g.sendIntent({ type: 'flip' }, i);
  await new Promise((r) => setTimeout(r, 80));
  accepted = host.state.seq - seq0;
  assert.ok(accepted <= 25, 'burst of 200 flips is throttled to the bucket size, got ' + accepted);
  g.close(); host.close();
});

test('security: id counter never recycles a seat after a kick', async () => {
  const host = new Net.HostSession({ name: 'Marc', transport: 'local', code: 'SECEEE' });
  const g1 = makeGuest('SECEEE', 'A');
  const g2 = makeGuest('SECEEE', 'B');
  const g3 = makeGuest('SECEEE', 'C');
  await waitFor(() => g1.playerId && g2.playerId && g3.playerId, 'table of 4');
  const ids = [g1.playerId, g2.playerId, g3.playerId];
  host.removePlayer(g2.playerId); // kick the middle seat
  const g4 = makeGuest('SECEEE', 'D');
  await waitFor(() => g4.playerId, 'replacement joins');
  assert.ok(ids.indexOf(g4.playerId) === -1, 'new seat id ' + g4.playerId + ' collides with a live seat');
  const live = host.players.map((p) => p.id);
  assert.strictEqual(new Set(live).size, live.length, 'all seat ids unique');
  [g1, g3, g4].forEach((g) => g.close()); host.close();
});

test('chat relays to every seat, trimmed and length-capped', async () => {
  const host = new Net.HostSession({ name: 'Marc', transport: 'local', code: 'CHATAA' });
  const g1 = makeGuest('CHATAA', 'Ada');
  const g2 = makeGuest('CHATAA', 'Bo');
  await waitFor(() => g1.playerId && g2.playerId, 'joined');
  const c1 = collect(g1, 'chat'), c2 = collect(g2, 'chat'), ch = collect(host, 'chat');
  g1.sendChat('  hey   everyone  ');
  await waitFor(() => c2.length && ch.length, 'chat fanned out');
  const line = c2[c2.length - 1];
  assert.strictEqual(line.text, 'hey everyone', 'whitespace collapsed + trimmed');
  assert.strictEqual(line.name, 'Ada');
  assert.strictEqual(line.id, g1.playerId);
  // host chat reaches guests too; overlong text is capped
  host.sendChat('x'.repeat(500));
  const long = await waitFor(() => c1.find((l) => l.id === 'p0'), 'host chat');
  assert.ok(long.text.length <= 120, 'chat capped to 120 chars');
  g1.close(); g2.close(); host.close();
});

test('host snapshot + restore reattaches guests mid-round by token', async () => {
  var host = new Net.HostSession({ name: 'Marc', transport: 'local', code: 'RESUME' });
  const g1 = makeGuest('RESUME', 'Ada');
  await waitFor(() => g1.playerId, 'joined');
  host.startRound(11);
  await waitFor(() => host.state, 'dealt');
  g1.sendIntent({ type: 'flip' }, 1);
  await waitFor(() => host.state.players[g1.playerId].wood.length === 3, 'a play happened');

  // host "reloads": snapshot, silent close, rebuild from the snapshot
  const snap = host.snapshot();
  assert.strictEqual(snap.role, 'host');
  assert.strictEqual(snap.roundNo, 1);
  assert.ok(snap.players.find((p) => p.name === 'Ada').token, 'guest token preserved in snapshot');
  host.close(true); // silent — no bye

  const host2 = new Net.HostSession({ restore: snap, transport: 'local' });
  assert.strictEqual(host2.code, 'RESUME', 'same code');
  assert.strictEqual(host2.roundNo, 1, 'round restored');
  assert.strictEqual(host2.state.players[g1.playerId].wood.length, 3, 'board state restored');
  // the still-open guest re-hellos on the new host and gets its seat + state back
  const states = collect(g1, 'state');
  g1.transport.send({ t: 'hello', v: Net.PROTOCOL_V, name: 'Ada', token: g1.token });
  await waitFor(() => states.find((s) => s.state && s.roundNo === 1), 'restored state re-sent to guest');
  const seat = host2.players.find((p) => p.token === g1.token);
  assert.ok(seat && seat.connected, 'guest reattached to the same seat after restore');
  g1.close(); host2.close();
});

test('security: a guest cannot force a table-wide nudge', async () => {
  const host = new Net.HostSession({ name: 'Marc', transport: 'local', code: 'NUDGEX' });
  const g = makeGuest('NUDGEX', 'Mallory');
  await waitFor(() => g.playerId, 'joined');
  host.startRound(7);
  await waitFor(() => host.state, 'dealt');
  const handBefore = host.state.players[g.playerId].hand.map((c) => c.id).join(',');
  const seqBefore = host.state.seq;
  for (let i = 0; i < 20; i++) g.transport.send({ t: 'intent', intent: { type: 'nudge' }, n: i });
  await new Promise((r) => setTimeout(r, 80));
  assert.strictEqual(host.state.seq, seqBefore, 'no nudge was applied');
  assert.strictEqual(host.state.players[g.playerId].hand.map((c) => c.id).join(','), handBefore, 'hands untouched');
  g.close(); host.close();
});

// simulate the human host actively playing (solo practice): drive p0 through
// the same bot brain on a timer until the round ends.
function driveHostSeat(host) {
  const G = globalThis.BlitzPlay, Bot = globalThis.BlitzBot, cfg = Bot.tier('medium');
  const t = setInterval(() => {
    if (!host.state || host.state.status !== 'playing') return;
    const c = Bot.decide(G, host.state, 'p0', cfg, Math.random);
    if (c && c.kind !== 'misplay') host.hostIntent(c.intent);
  }, 120);
  return () => clearInterval(t);
}

test('bots: added to the roster, deal, play a full round to a Blitz, and settle', async () => {
  const host = new Net.HostSession({ name: 'Marc', transport: 'local', code: 'BOTAAA' });
  const b1 = host.addBot('hard');
  const b2 = host.addBot('expert');
  assert.ok(b1 && b2 && b1.isBot && b2.isBot, 'bots seated');
  assert.strictEqual(host.rosterPayload().filter((p) => p.bot).length, 2, 'roster marks bots');
  const stop = driveHostSeat(host);
  host.startRound(7);
  await waitFor(() => host.state.status === 'ended', 'bots finished the round', 25000);
  stop();
  assert.ok(host.state.winner, 'someone won');
  const sc = host.state.scores;
  Object.keys(sc).forEach((id) => {
    assert.strictEqual(sc[id].score, sc[id].played - 2 * sc[id].blitzLeft, id + ' scored correctly');
  });
  assert.ok(host.totals[host.state.winner] !== undefined, 'winner has a running total');
  host.close();
});

test('bots: only ever produce legal moves (they go through applyIntent)', async () => {
  const host = new Net.HostSession({ name: 'Marc', transport: 'local', code: 'BOTLEG' });
  host.addBot('expert');
  let badRejects = 0;
  const orig = host._apply.bind(host);
  host._apply = function (pid, intent, n, nackTo) {
    const r = orig(pid, intent, n, nackTo);
    if (r && !r.ok && intent.type === 'play' && r.reason !== 'beaten-to-it' && r.reason !== 'no-such-post') badRejects++;
    return r;
  };
  let applies = 0;
  const orig2 = host._apply;
  host._apply = function (pid, intent, n, nackTo) { if (pid !== 'p0') applies++; return orig2(pid, intent, n, nackTo); };
  const stop = driveHostSeat(host);
  host.startRound(3);
  // run the bot for a few seconds of real play, then judge its move legality
  await new Promise((r) => setTimeout(r, 3500));
  stop();
  assert.ok(applies > 5, 'bot actually made moves (' + applies + ')');
  // expert misplayRate is 0.003; only a tiny fraction should be real rejects
  assert.ok(badRejects <= 3, 'bot produced too many illegal non-race moves: ' + badRejects + ' of ' + applies);
  host.close();
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
