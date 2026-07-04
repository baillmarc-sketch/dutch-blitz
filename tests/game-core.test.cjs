/* Pile On — live-play rules engine tests. Run: node tests/game-core.test.cjs */
'use strict';
const assert = require('assert');
const G = require('../game-core.js');

let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (err) { failed++; failures.push({ name, err }); console.error('  ✗ ' + name + '\n    ' + err.message); }
}

const P2 = [{ id: 'a', name: 'Ann' }, { id: 'b', name: 'Ben' }];

/** Rig a player's zones for scenario tests. */
function card(owner, color, value) { return { id: owner + ':' + color + ':' + value, color, value, owner }; }

console.log('\n— dealing —');

test('deal: 40-card decks split into blitz 10 / post 3×1 / hand 27 / wood 0', () => {
  const s = G.newRound(P2, 42);
  for (const id of ['a', 'b']) {
    const p = s.players[id];
    assert.strictEqual(p.blitz.length, 10);
    assert.deepStrictEqual(p.post.map((x) => x.length), [1, 1, 1]);
    assert.strictEqual(p.hand.length, 27);
    assert.strictEqual(p.wood.length, 0);
    const all = [...p.blitz, ...p.post.flat(), ...p.hand];
    assert.strictEqual(new Set(all.map((c) => c.id)).size, 40, 'no duplicate cards');
    assert.ok(all.every((c) => c.owner === id), 'cards belong to their player');
  }
});

test('deal is deterministic by seed and differs across seeds', () => {
  const x = G.newRound(P2, 7), y = G.newRound(P2, 7), z = G.newRound(P2, 8);
  assert.deepStrictEqual(x.players.a.blitz.map(c => c.id), y.players.a.blitz.map(c => c.id));
  assert.notDeepStrictEqual(x.players.a.blitz.map(c => c.id), z.players.a.blitz.map(c => c.id));
});

test('player count enforced (2–4)', () => {
  assert.throws(() => G.newRound([{ id: 'a', name: 'A' }], 1));
  assert.throws(() => G.newRound([1, 2, 3, 4, 5].map(i => ({ id: 'p' + i, name: 'P' + i })), 1));
});

console.log('\n— wood pile: flip 3, cycle unshuffled —');

test('flip moves 3 from hand to wood, third flipped lands on top', () => {
  const s = G.newRound(P2, 1);
  const p = s.players.a;
  const expectTop = p.hand[p.hand.length - 3]; // third card popped ends on top of wood
  const r = G.applyIntent(s, 'a', { type: 'flip' });
  assert.ok(r.ok);
  assert.strictEqual(p.wood.length, 3);
  assert.strictEqual(p.hand.length, 24);
  assert.strictEqual(G.top(p.wood).id, expectTop.id);
});

test('exhausted hand picks the wood pile back up turned over — cycle order preserved', () => {
  const s = G.newRound(P2, 1);
  const p = s.players.a;
  const firstCycle = [];
  for (let i = 0; i < 9; i++) { // 27 cards = 9 flips
    G.applyIntent(s, 'a', { type: 'flip' });
    firstCycle.push(G.top(p.wood).id);
  }
  assert.strictEqual(p.hand.length, 0);
  const secondCycle = [];
  for (let i = 0; i < 9; i++) {
    G.applyIntent(s, 'a', { type: 'flip' });
    secondCycle.push(G.top(p.wood).id);
  }
  assert.deepStrictEqual(secondCycle, firstCycle, 'unshuffled cycle repeats identically');
});

test('flip with no cards anywhere is rejected', () => {
  const s = G.newRound(P2, 1);
  s.players.a.hand = []; s.players.a.wood = [];
  assert.strictEqual(G.applyIntent(s, 'a', { type: 'flip' }).ok, false);
});

console.log('\n— dutch piles —');

test('only a 1 starts a pile; builds 1→10 same color; completed pile set aside', () => {
  const s = G.newRound(P2, 1);
  const p = s.players.a;
  p.blitz = [card('a', 'red', 2)];
  assert.strictEqual(G.applyIntent(s, 'a', { type: 'play', from: { zone: 'blitz' }, to: { zone: 'dutchNew' } }).ok, false);
  p.blitz = [card('a', 'red', 1)];
  s.status = 'playing';
  // build the whole red pile
  assert.ok(G.applyIntent(s, 'a', { type: 'play', from: { zone: 'blitz' }, to: { zone: 'dutchNew' } }).ok);
  // blitz emptied -> round actually ended; rebuild a live state for the climb
  const s2 = G.newRound(P2, 1);
  const q = s2.players.b;
  s2.dutch = [{ color: 'red', top: 1 }];
  for (let v = 2; v <= 10; v++) {
    q.wood = [card('b', 'red', v)];
    const r = G.applyIntent(s2, 'b', { type: 'play', from: { zone: 'wood' }, to: { zone: 'dutch', idx: 0 } });
    assert.ok(r.ok, 'value ' + v + ' should stack');
  }
  assert.strictEqual(s2.dutch.length, 1, 'slot stays put');
  assert.strictEqual(s2.dutch[0].done, true, 'completed pile is set aside in place');
  assert.strictEqual(s2.completedPiles, 1);
  assert.strictEqual(q.dutchCount, 9);
  // a play aimed at the finished slot loses cleanly
  q.wood = [card('b', 'red', 1)];
  assert.strictEqual(G.applyIntent(s2, 'b', { type: 'play', from: { zone: 'wood' }, to: { zone: 'dutch', idx: 0 } }).reason, 'beaten-to-it');
  // and a fresh 1 reuses the spent slot instead of reflowing the grid
  assert.ok(G.applyIntent(s2, 'b', { type: 'play', from: { zone: 'wood' }, to: { zone: 'dutchNew' } }).ok);
  assert.strictEqual(s2.dutch.length, 1);
  assert.strictEqual(s2.dutch[0].done, false);
  assert.strictEqual(s2.dutch[0].top, 1);
});

test('wrong color or skipped number loses the race (rejected)', () => {
  const s = G.newRound(P2, 1);
  s.dutch = [{ color: 'blue', top: 3 }];
  s.players.a.wood = [card('a', 'red', 4)];
  assert.strictEqual(G.applyIntent(s, 'a', { type: 'play', from: { zone: 'wood' }, to: { zone: 'dutch', idx: 0 } }).reason, 'beaten-to-it');
  s.players.a.wood = [card('a', 'blue', 5)];
  assert.strictEqual(G.applyIntent(s, 'a', { type: 'play', from: { zone: 'wood' }, to: { zone: 'dutch', idx: 0 } }).reason, 'beaten-to-it');
});

test('race: two players target the same pile — first stays, second bounces', () => {
  const s = G.newRound(P2, 1);
  s.dutch = [{ color: 'green', top: 4 }];
  s.players.a.wood = [card('a', 'green', 5)];
  s.players.b.wood = [card('b', 'green', 5)];
  const first = G.applyIntent(s, 'a', { type: 'play', from: { zone: 'wood' }, to: { zone: 'dutch', idx: 0 } });
  const second = G.applyIntent(s, 'b', { type: 'play', from: { zone: 'wood' }, to: { zone: 'dutch', idx: 0 } });
  assert.ok(first.ok);
  assert.strictEqual(second.ok, false);
  assert.strictEqual(second.reason, 'beaten-to-it');
  assert.strictEqual(s.players.b.wood.length, 1, 'loser keeps the card');
});

console.log('\n— post piles —');

test('post builds down with alternating boy/girl only', () => {
  const s = G.newRound(P2, 1);
  const p = s.players.a;
  p.post = [[card('a', 'red', 7)], [], []]; // red = boy
  p.wood = [card('a', 'blue', 6)]; // boy on boy — illegal
  assert.strictEqual(G.applyIntent(s, 'a', { type: 'play', from: { zone: 'wood' }, to: { zone: 'post', idx: 0 } }).reason, 'must-alternate-boy-girl');
  p.wood = [card('a', 'green', 5)]; // girl but skips a number
  assert.strictEqual(G.applyIntent(s, 'a', { type: 'play', from: { zone: 'wood' }, to: { zone: 'post', idx: 0 } }).reason, 'must-build-down');
  p.wood = [card('a', 'yellow', 6)]; // girl, one lower — legal
  assert.ok(G.applyIntent(s, 'a', { type: 'play', from: { zone: 'wood' }, to: { zone: 'post', idx: 0 } }).ok);
  assert.strictEqual(p.post[0].length, 2);
});

test('an empty post slot refills from the Blitz pile only', () => {
  const s = G.newRound(P2, 1);
  const p = s.players.a;
  p.post = [[], [card('a', 'red', 9)], [card('a', 'blue', 9)]];
  p.wood = [card('a', 'green', 2)];
  assert.strictEqual(G.applyIntent(s, 'a', { type: 'play', from: { zone: 'wood' }, to: { zone: 'post', idx: 0 } }).reason, 'empty-post-fills-from-blitz');
  p.blitz = [card('a', 'green', 2), card('a', 'red', 5)]; // top = red 5
  assert.ok(G.applyIntent(s, 'a', { type: 'play', from: { zone: 'blitz' }, to: { zone: 'post', idx: 0 } }).ok);
  assert.strictEqual(G.top(p.post[0]).value, 5);
});

test('moving the top card between post piles is legal when it fits', () => {
  const s = G.newRound(P2, 1);
  const p = s.players.a;
  p.post = [[card('a', 'red', 4)], [card('a', 'yellow', 5)], [card('a', 'blue', 9)]];
  const r = G.applyIntent(s, 'a', { type: 'play', from: { zone: 'post', idx: 0 }, to: { zone: 'post', idx: 1 } });
  assert.ok(r.ok);
  assert.strictEqual(p.post[0].length, 0);
  assert.strictEqual(G.top(p.post[1]).value, 4);
});

console.log('\n— blitz call & scoring —');

test('emptying the blitz pile ends the round instantly and scores everyone', () => {
  const s = G.newRound(P2, 1);
  const a = s.players.a, b = s.players.b;
  a.blitz = [card('a', 'red', 1)];
  a.dutchCount = 12;
  b.blitz = [card('b', 'red', 9), card('b', 'blue', 4), card('b', 'green', 2)];
  b.dutchCount = 7;
  const r = G.applyIntent(s, 'a', { type: 'play', from: { zone: 'blitz' }, to: { zone: 'dutchNew' } });
  assert.ok(r.ok);
  assert.ok(r.event.blitz, 'event carries the blitz call');
  assert.strictEqual(s.status, 'ended');
  assert.strictEqual(s.winner, 'a');
  assert.strictEqual(s.scores.a.score, 13 - 0); // 12 + the 1 just played, no blitz left
  assert.strictEqual(s.scores.a.played, 13);
  assert.strictEqual(s.scores.b.score, 7 - 2 * 3);
  assert.strictEqual(s.scores.b.blitzLeft, 3);
});

test('no play accepted after the round ends', () => {
  const s = G.newRound(P2, 1);
  s.status = 'ended';
  assert.strictEqual(G.applyIntent(s, 'a', { type: 'flip' }).reason, 'round-over');
});

console.log('\n— helpers —');

test('legalDutchTargets finds every stackable pile plus new-pile for 1s', () => {
  const s = G.newRound(P2, 1);
  s.dutch = [{ color: 'red', top: 4 }, { color: 'red', top: 4 }, { color: 'blue', top: 4 }];
  assert.deepStrictEqual(G.legalDutchTargets(s, card('a', 'red', 5)), [0, 1]);
  assert.deepStrictEqual(G.legalDutchTargets(s, card('a', 'blue', 1)), ['new']);
  assert.deepStrictEqual(G.legalDutchTargets(s, card('a', 'green', 7)), []);
});

test('full simulated round: two bots race to a legitimate finish', () => {
  const s = G.newRound(P2, 99);
  let guard = 40000;
  while (s.status === 'playing' && guard-- > 0) {
    if (G.isStalled(s)) { G.applyIntent(s, 'host', { type: 'nudge' }); continue; }
    for (const id of s.order) {
      if (s.status !== 'playing') break;
      const p = s.players[id];
      let acted = false;
      const sources = [{ zone: 'blitz' }, { zone: 'post', idx: 0 }, { zone: 'post', idx: 1 }, { zone: 'post', idx: 2 }, { zone: 'wood' }];
      // 1) any dutch play
      for (const from of sources) {
        const c = from.zone === 'blitz' ? G.top(p.blitz) : from.zone === 'wood' ? G.top(p.wood) : G.top(p.post[from.idx]);
        if (!c) continue;
        const targets = G.legalDutchTargets(s, c);
        if (targets.length) {
          const t = targets[0];
          const r = G.applyIntent(s, id, { type: 'play', from, to: t === 'new' ? { zone: 'dutchNew' } : { zone: 'dutch', idx: t } });
          if (r.ok) { acted = true; break; }
        }
      }
      // 2) drain blitz onto posts (empty slot, or a legal descending stack)
      if (!acted && G.top(p.blitz)) {
        for (let i = 0; i < 3; i++) {
          const r = G.applyIntent(s, id, { type: 'play', from: { zone: 'blitz' }, to: { zone: 'post', idx: i } });
          if (r.ok) { acted = true; break; }
        }
      }
      // 3) stack wood onto posts to keep cycling fresh cards
      if (!acted && G.top(p.wood)) {
        for (let i = 0; i < 3; i++) {
          const r = G.applyIntent(s, id, { type: 'play', from: { zone: 'wood' }, to: { zone: 'post', idx: i } });
          if (r.ok) { acted = true; break; }
        }
      }
      if (!acted) G.applyIntent(s, id, { type: 'flip' });
    }
  }
  assert.ok(guard > 0, 'round terminated');
  assert.strictEqual(s.status, 'ended');
  assert.ok(s.winner, 'someone blitzed');
  assert.strictEqual(s.players[s.winner].blitz.length, 0);
  for (const id of s.order) {
    const sc = s.scores[id];
    assert.strictEqual(sc.score, sc.played - 2 * sc.blitzLeft, 'scoring formula holds');
  }
});

console.log('\n' + '─'.repeat(40));
console.log('GAME-CORE TESTS: ' + (passed + failed) + '  PASSED: ' + passed + '  FAILED: ' + failed);
if (failed > 0) process.exit(1);
