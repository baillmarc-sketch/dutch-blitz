/*
 * Pile On — session networking for live play.
 * Host-authoritative star topology: the host's phone runs game-core and is
 * the single source of truth; guests send intents and render broadcast state.
 * The share code IS the room: PeerJS peer id 'pileon-v1-<CODE>'.
 *
 * Two transports behind one interface:
 *   - 'peer'  : WebRTC data channels via the free public PeerJS cloud
 *   - 'local' : BroadcastChannel — same-device tabs; used by tests and demos
 * Plain script: window.BlitzNet.
 */
(function (global) {
  'use strict';

  var PROTOCOL_V = 1;
  var PEER_PREFIX = 'pileon-v1-';
  // no 0/O/1/I/L/5/S/U — codes get read aloud across kitchens
  var ALPHABET = 'ABCDEFGHJKMNPQRTVWXYZ2346789';
  var HEARTBEAT_MS = 2000;
  var HOST_TIMEOUT_MS = 7000;

  function makeCode(len) {
    var out = '';
    for (var i = 0; i < (len || 6); i++) out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    return out;
  }
  function normalizeCode(raw) {
    return String(raw || '').toUpperCase().replace(/[^A-Z2-9]/g, '');
  }

  /* ---------------- transports ---------------- */

  function localHostTransport(code, cbs) {
    var ch = new BroadcastChannel('pileon-' + code);
    ch.onmessage = function (e) {
      var m = e.data;
      if (m && m.dir === 'up') cbs.onMessage(m.from, m.msg);
    };
    setTimeout(function () { cbs.onOpen(); }, 0);
    return {
      send: function (connId, msg) { ch.postMessage({ dir: 'down', to: connId, msg: msg }); },
      broadcast: function (msg) { ch.postMessage({ dir: 'down', to: '*', msg: msg }); },
      close: function () { ch.close(); },
    };
  }

  function localGuestTransport(code, cbs) {
    var ch = new BroadcastChannel('pileon-' + code);
    var myId = 'g-' + Math.random().toString(36).slice(2, 9);
    ch.onmessage = function (e) {
      var m = e.data;
      if (m && m.dir === 'down' && (m.to === '*' || m.to === myId)) cbs.onMessage(m.msg);
    };
    setTimeout(function () { cbs.onOpen(); }, 0);
    return {
      id: myId,
      send: function (msg) { ch.postMessage({ dir: 'up', from: myId, msg: msg }); },
      close: function () { ch.close(); },
    };
  }

  function peerHostTransport(code, cbs) {
    var peer = new global.Peer(PEER_PREFIX + code, { debug: 0 });
    var conns = {};
    peer.on('open', function () { cbs.onOpen(); });
    peer.on('error', function (err) { cbs.onError(err && err.type ? err.type : 'peer-error'); });
    peer.on('connection', function (conn) {
      conns[conn.connectionId] = conn;
      conn.on('data', function (msg) { cbs.onMessage(conn.connectionId, msg); });
      conn.on('close', function () { delete conns[conn.connectionId]; cbs.onClose(conn.connectionId); });
      conn.on('error', function () { delete conns[conn.connectionId]; cbs.onClose(conn.connectionId); });
    });
    return {
      send: function (connId, msg) { var c = conns[connId]; if (c && c.open) c.send(msg); },
      broadcast: function (msg) {
        Object.keys(conns).forEach(function (k) { var c = conns[k]; if (c.open) c.send(msg); });
      },
      close: function () { peer.destroy(); },
    };
  }

  function peerGuestTransport(code, cbs) {
    var peer = new global.Peer({ debug: 0 });
    var conn = null;
    peer.on('error', function (err) {
      var type = err && err.type;
      if (type === 'peer-unavailable') cbs.onError('no-such-room');
      else cbs.onError(type || 'peer-error');
    });
    peer.on('open', function () {
      conn = peer.connect(PEER_PREFIX + code, { reliable: true });
      conn.on('open', function () { cbs.onOpen(); });
      conn.on('data', function (msg) { cbs.onMessage(msg); });
      conn.on('close', function () { cbs.onClose(); });
    });
    return {
      send: function (msg) { if (conn && conn.open) conn.send(msg); },
      close: function () { peer.destroy(); },
    };
  }

  function hostTransport(kind, code, cbs) {
    return kind === 'local' ? localHostTransport(code, cbs) : peerHostTransport(code, cbs);
  }
  function guestTransport(kind, code, cbs) {
    return kind === 'local' ? localGuestTransport(code, cbs) : peerGuestTransport(code, cbs);
  }

  /* ---------------- host session ---------------- */

  function HostSession(opts) {
    var G = global.BlitzPlay;
    var self = this;
    this.code = opts.code || makeCode(6);
    this.target = opts.target || 75;
    this.hostName = opts.name;
    this.roundNo = 0;
    this.totals = {};
    this.state = null;
    this.listeners = {};
    this.players = [{ id: 'p0', name: opts.name, connId: null, token: 'host', connected: true }];

    this.transport = hostTransport(opts.transport || 'peer', this.code, {
      onOpen: function () { self.emit('status', 'live'); },
      onError: function (code) { self.emit('err', code); },
      onMessage: function (connId, msg) { self.onMessage(connId, msg); },
      onClose: function (connId) {
        var p = self.players.find(function (x) { return x.connId === connId; });
        if (p) { p.connected = false; p.connId = null; self.broadcastRoster(); }
      },
    });

    this.hb = setInterval(function () { self.transport.broadcast({ t: 'hb' }); }, HEARTBEAT_MS);
  }

  HostSession.prototype.on = function (ev, cb) { (this.listeners[ev] = this.listeners[ev] || []).push(cb); };
  HostSession.prototype.emit = function (ev, a, b) {
    (this.listeners[ev] || []).forEach(function (cb) { cb(a, b); });
  };

  HostSession.prototype.rosterPayload = function () {
    return this.players.map(function (p) {
      return { id: p.id, name: p.name, connected: p.connected };
    });
  };

  HostSession.prototype.broadcastRoster = function () {
    this.transport.broadcast({ t: 'roster', players: this.rosterPayload() });
    this.emit('roster', this.rosterPayload());
  };

  HostSession.prototype.statePayload = function () {
    return { t: 'state', roundNo: this.roundNo, target: this.target, totals: this.totals, state: this.state };
  };

  HostSession.prototype.broadcastState = function () {
    this.transport.broadcast(this.statePayload());
    this.emit('state', this.statePayload());
  };

  HostSession.prototype.onMessage = function (connId, msg) {
    var self = this;
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'hello') {
      if ((msg.v | 0) !== PROTOCOL_V) { this.transport.send(connId, { t: 'err', code: 'version' }); return; }
      // reconnect with a token re-attaches the same seat
      var existing = msg.token && this.players.find(function (p) { return p.token === msg.token; });
      if (existing) {
        existing.connId = connId; existing.connected = true;
      } else {
        if (this.state && this.state.status === 'playing') { this.transport.send(connId, { t: 'err', code: 'round-in-progress' }); return; }
        if (this.players.length >= 4) { this.transport.send(connId, { t: 'err', code: 'full' }); return; }
        var name = String(msg.name || 'Player').slice(0, 12) || 'Player';
        var base = name; var n = 2;
        while (this.players.some(function (p) { return p.name.toLowerCase() === name.toLowerCase(); })) name = base + ' ' + n++;
        existing = { id: 'p' + this.players.length, name: name, connId: connId, token: 'tk-' + Math.random().toString(36).slice(2, 10), connected: true };
        this.players.push(existing);
      }
      this.transport.send(connId, { t: 'welcome', playerId: existing.id, name: existing.name, token: existing.token, code: this.code, roster: this.rosterPayload() });
      if (this.state) this.transport.send(connId, this.statePayload());
      this.broadcastRoster();
      return;
    }
    if (msg.t === 'intent') {
      var p = this.players.find(function (x) { return x.connId === connId; });
      if (!p) return;
      this.applyFrom(p.id, msg.intent, msg.n, function (nack) { self.transport.send(connId, nack); });
      return;
    }
    if (msg.t === 'bye') {
      var q = this.players.find(function (x) { return x.connId === connId; });
      if (q) { q.connected = false; q.connId = null; this.broadcastRoster(); }
    }
  };

  /** Single entry point for every intent — host's own taps use it too. */
  HostSession.prototype.applyFrom = function (playerId, intent, n, nackTo) {
    var G = global.BlitzPlay;
    if (!this.state) return;
    var r = G.applyIntent(this.state, playerId, intent);
    if (!r.ok) {
      var nack = { t: 'nack', n: n, reason: r.reason, intent: intent };
      if (nackTo) nackTo(nack); else this.emit('nack', nack);
      return;
    }
    // official stall rule, applied automatically when the whole table is dry
    if (intent.type === 'flip' && G.isStalled(this.state)) {
      G.applyIntent(this.state, playerId, { type: 'nudge' });
      this.emit('nudged');
      this.transport.broadcast({ t: 'nudged' });
    }
    if (this.state.status === 'ended') this.settleRound();
    this.broadcastState();
  };

  HostSession.prototype.hostIntent = function (intent, n) {
    this.applyFrom('p0', intent, n == null ? 0 : n, null);
  };

  HostSession.prototype.startRound = function (seed) {
    var G = global.BlitzPlay;
    this.roundNo++;
    this.state = G.newRound(
      this.players.map(function (p) { return { id: p.id, name: p.name }; }),
      seed == null ? Math.floor(Math.random() * 2147483647) : seed
    );
    this.broadcastState();
  };

  HostSession.prototype.settleRound = function () {
    var self = this;
    Object.keys(this.state.scores).forEach(function (id) {
      self.totals[id] = (self.totals[id] || 0) + self.state.scores[id].score;
    });
  };

  HostSession.prototype.removePlayer = function (playerId) {
    var p = this.players.find(function (x) { return x.id === playerId; });
    if (!p || p.id === 'p0') return;
    if (p.connId) this.transport.send(p.connId, { t: 'err', code: 'removed' });
    this.players = this.players.filter(function (x) { return x.id !== playerId; });
    this.broadcastRoster();
  };

  HostSession.prototype.close = function () {
    clearInterval(this.hb);
    this.transport.broadcast({ t: 'bye' });
    this.transport.close();
  };

  /* ---------------- guest session ---------------- */

  function GuestSession(opts) {
    var self = this;
    this.code = normalizeCode(opts.code);
    this.name = opts.name;
    this.kind = opts.transport || 'peer';
    this.listeners = {};
    this.playerId = null;
    this.token = opts.token || null;
    this.lastHb = 0;
    this.closed = false;
    this.connect();

    this.watch = setInterval(function () {
      if (self.closed || !self.playerId) return;
      if (self.lastHb && Date.now() - self.lastHb > HOST_TIMEOUT_MS) {
        self.emit('status', 'reconnecting');
      }
    }, 1500);
  }

  GuestSession.prototype.on = HostSession.prototype.on;
  GuestSession.prototype.emit = HostSession.prototype.emit;

  GuestSession.prototype.connect = function () {
    var self = this;
    this.emit('status', 'connecting');
    this.transport = guestTransport(this.kind, this.code, {
      onOpen: function () {
        self.transport.send({ t: 'hello', v: PROTOCOL_V, name: self.name, token: self.token });
      },
      onMessage: function (msg) { self.onMessage(msg); },
      onClose: function () { if (!self.closed) self.scheduleReconnect(); },
      onError: function (code) { self.emit('err', code); },
    });
  };

  GuestSession.prototype.scheduleReconnect = function () {
    var self = this;
    this.emit('status', 'reconnecting');
    setTimeout(function () {
      if (self.closed) return;
      try { self.transport.close(); } catch (e) { /* already gone */ }
      self.connect();
    }, 2000);
  };

  GuestSession.prototype.onMessage = function (msg) {
    if (!msg || typeof msg !== 'object') return;
    this.lastHb = Date.now();
    if (msg.t === 'welcome') {
      this.playerId = msg.playerId;
      this.token = msg.token;
      this.name = msg.name;
      this.emit('welcome', msg);
      this.emit('status', 'live');
      return;
    }
    if (msg.t === 'err') { this.emit('err', msg.code); return; }
    if (msg.t === 'roster') { this.emit('roster', msg.players); return; }
    if (msg.t === 'state') { this.emit('state', msg); return; }
    if (msg.t === 'nack') { this.emit('nack', msg); return; }
    if (msg.t === 'nudged') { this.emit('nudged'); return; }
    if (msg.t === 'bye') { this.emit('status', 'host-gone'); return; }
    // hb falls through — lastHb already updated
  };

  GuestSession.prototype.sendIntent = function (intent, n) {
    this.transport.send({ t: 'intent', intent: intent, n: n });
  };

  GuestSession.prototype.close = function () {
    this.closed = true;
    clearInterval(this.watch);
    try { this.transport.send({ t: 'bye' }); this.transport.close(); } catch (e) { /* gone */ }
  };

  global.BlitzNet = {
    PROTOCOL_V: PROTOCOL_V,
    makeCode: makeCode,
    normalizeCode: normalizeCode,
    HostSession: HostSession,
    GuestSession: GuestSession,
  };
})(typeof self !== 'undefined' ? self : this);
