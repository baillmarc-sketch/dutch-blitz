/*
 * Dutch Blitz Sidecar — persistence layer.
 * localStorage only, autosave on every mutation, and three safety rules:
 *   1. Merge, never clobber: before each write we re-read the store; if another
 *      tab wrote a newer revision, we merge — per game, rounds and adjustments
 *      are unioned by id, so two tabs adding rounds both keep their work.
 *   2. Deletions use tombstones, so a deleted game can't be resurrected by a
 *      tab that still holds a copy.
 *   3. Never wipe silently: unparseable data is backed up under a separate key
 *      (verified!) and reported to the UI before we start fresh.
 * Plain script (no modules) so the app runs from file://.
 */
(function (global) {
  'use strict';

  var KEY = 'dutch-blitz-sidecar/v1';
  var BACKUP_PREFIX = 'dutch-blitz-sidecar/backup-';
  var VERSION = 1;
  var MAX_TOMBSTONES = 40;

  var Engine = global.BlitzEngine || (typeof require !== 'undefined' ? require('./engine.js') : null);
  if (!Engine) throw new Error('storage.js requires engine.js to be loaded first');
  var toInt = Engine.toInt;

  function defaultSettings() {
    return {
      bigType: false,
      darkMode: 'auto', // 'auto' | 'light' | 'dark'
      soundOn: false,
      defaultInputMode: 'simple', // 'simple' | 'calc'
    };
  }

  function emptyState() {
    return {
      version: VERSION,
      rev: 0,
      // null-prototype maps: ids named like Object.prototype keys ("constructor")
      // in a hostile/corrupt save must not hit inherited properties
      games: Object.create(null),
      tombstones: Object.create(null), // gameId -> deletion timestamp
      currentGameId: null,
      seedLoaded: false,
      settings: defaultSettings(),
    };
  }

  var MAX_GAMES = 100; // sanity cap so a hostile multi-MB payload can't freeze the tab

  /** Coerce anything parsed from storage into a valid state. Drops nothing it can keep. */
  function sanitizeState(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var state = emptyState();
    state.rev = toInt(raw.rev);
    state.seedLoaded = !!raw.seedLoaded;
    if (raw.settings && typeof raw.settings === 'object') {
      var s = raw.settings;
      state.settings.bigType = !!s.bigType;
      state.settings.darkMode = ['auto', 'light', 'dark'].indexOf(s.darkMode) !== -1 ? s.darkMode : 'auto';
      state.settings.soundOn = !!s.soundOn;
      state.settings.defaultInputMode = s.defaultInputMode === 'calc' ? 'calc' : 'simple';
    }
    if (raw.tombstones && typeof raw.tombstones === 'object') {
      Object.keys(raw.tombstones).forEach(function (id) {
        var ts = toInt(raw.tombstones[id]);
        if (ts > 0) state.tombstones[id] = ts;
      });
    }
    if (raw.games && typeof raw.games === 'object') {
      Object.keys(raw.games).slice(0, MAX_GAMES).forEach(function (id) {
        var g = Engine.sanitizeGame(raw.games[id]);
        if (g && !state.tombstones[g.id]) state.games[g.id] = g;
      });
    }
    if (typeof raw.currentGameId === 'string' && state.games[raw.currentGameId]) {
      state.currentGameId = raw.currentGameId;
    }
    return state;
  }

  function pickNewer(a, b) {
    if (toInt(b.rev) > toInt(a.rev)) return b;
    if (toInt(b.rev) === toInt(a.rev) && toInt(b.updatedAt) > toInt(a.updatedAt)) return b;
    return a;
  }

  /**
   * Merge two copies of the same game. The higher-revision copy is the base;
   * rounds, adjustments, and players the other copy has that the base lacks
   * are unioned in by id, so concurrent edits in two tabs both survive.
   * Mutates and returns the base copy (keeping live in-memory references valid).
   */
  function mergeGame(a, b) {
    var base = pickNewer(a, b);
    var other = base === a ? b : a;

    // Union deletion tombstones first: a delete in either tab always wins,
    // so a stale copy can't resurrect a removed round or correction.
    ['deletedRounds', 'deletedAdjustments'].forEach(function (field) {
      var union = Object.create(null);
      [a, b].forEach(function (g) {
        Object.keys(g[field] || {}).forEach(function (id) { union[id] = 1; });
      });
      base[field] = union;
    });
    var deadRound = base.deletedRounds;
    var deadAdj = base.deletedAdjustments;

    // Remember which round each side's index numbers refer to, pre-merge.
    var baseIdxToId = Object.create(null);
    var otherIdxToId = Object.create(null);
    (base.rounds || []).forEach(function (r) { baseIdxToId[r.index] = r.id; });
    (other.rounds || []).forEach(function (r) { otherIdxToId[r.index] = r.id; });

    base.rounds = (base.rounds || []).filter(function (r) { return !deadRound[r.id]; });
    base.adjustments = (base.adjustments || []).filter(function (adj) { return !deadAdj[adj.id]; });

    var haveRound = Object.create(null);
    base.rounds.forEach(function (r) { haveRound[r.id] = true; });
    (other.rounds || []).forEach(function (r) {
      if (!haveRound[r.id] && !deadRound[r.id]) base.rounds.push(r);
    });
    base.rounds.sort(function (x, y) {
      return (toInt(x.timestamp) - toInt(y.timestamp)) || (toInt(x.index) - toInt(y.index));
    });
    var idToNewIndex = Object.create(null);
    base.rounds.forEach(function (r, i) { r.index = i + 1; idToNewIndex[r.id] = i + 1; });

    function remapAnchor(adj, idxToId) {
      if (Engine.isStandalone(adj)) return;
      var rid = idxToId[adj.attachedToRoundIndex];
      adj.attachedToRoundIndex = (rid && idToNewIndex[rid]) ? idToNewIndex[rid] : null;
    }
    var haveAdj = Object.create(null);
    base.adjustments.forEach(function (adj) { haveAdj[adj.id] = true; remapAnchor(adj, baseIdxToId); });
    (other.adjustments || []).forEach(function (adj) {
      if (!haveAdj[adj.id] && !deadAdj[adj.id]) { remapAnchor(adj, otherIdxToId); base.adjustments.push(adj); }
    });

    var havePlayer = Object.create(null);
    (base.players || []).forEach(function (p) { havePlayer[p.id] = true; });
    (other.players || []).forEach(function (p) {
      if (!havePlayer[p.id]) base.players.push(p);
    });

    base.rev = Math.max(toInt(a.rev), toInt(b.rev));
    base.updatedAt = Math.max(toInt(a.updatedAt), toInt(b.updatedAt));
    return base;
  }

  function Store(storage, now) {
    this.storage = storage; // injectable for tests
    this.now = now || function () { return Date.now(); };
    this.state = emptyState();
    this.recoveryNotice = null; // set when a save had to be recovered or couldn't be written
    // Set when a corrupt save exists that could NOT be backed up: all writes
    // are refused so the user's only copy survives until they explicitly
    // choose to start fresh (allowOverwrite()).
    this.writesBlocked = false;
  }

  /** Explicit user consent to overwrite an unrecoverable corrupt save. */
  Store.prototype.allowOverwrite = function () {
    this.writesBlocked = false;
    this.recoveryNotice = null;
    this.persist();
  };

  Store.prototype.readRaw = function () {
    try {
      return this.storage.getItem(KEY);
    } catch (e) {
      return null;
    }
  };

  /** Parse + sanitize a raw string. Returns {state} on success, {corrupt:true} on parse failure, null when absent. */
  Store.prototype.parseRaw = function (raw) {
    if (raw === null || raw === undefined || raw === '') return null;
    var parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return { corrupt: true };
    }
    var state = sanitizeState(parsed);
    if (!state) return { corrupt: true };
    return { state: state };
  };

  /** Back up a corrupt raw string. Returns the backup key on verified success, null on failure. */
  Store.prototype.backupCorrupt = function (raw) {
    var backupKey = BACKUP_PREFIX + this.now() + '-' + Math.random().toString(36).slice(2, 6);
    try {
      this.storage.setItem(backupKey, raw);
      if (this.storage.getItem(backupKey) === raw) return backupKey;
    } catch (e) { /* quota — fall through */ }
    return null;
  };

  /** Load on startup. Corrupted data is backed up — the notice never claims more than actually happened. */
  Store.prototype.load = function () {
    var raw = this.readRaw();
    var result = this.parseRaw(raw);
    if (result === null) {
      this.state = emptyState();
      return this.state;
    }
    if (result.corrupt) {
      var backupKey = this.backupCorrupt(raw);
      if (backupKey) {
        this.recoveryNotice = 'A previous save could not be read. It was preserved under "' +
          backupKey + '" in this browser’s storage and a fresh start was created — nothing was deleted.';
        this.state = emptyState();
        this.persist();
      } else {
        this.recoveryNotice = 'A previous save could not be read, and there was no room to back it up. ' +
          'It has NOT been touched — but recording anything new will overwrite it. ' +
          'If it matters, copy this browser’s "' + KEY + '" storage value somewhere safe first.';
        this.state = emptyState();
        // Block ALL writes (including the first-run seed) until the user
        // explicitly opts in — the corrupt blob is their only copy.
        this.writesBlocked = true;
      }
      return this.state;
    }
    this.state = result.state;
    return this.state;
  };

  /**
   * Merge another state into ours. Games merge by id (see mergeGame);
   * tombstones union in and suppress resurrected deletes. Settings and
   * currentGameId are adopted only when adoptMeta is true (i.e. when
   * refreshing FROM storage) — a tab persisting its own change must never
   * have that change reverted by a merely-newer global revision.
   */
  Store.prototype.mergeFrom = function (other, adoptMeta) {
    var mine = this.state;

    Object.keys(other.tombstones || {}).forEach(function (id) {
      mine.tombstones[id] = Math.max(toInt(mine.tombstones[id]), toInt(other.tombstones[id]));
    });

    Object.keys(other.games).forEach(function (id) {
      var theirs = other.games[id];
      if (mine.tombstones[id] && toInt(mine.tombstones[id]) >= toInt(theirs.updatedAt)) return;
      var ours = mine.games[id];
      mine.games[id] = ours ? mergeGame(ours, theirs) : theirs;
    });
    // Apply tombstones we just learned about to games we still hold.
    Object.keys(mine.tombstones).forEach(function (id) {
      var g = mine.games[id];
      if (g && toInt(mine.tombstones[id]) >= toInt(g.updatedAt)) delete mine.games[id];
    });

    if (adoptMeta && toInt(other.rev) > toInt(mine.rev)) {
      mine.settings = other.settings;
      if (other.currentGameId && mine.games[other.currentGameId]) {
        mine.currentGameId = other.currentGameId;
      }
    }
    mine.rev = Math.max(toInt(mine.rev), toInt(other.rev));
    mine.seedLoaded = mine.seedLoaded || other.seedLoaded;
    if (!mine.currentGameId || !mine.games[mine.currentGameId]) {
      mine.currentGameId = this.newestGameId();
    }
  };

  Store.prototype.newestGameId = function () {
    var games = this.state.games;
    var best = null;
    Object.keys(games).forEach(function (id) {
      if (!best || toInt(games[id].updatedAt) > toInt(games[best].updatedAt)) best = id;
    });
    return best;
  };

  /** Write to storage, merging first if another tab advanced the revision under us. */
  Store.prototype.persist = function () {
    if (this.writesBlocked) return false; // an unrecoverable corrupt save must not be overwritten
    var raw = this.readRaw();
    var result = this.parseRaw(raw);
    if (result && result.corrupt) {
      // Someone corrupted the key since we loaded — preserve it before writing over it.
      this.backupCorrupt(raw);
    }
    if (result && result.state && toInt(result.state.rev) > toInt(this.state.rev)) {
      this.mergeFrom(result.state, false);
    }
    var prevRev = this.state.rev;
    this.state.rev = toInt(this.state.rev) + 1;
    this.state.version = VERSION;
    this.pruneTombstones();
    try {
      this.storage.setItem(KEY, JSON.stringify(this.state));
      return true;
    } catch (e) {
      // Quota exceeded or storage blocked: roll the revision back so the
      // monotonic guard still merges correctly on the next successful write.
      this.state.rev = prevRev;
      if (!this.recoveryNotice) { // never clobber a more important notice
        this.recoveryNotice = 'Autosave failed (storage full or blocked). Scores are kept in memory — export them as text to be safe.';
      }
      return false;
    }
  };

  Store.prototype.pruneTombstones = function () {
    var t = this.state.tombstones;
    var ids = Object.keys(t);
    if (ids.length <= MAX_TOMBSTONES) return;
    ids.sort(function (x, y) { return t[x] - t[y]; }); // oldest first
    ids.slice(0, ids.length - MAX_TOMBSTONES).forEach(function (id) { delete t[id]; });
  };

  /** Re-read from storage (e.g. on the cross-tab 'storage' event) and merge in whatever is newer. */
  Store.prototype.refreshFromStorage = function () {
    var result = this.parseRaw(this.readRaw());
    if (result && result.state) {
      this.mergeFrom(result.state, toInt(result.state.rev) >= toInt(this.state.rev));
    }
  };

  /* ---------- convenience API used by the UI; every mutation autosaves ---------- */

  Store.prototype.currentGame = function () {
    return this.state.currentGameId ? this.state.games[this.state.currentGameId] || null : null;
  };

  Store.prototype.touch = function (game) {
    game.updatedAt = this.now();
    game.rev = toInt(game.rev) + 1;
    this.persist();
  };

  Store.prototype.addGame = function (game, makeCurrent) {
    this.state.games[game.id] = game;
    delete this.state.tombstones[game.id];
    if (makeCurrent !== false) this.state.currentGameId = game.id;
    this.touch(game);
    return game;
  };

  Store.prototype.setCurrentGame = function (gameId) {
    if (this.state.games[gameId]) {
      this.state.currentGameId = gameId;
      this.persist();
    }
  };

  Store.prototype.deleteGame = function (gameId) {
    if (!this.state.games[gameId]) return;
    delete this.state.games[gameId];
    this.state.tombstones[gameId] = this.now();
    if (this.state.currentGameId === gameId) {
      this.state.currentGameId = this.newestGameId();
    }
    this.persist();
  };

  Store.prototype.updateSettings = function (patch) {
    var s = this.state.settings;
    Object.keys(patch).forEach(function (k) { s[k] = patch[k]; });
    this.persist();
  };

  /** First-run seed: the sample game from the brief (also the regression fixture). */
  Store.prototype.ensureSeed = function () {
    if (this.state.seedLoaded || this.writesBlocked) return null;
    var game = Engine.seedGame(this.now());
    game.updatedAt = this.now();
    this.state.games[game.id] = game;
    if (!this.state.currentGameId) this.state.currentGameId = game.id;
    this.state.seedLoaded = true;
    this.persist();
    return game;
  };

  var api = {
    Store: Store,
    KEY: KEY,
    BACKUP_PREFIX: BACKUP_PREFIX,
    defaultSettings: defaultSettings,
    emptyState: emptyState,
    sanitizeState: sanitizeState,
    mergeGame: mergeGame,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    global.BlitzStore = api;
  }
})(typeof self !== 'undefined' ? self : this);
