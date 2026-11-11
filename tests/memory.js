/* Тест «Проверь память». Все вопросы — типа «запомни» (type: 'memory').
   Вопросы ГЕНЕРИРУЮТСЯ заново при каждом прохождении: случайные предметы, количества
   и места, а верный ответ вычисляется из того, что показали. Лестница сложности
   постоянная: от 3 до 7 предметов, время показа растёт с 4 до 8 секунд.

   Как это устроено для движка: вопрос с полем make() — движок вызывает make() в начале
   прохождения и получает обычный вопрос «запомни»:
     { type: 'memory', kind, show: [...], cols, seconds, q, a: [верный, ...] }
   Элемент show: эмодзи, '' (пустая клетка) или { color: '#rrggbb', name } (цветной кружок).
   layout — раскладка картинки (на каждом шаге своя, как раньше); kind — какой вопрос задан
   к ней в этот раз (по нему tools/check.js проверяет, что верный ответ посчитан по показанному). */
(function () {
  // Наборы картинок. Только старые эмодзи (2010 года) — их показывают даже старые телефоны.
  var SETS = {
    fruits: ['🍎', '🍌', '🍇', '🍐', '🍋', '🍓', '🍒', '🍉', '🍍', '🍑'],
    animals: ['🐱', '🐶', '🐰', '🐭', '🐻', '🐷', '🐸', '🐵', '🐔', '🐮'],
    transport: ['🚗', '🚲', '🚂', '✈️', '🚢', '🚌', '🚀', '🚜'],
    things: ['🔑', '⏰', '🎈', '👓', '✂️', '🔔', '✏️', '📚', '☂️', '⚽', '🎸', '🎩'],
    water: ['🐟', '🐢', '🐝', '🐞', '🐌', '🐙', '🐬', '🐳']
  };
  // Картинки для раскладок «сколько / чего больше всего»: все из одного набора и у всех есть название
  // для «Сколько было …?» (родительный падеж мн. ч.). Повторяется любая из них, остальные клетки —
  // другие из этого же набора, поэтому по набору нельзя угадать ни что повторялось, ни что спросят.
  var COUNTABLE = [
    { e: '🍎', name: 'яблок' }, { e: '⭐', name: 'звёздочек' }, { e: '🐟', name: 'рыбок' },
    { e: '🎈', name: 'шариков' }, { e: '🌸', name: 'цветочков' }, { e: '🐱', name: 'котиков' },
    { e: '🍐', name: 'груш' }, { e: '🍋', name: 'лимонов' }, { e: '☀️', name: 'солнышек' },
    { e: '🍄', name: 'грибочков' }, { e: '🐶', name: 'собачек' }, { e: '🔔', name: 'колокольчиков' },
    { e: '🍓', name: 'клубничек' }, { e: '🐢', name: 'черепашек' }, { e: '⚽', name: 'мячиков' }
  ];
  // Неверные варианты «Сколько было …?» — 4 соседних числа, верное — на случайном месте по величине.
  // Вес места (0 — самое маленькое … 3 — самое большое) для каждого шага: при малом k (2–3)
  // самым большим верное быть не может (нужны три меньших числа без нуля), поэтому на шаге из 5
  // «третье» выпадает чаще, а на шаге из 7 клеток (k 3–5) — «самое большое»: в сумме по тесту каждое
  // место ~21–29 % (проверяет tools/check.js на 2000 вопросах).
  var COUNT_PLACE_WEIGHTS = { count5: [1, 1, 2, 0], count7: [1, 1, 1, 5] };
  var COLORS = [
    { color: '#e53935', name: 'Красного' }, { color: '#fdd835', name: 'Жёлтого' },
    { color: '#43a047', name: 'Зелёного' }, { color: '#1e88e5', name: 'Синего' },
    { color: '#8e24aa', name: 'Фиолетового' }, { color: '#212121', name: 'Чёрного' },
    { color: '#fb8c00', name: 'Оранжевого' }, { color: '#81d4fa', name: 'Голубого' }
  ];

  function rnd(n) { return Math.floor(Math.random() * n); }
  function shuffle(a) {
    a = a.slice();
    for (var i = a.length - 1; i > 0; i--) { var j = rnd(i + 1); var t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }
  function pick(arr, n) { return shuffle(arr).slice(0, n); }
  function one(arr) { return arr[rnd(arr.length)]; }
  // Набор, в котором хватает картинок на показ и на неверные варианты (need штук)
  function pickSet(need) {
    var names = Object.keys(SETS).filter(function (k) { return SETS[k].length >= (need || 0); });
    return SETS[names[rnd(names.length)]];
  }

  /* Решение Романа 11 ноя: к одной и той же раскладке задаём случайно один из нескольких
     равных по трудности вопросов — чтобы по картинке нельзя было заранее понять, что спросят
     (и запоминать одну клетку). Раскладки, порядок и трудность шагов — прежние.
     layout — раскладка (одна на шаг), kind — какой вопрос задан (по нему tools/check.js
     проверяет, что верный ответ посчитан по показанному). */
  function q(layout, kind, show, cols, seconds, text, a, extra) {
    var out = { type: 'memory', layout: layout, kind: kind, show: show, cols: cols, seconds: seconds, q: text, a: a };
    for (var k in extra || {}) out[k] = extra[k];
    return out;
  }
  // «Чего не было?»: верный — не показанный; неверные — три показанных
  function askMissing(layout, shown, pool, cols, seconds) {
    var uniq = shown.filter(function (x, i) { return x !== '' && shown.indexOf(x) === i; });
    var absent = pool.filter(function (x) { return uniq.indexOf(x) < 0; });
    return q(layout, 'missing', shown, cols, seconds, 'Чего не было?', [one(absent)].concat(pick(uniq, 3)));
  }
  // «Что было на картинке?»: верный — показанный; неверные — три не показанных
  function askPresent(layout, shown, pool, cols, seconds) {
    var uniq = shown.filter(function (x, i) { return x !== '' && shown.indexOf(x) === i; });
    var absent = pool.filter(function (x) { return uniq.indexOf(x) < 0; });
    return q(layout, 'present', shown, cols, seconds, 'Что было на картинке?', [one(uniq)].concat(pick(absent, 3)));
  }
  // «Кто/что был(о) <место>?»: верный — клетка at; неверные — другие показанные (не хватает — не показанные)
  function askAt(layout, shown, pool, cols, seconds, at, text) {
    var others = shown.filter(function (x, i) { return i !== at && x !== ''; });
    var wrong = pick(others, 3);
    if (wrong.length < 3) wrong = wrong.concat(pick(pool.filter(function (x) { return shown.indexOf(x) < 0; }), 3 - wrong.length));
    return q(layout, 'pos', shown, cols, seconds, text, [shown[at]].concat(wrong), { at: at });
  }

  // n разных предметов в ряд или сеткой: «чего не было» / «что было»
  //   (3 в ряд — ещё и «кто слева / посередине / справа»)
  function lineup(layout, n, cols, seconds, setName) {
    return { make: function () {
      var pool = setName ? SETS[setName] : pickSet(n + 3);
      var shown = pick(pool, n);
      var who = setName === 'animals' ? 'Кто был ' : 'Что было ';
      var asks = [
        function () { return askMissing(layout, shown, pool, cols, seconds); },
        function () { return askPresent(layout, shown, pool, cols, seconds); }
      ];
      if (n === 3) {
        asks.push(function () { return askAt(layout, shown, pool, cols, seconds, 0, who + 'слева?'); });
        asks.push(function () { return askAt(layout, shown, pool, cols, seconds, 1, who + 'посередине?'); });
        asks.push(function () { return askAt(layout, shown, pool, cols, seconds, 2, who + 'справа?'); });
      }
      var out = one(asks)();
      if (setName === 'animals' && out.kind === 'present') out.q = 'Кто был на картинке?';
      return out;
    } };
  }

  // n цветных кружков: «какого цвета НЕ было» / «кружок какого цвета был»
  function colors(n, seconds) {
    return { make: function () {
      var shown = pick(COLORS, n);
      var absent = COLORS.filter(function (c) { return shown.indexOf(c) < 0; });
      var name = function (c) { return c.name; };
      if (rnd(2)) return q('colors', 'color-missing', shown, n, seconds, 'Какого цвета НЕ было?', [one(absent).name].concat(pick(shown, 3).map(name)));
      return q('colors', 'color-present', shown, n, seconds, 'Кружок какого цвета был на картинке?', [one(shown).name].concat(pick(absent, 3).map(name)));
    } };
  }

  // Случайное место по весам: веса [w0, w1, …] → номер
  function weighted(w) {
    var sum = 0, i;
    for (i = 0; i < w.length; i++) sum += w[i];
    var x = Math.random() * sum;
    for (i = 0; i < w.length; i++) { x -= w[i]; if (x < 0 && w[i] > 0) return i; }
    for (i = w.length - 1; i >= 0; i--) if (w[i] > 0) return i;
    return 0;
  }

  // n предметов, из них k одинаковых (остальные — разные): «сколько было …» / «чего было
  // больше всего» / «чего не было»
  function count(layout, n, cols, seconds, kMin, kMax) {
    return { make: function () {
      var target = COUNTABLE[rnd(COUNTABLE.length)];
      var k = kMin + rnd(kMax - kMin + 1);
      var fill = pick(COUNTABLE.filter(function (c) { return c !== target; }), n - k).map(function (c) { return c.e; });
      var items = fill.slice();
      for (var i = 0; i < k; i++) items.push(target.e);
      var shown = shuffle(items);
      var pool = COUNTABLE.map(function (c) { return c.e; });
      var v = rnd(3);
      if (v === 1) {
        // неверные — то, что тоже было на картинке, но по одному разу; не хватает — не показанные
        var wrongMost = pick(fill, 3);
        if (wrongMost.length < 3) wrongMost = wrongMost.concat(pick(pool.filter(function (x) { return shown.indexOf(x) < 0; }), 3 - wrongMost.length));
        return q(layout, 'most', shown, cols, seconds, 'Чего было больше всего?', [target.e].concat(wrongMost));
      }
      if (v === 2) return askMissing(layout, shown, pool, cols, seconds);
      // 4 соседних числа от 1 до n + 1; верное k — на месте place по величине
      var w = (COUNT_PLACE_WEIGHTS[layout] || [1, 1, 1, 1]).map(function (x, p) {
        var lo = k - p;
        return lo >= 1 && lo + 3 <= n + 1 ? x : 0;
      });
      var lo = k - weighted(w);
      var nums = [lo, lo + 1, lo + 2, lo + 3].filter(function (x) { return x !== k; });
      return q(layout, 'count', shown, cols, seconds, 'Сколько было ' + target.name + '?', [String(k)].concat(nums.map(String)), { target: target.e });
    } };
  }

  // Крест из 5 клеток в сетке 3×3: что было в центре / сверху / снизу / слева / справа
  function cross(seconds) {
    return { make: function () {
      var pool = pickSet(8);
      var items = pick(pool, 5);
      var show = ['', items[1], '', items[2], items[0], items[3], '', items[4], ''];
      var places = [[4, 'Что было в центре?'], [1, 'Что было сверху?'], [7, 'Что было снизу?'], [3, 'Что было слева?'], [5, 'Что было справа?']];
      var p = one(places);
      return askAt('cross', show, pool, 3, seconds, p[0], p[1]);
    } };
  }

  // n в ряд (морские жители): кто первый слева / посередине / последний справа
  function row(n, seconds) {
    return { make: function () {
      var shown = pick(SETS.water, n);
      var places = [[0, 'Кто был первым, слева?'], [Math.floor(n / 2), 'Кто был посередине?'], [n - 1, 'Кто был последним, справа?']];
      var p = one(places);
      return askAt('row' + n, shown, SETS.water, n, seconds, p[0], p[1]);
    } };
  }

  // n клеток, один предмет повторяется: «что было два раза» / «чего не было» / «что было»
  function twice(n, cols, seconds) {
    return { make: function () {
      var pool = pickSet(n + 3);
      var uniq = pick(pool, n - 1);
      var dup = uniq[0];
      var shown = shuffle(uniq.concat([dup]));
      var v = rnd(3);
      if (v === 1) return askMissing('twice', shown, pool, cols, seconds);
      if (v === 2) return askPresent('twice', shown, pool, cols, seconds);
      return q('twice', 'twice', shown, cols, seconds, 'Что было два раза?', [dup].concat(pick(uniq.slice(1), 3)));
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
      lineup('row3', 3, 3, 4),            // 3 предмета в ряд
      lineup('row3-animals', 3, 3, 4, 'animals'), // 3 зверя в ряд
      colors(4, 5),                       // 4 кружка
      lineup('row4', 4, 4, 5),            // 4 в ряд
      count('count5', 5, 5, 5, 2, 3),     // 5 в ряд, 2–3 одинаковых
      cross(6),                           // 5 крестом в сетке 3×3
      row(5, 6),                          // 5 в ряд
      lineup('grid6', 6, 3, 7),           // 6 сеткой 3×2
      twice(6, 3, 7),                     // 6, один два раза
      count('count7', 7, 4, 8, 3, 5)      // 7, из них 3–5 одинаковых
    ],
    ranks: [
      { min: 0, title: 'Рассеянный с улицы Бассейной', text: 'Ничего страшного — память можно тренировать!' },
      { min: 4, title: 'Внимательный', text: 'Неплохо! Ещё немного тренировки — и будет отлично.' },
      { min: 7, title: 'Глаз-алмаз', text: 'Вы замечаете то, что другие пропускают!' },
      { min: 9, title: 'Память как у слона', text: 'Потрясающе! Вас не проведёшь.' }
    ]
  });
})();
