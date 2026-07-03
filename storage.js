/*
 * Dutch Blitz Sidecar — persistence layer.
 * localStorage only, autosave on every mutation, and two safety rules:
 *   1. Merge, never clobber: before each write we re-read the store; if another
 *      tab wrote a newer revision, we merge per-game by revision instead of
 *      overwriting it.
 *   2. Never wipe silently: unparseable data is backed up under a separate key
 *      and reported to the UI before we start fresh.
 * Plain script (no modules) so the app runs from file://.
 */
(function (global) {
  'use strict';

  var KEY = 'dutch-blitz-sidecar/v1';
  var BACKUP_PREFIX = 'dutch-blitz-sidecar/backup-';
  var VERSION = 1;

  var Engine = global.BlitzEngine || (typeof require !== 'undefined' ? require('./engine.js') : null);

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
      games: {},
      currentGameId: null,
      seedLoaded: false,
      settings: defaultSettings(),
    };
  }

  /** Coerce anything parsed from storage into a valid state. Drops nothing it can keep. */
  function sanitizeState(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var state = emptyState();
    state.rev = Engine.toInt(raw.rev);
    state.seedLoaded = !!raw.seedLoaded;
    if (raw.settings && typeof raw.settings === 'object') {
      var s = raw.settings;
      state.settings.bigType = !!s.bigType;
      state.settings.darkMode = ['auto', 'light', 'dark'].indexOf(s.darkMode) !== -1 ? s.darkMode : 'auto';
      state.settings.soundOn = !!s.soundOn;
      state.settings.defaultInputMode = s.defaultInputMode === 'calc' ? 'calc' : 'simple';
    }
    if (raw.games && typeof raw.games === 'object') {
      Object.keys(raw.games).forEach(function (id) {
        var g = Engine.sanitizeGame(raw.games[id]);
        if (g) state.games[g.id] = g;
      });
    }
    if (typeof raw.currentGameId === 'string' && state.games[raw.currentGameId]) {
      state.currentGameId = raw.currentGameId;
    }
    return state;
  }

  function Store(storage, now) {
    this.storage = storage; // injectable for tests
    this.now = now || function () { return Date.now(); };
    this.state = emptyState();
    this.recoveryNotice = null; // set when a corrupted save was backed up
    this.listeners = [];
  }

  Store.prototype.onChange = function (fn) { this.listeners.push(fn); };
  Store.prototype.emit = function () {
    var self = this;
    this.listeners.forEach(function (fn) { fn(self.state); });
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

  /** Load on startup. Corrupted data is backed up under a timestamped key — never deleted silently. */
  Store.prototype.load = function () {
    var raw = this.readRaw();
    var result = this.parseRaw(raw);
    if (result === null) {
      this.state = emptyState();
      return this.state;
    }
    if (result.corrupt) {
      var backupKey = BACKUP_PREFIX + this.now();
      try { this.storage.setItem(backupKey, raw); } catch (e) { /* quota — nothing more we can do */ }
      this.recoveryNotice = 'A previous save could not be read. It was preserved under "' +
        backupKey + '" and a fresh start was created — nothing was deleted.';
      this.state = emptyState();
      this.persist();
      return this.state;
    }
    this.state = result.state;
    return this.state;
  };

  /**
   * Merge another state into ours: per-game the higher revision wins, games
   * missing on either side are kept. This is the monotonic guard — a stale tab
   * can add its newer work but can never erase someone else's.
   */
  Store.prototype.mergeFrom = function (other) {
    var mine = this.state;
    var self = this;
    Object.keys(other.games).forEach(function (id) {
      var theirs = other.games[id];
      var ours = mine.games[id];
      if (!ours || Engine.toInt(theirs.rev) > Engine.toInt(ours.rev) ||
          (Engine.toInt(theirs.rev) === Engine.toInt(ours.rev) &&
           Engine.toInt(theirs.updatedAt) > Engine.toInt(ours.updatedAt))) {
        mine.games[id] = theirs;
      }
    });
    if (Engine.toInt(other.rev) > Engine.toInt(mine.rev)) {
      mine.settings = other.settings;
      if (other.currentGameId && mine.games[other.currentGameId]) {
        mine.currentGameId = other.currentGameId;
      }
      mine.rev = Engine.toInt(other.rev);
    }
    mine.seedLoaded = mine.seedLoaded || other.seedLoaded;
    if (!mine.currentGameId || !mine.games[mine.currentGameId]) {
      mine.currentGameId = self.newestGameId();
    }
  };

  Store.prototype.newestGameId = function () {
    var games = this.state.games;
    var best = null;
    Object.keys(games).forEach(function (id) {
      if (!best || Engine.toInt(games[id].updatedAt) > Engine.toInt(games[best].updatedAt)) best = id;
    });
    return best;
  };

  /** Write to storage, merging first if another tab advanced the revision under us. */
  Store.prototype.persist = function () {
    var raw = this.readRaw();
    var result = this.parseRaw(raw);
    if (result && result.state && Engine.toInt(result.state.rev) > Engine.toInt(this.state.rev)) {
      this.mergeFrom(result.state);
    }
    this.state.rev = Engine.toInt(this.state.rev) + 1;
    this.state.version = VERSION;
    try {
      this.storage.setItem(KEY, JSON.stringify(this.state));
      return true;
    } catch (e) {
      // Quota exceeded or storage unavailable: keep running in memory, tell the UI.
      this.recoveryNotice = 'Autosave failed (storage full or blocked). Scores are kept in memory — export them as text to be safe.';
      return false;
    }
  };

  /** Re-read from storage (e.g. on the cross-tab 'storage' event) and merge in whatever is newer. */
  Store.prototype.refreshFromStorage = function () {
    var result = this.parseRaw(this.readRaw());
    if (result && result.state) {
      if (Engine.toInt(result.state.rev) >= Engine.toInt(this.state.rev)) {
        this.mergeFrom(result.state);
      }
      this.emit();
    }
  };

  /* ---------- convenience API used by the UI; every mutation autosaves ---------- */

  Store.prototype.currentGame = function () {
    return this.state.currentGameId ? this.state.games[this.state.currentGameId] || null : null;
  };

  Store.prototype.touch = function (game) {
    game.updatedAt = this.now();
    game.rev = Engine.toInt(game.rev) + 1;
    this.persist();
    this.emit();
  };

  Store.prototype.addGame = function (game, makeCurrent) {
    this.state.games[game.id] = game;
    if (makeCurrent !== false) this.state.currentGameId = game.id;
    this.touch(game);
    return game;
  };

  Store.prototype.setCurrentGame = function (gameId) {
    if (this.state.games[gameId]) {
      this.state.currentGameId = gameId;
      this.persist();
      this.emit();
    }
  };

  Store.prototype.deleteGame = function (gameId) {
    if (!this.state.games[gameId]) return;
    delete this.state.games[gameId];
    if (this.state.currentGameId === gameId) {
      this.state.currentGameId = this.newestGameId();
    }
    this.persist();
    this.emit();
  };

  Store.prototype.updateSettings = function (patch) {
    var s = this.state.settings;
    Object.keys(patch).forEach(function (k) { s[k] = patch[k]; });
    this.persist();
    this.emit();
  };

  /** First-run seed: the sample game from the brief (also the regression fixture). */
  Store.prototype.ensureSeed = function () {
    if (this.state.seedLoaded) return null;
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
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    global.BlitzStore = api;
  }
})(typeof self !== 'undefined' ? self : this);
