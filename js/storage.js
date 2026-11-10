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
  /* Лучший результат: только целое число от 0 до max. Испорченное значение
     (например «99» при 10 вопросах) не показываем, как будто теста не было. */
  function getBest(testId, max) {
    var raw = get('best:' + testId);
    if (raw == null || !/^\d+$/.test(String(raw).trim())) return null;
    var v = parseInt(raw, 10);
    if (v < 0 || (max != null && v > max)) return null;
    return v;
  }
  function setBest(testId, score) { set('best:' + testId, score); }
  return { get: get, set: set, getBest: getBest, setBest: setBest };
})();
