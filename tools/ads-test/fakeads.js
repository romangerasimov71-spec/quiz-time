/*
 * Ads test kit: fake platform ads for any HTML5 game on Playgama Bridge (made for Bridge 2.4.1).
 * Load it into the page BEFORE the game (Playwright: page.addInitScript). It does not touch the game.
 *
 * As soon as the game creates window.bridge, the kit waits for bridge.initialize() and then
 * replaces showRewarded / showInterstitial on bridge.advertisement:
 *   - like Bridge 2.4.1, both methods return undefined; the result comes only as state events,
 *     later (asynchronously): loading -> opened -> rewarded -> closed, or loading -> failed;
 *   - the states go through Bridge's own internal path (_platformBridge._setRewardedState /
 *     _setInterstitialState), so the game also gets the platform pause / audio events exactly as on
 *     a real platform. If those internals are missing, the kit sends the ad events itself and calls
 *     the game's pause / audio handlers from bridge.platform.on.
 *
 * What the ads do is set from the test: window.__adsKit.mode = { rewarded: ..., interstitial: ... }
 *   rewarded:     'ok' (watched to the end) | 'cancel' (closed early, no reward) | 'fail' (failed)
 *                 | 'double' (watched, "rewarded" comes twice inside the same show)
 *                 | 'silent' (never answers) | 'late' (answers only when the test calls playPending())
 *   interstitial: 'ok' | 'fail' | 'silent'
 * Timings (ms after the show call): window.__adsKit.timing.
 * window.__adsKitStandalone = true (set before this script) forces the standalone mode (to test the kit).
 * The kit also watches the page sound (AudioContext, <audio>/<video>, Howler) for soundOff().
 */
(function () {
  'use strict';
  if (window.__adsKit) return;
  var kit = window.__adsKit = {
    mode: { rewarded: 'ok', interstitial: 'ok' },
    timing: { loading: 50, opened: 150, watch: 1500, fail: 300, interstitialWatch: 1500 },
    log: [],               // 'showRewarded:<placement>', 'rewarded:opened', ...
    calls: { rewarded: 0, interstitial: 0 },
    pending: [],           // rewarded requests that did not answer yet (silent / late)
    installed: '',         // 'bridge-internals' | 'standalone' once the fake is in place
    rewardedState: 'closed', interstitialState: 'closed'
  };
  var bridgeRef = null, pb = null, EV = {}, platformHandlers = { pause: [], audio: [] };

  function note(s) { kit.log.push(s); }
  function evName(key, fallback) { return (EV && EV[key]) || fallback; }

  // ---- sending states
  var standaloneCbs = {};
  function sendRewarded(state) {
    kit.rewardedState = state;
    note('rewarded:' + state);
    if (pb) { pb._setRewardedState(state); return; }
    (standaloneCbs[evName('REWARDED_STATE_CHANGED', 'rewarded_state_changed')] || []).forEach(function (f) { f(state); });
    var on = state === 'opened' || state === 'rewarded';
    if (state !== 'loading') platformPause(on);
  }
  function sendInterstitial(state) {
    kit.interstitialState = state;
    note('interstitial:' + state);
    if (pb) { pb._setInterstitialState(state); return; }
    (standaloneCbs[evName('INTERSTITIAL_STATE_CHANGED', 'interstitial_state_changed')] || []).forEach(function (f) { f(state); });
    if (state !== 'loading') platformPause(state === 'opened');
  }
  function platformPause(on) {
    platformHandlers.pause.forEach(function (f) { try { f(on); } catch (e) { /* game handler */ } });
    platformHandlers.audio.forEach(function (f) { try { f(!on); } catch (e) { /* game handler */ } });
  }
  function later(ms, fn) { setTimeout(fn, ms); }

  // one rewarded ad, from loading to the end; how = 'ok' | 'cancel' | 'fail' | 'double'
  function playRewarded(how) {
    var T = kit.timing;
    later(T.loading, function () { sendRewarded('loading'); });
    if (how === 'fail') { later(T.fail, function () { sendRewarded('failed'); }); return; }
    later(T.opened, function () { sendRewarded('opened'); });
    if (how === 'ok' || how === 'double') later(T.opened + T.watch, function () { sendRewarded('rewarded'); });
    // 'double': the platform reports "rewarded" twice inside one show (seen on some platforms)
    if (how === 'double') later(T.opened + T.watch + 50, function () { sendRewarded('rewarded'); });
    later(T.opened + T.watch + 100, function () { sendRewarded('closed'); });
  }
  function playInterstitial(how) {
    var T = kit.timing;
    later(T.loading, function () { sendInterstitial('loading'); });
    if (how === 'fail') { later(T.fail, function () { sendInterstitial('failed'); }); return; }
    later(T.opened, function () { sendInterstitial('opened'); });
    later(T.opened + T.interstitialWatch, function () { sendInterstitial('closed'); });
  }

  function showRewarded(placement) {
    kit.calls.rewarded++;
    note('showRewarded:' + (placement === undefined ? '' : placement));
    var m = kit.mode.rewarded;
    if (m === 'silent' || m === 'late') kit.pending.push(m);
    else playRewarded(m);
    return undefined;            // Bridge 2.4.1: no promise, only state events
  }
  function showInterstitial(placement) {
    kit.calls.interstitial++;
    note('showInterstitial:' + (placement === undefined ? '' : placement));
    var m = kit.mode.interstitial;
    if (m !== 'silent') playInterstitial(m);
    return undefined;
  }

  // for the runner: the late ad finally shows (watched to the end by default)
  kit.playPending = function (how) {
    var p = kit.pending.shift();
    if (!p) return false;
    playRewarded(how || 'ok');
    return true;
  };
  // for the runner: send a single state as the platform would (e.g. a stray second "rewarded")
  kit.sendRewarded = sendRewarded;
  kit.sendInterstitial = sendInterstitial;

  // ---- installing the fake
  function define(obj, name, desc) {
    try { Object.defineProperty(obj, name, Object.assign({ configurable: true }, desc)); return true; } catch (e) { return false; }
  }
  function install(b) {
    if (kit.installed) return;
    EV = b.EVENT_NAME || {};
    // remember the game's pause / audio handlers (used only in standalone mode); read b.platform only
    // after initialize(): Bridge logs an error when its modules are touched earlier
    try {
      var plat = b.platform, on = plat && plat.on && plat.on.bind(plat);
      if (on) plat.on = function (n, cb) {
        if (n === evName('PAUSE_STATE_CHANGED', 'pause_state_changed')) platformHandlers.pause.push(cb);
        if (n === evName('AUDIO_STATE_CHANGED', 'audio_state_changed')) platformHandlers.audio.push(cb);
        return on(n, cb);
      };
    } catch (e) { /* no platform module */ }
    var adv = b.advertisement;
    var q = adv && adv._platformBridge;
    if (!window.__adsKitStandalone && q && typeof q._setRewardedState === 'function' && typeof q._setInterstitialState === 'function') {
      pb = q;
      define(adv, 'isRewardedSupported', { get: function () { return true; } });
      define(adv, 'isInterstitialSupported', { get: function () { return true; } });
      define(adv, 'rewardedState', { get: function () { return kit.rewardedState; } });
      define(adv, 'interstitialState', { get: function () { return kit.interstitialState; } });
      define(adv, 'showRewarded', { value: showRewarded, writable: true });
      define(adv, 'showInterstitial', { value: showInterstitial, writable: true });
      kit.installed = 'bridge-internals';
    } else {
      var fake = {
        isRewardedSupported: true, isInterstitialSupported: true, isBannerSupported: false,
        get rewardedState() { return kit.rewardedState; },
        get interstitialState() { return kit.interstitialState; },
        minimumDelayBetweenInterstitial: 0,
        setMinimumDelayBetweenInterstitial: function () {},
        on: function (n, cb) { (standaloneCbs[n] = standaloneCbs[n] || []).push(cb); },
        off: function (n, cb) { standaloneCbs[n] = (standaloneCbs[n] || []).filter(function (f) { return f !== cb; }); },
        showRewarded: showRewarded, showInterstitial: showInterstitial,
        showBanner: function () {}, hideBanner: function () {},
        checkAdBlock: function () { return Promise.resolve(false); }
      };
      define(b, 'advertisement', { get: function () { return fake; } });
      kit.installed = 'standalone';
    }
    note('installed:' + kit.installed);
  }
  function wrap(b) {
    if (!b || b === bridgeRef || typeof b.initialize !== 'function') return;
    bridgeRef = b;
    var init = b.initialize.bind(b);
    b.initialize = function () {
      var r = init.apply(null, arguments);
      return Promise.resolve(r).then(function (v) { install(b); return v; });
    };
  }
  // the bridge script does `window.bridge = new Bridge()`: catch that moment
  var current = window.bridge;
  try {
    Object.defineProperty(window, 'bridge', {
      configurable: true,
      get: function () { return current; },
      set: function (v) { current = v; wrap(v); }
    });
  } catch (e) { /* fall back to polling */ }
  if (current) wrap(current);
  var poll = setInterval(function () {
    if (window.bridge && window.bridge !== bridgeRef) wrap(window.bridge);
    if (kit.installed) clearInterval(poll);
  }, 20);

  // ---- sound watch
  var contexts = [], media = [];
  ['AudioContext', 'webkitAudioContext'].forEach(function (name) {
    var Orig = window[name];
    if (!Orig) return;
    var Wrapped = function () {
      var c = new (Function.prototype.bind.apply(Orig, [null].concat([].slice.call(arguments))))();
      contexts.push(c);
      return c;
    };
    Wrapped.prototype = Orig.prototype;
    try { window[name] = Wrapped; } catch (e) { /* read-only */ }
  });
  if (window.Audio) {
    var OrigAudio = window.Audio;
    window.Audio = function (src) { var a = new OrigAudio(src); media.push(a); return a; };
    window.Audio.prototype = OrigAudio.prototype;
  }
  // true when nothing can be heard: every AudioContext is suspended / closed, every media element is
  // paused or muted, Howler (if any) is muted. A game that mutes with a gain node only needs its own check.
  kit.soundOff = function () {
    var all = media.concat([].slice.call(document.querySelectorAll('audio, video')));
    var ctxOn = contexts.some(function (c) { return c.state === 'running'; });
    var mediaOn = all.some(function (m) { return !m.paused && !m.muted && m.volume > 0; });
    var howlerOn = !!(window.Howler && !window.Howler._muted && window.Howler.ctx && window.Howler.ctx.state === 'running');
    return !ctxOn && !mediaOn && !howlerOn;
  };
  kit.soundInfo = function () {
    return { contexts: contexts.map(function (c) { return c.state; }), media: media.length + document.querySelectorAll('audio, video').length };
  };
})();
