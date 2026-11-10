/* Безопасное хранилище: если localStorage недоступен (приватный режим,
   запрет в iframe), приложение работает дальше, просто ничего не помнит. */
window.QuizStore = (function () {
  var PREFIX = 'quiz-time:';
  var memory = {};
  function get(key) {
    try {
      var v = window.localStorage.getItem(PREFIX + key);
      if (v !== null) return v;
    } catch (e) { /* хранилище недоступно */ }
    return Object.prototype.hasOwnProperty.call(memory, key) ? memory[key] : null;
  }
  function set(key, value) {
    memory[key] = String(value);
    try { window.localStorage.setItem(PREFIX + key, String(value)); } catch (e) { /* ничего */ }
  }
  function getBest(testId) {
    var v = parseInt(get('best:' + testId), 10);
    return isNaN(v) ? null : v;
  }
  function setBest(testId, score) { set('best:' + testId, score); }
  return { get: get, set: set, getBest: getBest, setBest: setBest };
})();
