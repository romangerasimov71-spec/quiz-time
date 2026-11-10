/* Тест «Проверь память». Все вопросы — типа «запомни» (type: 'memory').
   Вопросы ГЕНЕРИРУЮТСЯ заново при каждом прохождении: случайные предметы, количества
   и места, а верный ответ вычисляется из того, что показали. Лестница сложности
   постоянная: от 3 до 7 предметов, время показа растёт с 4 до 8 секунд.

   Как это устроено для движка: вопрос с полем make() — движок вызывает make() в начале
   прохождения и получает обычный вопрос «запомни»:
     { type: 'memory', kind, show: [...], cols, seconds, q, a: [верный, ...] }
   Элемент show: эмодзи, '' (пустая клетка) или { color: '#rrggbb', name } (цветной кружок).
   kind — шаблон вопроса (по нему tools/check.js проверяет, что ответ верный). */
(function () {
  // Наборы картинок. Только старые эмодзи (2010 года) — их показывают даже старые телефоны.
  var SETS = {
    fruits: ['🍎', '🍌', '🍇', '🍐', '🍋', '🍓', '🍒', '🍉', '🍍', '🍑'],
    animals: ['🐱', '🐶', '🐰', '🐭', '🐻', '🐷', '🐸', '🐵', '🐔', '🐮'],
    transport: ['🚗', '🚲', '🚂', '✈️', '🚢', '🚌', '🚀', '🚜'],
    things: ['🔑', '⏰', '🎈', '👓', '✂️', '🔔', '✏️', '📚', '☂️', '⚽', '🎸', '🎩'],
    water: ['🐟', '🐢', '🐝', '🐞', '🐌', '🐙', '🐬', '🐳']
  };
  // Что считаем в вопросе «Сколько было …?» (родительный падеж множественного числа)
  var COUNTABLE = [
    { e: '🍎', name: 'яблок' }, { e: '⭐', name: 'звёздочек' }, { e: '🐟', name: 'рыбок' },
    { e: '🎈', name: 'шариков' }, { e: '🌸', name: 'цветочков' }, { e: '🐱', name: 'котиков' }
  ];
  var FILLERS = ['🍐', '🍋', '🌙', '☀️', '🍄', '🐶', '🔔', '🍓', '🐢', '⚽'];
  var COLORS = [
    { color: '#e53935', name: 'Красного' }, { color: '#fdd835', name: 'Жёлтого' },
    { color: '#43a047', name: 'Зелёного' }, { color: '#1e88e5', name: 'Синего' },
    { color: '#8e24aa', name: 'Фиолетового' }, { color: '#212121', name: 'Чёрного' }
  ];

  function rnd(n) { return Math.floor(Math.random() * n); }
  function shuffle(a) {
    a = a.slice();
    for (var i = a.length - 1; i > 0; i--) { var j = rnd(i + 1); var t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }
  function pick(arr, n) { return shuffle(arr).slice(0, n); }
  function pickSet(except) {
    var names = Object.keys(SETS).filter(function (k) { return k !== except; });
    return SETS[names[rnd(names.length)]];
  }

  // «Чего не было?» — n разных предметов; верный — тот, которого не показали
  function missing(n, cols, seconds) {
    return { make: function () {
      var items = pick(pickSet(), n + 1);
      var shown = items.slice(0, n);
      return { type: 'memory', kind: 'missing', show: shown, cols: cols, seconds: seconds,
        q: 'Чего не было?', a: [items[n]].concat(pick(shown, 3)) };
    } };
  }

  // «Кто был посередине?» — 3 в ряд
  function middle(seconds) {
    return { make: function () {
      var items = pick(SETS.animals, 4);
      var shown = items.slice(0, 3);
      return { type: 'memory', kind: 'middle', show: shown, cols: 3, seconds: seconds,
        q: 'Кто был посередине?', a: [shown[1], shown[0], shown[2], items[3]] };
    } };
  }

  // «Какого цвета НЕ было?» — n цветных кружков
  function colorMissing(n, seconds) {
    return { make: function () {
      var cs = pick(COLORS, n + 1);
      var shown = cs.slice(0, n);
      return { type: 'memory', kind: 'color-missing', show: shown, cols: n, seconds: seconds,
        q: 'Какого цвета НЕ было?', a: [cs[n].name].concat(pick(shown, 3).map(function (c) { return c.name; })) };
    } };
  }

  // «Сколько было …?» — n предметов, из них k одинаковых
  function count(n, cols, seconds, kMin, kMax) {
    return { make: function () {
      var target = COUNTABLE[rnd(COUNTABLE.length)];
      var k = kMin + rnd(kMax - kMin + 1);
      var fill = FILLERS.filter(function (f) { return f !== target.e; });
      var items = [];
      for (var i = 0; i < k; i++) items.push(target.e);
      for (var j = 0; j < n - k; j++) items.push(fill[rnd(fill.length)]);
      var shown = shuffle(items);
      // Неверные варианты — соседние числа
      var wrong = [k - 1, k + 1, k + 2, k - 2].filter(function (x) { return x >= 1 && x <= n + 1; }).slice(0, 3);
      return { type: 'memory', kind: 'count', target: target.e, show: shown, cols: cols, seconds: seconds,
        q: 'Сколько было ' + target.name + '?', a: [String(k)].concat(wrong.map(String)) };
    } };
  }

  // «Что было в центре?» — крест из 5 клеток в сетке 3×3
  function center(seconds) {
    return { make: function () {
      var items = pick(pickSet(), 5);
      var c = items[0];
      var around = items.slice(1);
      var show = ['', around[0], '', around[1], c, around[2], '', around[3], ''];
      return { type: 'memory', kind: 'center', show: show, cols: 3, seconds: seconds,
        q: 'Что было в центре?', a: [c].concat(pick(around, 3)) };
    } };
  }

  // «Кто был последним, справа?» — n в ряд
  function last(n, seconds) {
    return { make: function () {
      var shown = pick(SETS.water, n);
      return { type: 'memory', kind: 'last', show: shown, cols: n, seconds: seconds,
        q: 'Кто был последним, справа?', a: [shown[n - 1]].concat(pick(shown.slice(0, n - 1), 3)) };
    } };
  }

  // «Что было два раза?» — n клеток, один предмет повторяется
  function twice(n, cols, seconds) {
    return { make: function () {
      var uniq = pick(pickSet(), n - 1);
      var dup = uniq[0];
      var shown = shuffle(uniq.concat([dup]));
      return { type: 'memory', kind: 'twice', show: shown, cols: cols, seconds: seconds,
        q: 'Что было два раза?', a: [dup].concat(pick(uniq.slice(1), 3)) };
    } };
  }

  (window.QUIZ_TESTS = window.QUIZ_TESTS || []).push({
    id: 'memory',
    title: 'Проверь память',
    subtitle: 'Запомните картинку — и ответьте',
    intro: 'Покажем картинку на несколько секунд — потом спросим, что на ней было: сколько, где, чего не было.',
    emoji: '👀',
    color: '#006b78',
    color2: '#007c8a',
    keepOrder: true, // лестница сложности: порядок вопросов не перемешиваем
    questions: [
      missing(3, 3, 4),        // 3 предмета
      middle(4),               // 3
      colorMissing(4, 5),      // 4
      missing(4, 4, 5),        // 4
      count(5, 5, 5, 2, 3),    // 5
      center(6),               // 5
      last(5, 6),              // 5
      missing(6, 3, 7),        // 6
      twice(6, 3, 7),          // 6
      count(7, 4, 8, 3, 5)     // 7
    ],
    ranks: [
      { min: 0, title: 'Рассеянный с улицы Бассейной', text: 'Ничего страшного — память можно тренировать!' },
      { min: 4, title: 'Внимательный', text: 'Неплохо! Ещё немного тренировки — и будет отлично.' },
      { min: 7, title: 'Глаз-алмаз', text: 'Вы замечаете то, что другие пропускают!' },
      { min: 9, title: 'Память как у слона', text: 'Потрясающе! Вас не проведёшь.' }
    ]
  });
})();
