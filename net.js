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

  /** Cryptographically strong randomness where available (codes + tokens). */
  function randBytes(n) {
    var a = new Uint8Array(n);
    if (global.crypto && global.crypto.getRandomValues) global.crypto.getRandomValues(a);
    else for (var i = 0; i < n; i++) a[i] = Math.floor(Math.random() * 256);
    return a;
  }
  function makeCode(len) {
    len = len || 6;
    var out = '', b = randBytes(len);
    // rejection-free: ALPHABET is 27 chars; a tiny modulo bias is fine for a
    // human-readable room code (still ~28 bits of entropy at length 6)
    for (var i = 0; i < len; i++) out += ALPHABET[b[i] % ALPHABET.length];
    return out;
  }
  function randToken() {
    var b = randBytes(16), s = '';
    for (var i = 0; i < b.length; i++) s += (b[i] + 256).toString(16).slice(1);
    return 'tk-' + s;
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

  /**
   * Mobile browsers drop the signaling WebSocket whenever the phone locks or
   * the tab is backgrounded. PeerJS then fires 'disconnected' and does NOT
   * reconnect on its own — without this handler the room silently dies and
   * every new guest gets 'no-such-room'. Reconnect keeps the same peer id,
   * so the share code stays valid; open data channels are unaffected.
   */
  function keepSignalAlive(peer, cbs) {
    var tries = 0;
    peer.on('open', function () { tries = 0; if (cbs.onSignal) cbs.onSignal('up'); });
    peer.on('disconnected', function () {
      if (peer.destroyed) return;
      if (cbs.onSignal) cbs.onSignal('down');
      if (tries++ < 30) {
        setTimeout(function () {
          if (!peer.destroyed && peer.disconnected) { try { peer.reconnect(); } catch (e) { /* retry next round */ } }
        }, Math.min(1000 * tries, 5000));
      } else {
        cbs.onError('signal-lost');
      }
    });
  }

  function peerHostTransport(code, cbs) {
    var peer = new global.Peer(PEER_PREFIX + code, { debug: 0 });
    var conns = {};
    peer.on('open', function () { cbs.onOpen(); });
    peer.on('error', function (err) { cbs.onError(err && err.type ? err.type : 'peer-error'); });
    keepSignalAlive(peer, cbs);
    peer.on('connection', function (conn) {
      conns[conn.connectionId] = conn;
      conn.on('data', function (msg) {
        // a throwing handler must never tear down the data channel
        try { cbs.onMessage(conn.connectionId, msg); } catch (e) { /* drop bad frame */ }
      });
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
      if (conn) return; // signaling reconnected; the data channel is intact
      conn = peer.connect(PEER_PREFIX + code, { reliable: true });
      conn.on('open', function () { cbs.onOpen(); });
      conn.on('data', function (msg) { try { cbs.onMessage(msg); } catch (e) { /* drop bad frame */ } });
      conn.on('close', function () { cbs.onClose(); });
    });
    keepSignalAlive(peer, cbs);
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
    this.listeners = {};
    var r = opts.restore;
    if (r) {
      // resume an interrupted table (host reloaded / hit back): re-open the
      // same peer id so the code stays valid; guests reconnect with their
      // tokens and get the current state rebroadcast to them.
      this.code = r.code;
      this.target = r.target || 75;
      this.hostName = r.hostName || (r.players[0] && r.players[0].name);
      this.roundNo = r.roundNo || 0;
      this.totals = r.totals || {};
      this.state = r.state || null;
      this.lastPlay = r.lastPlay || null;
      this.nextSeat = r.nextSeat || r.players.length;
      this.players = r.players.map(function (p, i) {
        // everyone but the host starts disconnected until they reconnect
        return { id: p.id, name: p.name, token: p.token, connId: null, connected: i === 0 };
      });
    } else {
      this.code = opts.code || makeCode(6);
      this.target = opts.target || 75;
      this.hostName = opts.name;
      this.roundNo = 0;
      this.totals = {};
      this.state = null;
      this.nextSeat = 1; // p0 is the host; monotonic so a kick never recycles an id
      // p0's token is random and NEVER leaves this device — the host runs the
      // engine locally and never re-joins over the wire, so no guest can present
      // it to hijack the host seat.
      this.players = [{ id: 'p0', name: opts.name, connId: null, token: randToken(), connected: true }];
    }

    this.transport = hostTransport(opts.transport || 'peer', this.code, {
      onOpen: function () { self.emit('status', 'live'); },
      onSignal: function (s) { self.emit('signal', s); },
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

  /** Serializable table state for crash/reload recovery (kept on the host). */
  HostSession.prototype.snapshot = function () {
    return {
      role: 'host', code: this.code, target: this.target, hostName: this.hostName,
      roundNo: this.roundNo, totals: this.totals, state: this.state,
      lastPlay: this.lastPlay || null, nextSeat: this.nextSeat,
      players: this.players.map(function (p) { return { id: p.id, name: p.name, token: p.token }; }),
    };
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

  HostSession.prototype.statePayload = function (state) {
    // lastPlay rides alongside (not inside) state so it survives redaction —
    // guests use it to animate the exact pile and show the activity ticker
    return { t: 'state', roundNo: this.roundNo, target: this.target, totals: this.totals, lastPlay: this.lastPlay || null, state: state === undefined ? this.state : state };
  };

  /**
   * Guests only ever receive a state redacted for their seat: opponents'
   * cards become length-preserving null placeholders and the deal seed is
   * withheld, so a modified client can't read other hands or re-derive the
   * whole deal. Public facts (Dutch piles, counts, scores) pass through.
   */
  function redactFor(state, viewerId) {
    if (!state) return state;
    var out = {
      status: state.status, seq: state.seq, winner: state.winner,
      scores: state.scores, completedPiles: state.completedPiles,
      dutch: state.dutch, order: state.order, players: {},
    };
    state.order.forEach(function (id) {
      var p = state.players[id];
      if (id === viewerId) { out.players[id] = p; return; }
      out.players[id] = {
        id: p.id, name: p.name, identity: p.identity, dutchCount: p.dutchCount,
        blitz: new Array(p.blitz.length),
        hand: new Array(p.hand.length),
        wood: new Array(p.wood.length),
        post: p.post.map(function (s) { return new Array(s.length); }),
      };
    });
    return out;
  }

  HostSession.prototype.sendStateTo = function (player) {
    if (!player.connId) return;
    this.transport.send(player.connId, this.statePayload(redactFor(this.state, player.id)));
  };

  HostSession.prototype.broadcastState = function () {
    var self = this;
    this.players.forEach(function (p) { if (p.id !== 'p0' && p.connected) self.sendStateTo(p); });
    this.emit('state', this.statePayload()); // the host UI sees the full truth
  };

  /** Token-bucket rate limit per connection — caps intent floods (10/sec). */
  HostSession.prototype.allow = function (connId) {
    var now = (global.Date && Date.now) ? Date.now() : 0;
    var b = (this.buckets = this.buckets || {})[connId] || { tokens: 20, ts: now };
    b.tokens = Math.min(20, b.tokens + (now - b.ts) / 100);
    b.ts = now;
    this.buckets[connId] = b;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  };

  HostSession.prototype.onMessage = function (connId, msg) {
    var self = this;
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'hello') {
      if ((msg.v | 0) !== PROTOCOL_V) { this.transport.send(connId, { t: 'err', code: 'version' }); return; }
      // reconnect with a token re-attaches the same seat — but NEVER the host
      // seat (p0's token stays on the host device and is never a valid hello)
      var tok = typeof msg.token === 'string' ? msg.token : null;
      var existing = tok && this.players.find(function (p) { return p.id !== 'p0' && p.token === tok; });
      if (existing) {
        existing.connId = connId; existing.connected = true;
      } else {
        if (this.state && this.state.status === 'playing') { this.transport.send(connId, { t: 'err', code: 'round-in-progress' }); return; }
        if (this.players.length >= 4) { this.transport.send(connId, { t: 'err', code: 'full' }); return; }
        var name = String(msg.name == null ? 'Player' : msg.name).slice(0, 12).trim() || 'Player';
        var base = name; var n = 2;
        while (this.players.some(function (p) { return p.name.toLowerCase() === name.toLowerCase(); })) name = base + ' ' + n++;
        existing = { id: 'p' + this.nextSeat++, name: name, connId: connId, token: randToken(), connected: true };
        this.players.push(existing);
      }
      this.transport.send(connId, { t: 'welcome', playerId: existing.id, name: existing.name, token: existing.token, code: this.code, roster: this.rosterPayload() });
      if (this.state) this.sendStateTo(existing);
      this.broadcastRoster();
      return;
    }
    if (msg.t === 'intent') {
      var p = this.players.find(function (x) { return x.connId === connId; });
      if (!p) return;
      if (!this.allow(connId)) return; // silently drop floods
      var intent = msg.intent;
      if (!intent || typeof intent !== 'object' || typeof intent.type !== 'string') return;
      this.applyFrom(p.id, intent, msg.n, function (nack) { self.transport.send(connId, nack); });
      return;
    }
    if (msg.t === 'chat') {
      var cp = this.players.find(function (x) { return x.connId === connId; });
      if (!cp) return;
      if (!this.allow(connId)) return; // chat shares the flood budget
      this.relayChat(cp.id, cp.name, msg.text);
      return;
    }
    if (msg.t === 'bye') {
      var q = this.players.find(function (x) { return x.connId === connId; });
      if (q) { q.connected = false; q.connId = null; this.broadcastRoster(); }
    }
  };

  /** Fan a chat line out to everyone (and the host UI), trimmed + capped. */
  HostSession.prototype.relayChat = function (fromId, name, text) {
    var clean = String(text == null ? '' : text).replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!clean) return;
    var line = { t: 'chat', id: fromId, name: name, text: clean, seq: (this.chatSeq = (this.chatSeq || 0) + 1) };
    this.transport.broadcast(line);
    this.emit('chat', line);
  };

  HostSession.prototype.sendChat = function (text) { this.relayChat('p0', this.hostName, text); };

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
    // record the play so guests can animate the right pile + run the ticker
    if (r.event && r.event.type === 'play') {
      var pl = this.players.find(function (x) { return x.id === playerId; });
      this.lastPlay = {
        n: (this.lastPlay ? this.lastPlay.n : 0) + 1,
        playerId: playerId, name: pl ? pl.name : '',
        color: r.event.card.color, value: r.event.card.value,
        to: r.event.to, blitz: !!r.event.blitz,
      };
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
    this.lastPlay = null; // fresh deal, no history to animate
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

  HostSession.prototype.close = function (silent) {
    clearInterval(this.hb);
    // a silent close (page reload) must NOT tell guests the table is gone —
    // they should wait and reconnect once the host page comes back up
    if (!silent) this.transport.broadcast({ t: 'bye' });
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

    // if no welcome ever arrives, say so — a silent spinner reads as broken
    this.joinTimer = setTimeout(function () {
      if (!self.closed && !self.playerId) self.emit('err', 'join-timeout');
    }, 15000);

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
      clearTimeout(this.joinTimer);
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
    if (msg.t === 'chat') { this.emit('chat', msg); return; }
    if (msg.t === 'bye') { this.emit('status', 'host-gone'); return; }
    // hb falls through — lastHb already updated
  };

  GuestSession.prototype.sendIntent = function (intent, n) {
    this.transport.send({ t: 'intent', intent: intent, n: n });
  };

  GuestSession.prototype.sendChat = function (text) {
    this.transport.send({ t: 'chat', text: String(text == null ? '' : text).slice(0, 120) });
  };

  GuestSession.prototype.close = function (silent) {
    this.closed = true;
    clearInterval(this.watch);
    clearTimeout(this.joinTimer);
    try { if (!silent) this.transport.send({ t: 'bye' }); this.transport.close(); } catch (e) { /* gone */ }
  };

  global.BlitzNet = {
    PROTOCOL_V: PROTOCOL_V,
    makeCode: makeCode,
    normalizeCode: normalizeCode,
    HostSession: HostSession,
    GuestSession: GuestSession,
  };
})(typeof self !== 'undefined' ? self : this);
