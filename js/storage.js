/* Хранилище «Викторин»: рекорды, «какие вопросы уже были», звук.
   Читаем один раз при запуске (QuizStore.init → Platform.load), дальше держим в памяти,
   изменения сохраняем через Platform.save: хранилище площадки (во ВК и ОК — облако игрока),
   без площадки — запасной localStorage. Нет ни того, ни другого (приватный режим, запрет
   в iframe) — приложение работает дальше и помнит всё до закрытия страницы.

   Ключи — как в прототипе: quiz-time:best:<id>, quiz-time:recent:<id>, quiz-time:sound,
   поэтому рекорды, набранные на GitHub Pages, не теряются. Значения — JSON
   (рекорд — число, «недавние» — массив, звук — 'on' / 'off'); старые записи прототипа
   (строки «7», «off», «[[…]]») читаются так же. Во ВК ключ очищается в platform.js
   («quiz-time_best_ussr» — правило ВК). */
window.QuizStore = (function () {
  var PREFIX = 'quiz-time:';
  var memory = {};      // ключ без приставки → значение
  var pending = {}, timer = 0, SAVE_DELAY = 1500;

  function PF() { return window.Platform || null; }

  function lsGet(full) {
    try {
      var v = window.localStorage.getItem(full);
      if (v == null) return null;
      try { return JSON.parse(v); } catch (e) { return v; }
    } catch (e) { return null; }
  }
  function lsSet(full, v) {
    try { window.localStorage.setItem(full, JSON.stringify(v)); } catch (e) { /* ничего */ }
  }

  /* Прочитать все нужные ключи одним вызовом. keys — без приставки ('best:ussr', 'sound', …). */
  function init(keys) {
    var full = keys.map(function (k) { return PREFIX + k; });
    var pf = PF();
    var load = pf && pf.load ? pf.load(full) : Promise.resolve(null);
    return Promise.resolve(load).then(function (data) {
      keys.forEach(function (k, i) {
        var v = data ? data[full[i]] : lsGet(full[i]);
        if (v != null && !Object.prototype.hasOwnProperty.call(memory, k)) memory[k] = v;
      });
    }, function () { /* без сохранённого */ });
  }

  function flush() {
    clearTimeout(timer); timer = 0;
    var keys = Object.keys(pending);
    if (!keys.length) return;
    var obj = {};
    keys.forEach(function (k) { obj[PREFIX + k] = pending[k]; });
    pending = {};
    var pf = PF();
    if (pf && pf.save) pf.save(obj);
    else keys.forEach(function (k) { lsSet(PREFIX + k, obj[PREFIX + k]); });
  }

  function get(key) {
    return Object.prototype.hasOwnProperty.call(memory, key) ? memory[key] : null;
  }
  /* now = true — сохранить сразу (рекорд); иначе изменения копятся и уходят одним вызовом
     через полторы секунды (и сразу, когда вкладку прячут или закрывают). */
  function set(key, value, now) {
    memory[key] = value;
    pending[key] = value;
    if (now) flush();
    else if (!timer) timer = setTimeout(flush, SAVE_DELAY);
  }

  /* Лучший результат: только целое число от 0 до max. Испорченное значение
     (например «99» при 10 вопросах) не показываем, как будто теста не было. */
  function getBest(testId, max) {
    var raw = get('best:' + testId);
    if (raw == null || !/^\d+$/.test(String(raw).trim())) return null;
    var v = parseInt(raw, 10);
    if (v < 0 || (max != null && v > max)) return null;
    return v;
  }
  function setBest(testId, score) { set('best:' + testId, score, true); }

  try {
    document.addEventListener('visibilitychange', function () { if (document.hidden) flush(); });
    window.addEventListener('pagehide', flush);
  } catch (e) { /* ничего */ }

  return { init: init, get: get, set: set, flush: flush, getBest: getBest, setBest: setBest, PREFIX: PREFIX };
})();
