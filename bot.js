/*
 * Pile On — computer opponents.
 * Pure decision + timing helpers. The HOST runs bots; each bot emits the same
 * `play`/`flip` intents a guest would, through the same applyIntent authority,
 * so a bot races fairly (it can legitimately lose a Dutch race with
 * "beaten-to-it") and can never desync or cheat the rules.
 *
 * Difficulty is a blend of reaction latency, decision quality, and error rate
 * — not raw speed. Expert keeps a human-plausible reaction floor and still
 * makes rare real mistakes, so it feels like a sharp person, not a machine gun.
 * Tiers are tuned to a game designer's spec.
 * UMD: require() in tests, window.BlitzBot in the browser.
 */
(function (global, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else global.BlitzBot = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ranges are [min,max] ms; a fresh uniform sample is drawn per move so bots
  // never feel synchronized. floor = never react faster than this.
  var TIERS = {
    easy: {
      label: 'Easy', name: 'Sprout',
      think: [700, 1200], flip: [900, 1400], contestExtra: [600, 1000], floor: 700,
      missRate: 0.45, misplayRate: 0.12, blitzFirst: 0.15, postMgmt: 0.10,
      usePosts: false, postFromWood: false, dumpBlitz: false, rubberband: true,
    },
    medium: {
      label: 'Medium', name: 'Maple',
      think: [400, 650], flip: [500, 700], contestExtra: [300, 500], floor: 380,
      missRate: 0.22, misplayRate: 0.05, blitzFirst: 0.45, postMgmt: 0.40,
      usePosts: true, postFromWood: false, dumpBlitz: true, rubberband: 'mild',
    },
    hard: {
      label: 'Hard', name: 'Birch',
      think: [220, 360], flip: [300, 400], contestExtra: [120, 250], floor: 200,
      missRate: 0.08, misplayRate: 0.015, blitzFirst: 0.80, postMgmt: 0.75,
      usePosts: true, postFromWood: true, dumpBlitz: true, rubberband: false,
    },
    expert: {
      label: 'Expert', name: 'Cedar',
      think: [140, 260], flip: [180, 260], contestExtra: [60, 150], floor: 130,
      missRate: 0.02, misplayRate: 0.003, blitzFirst: 0.95, postMgmt: 0.95,
      usePosts: true, postFromWood: true, dumpBlitz: true, rubberband: false,
    },
  };
  var ORDER = ['easy', 'medium', 'hard', 'expert'];
  function tier(name) { return TIERS[name] || TIERS.medium; }

  function span(range, rnd) { return range[0] + (range[1] - range[0]) * rnd(); }

  /** Where can `card` legally land on this player's Posts? An empty Post slot
      may only be filled from the Blitz pile (official rule). */
  function postTargets(G, player, card, fromBlitz) {
    var out = [];
    for (var i = 0; i < 3; i++) {
      var t = G.top(player.post[i]);
      if (!t) { if (fromBlitz) out.push(i); }
      else if (card.value === t.value - 1 && G.isBoy(card) !== G.isBoy(t)) out.push(i);
    }
    return out;
  }

  function dutchTo(target) {
    return target === 'new' ? { zone: 'dutchNew' } : { zone: 'dutch', idx: target };
  }

  /** All legal moves this bot could make, each scored (higher = better). */
  function candidates(G, state, p, cfg) {
    var moves = [];
    var bTop = G.top(p.blitz), wTop = G.top(p.wood);
    var blitzBoost = cfg.blitzFirst * 40; // low blitzFirst => leaves Blitz sitting (beginner mistake)

    if (bTop) {
      var bt = G.legalDutchTargets(state, bTop);
      if (bt.length) moves.push({ w: 70 + blitzBoost, kind: 'dutch', intent: { type: 'play', from: { zone: 'blitz' }, to: dutchTo(bt[0]) } });
    }
    for (var i = 0; i < 3; i++) {
      var c = G.top(p.post[i]);
      if (!c) continue;
      var pt = G.legalDutchTargets(state, c);
      if (pt.length) moves.push({ w: 82, kind: 'dutch', intent: { type: 'play', from: { zone: 'post', idx: i }, to: dutchTo(pt[0]) } });
    }
    if (wTop) {
      var wt = G.legalDutchTargets(state, wTop);
      if (wt.length) moves.push({ w: 78, kind: 'dutch', intent: { type: 'play', from: { zone: 'wood' }, to: dutchTo(wt[0]) } });
    }
    if (bTop && cfg.usePosts && cfg.dumpBlitz) {
      var bp = postTargets(G, p, bTop, true);
      if (bp.length) moves.push({ w: 30 + blitzBoost, kind: 'post', intent: { type: 'play', from: { zone: 'blitz' }, to: { zone: 'post', idx: bp[0] } } });
    }
    if (wTop && cfg.usePosts && cfg.postFromWood) {
      var wp = postTargets(G, p, wTop, false);
      if (wp.length) moves.push({ w: 20 + cfg.postMgmt * 20, kind: 'post', intent: { type: 'play', from: { zone: 'wood' }, to: { zone: 'post', idx: wp[0] } } });
    }
    moves.sort(function (a, b) { return b.w - a.w; });
    return moves;
  }

  /**
   * Decide one move for bot `pid`. Returns { intent, kind } or null (nothing).
   * kind is 'dutch' | 'post' | 'flip' | 'misplay' — the host uses it to time
   * the next move (contested Dutch grabs get an extra latency). rnd() -> [0,1).
   */
  function decide(G, state, pid, cfg, rnd) {
    rnd = rnd || Math.random;
    if (!state || state.status !== 'playing') return null;
    var p = state.players[pid];
    if (!p) return null;

    var moves = candidates(G, state, p, cfg);

    // fumble: occasionally attempt a strictly-illegal move (gets nacked, costs
    // the bot a beat) — this is what makes Easy/Medium feel human.
    if (rnd() < cfg.misplayRate) {
      return { kind: 'misplay', intent: { type: 'play', from: { zone: 'wood' }, to: { zone: 'dutch', idx: 99 } } };
    }
    if (!moves.length) return { kind: 'flip', intent: { type: 'flip' } };

    // missed-play: don't take the best move this scan (take a worse one or flip)
    if (rnd() < cfg.missRate) {
      if (moves.length > 1 && rnd() < 0.5) return { kind: moves[1].kind, intent: moves[1].intent };
      return { kind: 'flip', intent: { type: 'flip' } };
    }
    return { kind: moves[0].kind, intent: moves[0].intent };
  }

  /** How long (ms) the bot should wait before its NEXT action after this one. */
  function nextDelay(cfg, rnd, kind, rubber) {
    var base;
    if (kind === 'flip') base = span(cfg.flip, rnd);
    else base = span(cfg.think, rnd);
    if (kind === 'dutch') base += span(cfg.contestExtra, rnd); // hesitate before grabbing a shared slot
    if (rubber) base *= 1.3; // easy bot eases off when a human is about to win
    return Math.max(cfg.floor, Math.round(base));
  }

  return { TIERS: TIERS, ORDER: ORDER, tier: tier, decide: decide, nextDelay: nextDelay, postTargets: postTargets, candidates: candidates };
});
