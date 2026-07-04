/* Pile On — live table client. Host and guest run the same page; the host's
   device additionally runs the authoritative game (net.js HostSession).
   Interaction grammar (game-design spec): tapping a playable card auto-plays
   it to a Dutch pile when one is legal (scoring first, zero ceremony);
   Post placement is always an explicit second tap — it's a strategic choice.
   ?room=CODE deep-links to join; ?transport=local uses BroadcastChannel
   (same-device tables and the test suite). */
(function () {
  'use strict';

  var G = window.BlitzPlay;
  var NET = window.BlitzNet;
  var E = window.BlitzEngine;

  var $ = function (s) { return document.querySelector(s); };
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var params = new URLSearchParams(location.search);
  var TRANSPORT = params.get('transport') === 'local' ? 'local' : 'peer';

  /* ---------- shared chrome ---------- */
  var toastTimer = null;
  function toast(msg) {
    var t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2000);
  }
  function announce(msg) {
    var el = $('#liveAnnounce');
    el.textContent = '';
    setTimeout(function () { el.textContent = msg; }, 30);
  }
  function setConn(cls, word) {
    var b = $('#connBadge');
    b.className = 'conn ' + cls;
    $('#connWord').textContent = word;
  }
  function confettiBurst() {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    var host = $('#confetti');
    var colors = ['var(--c-red)', 'var(--c-blue)', 'var(--c-green)', 'var(--c-yellow)'];
    for (var i = 0; i < 50; i++) {
      var s = document.createElement('span');
      s.style.left = Math.random() * 100 + 'vw';
      s.style.background = colors[i % 4];
      s.style.animationDelay = Math.random() * 0.5 + 's';
      host.appendChild(s);
    }
    setTimeout(function () { host.textContent = ''; }, 3000);
  }

  var VIEWS = ['entry', 'lobby', 'table', 'scores'];
  function show(view) {
    VIEWS.forEach(function (v) { $('#view-' + v).hidden = v !== view; });
    // table talk lives in the waiting moments — lobby and between rounds
    $('#chatDock').hidden = !(view === 'lobby' || view === 'scores');
  }

  /* ---------- table talk ---------- */
  // A grab-bag of one-tap reacts; three are drawn fresh each round so the
  // buttons feel different every time you land back between rounds.
  var REACT_POOL = [
    '🔥 Nice one', '👏 Clutch', '⚡ Blitzed it', '🐐 Legend',
    '😏 Too slow', '🐌 Slowpoke', '💨 Eat dust', '🥱 Yawn',
    '✅ Deal me in', '🚀 Let’s go', '🔁 Again!', '👀 Bring it',
    '🪵 Knock wood', '🪓 Timber!', '🌲 Out of woods', '🍂 Pile on!',
    '😅 So close', '🍀 Lucky!',
  ];
  function shuffleReacts() {
    var pool = REACT_POOL.slice();
    for (var i = pool.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = pool[i]; pool[i] = pool[j]; pool[j] = t;
    }
    $('#chatReacts').innerHTML = pool.slice(0, 3).map(function (r) {
      return '<button class="react" type="button" data-react="' + esc(r) + '">' + esc(r) + '</button>';
    }).join('');
  }

  function onChat(line) {
    if (!line || !line.text) return;
    var log = $('#chatLog');
    var mine = line.id === myId;
    var el = document.createElement('div');
    el.className = 'chat-line' + (mine ? ' me' : '');
    // names + text are attacker-influenced (relayed via the host) — escape both
    el.innerHTML = '<span class="who">' + esc(mine ? 'You' : (line.name || '?')) + '</span>' + esc(line.text);
    log.appendChild(el);
    while (log.children.length > 40) log.removeChild(log.firstChild);
    log.scrollTop = log.scrollHeight;
    if (!mine) announce(line.name + ' says ' + line.text);
  }
  function sendChat(text) {
    text = String(text || '').trim();
    if (!text || !session || !session.sendChat) return;
    session.sendChat(text);
  }
  $('#chatDock').addEventListener('click', function (e) {
    var b = e.target.closest('[data-react]');
    if (b) sendChat(b.getAttribute('data-react'));
  });
  $('#chatForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var t = $('#chatText').value;
    $('#chatText').value = '';
    sendChat(t);
  });

  /* boy ▲ / girl ○ — post-pile legality carried by shape, not color */
  function genderGlyph(color, size) {
    var s = size || 10;
    if (G.isBoy({ color: color })) {
      return '<svg class="g gender" width="' + s + '" height="' + s + '" viewBox="0 0 10 10" aria-hidden="true"><polygon points="5,1 9.4,9 0.6,9" fill="currentColor" opacity="0.7"/></svg>';
    }
    return '<svg class="g gender" width="' + s + '" height="' + s + '" viewBox="0 0 10 10" aria-hidden="true"><circle cx="5" cy="5" r="3.6" fill="none" stroke="currentColor" stroke-width="1.7" opacity="0.7"/></svg>';
  }
  /* hue rides a data attribute (play.css maps it to --hue) — the page's CSP
     has no 'unsafe-inline' for styles, so style="" attributes are dead */

  /* Broadcast state comes from the HOST's device — never trust card fields
     into markup. Colors pass a whitelist, numbers are coerced and clamped. */
  function safeColor(c) { return G.COLORS.indexOf(c) !== -1 ? c : 'red'; }
  function safeVal(v) { v = v | 0; return v < 1 ? 1 : v > 10 ? 10 : v; }
  function safeNum(v, lo, hi) { v = v | 0; return v < lo ? lo : v > hi ? hi : v; }

  /* ---------- session state ---------- */
  var session = null;      // HostSession | GuestSession
  var isHost = false;
  var myId = null;
  var roster = [];
  var payload = null;      // latest {roundNo, target, totals, state}
  var selection = null;    // {from:{zone,idx}, card}
  var inflight = {};       // sourceKey -> true
  var nSeq = 0;
  var nToSource = {};      // intent n -> sourceKey (for shake on nack)
  var loggedKey = 'pileon.logged';
  var wakeLock = null;
  // change-tracking so the board animates fluidly (no popups): remember the
  // previous board so we can pulse exactly what moved between broadcasts
  var prevTops = {};   // dutch slot index -> {top, done}
  var prevBlitz = {};  // opponent id -> blitz count
  var seenPlayN = 0;   // last lastPlay nonce we've shown in the ticker
  var trackRound = 0;  // round these snapshots belong to
  var resumeGuestCtx = null; // set while retrying a guest reconnect on load

  function myPlayer() { return payload && payload.state ? payload.state.players[myId] : null; }
  function sourceKey(from) { return from.zone + (from.idx != null ? from.idx : ''); }

  /* ---------- entry ---------- */
  var savedName = localStorage.getItem('pileon.onlineName') || '';
  $('#hostName').value = savedName;
  $('#joinName').value = savedName;
  var deepCode = NET.normalizeCode(params.get('room') || '');
  if (deepCode) $('#joinCode').value = deepCode;

  $('#joinCode').addEventListener('input', function () {
    this.value = NET.normalizeCode(this.value).slice(0, 6);
  });

  function rememberName(name) { try { localStorage.setItem('pileon.onlineName', name); } catch (e) { /* fine */ } }

  /* ---------- resume after a reload / accidental back button ----------
     We stash just enough to slip back into the same seat: guests keep their
     reconnect token; the host keeps a full table snapshot so it can re-open
     the same code and rebroadcast. Peer transport only (tests use local). */
  var SESSION_KEY = 'pileon.session';
  var SESSION_TTL = 3 * 60 * 60 * 1000; // 3h — stale tables shouldn't auto-resume
  function saveSession(obj) {
    if (!obj) return;
    try { obj.ts = Date.now(); obj.transport = TRANSPORT; localStorage.setItem(SESSION_KEY, JSON.stringify(obj)); } catch (e) { /* quota */ }
  }
  function loadSession() {
    try {
      var s = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
      // only resume into the same transport it was saved from, within the TTL
      if (s && s.transport === TRANSPORT && Date.now() - (s.ts || 0) < SESSION_TTL) return s;
    } catch (e) { /* corrupt */ }
    return null;
  }
  function clearSession() { try { localStorage.removeItem(SESSION_KEY); } catch (e) { /* fine */ } }

  $('#createBtn').addEventListener('click', function () {
    var name = $('#hostName').value.trim();
    var err = $('#hostError');
    if (!name) { err.textContent = 'Enter your name first.'; err.hidden = false; return; }
    err.hidden = true;
    rememberName(name);
    startHost(name, parseInt($('#hostTarget').value, 10) || 75);
  });

  $('#joinBtn').addEventListener('click', function () {
    var name = $('#joinName').value.trim();
    var code = NET.normalizeCode($('#joinCode').value);
    var err = $('#joinError');
    if (!name) { err.textContent = 'Enter your name first.'; err.hidden = false; return; }
    if (code.length !== 6) { err.textContent = 'Codes are 6 characters — check it with the host.'; err.hidden = false; return; }
    err.hidden = true;
    rememberName(name);
    startGuest(name, code);
  });

  /* ---------- host ---------- */
  function startHost(name, target, restore) {
    isHost = true;
    myId = 'p0';
    setConn(restore ? 'reconnecting' : 'connecting', restore ? 'resuming' : 'connecting');
    session = new NET.HostSession(restore ? { restore: restore, transport: TRANSPORT } : { name: name, target: target, transport: TRANSPORT });
    var persist = function () { try { saveSession(session.snapshot()); } catch (e) { /* fine */ } };
    wireCommon(session);
    session.on('status', function (s) {
      if (s === 'live') { setConn('', 'live'); }
    });
    session.on('err', function (code) {
      if (code === 'unavailable-id') {
        if (restore) {
          // reclaiming OUR OWN code after a reload — the PeerJS server frees
          // the old id a moment after our socket dropped; retry same code
          restore._tries = (restore._tries || 0) + 1;
          if (restore._tries <= 5) { toast('Reopening your table…'); try { session.close(true); } catch (e) {} setTimeout(function () { startHost(name, target, restore); }, 2000); return; }
          toast('Couldn’t reopen the table. Starting fresh.');
          clearSession();
        } else {
          toast('Code collision — rolling a new table');
          try { session.close(true); } catch (e) {}
          startHost(name, target); // fresh random code
          return;
        }
      }
      if (code === 'signal-lost') { setConn('gone', 'signal lost'); toast('Lost the signal server — new players can’t join. Reload to reopen the table.'); return; }
      setConn('reconnecting', 'network issue');
    });
    session.on('signal', function (s) {
      if (s === 'down') setConn('reconnecting', 'reconnecting…');
      else setConn('', 'live');
    });
    session.on('roster', function (r) { roster = r; renderLobby(); persist(); });
    session.on('nack', function (nack) { onNack(nack); });
    session.on('chat', function (line) { onChat(line); });
    roster = session.rosterPayload();
    $('#roomLabel').textContent = 'TABLE ' + session.code;
    session.on('state', function (p) { onState(p); persist(); });
    acquireWake(); // the host's device runs the game — keep it awake from the lobby on
    persist();
    if (restore && restore.state) {
      // render the restored board directly; reconnecting guests receive the
      // live state when they re-hello. Suppress the round-end celebration so a
      // reload on the score screen doesn't replay the Blitz stamp.
      payload = session.statePayload();
      trackRound = restore.roundNo; lastEndedRound = restore.roundNo;
      if (restore.state.status === 'playing') { show('table'); renderTable(); }
      else if (restore.state.status === 'ended') { renderScores(false); show('scores'); }
      else { show('lobby'); renderLobby(); }
    } else {
      show('lobby');
      renderLobby();
    }
  }

  // ?seed=N forces a reproducible deal (demos + the E2E); ignored in normal play
  var forcedSeed = params.has('seed') ? (parseInt(params.get('seed'), 10) || 1) : null;
  $('#startBtn').addEventListener('click', function () {
    if (!isHost) return;
    if (roster.length < 2) return;
    session.startRound(forcedSeed);
  });
  $('#nextRoundBtn').addEventListener('click', function () { if (isHost) session.startRound(); });
  $('#endGameBtn').addEventListener('click', function () { if (isHost) backToLobby(); });
  $('#backToLobbyBtn').addEventListener('click', function () { if (isHost) backToLobby(); });
  function backToLobby() {
    session.totals = {}; session.roundNo = 0; session.state = null;
    session.broadcastState();
  }

  /* ---------- guest ---------- */
  function startGuest(name, code, token) {
    isHost = false;
    setConn(token ? 'reconnecting' : 'connecting', token ? 'resuming' : 'connecting');
    session = new NET.GuestSession({ name: name, code: code, token: token || null, transport: TRANSPORT });
    wireCommon(session);
    session.on('welcome', function (w) {
      myId = w.playerId;
      roster = w.roster;
      resumeGuestCtx = null; // reconnected successfully
      $('#roomLabel').textContent = 'TABLE ' + w.code;
      if (w.name !== name) toast('You’re "' + w.name + '" at this table');
      // remember our seat so a reload / back button slides us right back in
      saveSession({ role: 'guest', code: w.code, token: w.token, name: w.name, playerId: w.playerId });
      if (!payload || !payload.state) { show('lobby'); renderLobby(); }
    });
    session.on('roster', function (r) {
      var joined = r.filter(function (p) { return !roster.some(function (q) { return q.id === p.id; }); });
      roster = r;
      joined.forEach(function (p) { if (p.id !== myId) { toast(p.name + ' joined'); announce(p.name + ' joined the table.'); } });
      renderLobby();
      renderOpponents();
    });
    session.on('status', function (s) {
      if (s === 'live') { setConn('', 'live'); offline(false); }
      else if (s === 'connecting') setConn('connecting', 'connecting');
      else if (s === 'reconnecting') { setConn('reconnecting', 'reconnecting'); offline(true); }
      else if (s === 'host-gone') hostGone();
    });
    session.on('err', function (code) { guestError(code); });
    session.on('state', function (p) { onState(p); });
    session.on('nack', function (nack) { onNack(nack); });
    session.on('nudged', function () { toast('Table was stuck — decks nudged'); });
    session.on('chat', function (line) { onChat(line); });
  }

  function guestError(code) {
    // mid-resume, a "not there yet" is expected (host may be reloading too) —
    // retry a few times before giving up rather than bouncing to the entry form
    if (resumeGuestCtx && (code === 'no-such-room' || code === 'join-timeout' || code === 'peer-error')) {
      if (resumeGuestCtx.tries++ < 4) {
        setConn('reconnecting', 'reconnecting…');
        if (session) try { session.close(true); } catch (e) {}
        setTimeout(function () { startGuest(resumeGuestCtx.name, resumeGuestCtx.code, resumeGuestCtx.token); }, 3000);
        return;
      }
      resumeGuestCtx = null;
    }
    var err = $('#joinError');
    var messages = {
      'no-such-room': 'No table found for that code. Check it with the host — codes never use 0, 1, I or O.',
      'full': 'That table is full (4 players).',
      'version': 'This table runs a newer Pile On. Refresh to update, then join again.',
      'round-in-progress': 'Round already started — ask the host to add you before the next deal.',
      'removed': 'The host removed you from the table.',
      'join-timeout': 'Couldn’t reach that table. Check the code, and make sure the host still has Pile On open and online.',
    };
    if (messages[code]) {
      // these are terminal — don't auto-resume a table we can't or shouldn't rejoin
      if (code === 'removed' || code === 'version' || code === 'full' || code === 'no-such-room') clearSession();
      show('entry');
      err.textContent = messages[code];
      err.hidden = false;
      setConn('gone', 'offline');
      if (session) { try { session.close(true); } catch (e) {} session = null; }
    } else {
      setConn('reconnecting', 'network issue');
    }
  }

  function hostGone() {
    clearSession(); // the host said goodbye — nothing to resume
    setConn('gone', 'table closed');
    offline(true);
    toast('The table closed — scores so far are saved below');
    if (payload && payload.totals && Object.keys(payload.totals).length) {
      renderScores(true);
      show('scores');
      $('#guestScoreNote').hidden = false;
      $('#guestScoreNote').textContent = 'The table closed. Rounds played so far are logged in your Scores.';
    } else {
      show('entry');
      $('#joinError').textContent = 'The table closed.';
      $('#joinError').hidden = false;
    }
  }

  var wired = false;
  function wireCommon() {
    if (wired) return; // attach the global listeners exactly once
    wired = true;
    // reload / app-switch: close QUIETLY (no "bye") so we can resume the seat
    window.addEventListener('pagehide', function () { if (session) try { session.close(true); } catch (e) {} });
    // tapping Leave is deliberate — drop the saved session and say goodbye
    $('#leaveLink').addEventListener('click', function () { clearSession(); if (session) try { session.close(); } catch (e) {} });
  }

  /* ---------- lobby ---------- */
  $('#autologSwitch').checked = localStorage.getItem('pileon.autolog') !== 'off';
  $('#autologSwitch').addEventListener('change', function () {
    try { localStorage.setItem('pileon.autolog', this.checked ? 'on' : 'off'); } catch (e) { /* fine */ }
  });

  function renderLobby() {
    if (!session) return;
    var code = isHost ? session.code : (session.code || '');
    $('#codeText').textContent = code.slice(0, 3) + ' ' + code.slice(3);
    $('#rosterLabel').textContent = 'At the table (' + roster.length + '/4)';
    $('#rosterList').innerHTML = roster.map(function (p, i) {
      return '<li><span class="seat">' + (i + 1) + '</span>' +
        '<span class="nm">' + esc(p.name) + '</span>' +
        (p.id === 'p0' ? '<span class="tagme">HOST</span>' : '') +
        (p.id === myId ? '<span class="tagme">YOU</span>' : '') +
        '<span class="pdot' + (p.connected ? '' : ' off') + '" aria-hidden="true"></span>' +
        '<span class="sr-only">' + (p.connected ? 'connected' : 'away') + '</span>' +
        (isHost && p.id !== 'p0' ? '<button type="button" class="kick" data-kick="' + esc(p.id) + '" aria-label="Remove ' + esc(p.name) + '">✕</button>' : '') +
        '</li>';
    }).join('');
    $('#hostLobbyControls').hidden = !isHost;
    $('#guestLobbyNote').hidden = isHost;
    if (isHost) {
      var n = roster.length;
      $('#startBtn').disabled = n < 2;
      $('#startBtn').textContent = n < 2 ? 'Start round' : 'Start round (' + n + ' players)';
      $('#startReason').textContent = n < 2 ? 'Waiting for players — need at least 2. Share the code!' :
        (payload && payload.roundNo ? 'Round ' + (payload.roundNo + 1) + ' is next.' : 'Everyone in? Deal when ready.');
    } else {
      var host = roster[0];
      $('#guestLobbyNote').textContent = 'Waiting for ' + (host ? host.name : 'the host') + ' to start the round…';
    }
  }

  $('#rosterList').addEventListener('click', function (e) {
    var k = e.target.closest('[data-kick]');
    if (k && isHost) session.removePlayer(k.getAttribute('data-kick'));
  });

  $('#codeText').addEventListener('click', copyCode);
  $('#copyCodeBtn').addEventListener('click', copyCode);
  function copyCode() {
    var code = isHost ? session.code : session.code;
    if (navigator.clipboard) navigator.clipboard.writeText(code).then(function () { toast('Code copied'); });
  }
  if (navigator.share) {
    $('#shareCodeBtn').hidden = false;
    $('#shareCodeBtn').addEventListener('click', function () {
      var code = session.code;
      navigator.share({ title: 'Pile On table ' + code, text: 'Join my Dutch Blitz table: ' + code, url: location.origin + location.pathname + '?room=' + code })
        .catch(function () { /* cancelled */ });
    });
  }

  /* ---------- state handling ---------- */
  var lastEndedRound = 0;

  function onState(p) {
    payload = p;
    inflight = {};
    if (!p.state) { // back to lobby
      show('lobby');
      renderLobby();
      return;
    }
    if (p.roundNo !== trackRound) { // fresh deal — forget last round's board
      prevTops = {}; prevBlitz = {}; seenPlayN = 0; trackRound = p.roundNo;
      shuffleReacts(); // new hand of quick-reacts each round
    }
    if (p.state.status === 'playing') {
      if ($('#view-table').hidden) {
        show('table');
        selection = null;
        acquireWake();
        announce('Round ' + p.roundNo + ' dealt. Go!');
      }
      renderTable();
      runTicker(p.lastPlay);
    } else if (p.state.status === 'ended') {
      renderTable();
      if (p.roundNo !== lastEndedRound) {
        lastEndedRound = p.roundNo;
        logRoundLocally(p);
        blitzMoment(p);
      }
    }
  }

  function blitzMoment(p) {
    var caller = p.state.players[p.state.winner];
    $('#blitzCaller').textContent = (caller ? caller.name : '?') + ' calls it';
    $('#blitzOverlay').hidden = false;
    announce('Blitz! ' + (caller ? caller.name : '') + ' ends the round.');
    confettiBurst();
    releaseWake();
    setTimeout(function () {
      $('#blitzOverlay').hidden = true;
      renderScores(false);
      show('scores');
    }, 1600);
  }

  /* ---------- table rendering ---------- */
  function runTicker(lastPlay) {
    var el = $('#ticker');
    if (!lastPlay || !lastPlay.n || lastPlay.n === seenPlayN) return;
    seenPlayN = lastPlay.n;
    var who = lastPlay.playerId === myId ? 'You' : esc(lastPlay.name || 'Someone');
    var color = safeColor(lastPlay.color), value = safeVal(lastPlay.value);
    var msg;
    if (lastPlay.blitz) msg = '<b>' + who + '</b> emptied the Blitz pile!';
    else if (lastPlay.to === 'post') msg = '<b>' + who + '</b> parked a card';
    else msg = '<b>' + who + '</b> → ' + color + ' ' + value;
    el.innerHTML = msg;
    el.classList.remove('tick'); void el.offsetWidth; el.classList.add('tick');
  }

  function renderOpponents() {
    if (!payload || !payload.state) return;
    var st = payload.state;
    var newBlitz = {};
    $('#oppStrip').innerHTML = st.order.filter(function (id) { return id !== myId; }).map(function (id) {
      var p = st.players[id];
      var r = roster.find(function (x) { return x.id === id; });
      var away = r && !r.connected;
      var blitzLeft = safeNum(p.blitz.length, 0, 10);
      var tier = blitzLeft > 0 && blitzLeft <= 2 ? ' danger' : blitzLeft === 3 ? ' warn' : '';
      newBlitz[id] = blitzLeft;
      var dropped = prevBlitz[id] != null && blitzLeft < prevBlitz[id];
      return '<div class="opp' + (away ? ' away' : '') + tier + (dropped ? ' drop' : '') + '">' +
        '<span class="nm">' + esc(p.name) + '</span>' +
        '<span class="blitz-read"><b class="bcount">' + blitzLeft + '</b><span class="cap">' + (blitzLeft === 1 ? 'to win!' : 'in blitz') + '</span></span>' +
        '<span class="pdot" aria-hidden="true"></span>' +
        '<span class="sr-only">' + esc(p.name) + ' has ' + blitzLeft + ' Blitz cards left' + (away ? ', away' : '') + '</span>' +
        '</div>';
    }).join('');
    prevBlitz = newBlitz;
  }

  function renderDutch() {
    var st = payload.state;
    var me = myPlayer();
    var sel = selection ? selection.card : null;
    var legal = sel ? G.legalDutchTargets(st, sel) : [];
    var newTops = {};
    var cells = st.dutch.map(function (pile, i) {
      var color = safeColor(pile.color);
      var topVal = safeVal(pile.top);
      var prev = prevTops[i];
      newTops[i] = { top: topVal, done: !!pile.done };
      var sealed = pile.done && !(prev && prev.done);
      var advanced = !pile.done && ((prev && !prev.done && topVal > prev.top) || !prev);
      if (pile.done) {
        return '<button type="button" class="pile live done' + (sealed ? ' sealed' : '') + '" disabled data-c="' + color + '">10<span class="prog">done</span></button>';
      }
      var isLegal = legal.indexOf(i) !== -1;
      return '<button type="button" class="pile live' + (isLegal ? ' legal' : '') + (advanced ? ' advanced' : '') + '" data-pile="' + i + '" data-c="' + color + '"' +
        ' aria-label="' + color + ' pile at ' + topVal + (isLegal ? ', legal target' : '') + '">' +
        genderGlyph(color, 9) + topVal +
        '<span class="prog">' + topVal + '/10</span></button>';
    });
    var minSlots = Math.max(8, st.dutch.length + 1);
    var canNew = legal.indexOf('new') !== -1;
    for (var i = st.dutch.length; i < minSlots; i++) {
      cells.push('<button type="button" class="pile empty' + (canNew ? ' legal' : '') + '" data-pile="new" aria-label="Empty pile slot — a 1 starts here">' + (canNew ? '▸1' : '1') + '</button>');
    }
    $('#dutchGrid').innerHTML = cells.join('');
    prevTops = newTops;
  }

  function cardHtml(card, extraClass, attrs) {
    var color = safeColor(card.color);
    var value = safeVal(card.value);
    return '<button type="button" class="pcard ' + (extraClass || '') + (value === 10 ? ' ten' : '') + '" data-c="' + color + '" ' + (attrs || '') + '>' +
      genderGlyph(color, 11) + value + '</button>';
  }

  function renderYou() {
    var me = myPlayer();
    if (!me) return;
    var slots = [];
    var selKey = selection ? sourceKey(selection.from) : null;

    // Blitz
    var bTop = G.top(me.blitz);
    var bLeft = safeNum(me.blitz.length, 0, 10);
    if (bTop) {
      slots.push('<div class="slot blitz">' +
        cardHtml(bTop, (selKey === 'blitz' ? 'selected' : '') + (inflight.blitz ? ' inflight' : ''), 'data-src="blitz" aria-label="Your Blitz card: ' + safeColor(bTop.color) + ' ' + safeVal(bTop.value) + ', ' + bLeft + ' left"') +
        '<span class="chit blitz">' + bLeft + '</span>' +
        '<div class="lbl">Blitz · <b>' + bLeft + '</b></div></div>');
    } else {
      slots.push('<div class="slot blitz"><button type="button" class="pcard slot-empty" disabled>OUT</button><div class="lbl">Blitz · <b>0</b></div></div>');
    }

    // Posts
    for (var i = 0; i < 3; i++) {
      var pTop = G.top(me.post[i]);
      var key = 'post' + i;
      var postLegal = selection && legalPostTarget(me, selection, i);
      if (pTop) {
        slots.push('<div class="slot">' +
          cardHtml(pTop, (selKey === key ? 'selected' : '') + (postLegal ? ' legal' : '') + (inflight[key] ? ' inflight' : ''), 'data-src="post" data-idx="' + i + '" aria-label="Post pile ' + (i + 1) + ': ' + safeColor(pTop.color) + ' ' + safeVal(pTop.value) + (postLegal ? ', legal target' : '') + '"') +
          '<div class="lbl">Post</div></div>');
      } else {
        slots.push('<div class="slot"><button type="button" class="pcard slot-empty' + (postLegal ? ' legal' : '') + '" data-src="post" data-idx="' + i + '" aria-label="Empty post slot ' + (i + 1) + ' — fills from your Blitz pile">＋</button><div class="lbl">Post</div></div>');
      }
    }

    // Wood
    var wTop = G.top(me.wood);
    if (wTop) {
      slots.push('<div class="slot">' +
        cardHtml(wTop, (selKey === 'wood' ? 'selected' : '') + (inflight.wood ? ' inflight' : ''), 'data-src="wood" aria-label="Wood pile top: ' + safeColor(wTop.color) + ' ' + safeVal(wTop.value) + '"') +
        '<div class="lbl">Wood</div></div>');
    } else {
      slots.push('<div class="slot"><button type="button" class="pcard back" disabled aria-label="Wood pile empty — flip to reveal"><span class="chit">' + safeNum(me.hand.length, 0, 40) + '</span></button><div class="lbl">Wood</div></div>');
    }

    $('#youSlots').innerHTML = slots.join('');

    var flip = $('#flipBtn');
    if (me.hand.length) { flip.disabled = false; flip.textContent = 'FLIP ×3 · ' + me.hand.length; }
    else if (me.wood.length) { flip.disabled = false; flip.textContent = 'TURN OVER'; }
    else { flip.disabled = true; flip.textContent = 'EMPTY'; }

    $('#hintLine').textContent = selection
      ? selection.card.color + ' ' + selection.card.value + ' — tap a Post pile, or tap it again to cancel'
      : 'Tap a card to play it';
  }

  function legalPostTarget(me, sel, idx) {
    if (sel.from.zone === 'post' && sel.from.idx === idx) return false;
    var slotTop = G.top(me.post[idx]);
    if (!slotTop) return sel.from.zone === 'blitz';
    return sel.card.value === slotTop.value - 1 && G.isBoy(sel.card) !== G.isBoy(slotTop);
  }

  function renderTable() {
    renderOpponents();
    renderDutch();
    renderYou();
  }

  /* ---------- interaction ---------- */
  function sendIntent(intent, srcKey) {
    nSeq++;
    nToSource[nSeq] = srcKey;
    if (srcKey) inflight[srcKey] = true;
    if (isHost) {
      session.hostIntent(intent, nSeq); // state broadcast re-renders everything
    } else {
      session.sendIntent(intent, nSeq);
      renderYou(); // show in-flight ghost immediately
    }
  }

  function onNack(nack) {
    var src = nToSource[nack.n];
    delete nToSource[nack.n];
    if (src) delete inflight[src];
    renderTable();
    if (navigator.vibrate) navigator.vibrate(40);
    var el = document.querySelector('[data-src="' + (src ? src.replace(/\d+$/, '') : '') + '"]');
    if (el) { el.classList.add('shake'); setTimeout(function () { el.classList.remove('shake'); }, 260); }
    var msgs = {
      'beaten-to-it': 'Beaten to it!',
      'must-alternate-boy-girl': 'Post piles alternate ▲ and ○',
      'must-build-down': 'Post piles build down',
      'empty-post-fills-from-blitz': 'Empty Post slots fill from your Blitz pile',
      'only-a-1-starts-a-pile': 'Only a 1 starts a pile',
    };
    toast(msgs[nack.reason] || 'No dice');
    announce(msgs[nack.reason] || 'Play rejected.');
  }

  $('#flipBtn').addEventListener('pointerup', function () {
    var me = myPlayer();
    if (!me || payload.state.status !== 'playing') return;
    selection = null;
    // optimistic: guests apply locally for instant feel; the broadcast reconciles
    if (!isHost) G.applyIntent(payload.state, myId, { type: 'flip' });
    sendIntent({ type: 'flip' }, null);
    renderTable();
  });

  $('#dutchGrid').addEventListener('pointerup', function (e) {
    var btn = e.target.closest('[data-pile]');
    if (!btn || !selection || payload.state.status !== 'playing') return;
    var which = btn.getAttribute('data-pile');
    var to = which === 'new' ? { zone: 'dutchNew' } : { zone: 'dutch', idx: parseInt(which, 10) };
    var from = selection.from;
    selection = null;
    sendIntent({ type: 'play', from: from, to: to }, sourceKey(from));
    renderTable();
  });

  $('#youSlots').addEventListener('pointerup', function (e) {
    var btn = e.target.closest('[data-src]');
    if (!btn || payload.state.status !== 'playing') return;
    var me = myPlayer();
    var zone = btn.getAttribute('data-src');
    var idx = btn.hasAttribute('data-idx') ? parseInt(btn.getAttribute('data-idx'), 10) : null;
    var from = idx == null ? { zone: zone } : { zone: zone, idx: idx };

    // a selection exists and this is a Post slot → try to place there
    if (selection && zone === 'post') {
      var same = selection.from.zone === 'post' && selection.from.idx === idx;
      if (!same) {
        var f = selection.from;
        selection = null;
        sendIntent({ type: 'play', from: f, to: { zone: 'post', idx: idx } }, sourceKey(f));
        renderTable();
        return;
      }
    }

    // tapping the selected card again deselects
    if (selection && sourceKey(selection.from) === sourceKey(from)) {
      selection = null;
      renderTable();
      return;
    }

    var card = zone === 'blitz' ? G.top(me.blitz) : zone === 'wood' ? G.top(me.wood) : G.top(me.post[idx]);
    if (!card) {
      // empty post slot shortcut: one tap pulls the Blitz top into it
      if (zone === 'post' && G.top(me.blitz)) {
        sendIntent({ type: 'play', from: { zone: 'blitz' }, to: { zone: 'post', idx: idx } }, 'blitz');
        renderTable();
      }
      return;
    }

    // auto-play: a legal Dutch destination wins immediately (it scores)
    var targets = G.legalDutchTargets(payload.state, card);
    if (targets.length) {
      var t = targets[0];
      sendIntent({ type: 'play', from: from, to: t === 'new' ? { zone: 'dutchNew' } : { zone: 'dutch', idx: t } }, sourceKey(from));
      renderTable();
      return;
    }

    // otherwise select for a Post placement
    selection = { from: from, card: card };
    renderTable();
  });

  /* ---------- results ---------- */
  function renderScores(terminal) {
    var p = payload;
    var st = p.state;
    var rows = st ? st.order.slice() : [];
    rows.sort(function (a, b) { return (p.totals[b] || 0) - (p.totals[a] || 0); });
    var target = p.target || 75;
    var champion = rows.length && (p.totals[rows[0]] || 0) >= target ? rows[0] : null;

    $('#scoresTitle').textContent = champion
      ? st.players[champion].name.toUpperCase() + ' WINS — first to ' + target
      : 'Round ' + p.roundNo + ' · first to ' + target;

    $('#scoreSheet').innerHTML = rows.map(function (id) {
      var pl = st.players[id];
      var sc = st.scores ? st.scores[id] : null;
      var total = safeNum(p.totals[id] || 0, -9999, 9999);
      var isW = champion === id;
      var played = sc ? safeNum(sc.played, 0, 40) : 0;
      var bLeft = sc ? safeNum(sc.blitzLeft, 0, 10) : 0;
      var scv = sc ? safeNum(sc.score, -999, 999) : 0;
      return '<div class="row' + (isW ? ' winner' : '') + '">' +
        '<span class="nm">' + esc(pl.name) + (st.winner === id ? ' ✦' : '') + '</span>' +
        (sc ? '<span class="detail">+' + played + ' · −2×' + bLeft + ' = ' + (scv >= 0 ? '+' : '') + '<span class="' + (scv < 0 ? 'neg-red' : '') + '">' + scv + '</span></span>' : '') +
        '<span class="rt">' + total + '</span></div>';
    }).join('');

    var matchOver = !!champion;
    $('#hostScoreControls').hidden = !isHost || matchOver || terminal;
    $('#matchEndControls').hidden = !isHost || !matchOver;
    $('#guestScoreNote').hidden = isHost || terminal === true;
    if (!isHost && !terminal) {
      var hostName = roster[0] ? roster[0].name : 'the host';
      $('#guestScoreNote').textContent = matchOver ? 'What a game! Waiting for ' + hostName + '…' : 'Waiting for ' + hostName + ' to deal round ' + (p.roundNo + 1) + '…';
    }
    if (isHost && !matchOver) $('#nextRoundBtn').textContent = 'Deal round ' + (p.roundNo + 1);
    if (matchOver) confettiBurst();
  }

  /* ---------- score tracker integration ---------- */
  function logRoundLocally(p) {
    if (localStorage.getItem('pileon.autolog') === 'off') return;
    try {
      var logged = JSON.parse(localStorage.getItem(loggedKey) || '{}');
      var code = session.code;
      logged[code] = logged[code] || [];
      if (logged[code].indexOf(p.roundNo) !== -1) return;

      var store = new window.BlitzStore.Store(window.localStorage);
      store.load();
      var gameName = 'Online · ' + code;
      var game = null;
      Object.keys(store.state.games).forEach(function (id) {
        if (store.state.games[id].name === gameName) game = store.state.games[id];
      });
      if (!game) {
        game = E.newGame({
          name: gameName,
          targetScore: p.target,
          playerNames: p.state.order.map(function (id) { return p.state.players[id].name; }),
          createdAt: Date.now(),
        });
        store.addGame(game, false);
      }
      var scores = p.state.order.map(function (id) {
        var local = game.players.find(function (x) { return x.name === p.state.players[id].name; });
        // clamp host-supplied score into a sane per-round range before it
        // lands in the persistent scorepad — a hostile host can't inject junk
        var v = p.state.scores[id].score | 0;
        if (v < -20) v = -20; if (v > 40) v = 40;
        return local ? { playerId: local.id, mode: 'simple', value: v } : null;
      }).filter(Boolean);
      E.addRound(game, scores, Date.now());
      store.touch(game);
      logged[code].push(p.roundNo);
      localStorage.setItem(loggedKey, JSON.stringify(logged));
    } catch (e) { /* logging is best-effort; play must never break */ }
  }

  /* ---------- misc ---------- */
  function offline(is) {
    var t = $('#view-table');
    if (is) t.classList.add('table--offline'); else t.classList.remove('table--offline');
    if (is) { $('#flipBtn').textContent = 'RECONNECTING…'; }
  }

  var wakeWanted = false;
  function acquireWake() {
    wakeWanted = true;
    if (navigator.wakeLock && navigator.wakeLock.request) {
      navigator.wakeLock.request('screen').then(function (l) { wakeLock = l; }).catch(function () { /* fine */ });
    }
  }
  function releaseWake() { wakeWanted = false; if (wakeLock) { wakeLock.release().catch(function () {}); wakeLock = null; } }
  // wake locks auto-release when the tab is hidden — re-take it on return so
  // the host's screen (which runs the game) doesn't sleep between rounds
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && wakeWanted && !wakeLock) acquireWake();
  });

  /* ---------- boot: resume, deep-link, or fresh ---------- */
  shuffleReacts(); // an opening set for the lobby before the first deal
  wireCommon();
  (function boot() {
    // Auto-resume targets the real cross-device case (peer transport, separate
    // localStorage per phone). The local transport shares one localStorage
    // across tabs, so only resume there when a test explicitly asks (?resume=1).
    var mayResume = TRANSPORT === 'peer' || params.get('resume') === '1';
    var saved = mayResume ? loadSession() : null;
    // A deep link to a *different* table wins over a stale saved session.
    if (deepCode && saved && saved.role === 'guest' && saved.code !== deepCode) saved = null;
    if (saved && saved.role === 'host') {
      toast('Reopening your table…');
      startHost(saved.hostName || saved.name, saved.target, saved);
      return;
    }
    if (saved && saved.role === 'guest') {
      toast('Rejoining your table…');
      resumeGuestCtx = { name: saved.name, code: saved.code, token: saved.token, tries: 0 };
      startGuest(saved.name, saved.code, saved.token);
      return;
    }
    if (deepCode) $('#joinName').focus();
    show('entry');
  })();
})();
