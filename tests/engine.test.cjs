/* Dutch Blitz Sidecar — engine + storage test suite.
   Run: node tests/engine.test.cjs
   The seed-game regression is the contract from the brief: totals must be
   Jessica 26 / Marc 23 / Ryan 11 / Anna 9 with the correction visible. */
'use strict';

const assert = require('assert');
const E = require('../engine.js');
const S = require('../storage.js');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    console.error('  ✗ ' + name + '\n    ' + err.message);
  }
}

function totalsByName(game) {
  const totals = E.playerTotals(game);
  const out = {};
  game.players.forEach((p) => { out[p.name] = totals[p.id]; });
  return out;
}

function fakeStorage() {
  const data = {};
  return {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: (k) => { delete data[k]; },
    _data: data,
  };
}

console.log('\n— scoring formula —');

test('calcScore: played − 2 × left', () => {
  assert.strictEqual(E.calcScore(10, 2), 6);
  assert.strictEqual(E.calcScore(0, 10), -20);
  assert.strictEqual(E.calcScore(15, 0), 15);
});

test('calcScore coerces strings and empty fields to 0', () => {
  assert.strictEqual(E.calcScore('12', '3'), 6);
  assert.strictEqual(E.calcScore('', ''), 0);
  assert.strictEqual(E.calcScore(undefined, null), 0);
});

test('scoreValue resolves simple and calc modes', () => {
  assert.strictEqual(E.scoreValue({ mode: 'simple', value: -7 }), -7);
  assert.strictEqual(E.scoreValue({ mode: 'calc', dutchCards: 9, blitzLeft: 4 }), 1);
  assert.strictEqual(E.scoreValue(null), 0);
});

console.log('\n— seed game regression (the brief\'s contract) —');

test('seed reproduces 26 / 23 / 11 / 9 exactly', () => {
  const game = E.seedGame(1000);
  const t = totalsByName(game);
  assert.strictEqual(t.Jessica, 26, 'Jessica must be 26, got ' + t.Jessica);
  assert.strictEqual(t.Marc, 23, 'Marc must be 23, got ' + t.Marc);
  assert.strictEqual(t.Ryan, 11, 'Ryan must be 11, got ' + t.Ryan);
  assert.strictEqual(t.Anna, 9, 'Anna must be 9, got ' + t.Anna);
});

test('seed standings order: Jessica, Marc, Ryan, Anna', () => {
  const rows = E.standings(E.seedGame(1000));
  assert.deepStrictEqual(rows.map((r) => r.player.name), ['Jessica', 'Marc', 'Ryan', 'Anna']);
  assert.deepStrictEqual(rows.map((r) => r.total), [26, 23, 11, 9]);
  assert.strictEqual(rows[0].isLeader, true);
  assert.strictEqual(rows[1].isLeader, false);
  assert.strictEqual(rows.some((r) => r.hitTarget), false);
});

test('seed correction is present, attached to round 2, and visible in export', () => {
  const game = E.seedGame(1000);
  assert.strictEqual(game.adjustments.length, 1);
  const adj = game.adjustments[0];
  assert.strictEqual(adj.delta, 3);
  assert.strictEqual(adj.attachedToRoundIndex, 2);
  const text = E.exportText(game);
  assert.ok(/CORRECTION — Anna: \+3/.test(text), 'export must show the correction: ' + text);
  assert.ok(text.includes('Jessica — 26'));
  assert.ok(text.includes('Anna — 9'));
});

test('seed cumulative after R1 and R2 (correction lands at round 2)', () => {
  const game = E.seedGame(1000);
  const byName = (snap) => {
    const out = {};
    game.players.forEach((p) => { out[p.name] = snap.totals[p.id]; });
    return out;
  };
  const rows = E.cumulativeByRound(game);
  assert.deepStrictEqual(byName(rows[0]), { Ryan: -2, Jessica: 8, Anna: 16, Marc: 9 });
  assert.deepStrictEqual(byName(rows[1]), { Ryan: 11, Jessica: 26, Anna: 9, Marc: 23 });
});

console.log('\n— rounds: add / edit / undo / delete —');

test('negative rounds and negative totals are allowed', () => {
  const g = E.newGame({ name: 't', playerNames: ['A', 'B'] });
  E.addRound(g, [
    { playerId: g.players[0].id, mode: 'simple', value: -6 },
    { playerId: g.players[1].id, mode: 'simple', value: -20 },
  ]);
  const t = totalsByName(g);
  assert.strictEqual(t.A, -6);
  assert.strictEqual(t.B, -20);
});

test('mixed simple + calc scores in one round', () => {
  const g = E.newGame({ playerNames: ['A', 'B'] });
  E.addRound(g, [
    { playerId: g.players[0].id, mode: 'simple', value: 5 },
    { playerId: g.players[1].id, mode: 'calc', dutchCards: 8, blitzLeft: 3 },
  ]);
  const t = totalsByName(g);
  assert.strictEqual(t.A, 5);
  assert.strictEqual(t.B, 2);
});

test('editing a past round recomputes totals', () => {
  const g = E.newGame({ playerNames: ['A'] });
  const r1 = E.addRound(g, [{ playerId: g.players[0].id, mode: 'simple', value: 10 }]);
  E.addRound(g, [{ playerId: g.players[0].id, mode: 'simple', value: 5 }]);
  E.updateRound(g, r1.id, [{ playerId: g.players[0].id, mode: 'simple', value: -4 }]);
  assert.strictEqual(totalsByName(g).A, 1);
});

test('undo last round removes only the last round', () => {
  const g = E.newGame({ playerNames: ['A'] });
  E.addRound(g, [{ playerId: g.players[0].id, mode: 'simple', value: 10 }]);
  E.addRound(g, [{ playerId: g.players[0].id, mode: 'simple', value: 7 }]);
  assert.strictEqual(E.undoLastRound(g), true);
  assert.strictEqual(g.rounds.length, 1);
  assert.strictEqual(totalsByName(g).A, 10);
  assert.strictEqual(E.undoLastRound(g), true);
  assert.strictEqual(E.undoLastRound(g), false, 'undo on empty history must return false');
});

test('deleting a middle round re-indexes and re-anchors adjustments', () => {
  const g = E.newGame({ playerNames: ['A'] });
  const pid = g.players[0].id;
  const r1 = E.addRound(g, [{ playerId: pid, mode: 'simple', value: 1 }]);
  const r2 = E.addRound(g, [{ playerId: pid, mode: 'simple', value: 2 }]);
  const r3 = E.addRound(g, [{ playerId: pid, mode: 'simple', value: 4 }]);
  E.addAdjustment(g, pid, 5, 'on r2', 2);
  E.addAdjustment(g, pid, 7, 'on r3', 3);
  E.deleteRound(g, r2.id);
  assert.deepStrictEqual(g.rounds.map((r) => r.index), [1, 2]);
  assert.strictEqual(g.rounds[1].id, r3.id);
  const onDeleted = g.adjustments.find((a) => a.delta === 5);
  const onLater = g.adjustments.find((a) => a.delta === 7);
  assert.strictEqual(onDeleted.attachedToRoundIndex, null, 'adjustment on deleted round becomes standalone');
  assert.ok(onDeleted.label.includes('deleted'), 'and says why');
  assert.strictEqual(onLater.attachedToRoundIndex, 2, 'later attachment follows its round down');
  assert.strictEqual(totalsByName(g).A, 1 + 4 + 5 + 7, 'no adjustment silently lost');
  assert.strictEqual(r1.index, 1);
});

console.log('\n— adjustments —');

test('standalone adjustment counts toward total and shows in export', () => {
  const g = E.newGame({ playerNames: ['A'] });
  E.addAdjustment(g, g.players[0].id, -4, 'penalty', null);
  assert.strictEqual(totalsByName(g).A, -4);
  const text = E.exportText(g);
  assert.ok(text.includes('Standalone corrections:'));
  assert.ok(text.includes('A: -4 (penalty)'));
});

test('deleting an adjustment restores the total', () => {
  const g = E.newGame({ playerNames: ['A'] });
  const adj = E.addAdjustment(g, g.players[0].id, 9, 'oops', null);
  assert.strictEqual(totalsByName(g).A, 9);
  assert.strictEqual(E.deleteAdjustment(g, adj.id), true);
  assert.strictEqual(totalsByName(g).A, 0);
});

console.log('\n— players —');

test('duplicate names get numbered suffixes (case-insensitive)', () => {
  const g = E.newGame({ playerNames: ['Sam', 'sam', 'SAM'] });
  assert.deepStrictEqual(g.players.map((p) => p.name), ['Sam', 'sam 2', 'SAM 3']);
});

test('rename to a taken name also dedupes', () => {
  const g = E.newGame({ playerNames: ['A', 'B'] });
  E.renamePlayer(g, g.players[1].id, 'A');
  assert.strictEqual(g.players[1].name, 'A 2');
});

test('player added mid-game scores 0 for earlier rounds', () => {
  const g = E.newGame({ playerNames: ['A'] });
  E.addRound(g, [{ playerId: g.players[0].id, mode: 'simple', value: 10 }]);
  E.addPlayer(g, 'Late');
  const t = totalsByName(g);
  assert.strictEqual(t.Late, 0);
  assert.strictEqual(t.A, 10);
});

test('removing a player strips their scores and adjustments', () => {
  const g = E.newGame({ playerNames: ['A', 'B'] });
  const bid = g.players[1].id;
  E.addRound(g, [
    { playerId: g.players[0].id, mode: 'simple', value: 3 },
    { playerId: bid, mode: 'simple', value: 8 },
  ]);
  E.addAdjustment(g, bid, 2, 'x', null);
  E.removePlayer(g, bid);
  assert.strictEqual(g.players.length, 1);
  assert.strictEqual(g.rounds[0].scores.length, 1);
  assert.strictEqual(g.adjustments.length, 0);
  assert.strictEqual(totalsByName(g).A, 3);
});

console.log('\n— target & winner —');

test('hitTarget flags at and past the target; mid-game target change re-evaluates', () => {
  const g = E.newGame({ playerNames: ['A', 'B'], targetScore: 20 });
  E.addRound(g, [
    { playerId: g.players[0].id, mode: 'simple', value: 20 },
    { playerId: g.players[1].id, mode: 'simple', value: 25 },
  ]);
  let rows = E.standings(g);
  assert.strictEqual(rows.filter((r) => r.hitTarget).length, 2);
  assert.strictEqual(E.hasWinner(g), true);
  g.targetScore = 75; // target raised mid-game
  rows = E.standings(g);
  assert.strictEqual(rows.filter((r) => r.hitTarget).length, 0);
  assert.strictEqual(E.hasWinner(g), false);
});

test('tied leaders share rank 1', () => {
  const g = E.newGame({ playerNames: ['A', 'B', 'C'] });
  E.addRound(g, [
    { playerId: g.players[0].id, mode: 'simple', value: 10 },
    { playerId: g.players[1].id, mode: 'simple', value: 10 },
    { playerId: g.players[2].id, mode: 'simple', value: 4 },
  ]);
  const rows = E.standings(g);
  assert.deepStrictEqual(rows.map((r) => r.rank), [1, 1, 3]);
  assert.strictEqual(rows[0].isLeader && rows[1].isLeader, true);
});

console.log('\n— reset —');

test('reset clears rounds and adjustments, keeps players and target', () => {
  const g = E.newGame({ playerNames: ['A', 'B'], targetScore: 50 });
  E.addRound(g, [{ playerId: g.players[0].id, mode: 'simple', value: 5 }]);
  E.addAdjustment(g, g.players[0].id, 1, 'x', null);
  E.resetGame(g);
  assert.strictEqual(g.rounds.length, 0);
  assert.strictEqual(g.adjustments.length, 0);
  assert.strictEqual(g.players.length, 2);
  assert.strictEqual(g.targetScore, 50);
});

console.log('\n— sanitize (corrupted / legacy saves) —');

test('sanitizeGame repairs malformed fields without dropping good data', () => {
  const g = E.sanitizeGame({
    name: '', targetScore: 'nope', players: [{ name: 'A' }, null, { id: 'x', name: 'B', color: 'purple' }],
    rounds: [{ scores: [{ playerId: 'x', mode: 'simple', value: '7' }, { playerId: 'ghost', value: 3 }] }, 'garbage' === 'never' ? {} : null],
    adjustments: [{ playerId: 'x', delta: '2', attachedToRoundIndex: 99 }],
  });
  assert.strictEqual(g.name, 'Recovered game');
  assert.strictEqual(g.targetScore, 75);
  assert.strictEqual(g.players.length, 2);
  assert.strictEqual(g.rounds.length, 1);
  assert.strictEqual(g.rounds[0].scores.length, 1, 'ghost-player score dropped');
  assert.strictEqual(g.rounds[0].scores[0].value, 7);
  assert.strictEqual(g.adjustments[0].attachedToRoundIndex, null, 'unmappable attachment becomes standalone (visible)');
  assert.strictEqual(E.sanitizeGame('not an object'), null);
});

console.log('\n— review-pass regressions —');

test('toCalcFields is an exact inverse of calcScore for any value', () => {
  for (let v = -25; v <= 25; v++) {
    const f = E.toCalcFields(v);
    assert.ok(f.dutchCards >= 0 && f.blitzLeft >= 0, 'fields non-negative for ' + v);
    assert.strictEqual(E.calcScore(f.dutchCards, f.blitzLeft), v, 'round-trip for ' + v);
  }
});

test('undoLastRound tolerates a game with no rounds array', () => {
  assert.strictEqual(E.undoLastRound({ players: [], adjustments: [] }), false);
});

test('addAdjustment with an out-of-range anchor becomes standalone (visible), never hidden', () => {
  const g = E.newGame({ playerNames: ['A'] });
  E.addRound(g, [{ playerId: g.players[0].id, mode: 'simple', value: 1 }]);
  const adj = E.addAdjustment(g, g.players[0].id, 5, 'x', 7);
  assert.strictEqual(adj.attachedToRoundIndex, null);
  assert.ok(E.exportText(g).includes('Standalone corrections:'), 'must appear in export');
  assert.strictEqual(totalsByName(g).A, 6);
});

test('cumulativeByRound final row includes standalone adjustments (matches leaderboard)', () => {
  const g = E.newGame({ playerNames: ['A'] });
  E.addRound(g, [{ playerId: g.players[0].id, mode: 'simple', value: 10 }]);
  E.addAdjustment(g, g.players[0].id, -4, 'penalty', null);
  const rows = E.cumulativeByRound(g);
  assert.strictEqual(rows[0].totals[g.players[0].id], 6);
  assert.strictEqual(E.playerTotals(g)[g.players[0].id], 6);
});

test('sanitizeGame remaps adjustment anchors by stored round index, not position', () => {
  const g = E.sanitizeGame({
    players: [{ id: 'p', name: 'A' }],
    rounds: [
      { id: 'r2', index: 2, scores: [{ playerId: 'p', mode: 'simple', value: 1 }] },
      { id: 'r3', index: 3, scores: [{ playerId: 'p', mode: 'simple', value: 2 }] },
    ],
    adjustments: [{ id: 'a', playerId: 'p', delta: 5, attachedToRoundIndex: 2 }],
  });
  assert.strictEqual(g.rounds[0].index, 1);
  assert.strictEqual(g.adjustments[0].attachedToRoundIndex, 1, 'anchor follows the round formerly numbered 2');
});

test('sanitizeGame drops duplicate player ids and prototype-key ghosts', () => {
  const g = E.sanitizeGame({
    players: [{ id: 'x', name: 'A' }, { id: 'x', name: 'B' }],
    rounds: [{ id: 'r', index: 1, scores: [{ playerId: 'x', mode: 'simple', value: 10 }] }],
    adjustments: [{ id: 'a', playerId: 'constructor', delta: 7 }],
  });
  assert.strictEqual(g.players.length, 1, 'duplicate id kept once');
  assert.strictEqual(g.adjustments.length, 0, 'ghost playerId "constructor" dropped');
});

test('addPlayer refuses a 9th player (MAX_PLAYERS)', () => {
  const g = E.newGame({ playerNames: ['1', '2', '3', '4', '5', '6', '7', '8'] });
  assert.strictEqual(g.players.length, 8);
  assert.strictEqual(E.addPlayer(g, 'Nine'), null);
  assert.strictEqual(g.players.length, 8);
});

console.log('\n— storage: autosave, merge-not-clobber, corruption —');

test('load → seed → reload round-trips through real JSON', () => {
  const ls = fakeStorage();
  const store = new S.Store(ls, () => 1000);
  store.load();
  store.ensureSeed();
  const store2 = new S.Store(ls, () => 2000);
  store2.load();
  const game = store2.currentGame();
  assert.ok(game, 'seed game survives reload');
  const t = totalsByName(game);
  assert.deepStrictEqual([t.Jessica, t.Marc, t.Ryan, t.Anna], [26, 23, 11, 9]);
  assert.strictEqual(store2.state.seedLoaded, true, 'seed does not reload twice');
});

test('corrupted save is backed up, never silently wiped', () => {
  const ls = fakeStorage();
  ls.setItem(S.KEY, '{definitely not json');
  const store = new S.Store(ls, () => 5000);
  store.load();
  assert.ok(store.recoveryNotice, 'user is told');
  const backupKey = Object.keys(ls._data).find((k) => k.startsWith(S.BACKUP_PREFIX));
  assert.ok(backupKey, 'a backup key exists');
  assert.strictEqual(ls.getItem(backupKey), '{definitely not json', 'original bytes preserved');
});

test('stale tab cannot clobber a newer save (monotonic merge)', () => {
  const ls = fakeStorage();
  // Tab A creates a game and saves several revisions.
  const a = new S.Store(ls, () => 1000);
  a.load();
  const game = E.newGame({ name: 'Kitchen table', playerNames: ['A', 'B'], createdAt: 1000 });
  a.addGame(game, true);
  E.addRound(game, [{ playerId: game.players[0].id, mode: 'simple', value: 10 }], 1000);
  a.touch(game);
  E.addRound(game, [{ playerId: game.players[0].id, mode: 'simple', value: 5 }], 1001);
  a.touch(game);

  // Tab B loaded long ago (stale snapshot) and now writes its own new game.
  const b = new S.Store(ls, () => 2000);
  b.state = S.emptyState(); // simulate the stale in-memory copy: rev 0, knows nothing
  const otherGame = E.newGame({ name: 'Cabin game', playerNames: ['C'], createdAt: 2000 });
  b.addGame(otherGame, true);

  // A fresh read must contain BOTH games with A's rounds intact.
  const check = new S.Store(ls, () => 3000);
  check.load();
  const ids = Object.keys(check.state.games);
  assert.strictEqual(ids.length, 2, 'both games survive: ' + ids.length);
  const kitchen = ids.map((i) => check.state.games[i]).find((g) => g.name === 'Kitchen table');
  assert.strictEqual(kitchen.rounds.length, 2, 'newer rounds not clobbered by stale tab');
});

test('two tabs adding different rounds to the same game both survive (union merge)', () => {
  const ls = fakeStorage();
  const a = new S.Store(ls, () => 1000);
  a.load();
  const game = E.newGame({ name: 'G', playerNames: ['P'], createdAt: 1000 });
  const pid = game.players[0].id;
  a.addGame(game, true);

  // Tab B loads a snapshot now, before either tab adds its round.
  const b = new S.Store(ls, () => 2000);
  b.load();

  // Tab A adds round RA and persists.
  E.addRound(game, [{ playerId: pid, mode: 'simple', value: 10 }], 1500);
  a.touch(game);

  // Tab B (stale) adds a different round RB and persists — must merge, not clobber.
  const bGame = b.currentGame();
  E.addRound(bGame, [{ playerId: pid, mode: 'simple', value: 7 }], 2500);
  b.touch(bGame);

  const check = new S.Store(ls, () => 3000);
  check.load();
  const merged = check.currentGame();
  assert.strictEqual(merged.rounds.length, 2, 'both rounds survive: got ' + merged.rounds.length);
  assert.deepStrictEqual(merged.rounds.map((r) => r.index), [1, 2]);
  assert.strictEqual(E.playerTotals(merged)[pid], 17);
});

test('deleted game stays deleted across tabs (tombstones)', () => {
  const ls = fakeStorage();
  const a = new S.Store(ls, () => 1000);
  a.load();
  const game = E.newGame({ name: 'Doomed', playerNames: ['P'], createdAt: 1000 });
  a.addGame(game, true);

  const b = new S.Store(ls, () => 2000);
  b.load(); // B holds a copy

  a.deleteGame(game.id); // A deletes at t=1000? now() is 1000 for a — use later store
  // B autosaves something unrelated; its copy of the game must NOT resurrect.
  const other = E.newGame({ name: 'Other', playerNames: ['Q'], createdAt: 2000 });
  b.addGame(other, true);

  const check = new S.Store(ls, () => 3000);
  check.load();
  const names = Object.keys(check.state.games).map((id) => check.state.games[id].name);
  assert.ok(names.indexOf('Doomed') === -1, 'tombstoned game resurrected: ' + JSON.stringify(names));
  assert.ok(names.indexOf('Other') !== -1);
});

test('settings change in a stale tab survives its own persist (no meta clobber)', () => {
  const ls = fakeStorage();
  const a = new S.Store(ls, () => 1000);
  a.load();
  const game = E.newGame({ name: 'G', playerNames: ['P'], createdAt: 1000 });
  a.addGame(game, true);
  a.touch(game); a.touch(game); // storage rev races ahead

  const b = new S.Store(ls, () => 2000);
  b.load();
  b.state.rev = 0; // simulate a long-stale in-memory tab
  b.updateSettings({ bigType: true });
  assert.strictEqual(b.state.settings.bigType, true, 'own change not reverted by merge');
  const check = new S.Store(ls, () => 3000);
  check.load();
  assert.strictEqual(check.state.settings.bigType, true, 'change reached storage');
});

test('failed write rolls the revision back so the guard still merges later', () => {
  const ls = fakeStorage();
  const a = new S.Store(ls, () => 1000);
  a.load();
  const game = E.newGame({ name: 'G', playerNames: ['P'], createdAt: 1000 });
  a.addGame(game, true);
  const revBefore = a.state.rev;

  // Simulate quota failure on the main key only (backup writes would also fail, fine).
  const realSet = ls.setItem;
  ls.setItem = () => { throw new Error('QuotaExceededError'); };
  const ok = a.persist();
  ls.setItem = realSet;
  assert.strictEqual(ok, false);
  assert.strictEqual(a.state.rev, revBefore, 'rev rolled back on failed write');
  assert.ok(a.recoveryNotice, 'user is told autosave failed');
});

test('corrupt save with failed backup: notice is honest, original untouched', () => {
  const ls = fakeStorage();
  ls.setItem(S.KEY, '{definitely not json');
  const realSet = ls.setItem.bind(ls);
  ls.setItem = (k, v) => { if (k.startsWith(S.BACKUP_PREFIX)) throw new Error('quota'); realSet(k, v); };
  const store = new S.Store(ls, () => 5000);
  store.load();
  assert.ok(store.recoveryNotice.indexOf('NOT been touched') !== -1, 'must not claim preservation: ' + store.recoveryNotice);
  assert.strictEqual(ls.getItem(S.KEY), '{definitely not json', 'original bytes still in place');
});

test('toInt: number-input strings like "1e3" read as 1000, junk as 0', () => {
  assert.strictEqual(E.toInt('1e3'), 1000);
  assert.strictEqual(E.toInt('2e2'), 200);
  assert.strictEqual(E.toInt('-7'), -7);
  assert.strictEqual(E.toInt('12.9'), 12);
  assert.strictEqual(E.toInt('abc'), 0);
  assert.strictEqual(E.toInt(''), 0);
  assert.strictEqual(E.toInt(null), 0);
});

test('merge: adjustment anchored in tab B follows its round when tab A deleted an earlier round', () => {
  const ls = fakeStorage();
  const a = new S.Store(ls, () => 1000);
  a.load();
  const game = E.newGame({ name: 'G', playerNames: ['P'], createdAt: 1000 });
  const pid = game.players[0].id;
  const r1 = E.addRound(game, [{ playerId: pid, mode: 'simple', value: 1 }], 100);
  E.addRound(game, [{ playerId: pid, mode: 'simple', value: 2 }], 200);
  a.addGame(game, true);

  const b = new S.Store(ls, () => 2000);
  b.load(); // B sees rounds 1 and 2

  // Tab A deletes round 1 (round 2 renumbers to 1) and persists.
  E.deleteRound(game, r1.id);
  a.touch(game);

  // Tab B (stale) attaches a correction to what it still calls round 2, persists → merge.
  const bGame = b.currentGame();
  E.addAdjustment(bGame, bGame.players[0].id, 5, 'fix', 2, 2000);
  b.touch(bGame);

  const check = new S.Store(ls, () => 3000);
  check.load();
  const merged = check.currentGame();
  const adj = merged.adjustments[0];
  const roundIdx = merged.rounds.find((r) => E.scoreValue(r.scores[0]) === 2).index;
  assert.strictEqual(adj.attachedToRoundIndex, roundIdx,
    'anchor must follow the round with value 2, got ' + adj.attachedToRoundIndex + ' vs ' + roundIdx);
  assert.strictEqual(E.playerTotals(merged)[pid], 2 + 5);
});

test('tombstones are pruned oldest-first past the cap', () => {
  const ls = fakeStorage();
  const s = new S.Store(ls, () => 1000);
  s.load();
  for (let i = 1; i <= 45; i++) s.state.tombstones['dead-' + i] = i;
  s.persist();
  const keys = Object.keys(s.state.tombstones);
  assert.strictEqual(keys.length, 40, 'capped at 40, got ' + keys.length);
  assert.ok(!keys.includes('dead-1') && !keys.includes('dead-5'), 'oldest dropped');
  assert.ok(keys.includes('dead-45'), 'newest kept');
});

test('deleting the current game falls back to the newest remaining game', () => {
  const ls = fakeStorage();
  const s = new S.Store(ls, () => 1000);
  s.load();
  const g1 = E.newGame({ name: 'Old', playerNames: ['A'], createdAt: 1 });
  const g2 = E.newGame({ name: 'New', playerNames: ['B'], createdAt: 2 });
  s.addGame(g1, false);
  g1.updatedAt = 1; s.persist();
  s.addGame(g2, true);
  g2.updatedAt = 99; s.persist();
  s.deleteGame(g2.id);
  assert.strictEqual(s.state.currentGameId, g1.id, 'falls back to remaining game');
});

test('corrupt save + failed backup: ensureSeed must NOT overwrite the original', () => {
  const ls = fakeStorage();
  ls.setItem(S.KEY, '{definitely not json');
  const realSet = ls.setItem.bind(ls);
  ls.setItem = (k, v) => { if (k.startsWith(S.BACKUP_PREFIX)) throw new Error('quota'); realSet(k, v); };
  const s = new S.Store(ls, () => 5000);
  s.load();
  assert.strictEqual(s.writesBlocked, true);
  s.ensureSeed(); // the exact boot sequence app.js runs
  s.persist();
  assert.strictEqual(ls.getItem(S.KEY), '{definitely not json',
    'original corrupt bytes survive the boot sequence');
  // Explicit user consent unblocks writes.
  s.allowOverwrite();
  s.ensureSeed();
  assert.notStrictEqual(ls.getItem(S.KEY), '{definitely not json', 'overwrite happens only after consent');
  assert.ok(s.currentGame(), 'seed loads after consent');
});

test('settings sanitization falls back safely on junk values', () => {
  const st = S.sanitizeState({ rev: 'x', settings: { darkMode: 'disco', defaultInputMode: 42, bigType: 'yes' } });
  assert.strictEqual(st.settings.darkMode, 'auto');
  assert.strictEqual(st.settings.defaultInputMode, 'simple');
  assert.strictEqual(st.settings.bigType, true);
  assert.strictEqual(st.rev, 0);
});

/* ---------- summary ---------- */
console.log('\n' + '─'.repeat(40));
console.log('TESTS: ' + (passed + failed) + '  PASSED: ' + passed + '  FAILED: ' + failed);
if (failed > 0) {
  failures.forEach((f) => console.error('FAILED: ' + f.name + ' — ' + f.err.message));
  process.exit(1);
}
