/*
 * Dutch Blitz Sidecar — scoring engine.
 * Pure functions only: no DOM, no storage, no clocks. Everything that decides
 * a number lives here so the Node test suite and the browser run identical code.
 * UMD-ish wrapper: `require()` in Node, `window.BlitzEngine` in the browser
 * (plain script tag, so the app still runs from file://).
 */
(function (global, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    global.BlitzEngine = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var uidCounter = 0;
  function uid(prefix) {
    uidCounter += 1;
    return (
      (prefix || 'id') + '-' +
      Date.now().toString(36) + '-' +
      Math.random().toString(36).slice(2, 8) + '-' +
      uidCounter.toString(36)
    );
  }

  function toInt(value) {
    var n = typeof value === 'number' ? value : parseInt(value, 10);
    return Number.isFinite(n) ? Math.trunc(n) : 0;
  }

  /** Official scoring: +1 per card played to Dutch piles, −2 per card left in Blitz pile. */
  function calcScore(dutchCards, blitzLeft) {
    return toInt(dutchCards) - 2 * toInt(blitzLeft);
  }

  /**
   * Exact inverse of calcScore for a bare value, so switching entry modes never
   * loses what was typed: value = dutchCards − 2 × blitzLeft always holds.
   */
  function toCalcFields(value) {
    var v = toInt(value);
    if (v >= 0) return { dutchCards: v, blitzLeft: 0 };
    var d = (v % 2 !== 0) ? 1 : 0;
    return { dutchCards: d, blitzLeft: (d - v) / 2 };
  }

  /** Resolve a RoundScore entry (simple or calc mode) to its point value. */
  function scoreValue(rs) {
    if (!rs) return 0;
    if (rs.mode === 'calc') return calcScore(rs.dutchCards, rs.blitzLeft);
    return toInt(rs.value);
  }

  function roundScoreFor(round, playerId) {
    if (!round || !Array.isArray(round.scores)) return null;
    for (var i = 0; i < round.scores.length; i++) {
      if (round.scores[i].playerId === playerId) return round.scores[i];
    }
    return null;
  }

  /**
   * Totals per player: sum of all round scores plus all adjustments.
   * Always recomputed from history — totals are never stored, so edits and
   * corrections can't drift out of sync.
   */
  function playerTotals(game) {
    var totals = {};
    (game.players || []).forEach(function (p) { totals[p.id] = 0; });
    (game.rounds || []).forEach(function (round) {
      (round.scores || []).forEach(function (rs) {
        if (Object.prototype.hasOwnProperty.call(totals, rs.playerId)) {
          totals[rs.playerId] += scoreValue(rs);
        }
      });
    });
    (game.adjustments || []).forEach(function (adj) {
      if (Object.prototype.hasOwnProperty.call(totals, adj.playerId)) {
        totals[adj.playerId] += toInt(adj.delta);
      }
    });
    return totals;
  }

  function isStandalone(adj) {
    return adj.attachedToRoundIndex === null || adj.attachedToRoundIndex === undefined;
  }

  /**
   * Running totals per player after each round index. Adjustments attached to
   * a round count at that round; standalone adjustments count in the final
   * row, so the last "after:" snapshot always agrees with the leaderboard.
   */
  function cumulativeByRound(game) {
    var rows = [];
    var running = {};
    (game.players || []).forEach(function (p) { running[p.id] = 0; });
    (game.rounds || []).forEach(function (round) {
      (game.players || []).forEach(function (p) {
        var rs = roundScoreFor(round, p.id);
        if (rs) running[p.id] += scoreValue(rs);
      });
      (game.adjustments || []).forEach(function (adj) {
        if (adj.attachedToRoundIndex === round.index &&
            Object.prototype.hasOwnProperty.call(running, adj.playerId)) {
          running[adj.playerId] += toInt(adj.delta);
        }
      });
      var snapshot = {};
      Object.keys(running).forEach(function (k) { snapshot[k] = running[k]; });
      rows.push({ index: round.index, totals: snapshot });
    });
    if (rows.length) {
      var last = rows[rows.length - 1].totals;
      (game.adjustments || []).forEach(function (adj) {
        if (isStandalone(adj) && Object.prototype.hasOwnProperty.call(last, adj.playerId)) {
          last[adj.playerId] += toInt(adj.delta);
        }
      });
    }
    return rows;
  }

  /**
   * Leaderboard, high → low. Ties share a rank (1, 1, 3). Flags the leader(s)
   * and anyone at or past the target.
   */
  function standings(game) {
    var totals = playerTotals(game);
    var target = toInt(game.targetScore) || 75;
    var list = (game.players || []).map(function (p) {
      return { player: p, total: totals[p.id] || 0 };
    });
    list.sort(function (a, b) {
      if (b.total !== a.total) return b.total - a.total;
      return String(a.player.name).localeCompare(String(b.player.name));
    });
    var max = list.length ? list[0].total : 0;
    var prevTotal = null;
    var prevRank = 0;
    list.forEach(function (row, i) {
      row.rank = row.total === prevTotal ? prevRank : i + 1;
      prevTotal = row.total;
      prevRank = row.rank;
      row.isLeader = list.length > 0 && row.total === max &&
        (game.rounds || []).length + (game.adjustments || []).length > 0;
      row.hitTarget = row.total >= target;
    });
    return list;
  }

  function hasWinner(game) {
    return standings(game).some(function (r) { return r.hitTarget; });
  }

  function playerName(game, playerId) {
    var p = (game.players || []).find(function (x) { return x.id === playerId; });
    return p ? p.name : '(removed player)';
  }

  function signed(n) { return n > 0 ? '+' + n : String(n); }

  /** Plain-text history export — rounds, corrections (always visible), and final standings. */
  function exportText(game) {
    var lines = [];
    lines.push('Dutch Blitz — ' + (game.name || 'Game'));
    lines.push('Target: ' + (toInt(game.targetScore) || 75) + ' points');
    lines.push('');
    var cumulative = cumulativeByRound(game);
    (game.rounds || []).forEach(function (round, i) {
      lines.push('Round ' + round.index + ':');
      (game.players || []).forEach(function (p) {
        var rs = roundScoreFor(round, p.id);
        if (!rs) {
          lines.push('  ' + p.name + ': — (not in this round)');
          return;
        }
        var detail = rs.mode === 'calc'
          ? ' (' + toInt(rs.dutchCards) + ' played − 2×' + toInt(rs.blitzLeft) + ' left)'
          : '';
        lines.push('  ' + p.name + ': ' + signed(scoreValue(rs)) + detail);
      });
      (game.adjustments || []).forEach(function (adj) {
        if (adj.attachedToRoundIndex === round.index) {
          lines.push('  CORRECTION — ' + playerName(game, adj.playerId) + ': ' +
            signed(toInt(adj.delta)) + (adj.label ? ' (' + adj.label + ')' : ''));
        }
      });
      var snap = cumulative[i];
      if (snap) {
        lines.push('  Totals: ' + (game.players || []).map(function (p) {
          return p.name + ' ' + (snap.totals[p.id] || 0);
        }).join(' · '));
      }
      lines.push('');
    });
    var standalone = (game.adjustments || []).filter(function (a) {
      return a.attachedToRoundIndex === null || a.attachedToRoundIndex === undefined;
    });
    if (standalone.length) {
      lines.push('Standalone corrections:');
      standalone.forEach(function (adj) {
        lines.push('  ' + playerName(game, adj.playerId) + ': ' + signed(toInt(adj.delta)) +
          (adj.label ? ' (' + adj.label + ')' : ''));
      });
      lines.push('');
    }
    lines.push('Standings:');
    standings(game).forEach(function (row) {
      lines.push('  ' + row.rank + '. ' + row.player.name + ' — ' + row.total +
        (row.hitTarget ? ' 🏆 target reached' : ''));
    });
    return lines.join('\n');
  }

  /* ---------- mutations (pure: return the same game object, mutated in place by app layer contract) ---------- */

  function addRound(game, scores, timestamp) {
    var round = {
      id: uid('round'),
      index: (game.rounds || []).length + 1,
      timestamp: timestamp || 0,
      scores: scores,
    };
    game.rounds = (game.rounds || []).concat([round]);
    return round;
  }

  function updateRound(game, roundId, scores) {
    var round = (game.rounds || []).find(function (r) { return r.id === roundId; });
    if (!round) return null;
    round.scores = scores;
    return round;
  }

  /**
   * Delete a round and re-index the ones after it. Adjustments attached to the
   * deleted round become standalone (still visible, never silently dropped);
   * adjustments attached to later rounds follow their round down one index.
   */
  function deleteRound(game, roundId) {
    var idx = (game.rounds || []).findIndex(function (r) { return r.id === roundId; });
    if (idx === -1) return false;
    var removedIndex = game.rounds[idx].index;
    game.rounds.splice(idx, 1);
    game.rounds.forEach(function (r, i) { r.index = i + 1; });
    (game.adjustments || []).forEach(function (adj) {
      if (adj.attachedToRoundIndex === removedIndex) {
        adj.attachedToRoundIndex = null;
        adj.label = (adj.label ? adj.label + ' ' : '') + '(round ' + removedIndex + ' deleted)';
      } else if (adj.attachedToRoundIndex > removedIndex) {
        adj.attachedToRoundIndex -= 1;
      }
    });
    return true;
  }

  function undoLastRound(game) {
    var rounds = game.rounds || [];
    var last = rounds[rounds.length - 1];
    if (!last) return false;
    return deleteRound(game, last.id);
  }

  function addAdjustment(game, playerId, delta, label, attachedToRoundIndex, timestamp) {
    // An anchor that doesn't point at a real round becomes standalone —
    // an adjustment must never count toward totals while hidden from history.
    var anchor = null;
    if (attachedToRoundIndex !== null && attachedToRoundIndex !== undefined) {
      var n = toInt(attachedToRoundIndex);
      if (n >= 1 && n <= (game.rounds || []).length) anchor = n;
    }
    var adj = {
      id: uid('adj'),
      playerId: playerId,
      delta: toInt(delta),
      label: label || 'Correction',
      attachedToRoundIndex: anchor,
      timestamp: timestamp || 0,
    };
    game.adjustments = (game.adjustments || []).concat([adj]);
    return adj;
  }

  function deleteAdjustment(game, adjId) {
    var before = (game.adjustments || []).length;
    game.adjustments = (game.adjustments || []).filter(function (a) { return a.id !== adjId; });
    return game.adjustments.length !== before;
  }

  /** Duplicate names get a numeric suffix so history stays unambiguous. */
  function dedupeName(game, name, excludePlayerId) {
    var base = String(name || '').trim() || 'Player';
    var taken = Object.create(null); // null-proto so names like "constructor" don't false-match
    (game.players || []).forEach(function (p) {
      if (p.id !== excludePlayerId) taken[p.name.toLowerCase()] = true;
    });
    if (!taken[base.toLowerCase()]) return base;
    var n = 2;
    while (taken[(base + ' ' + n).toLowerCase()]) n += 1;
    return base + ' ' + n;
  }

  var PLAYER_COLORS = ['red', 'blue', 'green', 'yellow'];
  var MAX_PLAYERS = 8; // standard 2–4; expansion pack allows up to 8

  function addPlayer(game, name) {
    if ((game.players || []).length >= MAX_PLAYERS) return null;
    var player = {
      id: uid('player'),
      name: dedupeName(game, name),
      color: PLAYER_COLORS[(game.players || []).length % PLAYER_COLORS.length],
    };
    game.players = (game.players || []).concat([player]);
    return player;
  }

  function renamePlayer(game, playerId, name) {
    var p = (game.players || []).find(function (x) { return x.id === playerId; });
    if (!p) return false;
    p.name = dedupeName(game, name, playerId);
    return true;
  }

  /** Removing a player strips their scores and adjustments — the confirm dialog in the UI states this explicitly. */
  function removePlayer(game, playerId) {
    var before = (game.players || []).length;
    game.players = (game.players || []).filter(function (p) { return p.id !== playerId; });
    if (game.players.length === before) return false;
    (game.rounds || []).forEach(function (r) {
      r.scores = (r.scores || []).filter(function (rs) { return rs.playerId !== playerId; });
    });
    game.adjustments = (game.adjustments || []).filter(function (a) { return a.playerId !== playerId; });
    return true;
  }

  /** Reset scores, keep players and target. */
  function resetGame(game) {
    game.rounds = [];
    game.adjustments = [];
    return game;
  }

  function newGame(opts) {
    opts = opts || {};
    var game = {
      id: uid('game'),
      name: String(opts.name || 'Dutch Blitz').trim() || 'Dutch Blitz',
      targetScore: toInt(opts.targetScore) || 75,
      players: [],
      rounds: [],
      adjustments: [],
      createdAt: opts.createdAt || 0,
      updatedAt: opts.createdAt || 0,
      rev: 0,
    };
    (opts.playerNames || []).forEach(function (n) {
      if (String(n).trim()) addPlayer(game, n);
    });
    return game;
  }

  /**
   * Seed game from the brief — doubles as the engine's regression fixture.
   * Expected totals: Jessica 26, Marc 23, Ryan 11, Anna 9.
   */
  function seedGame(timestamp) {
    var ts = timestamp || 0;
    var game = newGame({
      name: 'Sample game (demo)',
      targetScore: 75,
      playerNames: ['Ryan', 'Jessica', 'Anna', 'Marc'],
      createdAt: ts,
    });
    var ids = {};
    game.players.forEach(function (p) { ids[p.name] = p.id; });
    addRound(game, [
      { playerId: ids.Ryan, mode: 'simple', value: -2 },
      { playerId: ids.Jessica, mode: 'simple', value: 8 },
      { playerId: ids.Anna, mode: 'simple', value: 16 },
      { playerId: ids.Marc, mode: 'simple', value: 9 },
    ], ts);
    addRound(game, [
      { playerId: ids.Ryan, mode: 'simple', value: 13 },
      { playerId: ids.Jessica, mode: 'simple', value: 18 },
      { playerId: ids.Anna, mode: 'simple', value: -10 },
      { playerId: ids.Marc, mode: 'simple', value: 14 },
    ], ts);
    addAdjustment(game, ids.Anna, 3, 'Correction after Round 2', 2, ts);
    game.seed = true;
    return game;
  }

  /**
   * Fail-safe normalizer for anything read from storage. Coerces every field
   * to a usable shape; returns null only if the value isn't an object at all.
   * Unknown fields are preserved (forward compatibility).
   */
  function sanitizeGame(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var game = raw;
    game.id = typeof game.id === 'string' ? game.id : uid('game');
    game.name = typeof game.name === 'string' && game.name.trim() ? game.name : 'Recovered game';
    game.targetScore = toInt(game.targetScore) || 75;
    game.rev = toInt(game.rev);
    game.createdAt = toInt(game.createdAt);
    game.updatedAt = toInt(game.updatedAt);
    var seenIds = Object.create(null); // null-proto: ids named like Object.prototype keys must not collide
    game.players = (Array.isArray(game.players) ? game.players : [])
      .filter(function (p) { return p && typeof p === 'object'; })
      .filter(function (p) {
        // duplicate ids would double-count one player's totals — keep the first
        if (typeof p.id === 'string' && seenIds[p.id]) return false;
        if (typeof p.id === 'string') seenIds[p.id] = true;
        return true;
      })
      .map(function (p, i) {
        return {
          id: typeof p.id === 'string' ? p.id : uid('player'),
          name: typeof p.name === 'string' && p.name.trim() ? p.name : 'Player ' + (i + 1),
          color: PLAYER_COLORS.indexOf(p.color) !== -1 ? p.color : PLAYER_COLORS[i % PLAYER_COLORS.length],
        };
      });
    var validIds = Object.create(null);
    game.players.forEach(function (p) { validIds[p.id] = true; });
    // Remember each round's stored index before renumbering, so adjustment
    // anchors can be remapped to the same round rather than the same number.
    var indexMap = Object.create(null);
    game.rounds = (Array.isArray(game.rounds) ? game.rounds : [])
      .filter(function (r) { return r && typeof r === 'object'; })
      .map(function (r, i) {
        var storedIndex = toInt(r.index) >= 1 ? toInt(r.index) : i + 1; // legacy rounds without an index anchor by position
        if (indexMap[storedIndex] === undefined) indexMap[storedIndex] = i + 1;
        return {
          id: typeof r.id === 'string' ? r.id : uid('round'),
          index: i + 1,
          timestamp: toInt(r.timestamp),
          scores: (Array.isArray(r.scores) ? r.scores : [])
            .filter(function (rs) { return rs && typeof rs === 'object' && validIds[rs.playerId] === true; })
            .map(function (rs) {
              return rs.mode === 'calc'
                ? { playerId: rs.playerId, mode: 'calc', dutchCards: toInt(rs.dutchCards), blitzLeft: toInt(rs.blitzLeft) }
                : { playerId: rs.playerId, mode: 'simple', value: toInt(rs.value) };
            }),
        };
      });
    game.adjustments = (Array.isArray(game.adjustments) ? game.adjustments : [])
      .filter(function (a) { return a && typeof a === 'object' && validIds[a.playerId] === true; })
      .map(function (a) {
        var anchor = null;
        if (a.attachedToRoundIndex !== null && a.attachedToRoundIndex !== undefined) {
          // unmappable anchors become standalone — visible, never hidden
          anchor = indexMap[toInt(a.attachedToRoundIndex)] !== undefined
            ? indexMap[toInt(a.attachedToRoundIndex)] : null;
        }
        return {
          id: typeof a.id === 'string' ? a.id : uid('adj'),
          playerId: a.playerId,
          delta: toInt(a.delta),
          label: typeof a.label === 'string' ? a.label : 'Correction',
          attachedToRoundIndex: anchor,
          timestamp: toInt(a.timestamp),
        };
      });
    return game;
  }

  return {
    uid: uid,
    toInt: toInt,
    signed: signed,
    playerName: playerName,
    isStandalone: isStandalone,
    calcScore: calcScore,
    toCalcFields: toCalcFields,
    scoreValue: scoreValue,
    roundScoreFor: roundScoreFor,
    playerTotals: playerTotals,
    cumulativeByRound: cumulativeByRound,
    standings: standings,
    hasWinner: hasWinner,
    exportText: exportText,
    addRound: addRound,
    updateRound: updateRound,
    deleteRound: deleteRound,
    undoLastRound: undoLastRound,
    addAdjustment: addAdjustment,
    deleteAdjustment: deleteAdjustment,
    addPlayer: addPlayer,
    renamePlayer: renamePlayer,
    removePlayer: removePlayer,
    dedupeName: dedupeName,
    resetGame: resetGame,
    newGame: newGame,
    seedGame: seedGame,
    sanitizeGame: sanitizeGame,
    PLAYER_COLORS: PLAYER_COLORS,
    MAX_PLAYERS: MAX_PLAYERS,
  };
});
