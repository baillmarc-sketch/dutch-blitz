/*
 * Computer-opponent tests: the pure decision function (bot.js) against the
 * real rules engine (game-core.js), plus a full 4-bot round that must
 * terminate with correct scoring. Run: node tests/bot.test.cjs
 */
'use strict';
globalThis.self = globalThis;
const G = require('../game-core.js');
globalThis.BlitzPlay = G;
const Bot = require('../bot.js');
const assert = require('node:assert');

let passed = 0; const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
function mulberry(seed) { let a = seed >>> 0; return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

test('tiers exist in order, each with sane knobs', () => {
  assert.deepStrictEqual(Bot.ORDER, ['easy', 'medium', 'hard', 'expert']);
  Bot.ORDER.forEach((k) => {
    const c = Bot.tier(k);
    assert.ok(c.think[0] <= c.think[1] && c.floor > 0, k + ' timing');
    assert.ok(c.missRate >= 0 && c.missRate <= 1, k + ' missRate');
  });
  // difficulty should be monotonic: harder = faster + fewer misses
  assert.ok(Bot.tier('easy').think[0] > Bot.tier('expert').think[0], 'expert thinks faster');
  assert.ok(Bot.tier('easy').missRate > Bot.tier('expert').missRate, 'expert misses less');
});

test('decide returns a legal intent that the engine accepts', () => {
  const s = G.newRound([{ id: 'p0', name: 'A' }, { id: 'p1', name: 'Cedar' }], 7);
  const rnd = mulberry(1);
  // expert never "misses", so its top choice should be a real move
  const cfg = Bot.tier('expert');
  let sawPlay = false;
  for (let i = 0; i < 200 && s.status === 'playing'; i++) {
    const choice = Bot.decide(G, s, 'p1', cfg, rnd);
    assert.ok(choice && choice.intent, 'always returns a choice');
    if (choice.kind === 'misplay') {
      const r = G.applyIntent(s, 'p1', choice.intent);
      assert.strictEqual(r.ok, false, 'misplay is correctly rejected by the engine');
      continue;
    }
    const r = G.applyIntent(s, 'p1', choice.intent);
    // a decided (non-misplay) move is either accepted or a legit lost race
    assert.ok(r.ok || r.reason === 'beaten-to-it', 'legal or lost race, got ' + (r.reason || 'ok'));
    if (r.ok && choice.kind === 'dutch') sawPlay = true;
    // also let p0 flip so the round advances
    G.applyIntent(s, 'p0', { type: 'flip' });
  }
  assert.ok(sawPlay, 'expert bot scored at least one Dutch play');
});

test('easy leaves its Blitz fuller than expert over the same start', () => {
  // Compare how much each empties its Blitz in a fixed number of solo moves.
  function soloBlitzLeft(diff, seed) {
    const s = G.newRound([{ id: 'p0', name: 'A' }, { id: 'p1', name: 'B' }], seed);
    const cfg = Bot.tier(diff); const rnd = mulberry(99);
    for (let i = 0; i < 300 && s.status === 'playing'; i++) {
      const c = Bot.decide(G, s, 'p1', cfg, rnd);
      if (c && c.kind !== 'misplay') G.applyIntent(s, 'p1', c.intent);
      G.applyIntent(s, 'p0', { type: 'flip' }); // opponent idles
    }
    return s.players.p1.blitz.length;
  }
  const easy = soloBlitzLeft('easy', 3);
  const expert = soloBlitzLeft('expert', 3);
  assert.ok(expert <= easy, `expert should empty more Blitz (expert ${expert} <= easy ${easy})`);
});

test('nextDelay respects the floor and orders by tier', () => {
  const rnd = mulberry(5);
  const eFloor = Bot.tier('expert').floor, easyFloor = Bot.tier('easy').floor;
  for (let i = 0; i < 50; i++) {
    assert.ok(Bot.nextDelay(Bot.tier('expert'), rnd, 'dutch', false) >= eFloor, 'expert floor');
    assert.ok(Bot.nextDelay(Bot.tier('easy'), rnd, 'flip', false) >= easyFloor, 'easy floor');
  }
  // rubber-band slows a bot down
  const base = Bot.nextDelay(Bot.tier('easy'), mulberry(2), 'think', false);
  const rubbered = Bot.nextDelay(Bot.tier('easy'), mulberry(2), 'think', true);
  assert.ok(rubbered >= base, 'rubber-band never speeds up');
});

test('a full 4-bot round terminates with correct scoring', () => {
  const players = [{ id: 'p0', name: 'Sprout' }, { id: 'p1', name: 'Maple' }, { id: 'p2', name: 'Birch' }, { id: 'p3', name: 'Cedar' }];
  const s = G.newRound(players, 12345);
  const cfgs = { p0: Bot.tier('easy'), p1: Bot.tier('medium'), p2: Bot.tier('hard'), p3: Bot.tier('expert') };
  const rnd = mulberry(42);
  let guard = 60000;
  while (s.status === 'playing' && guard-- > 0) {
    for (const id of s.order) {
      if (s.status !== 'playing') break;
      const c = Bot.decide(G, s, id, cfgs[id], rnd);
      if (!c) continue;
      if (c.kind === 'misplay') { continue; } // engine would reject; skip to keep sim moving
      G.applyIntent(s, id, c.intent);
    }
    if (G.isStalled(s)) {
      // host would nudge; do it so the sim can't deadlock
      G.applyIntent(s, s.order[0], { type: 'nudge' });
    }
  }
  assert.ok(guard > 0, 'round terminated');
  assert.strictEqual(s.status, 'ended');
  assert.ok(s.winner, 'someone won');
  // scoring invariant holds for everyone
  const sc = G.computeScores(s);
  s.order.forEach((id) => {
    assert.strictEqual(sc[id].score, sc[id].played - 2 * sc[id].blitzLeft, id + ' score = played - 2*blitzLeft');
  });
  assert.strictEqual(sc[s.winner].blitzLeft, 0, 'winner emptied their Blitz');
});

(async () => {
  for (const { name, fn } of tests) {
    try { await fn(); passed++; console.log('  ok - ' + name); }
    catch (e) { console.error('  FAIL - ' + name); console.error(e && e.stack ? e.stack : e); process.exit(1); }
  }
  console.log(passed + '/' + tests.length + ' bot tests passed');
  process.exit(0);
})();
