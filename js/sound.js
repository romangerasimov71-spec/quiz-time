/* Тихие звуки «верно» / «неверно» через WebAudio. Без файлов.
   Состояние кнопки звука хранится в QuizStore ('sound' = 'on' | 'off'), читается после
   QuizStore.init(). Пока идёт реклама (площадка поставила паузу) — звука нет. */
window.QuizSound = (function () {
  var ctx = null;
  var enabled = null;   // читаем из хранилища при первом обращении (после QuizStore.init)
  function on() { if (enabled === null) enabled = QuizStore.get('sound') !== 'off'; return enabled; }
  function quiet() { return !on() || (window.Platform && Platform.isPaused && Platform.isPaused()); }

  function audio() {
    if (!ctx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try { ctx = new AC(); } catch (e) { return null; }
    }
    if (ctx.state === 'suspended') { try { ctx.resume(); } catch (e) { /* ничего */ } }
    return ctx;
  }

  function tone(freq, start, dur, type, vol, freqEnd) {
    var c = audio();
    if (!c) return;
    var t0 = c.currentTime + start;
    var osc = c.createOscillator();
    var gain = c.createGain();
    osc.type = type || 'sine';
    osc.frequency.setValueAtTime(freq, t0);
    if (freqEnd) osc.frequency.exponentialRampToValueAtTime(freqEnd, t0 + dur);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(vol || 0.08, t0 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain); gain.connect(c.destination);
    osc.start(t0); osc.stop(t0 + dur + 0.05);
  }

  return {
    isOn: on,
    toggle: function () {
      enabled = !on();
      QuizStore.set('sound', enabled ? 'on' : 'off', true);
      if (enabled) tone(660, 0, 0.12, 'sine', 0.05);
      return enabled;
    },
    /* Вызывать по первому нажатию — браузеры разрешают звук только после жеста. */
    unlock: function () { if (on()) audio(); },
    correct: function () {
      if (quiet()) return;
      tone(659, 0, 0.14, 'sine', 0.07);
      tone(988, 0.12, 0.22, 'sine', 0.07);
    },
    wrong: function () {
      if (quiet()) return;
      tone(220, 0, 0.32, 'triangle', 0.09, 150);
    }
  };
})();
