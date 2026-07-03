/* Dutch Blitz Sidecar — UI layer. Plain script; state lives in BlitzStore, math in BlitzEngine. */
(function () {
  'use strict';

  var E = window.BlitzEngine;
  var store = new window.BlitzStore.Store(window.localStorage);

  var $ = function (sel) { return document.querySelector(sel); };
  var $$ = function (sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); };

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function signed(n) { return n > 0 ? '+' + n : String(n); }

  /* ---------- boot ---------- */
  store.load();
  store.ensureSeed();
  if (store.recoveryNotice) {
    var rn = $('#recoveryNotice');
    rn.textContent = store.recoveryNotice;
    rn.hidden = false;
  }
  applySettings();
  window.addEventListener('storage', function (e) {
    if (e.key === window.BlitzStore.KEY) {
      store.refreshFromStorage();
      renderAll();
    }
  });

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(function () { /* offline shell just won't precache */ });
  }

  /* ---------- settings ---------- */
  function applySettings() {
    var s = store.state.settings;
    var root = document.documentElement;
    if (s.darkMode === 'auto') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', s.darkMode);
    root.setAttribute('data-bigtype', s.bigType ? 'true' : 'false');
  }

  /* ---------- toast / sound / confetti ---------- */
  var toastTimer = null;
  function toast(msg) {
    var t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2200);
  }

  function blip() {
    if (!store.state.settings.soundOn) return;
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      var ctx = blip.ctx || (blip.ctx = new Ctx());
      var o = ctx.createOscillator();
      var g = ctx.createGain();
      o.frequency.value = 660;
      g.gain.setValueAtTime(0.08, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.18);
      o.connect(g).connect(ctx.destination);
      o.start();
      o.stop(ctx.currentTime + 0.2);
    } catch (e) { /* no audio — fine */ }
  }

  function confetti() {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    var host = $('#confetti');
    var colors = ['var(--c-red)', 'var(--c-blue)', 'var(--c-green)', 'var(--c-yellow)'];
    for (var i = 0; i < 60; i++) {
      var s = document.createElement('span');
      s.style.left = Math.random() * 100 + 'vw';
      s.style.background = colors[i % 4];
      s.style.animationDelay = Math.random() * 0.6 + 's';
      s.style.transform = 'rotate(' + Math.random() * 360 + 'deg)';
      host.appendChild(s);
    }
    setTimeout(function () { host.textContent = ''; }, 3200);
  }

  /* ---------- confirm dialog (promise-based) ---------- */
  function confirmAction(message, okLabel) {
    return new Promise(function (resolve) {
      var dlg = $('#confirmDialog');
      $('#confirmMessage').textContent = message;
      $('#confirmOkBtn').textContent = okLabel || 'Confirm';
      function onClose() {
        dlg.removeEventListener('close', onClose);
        resolve(dlg.returnValue === 'ok');
      }
      dlg.addEventListener('close', onClose);
      dlg.returnValue = 'cancel'; // Esc must never replay a previous 'ok'
      dlg.showModal();
    });
  }

  /* ---------- tabs ---------- */
  var TABS = ['home', 'score', 'rules', 'guide'];
  function showTab(name) {
    TABS.forEach(function (t) {
      $('#panel-' + t).hidden = t !== name;
      var tab = $('#tab-' + t);
      tab.setAttribute('aria-selected', t === name ? 'true' : 'false');
      tab.tabIndex = t === name ? 0 : -1;
    });
    window.scrollTo(0, 0);
  }
  TABS.forEach(function (t) {
    $('#tab-' + t).addEventListener('click', function () { showTab(t); });
  });
  $('.tablist').addEventListener('keydown', function (e) {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    var current = TABS.findIndex(function (t) { return $('#tab-' + t).getAttribute('aria-selected') === 'true'; });
    var next = (current + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length;
    showTab(TABS[next]);
    $('#tab-' + TABS[next]).focus();
  });

  /* ---------- rendering ---------- */
  function dotHtml(player) {
    return '<span class="dot ' + esc(player.color) + '" aria-hidden="true"></span>';
  }

  function renderAll() {
    applySettings();
    renderHome();
    renderScore();
  }

  function renderHome() {
    var game = store.currentGame();
    var host = $('#homeCurrentGame');
    if (!game) {
      host.innerHTML =
        '<div class="empty-state"><p class="empty-art" aria-hidden="true">🔔</p>' +
        '<p>No game on the table yet.<br>Start one — it takes ten seconds.</p></div>';
    } else {
      var rows = E.standings(game).map(function (r) {
        return '<li>' + dotHtml(r.player) +
          '<span>' + esc(r.player.name) + '</span>' +
          (r.isLeader ? ' <span class="badge">★ Leader</span>' : '') +
          (r.hitTarget ? ' <span class="badge win">🏆 ' + game.targetScore + '+</span>' : '') +
          '<span class="total">' + r.total + '</span></li>';
      }).join('');
      host.innerHTML =
        '<div class="game-card">' +
        '<h2>' + esc(game.name) + '</h2>' +
        '<p class="game-meta">' + game.players.length + ' players · first to ' + game.targetScore +
        ' · ' + game.rounds.length + ' round' + (game.rounds.length === 1 ? '' : 's') + ' played</p>' +
        '<ol class="mini-standings" aria-label="Current standings">' + rows + '</ol>' +
        '</div>';
    }

    var others = Object.keys(store.state.games)
      .filter(function (id) { return id !== store.state.currentGameId; })
      .map(function (id) { return store.state.games[id]; })
      .sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
    var otherHost = $('#homeOtherGames');
    if (!others.length) { otherHost.innerHTML = ''; return; }
    otherHost.innerHTML = '<h3 class="section-label">Previous games</h3>' + others.map(function (g) {
      return '<div class="prev-game">' +
        '<button type="button" class="resume" data-resume="' + esc(g.id) + '">' +
        '<strong>' + esc(g.name) + '</strong><br><span class="meta">' +
        g.players.map(function (p) { return esc(p.name); }).join(', ') + ' · ' + g.rounds.length + ' rounds</span></button>' +
        '<button type="button" class="del" data-delete="' + esc(g.id) + '" aria-label="Delete ' + esc(g.name) + '">🗑</button>' +
        '</div>';
    }).join('');
  }

  $('#homeOtherGames').addEventListener('click', function (e) {
    var del = e.target.closest('[data-delete]');
    if (del) {
      e.stopPropagation();
      var g = store.state.games[del.getAttribute('data-delete')];
      if (!g) return;
      confirmAction('Delete "' + g.name + '" and all its scores? This cannot be undone.', 'Delete game')
        .then(function (ok) {
          if (ok) { store.deleteGame(g.id); renderAll(); toast('Game deleted'); }
        });
      return;
    }
    var btn = e.target.closest('[data-resume]');
    if (btn) {
      store.setCurrentGame(btn.getAttribute('data-resume'));
      renderAll();
      showTab('score');
    }
  });

  function renderScore() {
    var game = store.currentGame();
    $('#scoreEmpty').hidden = !!game;
    $('#scoreContent').hidden = !game;
    if (!game) return;

    $('#scoreGameName').textContent = game.name;
    var leaderRow = E.standings(game)[0];
    $('#scoreTargetLine').textContent = 'First to ' + game.targetScore +
      (leaderRow && leaderRow.hitTarget ? ' — target reached!' : '');

    $('#leaderboard').innerHTML = E.standings(game).map(function (r) {
      return '<li class="' + (r.isLeader ? 'leader ' : '') + (r.hitTarget ? 'hit-target' : '') + '">' +
        '<span class="rank" aria-hidden="true">' + r.rank + '</span>' +
        dotHtml(r.player) +
        '<span class="name">' + esc(r.player.name) +
        (r.isLeader ? '<span class="sr-only"> (leader)</span>' : '') +
        (r.hitTarget ? '<span class="sr-only"> (reached target)</span>' : '') + '</span>' +
        '<span class="badges">' +
        (r.isLeader ? '<span class="badge">★ Leader</span>' : '') +
        (r.hitTarget ? '<span class="badge win">🏆 Win</span>' : '') +
        '</span>' +
        '<span class="total">' + r.total + '</span></li>';
    }).join('');

    var hasHistory = game.rounds.length || game.adjustments.length;
    $('#historyEmpty').hidden = !!hasHistory;
    $('#history').innerHTML = hasHistory ? historyHtml(game) : '';
    $('#undoRoundBtn').disabled = !game.rounds.length;
  }

  function adjHtml(adj, game) {
    return '<div class="adj-card"><span class="tag">Correction</span>' +
      '<span>' + esc((game.players.find(function (p) { return p.id === adj.playerId; }) || { name: '(removed)' }).name) +
      ' <b>' + signed(adj.delta) + '</b>' +
      (adj.label ? ' — ' + esc(adj.label) : '') + '</span>' +
      '<button type="button" class="del" data-del-adj="' + esc(adj.id) + '" aria-label="Delete this correction">✕</button>' +
      '</div>';
  }

  function historyHtml(game) {
    var cumulative = E.cumulativeByRound(game);
    var out = [];
    var standalone = game.adjustments.filter(function (a) { return a.attachedToRoundIndex === null; });
    standalone.slice().reverse().forEach(function (adj) { out.push(adjHtml(adj, game)); });

    game.rounds.slice().reverse().forEach(function (round) {
      var scores = game.players.map(function (p) {
        var rs = E.roundScoreFor(round, p.id);
        if (!rs) return '<span>' + esc(p.name) + ' <b>—</b></span>';
        var v = E.scoreValue(rs);
        return '<span>' + esc(p.name) + ' <b class="' + (v < 0 ? 'neg' : '') + '">' + signed(v) + '</b></span>';
      }).join('');
      var snap = cumulative[round.index - 1];
      var after = snap ? game.players.map(function (p) {
        return esc(p.name) + ' ' + (snap.totals[p.id] || 0);
      }).join(' · ') : '';
      out.push(
        '<button type="button" class="round-card" data-edit-round="' + esc(round.id) + '">' +
        '<span class="round-head">Round ' + round.index +
        '<span class="edit-hint">tap to edit ✎</span></span>' +
        '<span class="round-scores">' + scores + '</span>' +
        (after ? '<span class="round-scores" style="margin-top:4px;color:var(--ink-soft);font-size:0.82em">after: ' + after + '</span>' : '') +
        '</button>'
      );
      game.adjustments.forEach(function (adj) {
        if (adj.attachedToRoundIndex === round.index) out.push(adjHtml(adj, game));
      });
    });
    return out.join('');
  }

  $('#history').addEventListener('click', function (e) {
    var delAdj = e.target.closest('[data-del-adj]');
    if (delAdj) {
      var game = store.currentGame();
      confirmAction('Delete this correction? Totals will change.', 'Delete')
        .then(function (ok) {
          if (ok && game) {
            E.deleteAdjustment(game, delAdj.getAttribute('data-del-adj'));
            store.touch(game);
            renderAll();
            toast('Correction deleted');
          }
        });
      return;
    }
    var card = e.target.closest('[data-edit-round]');
    if (card) openRoundDialog(card.getAttribute('data-edit-round'));
  });

  /* ---------- new game ---------- */
  var newGameDialog = $('#newGameDialog');
  function playerRowHtml(value) {
    return '<label class="field"><span class="sr-only">Player name</span>' +
      '<input type="text" class="new-player-name" maxlength="24" autocomplete="off" placeholder="Player name" value="' + esc(value || '') + '"></label>';
  }
  function openNewGameDialog() {
    $('#newGameForm').reset();
    $('#newGameTarget').value = '75';
    $('#newGameError').hidden = true;
    var current = store.currentGame();
    var names = current ? current.players.map(function (p) { return p.name; }) : ['', ''];
    if (names.length < 2) names = names.concat(['', '']).slice(0, 2);
    $('#newGamePlayers').innerHTML = names.map(playerRowHtml).join('');
    newGameDialog.showModal();
  }
  $('#addPlayerRowBtn').addEventListener('click', function () {
    var host = $('#newGamePlayers');
    if (host.querySelectorAll('input').length >= 8) { toast('8 players max (with expansion)'); return; }
    host.insertAdjacentHTML('beforeend', playerRowHtml(''));
    host.lastElementChild.querySelector('input').focus();
  });
  $('#newGameForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var names = $$('#newGamePlayers input').map(function (i) { return i.value.trim(); }).filter(Boolean);
    var err = $('#newGameError');
    if (names.length < 2) {
      err.textContent = 'Enter at least 2 player names.';
      err.hidden = false;
      return;
    }
    var target = E.toInt($('#newGameTarget').value) || 75;
    if (target < 1) target = 75;
    var game = E.newGame({
      name: $('#newGameName').value.trim() || 'Game night',
      targetScore: target,
      playerNames: names,
      createdAt: Date.now(),
    });
    store.addGame(game, true);
    newGameDialog.close();
    renderAll();
    showTab('score');
    toast('Game on! First to ' + target + '.');
  });

  /* ---------- round entry (add + edit) ---------- */
  var roundDialog = $('#roundDialog');
  var roundMode = 'simple';
  var editingRoundId = null;

  function setRoundMode(mode, prefill) {
    roundMode = mode;
    $$('#roundDialog .mode-btn').forEach(function (b) {
      b.setAttribute('aria-pressed', b.getAttribute('data-mode') === mode ? 'true' : 'false');
    });
    $$('#roundDialog .mode-hint').forEach(function (h) {
      h.hidden = h.getAttribute('data-for') !== mode;
    });
    renderRoundInputs(prefill || {});
  }

  function renderRoundInputs(prefill) {
    var game = store.currentGame();
    if (!game) return;
    var host = $('#roundInputs');
    host.innerHTML = game.players.map(function (p) {
      var pre = prefill[p.id] || {};
      if (roundMode === 'calc') {
        return '<div class="score-row calc"><span class="who">' + dotHtml(p) + '<span>' + esc(p.name) + '</span></span>' +
          '<div class="calc-inputs">' +
          '<label>Played to Dutch<input type="number" inputmode="numeric" min="0" max="40" data-calc-dutch="' + esc(p.id) + '" value="' + (pre.dutchCards !== undefined ? pre.dutchCards : '') + '"></label>' +
          '<label>Left in Blitz<input type="number" inputmode="numeric" min="0" max="10" data-calc-blitz="' + esc(p.id) + '" value="' + (pre.blitzLeft !== undefined ? pre.blitzLeft : '') + '"></label>' +
          '<span class="calc-result" data-calc-result="' + esc(p.id) + '" aria-live="off">= 0</span>' +
          '</div></div>';
      }
      return '<div class="score-row"><span class="who">' + dotHtml(p) + '<span>' + esc(p.name) + '</span></span>' +
        '<div class="stepper">' +
        '<button type="button" class="step-btn" data-step="-1" data-player="' + esc(p.id) + '" aria-label="Decrease ' + esc(p.name) + ' score">−</button>' +
        '<input type="text" inputmode="numeric" pattern="-?[0-9]*" autocomplete="off" data-simple="' + esc(p.id) + '" value="' + (pre.value !== undefined ? pre.value : '') + '" aria-label="' + esc(p.name) + ' round score">' +
        '<button type="button" class="step-btn" data-step="1" data-player="' + esc(p.id) + '" aria-label="Increase ' + esc(p.name) + ' score">＋</button>' +
        '</div></div>';
    }).join('');
    if (roundMode === 'calc') updateCalcResults();
  }

  function updateCalcResults() {
    var game = store.currentGame();
    if (!game) return;
    game.players.forEach(function (p) {
      var d = $('[data-calc-dutch="' + p.id + '"]');
      var b = $('[data-calc-blitz="' + p.id + '"]');
      var r = $('[data-calc-result="' + p.id + '"]');
      if (d && b && r) r.textContent = '= ' + E.calcScore(d.value, b.value);
    });
  }

  $('#roundInputs').addEventListener('input', function (e) {
    if (e.target.hasAttribute('data-calc-dutch') || e.target.hasAttribute('data-calc-blitz')) updateCalcResults();
  });
  $('#roundInputs').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-step]');
    if (!btn) return;
    var input = $('[data-simple="' + btn.getAttribute('data-player') + '"]');
    if (input) input.value = E.toInt(input.value) + E.toInt(btn.getAttribute('data-step'));
  });
  $$('#roundDialog .mode-btn').forEach(function (b) {
    b.addEventListener('click', function () {
      setRoundMode(b.getAttribute('data-mode'), collectPrefillFromForm());
    });
  });

  /** When flipping modes mid-entry, carry values across so nothing typed is lost. */
  function collectPrefillFromForm() {
    var game = store.currentGame();
    var prefill = {};
    if (!game) return prefill;
    game.players.forEach(function (p) {
      if (roundMode === 'simple') {
        var i = $('[data-simple="' + p.id + '"]');
        if (i && i.value.trim() !== '') prefill[p.id] = { value: E.toInt(i.value) };
      } else {
        var d = $('[data-calc-dutch="' + p.id + '"]');
        var b = $('[data-calc-blitz="' + p.id + '"]');
        if (d && b && (d.value !== '' || b.value !== '')) {
          prefill[p.id] = { value: E.calcScore(d.value, b.value), dutchCards: E.toInt(d.value), blitzLeft: E.toInt(b.value) };
        }
      }
    });
    return prefill;
  }

  function openRoundDialog(roundId) {
    var game = store.currentGame();
    if (!game) { openNewGameDialog(); return; }
    if (!game.players.length) { toast('Add players first'); openPlayersDialog(); return; }
    editingRoundId = roundId || null;
    var prefill = {};
    var mode = store.state.settings.defaultInputMode;
    if (roundId) {
      var round = game.rounds.find(function (r) { return r.id === roundId; });
      if (!round) return;
      $('#roundDialogTitle').textContent = 'Edit round ' + round.index;
      $('#deleteRoundBtn').hidden = false;
      var calcCount = 0;
      round.scores.forEach(function (rs) {
        if (rs.mode === 'calc') {
          calcCount++;
          prefill[rs.playerId] = { dutchCards: rs.dutchCards, blitzLeft: rs.blitzLeft, value: E.scoreValue(rs) };
        } else {
          prefill[rs.playerId] = { value: rs.value };
        }
      });
      mode = calcCount > round.scores.length / 2 ? 'calc' : 'simple';
    } else {
      $('#roundDialogTitle').textContent = 'Add round ' + (game.rounds.length + 1);
      $('#deleteRoundBtn').hidden = true;
    }
    setRoundMode(mode, prefill);
    roundDialog.showModal();
    var first = roundDialog.querySelector('input');
    if (first) first.focus();
  }

  $('#roundForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var game = store.currentGame();
    if (!game) return;
    var hadWinner = E.hasWinner(game);
    var scores = game.players.map(function (p) {
      if (roundMode === 'calc') {
        var d = $('[data-calc-dutch="' + p.id + '"]');
        var b = $('[data-calc-blitz="' + p.id + '"]');
        return { playerId: p.id, mode: 'calc', dutchCards: E.toInt(d && d.value), blitzLeft: E.toInt(b && b.value) };
      }
      var i = $('[data-simple="' + p.id + '"]');
      return { playerId: p.id, mode: 'simple', value: E.toInt(i && i.value) };
    });
    if (editingRoundId) {
      E.updateRound(game, editingRoundId, scores);
      toast('Round updated');
    } else {
      E.addRound(game, scores, Date.now());
      toast('Round ' + game.rounds.length + ' saved');
      blip();
    }
    store.touch(game);
    roundDialog.close();
    renderAll();
    showTab('score');
    if (!hadWinner && E.hasWinner(game)) {
      confetti();
      var winner = E.standings(game).filter(function (r) { return r.hitTarget; })
        .map(function (r) { return r.player.name; }).join(' & ');
      toast('🏆 ' + winner + ' reached ' + game.targetScore + '!');
    }
  });

  $('#deleteRoundBtn').addEventListener('click', function () {
    var game = store.currentGame();
    if (!game || !editingRoundId) return;
    confirmAction('Delete this round? Later rounds renumber; attached corrections become standalone (still visible).', 'Delete round')
      .then(function (ok) {
        if (!ok) return;
        E.deleteRound(game, editingRoundId);
        store.touch(game);
        roundDialog.close();
        renderAll();
        toast('Round deleted');
      });
  });

  $('#undoRoundBtn').addEventListener('click', function () {
    var game = store.currentGame();
    if (!game || !game.rounds.length) return;
    confirmAction('Undo round ' + game.rounds.length + '? Its scores are removed.', 'Undo round')
      .then(function (ok) {
        if (!ok) return;
        E.undoLastRound(game);
        store.touch(game);
        renderAll();
        toast('Last round undone');
      });
  });

  /* ---------- corrections ---------- */
  var adjDialog = $('#adjDialog');
  function openAdjDialog() {
    var game = store.currentGame();
    if (!game || !game.players.length) { toast('No players yet'); return; }
    $('#adjForm').reset();
    $('#adjError').hidden = true;
    $('#adjPlayer').innerHTML = game.players.map(function (p) {
      return '<option value="' + esc(p.id) + '">' + esc(p.name) + '</option>';
    }).join('');
    var opts = ['<option value="">Standalone (not tied to a round)</option>'];
    game.rounds.forEach(function (r) {
      opts.push('<option value="' + r.index + '"' + (r.index === game.rounds.length ? ' selected' : '') + '>Round ' + r.index + '</option>');
    });
    $('#adjRound').innerHTML = opts.join('');
    adjDialog.showModal();
  }
  $('#adjForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var game = store.currentGame();
    if (!game) return;
    var hadWinner = E.hasWinner(game);
    var raw = $('#adjDelta').value.trim().replace(/^\+/, '');
    var delta = parseInt(raw, 10);
    if (!Number.isFinite(delta) || delta === 0) {
      var err = $('#adjError');
      err.textContent = 'Enter a non-zero whole number, e.g. 3 or -4.';
      err.hidden = false;
      return;
    }
    var roundVal = $('#adjRound').value;
    E.addAdjustment(
      game,
      $('#adjPlayer').value,
      delta,
      $('#adjLabel').value.trim() || 'Correction',
      roundVal === '' ? null : E.toInt(roundVal),
      Date.now()
    );
    store.touch(game);
    adjDialog.close();
    renderAll();
    toast('Correction saved (' + signed(delta) + ')');
    if (!hadWinner && E.hasWinner(game)) confetti();
  });

  /* ---------- players ---------- */
  var playersDialog = $('#playersDialog');
  function renderPlayersList() {
    var game = store.currentGame();
    if (!game) return;
    $('#playersList').innerHTML = game.players.map(function (p) {
      return '<li>' + dotHtml(p) +
        '<input type="text" value="' + esc(p.name) + '" maxlength="24" data-rename="' + esc(p.id) + '" aria-label="Rename ' + esc(p.name) + '">' +
        '<button type="button" class="chip-btn" data-remove="' + esc(p.id) + '">Remove</button></li>';
    }).join('');
  }
  function openPlayersDialog() {
    if (!store.currentGame()) { openNewGameDialog(); return; }
    renderPlayersList();
    playersDialog.showModal();
  }
  $('#playersList').addEventListener('change', function (e) {
    var input = e.target.closest('[data-rename]');
    if (!input) return;
    var game = store.currentGame();
    if (!game) return;
    E.renamePlayer(game, input.getAttribute('data-rename'), input.value);
    store.touch(game);
    renderPlayersList();
    renderAll();
  });
  $('#playersList').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-remove]');
    if (!btn) return;
    var game = store.currentGame();
    if (!game) return;
    var p = game.players.find(function (x) { return x.id === btn.getAttribute('data-remove'); });
    if (!p) return;
    if (game.players.length <= 1) { toast('A game needs at least one player'); return; }
    confirmAction('Remove ' + p.name + '? Their scores and corrections are removed from this game too.', 'Remove player')
      .then(function (ok) {
        if (!ok) return;
        E.removePlayer(game, p.id);
        store.touch(game);
        renderPlayersList();
        renderAll();
        toast(p.name + ' removed');
      });
  });
  $('#addPlayerForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var game = store.currentGame();
    var name = $('#addPlayerName').value.trim();
    if (!game || !name) return;
    if (game.players.length >= 8) { toast('8 players max (with expansion)'); return; }
    var p = E.addPlayer(game, name);
    store.touch(game);
    $('#addPlayerName').value = '';
    renderPlayersList();
    renderAll();
    toast(p.name + ' joined');
  });

  /* ---------- edit game ---------- */
  var editGameDialog = $('#editGameDialog');
  $('#editGameBtn').addEventListener('click', function () {
    var game = store.currentGame();
    if (!game) return;
    $('#editGameName').value = game.name;
    $('#editGameTarget').value = game.targetScore;
    editGameDialog.showModal();
  });
  $('#editGameForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var game = store.currentGame();
    if (!game) return;
    game.name = $('#editGameName').value.trim() || game.name;
    var t = E.toInt($('#editGameTarget').value);
    if (t >= 1) game.targetScore = t;
    store.touch(game);
    editGameDialog.close();
    renderAll();
    toast('Game updated');
  });

  /* ---------- reset ---------- */
  $('#resetBtn').addEventListener('click', function () {
    var game = store.currentGame();
    if (!game) return;
    confirmAction('Reset "' + game.name + '"? All rounds and corrections are cleared. Players and target stay.', 'Reset scores')
      .then(function (ok) {
        if (!ok) return;
        E.resetGame(game);
        store.touch(game);
        renderAll();
        toast('Fresh scoreboard — same crew');
      });
  });

  /* ---------- export ---------- */
  $('#exportBtn').addEventListener('click', function () {
    var game = store.currentGame();
    if (!game) return;
    $('#exportText').value = E.exportText(game);
    $('#exportDialog').showModal();
  });
  $('#copyExportBtn').addEventListener('click', function () {
    var text = $('#exportText').value;
    function fallback() {
      $('#exportText').select();
      try { document.execCommand('copy'); toast('Copied'); }
      catch (e) { toast('Select the text and copy manually'); }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast('Copied to clipboard'); }, fallback);
    } else { fallback(); }
  });

  /* ---------- settings dialog ---------- */
  $('#settingsBtn').addEventListener('click', function () {
    var s = store.state.settings;
    $('#setBigType').checked = s.bigType;
    $('#setSound').checked = s.soundOn;
    $('#setTheme').value = s.darkMode;
    $('#setInputMode').value = s.defaultInputMode;
    $('#settingsDialog').showModal();
  });
  $('#setBigType').addEventListener('change', function (e) { store.updateSettings({ bigType: e.target.checked }); applySettings(); });
  $('#setSound').addEventListener('change', function (e) { store.updateSettings({ soundOn: e.target.checked }); });
  $('#setTheme').addEventListener('change', function (e) { store.updateSettings({ darkMode: e.target.value }); applySettings(); });
  $('#setInputMode').addEventListener('change', function (e) { store.updateSettings({ defaultInputMode: e.target.value }); });

  /* ---------- global buttons & dialog close plumbing ---------- */
  $('#homeAddRound').addEventListener('click', function () { openRoundDialog(); });
  $('#addRoundBtn').addEventListener('click', function () { openRoundDialog(); });
  $('#homeNewGame').addEventListener('click', openNewGameDialog);
  $('#addAdjBtn').addEventListener('click', openAdjDialog);
  $('#playersBtn').addEventListener('click', openPlayersDialog);
  document.addEventListener('click', function (e) {
    if (e.target.closest('[data-action="new-game"]')) openNewGameDialog();
    var closeBtn = e.target.closest('[data-close]');
    if (closeBtn) {
      var dlg = closeBtn.closest('dialog');
      if (dlg) dlg.close();
    }
  });
  // Close any sheet when its backdrop is tapped.
  $$('dialog.sheet').forEach(function (dlg) {
    dlg.addEventListener('click', function (e) {
      if (e.target === dlg) dlg.close();
    });
  });

  /* ---------- first paint ---------- */
  showTab('home');
  renderAll();
})();
