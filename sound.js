/*
 * Pile On — table sounds. A frantic card race lives on audio feedback; this is
 * a tiny dependency-free WebAudio synth (no samples to ship, works offline).
 * Every sound is short (<200ms) and gated on a persisted mute toggle. The
 * AudioContext is created lazily on the first user gesture (autoplay policy).
 * window.BlitzSound.
 */
(function (global) {
  'use strict';

  var KEY = 'pileon.sound';
  var ctx = null;
  var muted = false;
  try { muted = localStorage.getItem(KEY) === 'off'; } catch (e) { /* fine */ }

  function ensure() {
    if (muted) return null;
    if (!ctx) {
      var AC = global.AudioContext || global.webkitAudioContext;
      if (!AC) return null;
      try { ctx = new AC(); } catch (e) { return null; }
    }
    if (ctx.state === 'suspended') { try { ctx.resume(); } catch (e) { /* ignore */ } }
    return ctx;
  }

  /** One shaped oscillator note. */
  function tone(freq, dur, type, gain, slideTo) {
    var c = ensure();
    if (!c) return;
    var t0 = c.currentTime;
    var osc = c.createOscillator();
    var g = c.createGain();
    osc.type = type || 'sine';
    osc.frequency.setValueAtTime(freq, t0);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain || 0.14, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g); g.connect(c.destination);
    osc.start(t0); osc.stop(t0 + dur + 0.02);
  }

  function noise(dur, gain) {
    var c = ensure();
    if (!c) return;
    var n = Math.floor(c.sampleRate * dur);
    var buf = c.createBuffer(1, n, c.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
    var src = c.createBufferSource(); src.buffer = buf;
    var g = c.createGain(); g.gain.value = gain || 0.08;
    src.connect(g); g.connect(c.destination);
    src.start();
  }

  var API = {
    isMuted: function () { return muted; },
    toggle: function () {
      muted = !muted;
      try { localStorage.setItem(KEY, muted ? 'off' : 'on'); } catch (e) { /* fine */ }
      if (!muted) API.play('flip'); // little confirmation blip
      return muted;
    },
    // called from a user gesture so the context can start
    unlock: function () { ensure(); },
    play: function (kind, opts) {
      opts = opts || {};
      switch (kind) {
        case 'play': {
          // a "thock" whose pitch climbs with the pile value (1→10), so a
          // completing pile audibly ascends
          var v = Math.max(1, Math.min(10, opts.value || 1));
          tone(300 + v * 34, 0.11, 'triangle', 0.13);
          break;
        }
        case 'complete': tone(660, 0.10, 'sine', 0.14); tone(990, 0.16, 'sine', 0.11); break;
        case 'flip': noise(0.09, 0.06); break;
        case 'reject': tone(150, 0.14, 'sawtooth', 0.10, 90); break;
        case 'oppdrop': tone(520, 0.05, 'sine', 0.05); break;
        case 'deal': noise(0.16, 0.05); tone(440, 0.08, 'sine', 0.06); break;
        case 'blitz':
          // a rising 3-note stinger — the payoff of the whole round
          tone(523, 0.12, 'triangle', 0.16);
          setTimeout(function () { tone(659, 0.12, 'triangle', 0.16); }, 90);
          setTimeout(function () { tone(880, 0.22, 'triangle', 0.18); }, 190);
          break;
      }
    },
  };

  global.BlitzSound = API;
})(typeof self !== 'undefined' ? self : this);
