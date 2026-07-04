/*
 * Pile On — live Dutch Blitz rules engine.
 * Pure and deterministic: no DOM, no network, no clocks. The host runs this
 * as the single authority; guests send intents and receive state. Every rule
 * here mirrors the verified official rules in the Rules hub:
 *   - per-player 40-card deck, 1–10 in four colors; red/blue are boys,
 *     green/yellow are girls
 *   - Blitz pile of 10 (top playable); emptying it ends the round
 *   - 3 Post piles, built DOWN with alternating boy/girl; top card playable;
 *     an empty slot is refilled from the Blitz pile
 *   - hand flipped 3 at a time onto the face-up Wood pile (top playable);
 *     an exhausted hand picks the Wood pile back up, turned over, unshuffled
 *   - shared Dutch piles: any 1 starts a pile, build 1→10 in one color,
 *     a completed pile is set aside
 *   - scoring: +1 per own card in the Dutch piles, −2 per Blitz leftover
 *   - races: first card down stays (host applies intents in arrival order)
 * UMD: `require()` in Node tests, `window.BlitzPlay` in the browser.
 */
(function (global, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else global.BlitzPlay = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var COLORS = ['red', 'blue', 'green', 'yellow'];
  var BOYS = { red: true, blue: true }; // green/yellow are girls

  function isBoy(card) { return !!BOYS[card.color]; }

  /** Deterministic RNG (mulberry32) so rounds are reproducible in tests. */
  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function makeDeck(ownerId) {
    var deck = [];
    COLORS.forEach(function (color) {
      for (var v = 1; v <= 10; v++) {
        deck.push({ id: ownerId + ':' + color + ':' + v, color: color, value: v, owner: ownerId });
      }
    });
    return deck;
  }

  function shuffle(arr, random) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(random() * (i + 1));
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  /**
   * Deal a fresh round. players: [{id, name}]; seed: integer.
   * All piles are arrays with the TOP at the END.
   */
  function newRound(players, seed) {
    if (!players || players.length < 2 || players.length > 4) {
      throw new Error('Dutch Blitz needs 2–4 players');
    }
    var random = rng(seed == null ? 1 : seed);
    var state = {
      status: 'playing',
      seq: 0,
      seed: seed == null ? 1 : seed,
      winner: null,
      scores: null,
      completedPiles: 0,
      dutch: [],       // [{color, top, done}] — slots are stable; done piles stay put
      players: {},
      order: players.map(function (p) { return p.id; }),
    };
    players.forEach(function (p, i) {
      var deck = shuffle(makeDeck(p.id), random);
      var blitz = deck.slice(0, 10);
      var post = [[deck[10]], [deck[11]], [deck[12]]];
      var hand = deck.slice(13);
      state.players[p.id] = {
        id: p.id,
        name: p.name,
        identity: COLORS[i % 4], // deck-back identity for the UI
        blitz: blitz,   // face up, top = end
        post: post,     // three stacks, top = end
        hand: hand,     // face down, top = end
        wood: [],       // face up, top = end
        dutchCount: 0,
      };
    });
    return state;
  }

  function top(pile) { return pile.length ? pile[pile.length - 1] : null; }

  function computeScores(state) {
    var scores = {};
    state.order.forEach(function (id) {
      var p = state.players[id];
      scores[id] = {
        played: p.dutchCount,
        blitzLeft: p.blitz.length,
        score: p.dutchCount - 2 * p.blitz.length,
      };
    });
    return scores;
  }

  function endRound(state, winnerId) {
    state.status = 'ended';
    state.winner = winnerId;
    state.scores = computeScores(state);
  }

  /**
   * Strict index check for the three Post slots. Intents arrive from the
   * network — a loose `< 0 || > 2` guard lets strings like '__proto__'
   * through (NaN comparisons are false) and player.post['__proto__'] is
   * Array.prototype, so a hostile guest could push cards onto it.
   */
  function isPostIdx(i) { return i === 0 || i === 1 || i === 2; }

  /** Reads the playable card for a source zone without removing it. */
  function peek(player, from) {
    if (from.zone === 'blitz') return top(player.blitz);
    if (from.zone === 'wood') return top(player.wood);
    if (from.zone === 'post') {
      if (!isPostIdx(from.idx)) return null;
      return top(player.post[from.idx]);
    }
    return null;
  }

  function removeTop(player, from) {
    if (from.zone === 'blitz') return player.blitz.pop();
    if (from.zone === 'wood') return player.wood.pop();
    if (from.zone === 'post') return player.post[from.idx].pop();
    return null;
  }

  /**
   * Apply one intent. Mutates state; returns {ok:true, event} or
   * {ok:false, reason}. Rejections are normal gameplay (lost races) —
   * the reason string is surfaced to the player.
   */
  function applyIntent(state, playerId, intent) {
    if (state.status !== 'playing') return { ok: false, reason: 'round-over' };
    if (!intent || typeof intent !== 'object' || typeof intent.type !== 'string') return { ok: false, reason: 'bad-intent' };
    var player = state.players[playerId];
    if (!player) return { ok: false, reason: 'unknown-player' };

    if (intent.type === 'flip') {
      if (!player.hand.length && !player.wood.length) return { ok: false, reason: 'nothing-to-flip' };
      if (!player.hand.length) {
        // pick the wood pile back up, turned over — the first card flipped
        // long ago becomes the top of the hand again; never shuffled
        player.hand = player.wood.reverse();
        player.wood = [];
      }
      var n = Math.min(3, player.hand.length);
      for (var i = 0; i < n; i++) player.wood.push(player.hand.pop());
      player.flipsSincePlay = (player.flipsSincePlay || 0) + 1;
      state.seq++;
      return { ok: true, event: { type: 'flip', playerId: playerId } };
    }

    if (intent.type === 'nudge') {
      // Official stall rule: when nobody can move, each player takes the top
      // card of their hand and moves it to the bottom, changing what the
      // count-of-3 reveals. The host applies this to every player at once.
      state.order.forEach(function (id) {
        var q = state.players[id];
        if (!q.hand.length && q.wood.length) { q.hand = q.wood.reverse(); q.wood = []; }
        if (q.hand.length > 1) q.hand.unshift(q.hand.pop());
        q.flipsSincePlay = 0;
      });
      state.seq++;
      return { ok: true, event: { type: 'nudge' } };
    }

    if (intent.type === 'play') {
      var from = intent.from || {};
      var to = intent.to || {};
      var card = peek(player, from);
      if (!card) return { ok: false, reason: 'nothing-there' };

      if (to.zone === 'dutchNew') {
        if (card.value !== 1) return { ok: false, reason: 'only-a-1-starts-a-pile' };
        removeTop(player, from);
        // reuse the first spent slot so the grid never reflows under a thumb
        var spent = -1;
        for (var d = 0; d < state.dutch.length; d++) { if (state.dutch[d].done) { spent = d; break; } }
        var fresh = { color: card.color, top: 1, done: false };
        if (spent !== -1) state.dutch[spent] = fresh; else state.dutch.push(fresh);
        player.dutchCount++;
      } else if (to.zone === 'dutch') {
        var pile = typeof to.idx === 'number' ? state.dutch[to.idx] : null;
        if (!pile || pile.done) return { ok: false, reason: 'beaten-to-it' };
        if (pile.color !== card.color || card.value !== pile.top + 1) {
          return { ok: false, reason: 'beaten-to-it' }; // someone else got there first (or illegal)
        }
        removeTop(player, from);
        pile.top++;
        player.dutchCount++;
        if (pile.top === 10) {
          pile.done = true; // set aside in place — indexes stay stable mid-race
          state.completedPiles++;
        }
      } else if (to.zone === 'post') {
        if (!isPostIdx(to.idx)) return { ok: false, reason: 'no-such-post' };
        if (from.zone === 'post' && from.idx === to.idx) return { ok: false, reason: 'same-pile' };
        var slot = player.post[to.idx];
        var slotTop = top(slot);
        if (!slotTop) {
          // official rule: empty Post slots are refilled from the Blitz pile
          if (from.zone !== 'blitz') return { ok: false, reason: 'empty-post-fills-from-blitz' };
        } else {
          if (card.value !== slotTop.value - 1) return { ok: false, reason: 'must-build-down' };
          if (isBoy(card) === isBoy(slotTop)) return { ok: false, reason: 'must-alternate-boy-girl' };
        }
        removeTop(player, from);
        slot.push(card);
      } else {
        return { ok: false, reason: 'bad-target' };
      }

      state.seq++;
      // a successful play anywhere un-stalls the whole table
      state.order.forEach(function (id) { state.players[id].flipsSincePlay = 0; });
      var event = { type: 'play', playerId: playerId, card: { color: card.color, value: card.value }, from: from.zone, to: to.zone };
      if (from.zone === 'blitz' && player.blitz.length === 0) {
        endRound(state, playerId);
        event.blitz = true;
      }
      return { ok: true, event: event };
    }

    return { ok: false, reason: 'unknown-intent' };
  }

  /**
   * True when every player has cycled their whole hand at least once with no
   * successful play anywhere — the official stall; the host should nudge.
   */
  function isStalled(state) {
    if (state.status !== 'playing') return false;
    return state.order.every(function (id) {
      var p = state.players[id];
      var cycle = Math.ceil((p.hand.length + p.wood.length) / 3) + 1;
      return (p.flipsSincePlay || 0) >= Math.max(cycle, 3);
    });
  }

  /** Every legal Dutch-pile target for a card (for tap-to-play highlighting). */
  function legalDutchTargets(state, card) {
    var targets = [];
    if (!card) return targets;
    state.dutch.forEach(function (pile, i) {
      if (!pile.done && pile.color === card.color && card.value === pile.top + 1) targets.push(i);
    });
    if (card.value === 1) targets.push('new');
    return targets;
  }

  return {
    COLORS: COLORS,
    isBoy: isBoy,
    rng: rng,
    makeDeck: makeDeck,
    newRound: newRound,
    applyIntent: applyIntent,
    isStalled: isStalled,
    legalDutchTargets: legalDutchTargets,
    computeScores: computeScores,
    top: top,
  };
});
