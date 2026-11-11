/* Движок викторин. Ничего не знает о конкретных тестах:
   берёт их из window.QUIZ_TESTS (каждый тест — свой файл в tests/). */
(function () {
  'use strict';

  var INPUT_LOCK_MS = 400;     // после смены экрана столько игнорируем нажатия (двойной тап)
  var READY_DELAY_MS = 1500;   // «Готово, спрашивайте!» активна не раньше, чем через столько
  var HOME_COLOR = '#bf360c';
  var PER_RUN = 10;            // вопросов за одно прохождение (у теста можно задать perRun)
  var HOME_KEYS = 10;          // клавиши 1–9 и 0 на главном экране — для первых десяти тестов (дальше — стрелки)
  var MEMO_MIN_LEFT_MS = 1500; // после паузы картинка «запомни» видна ещё столько, даже если время почти вышло

  // Порядок тестов на главном экране (по id). Теста нет в index.html — он просто
  // пропускается; тест, которого нет в списке, встаёт в конец.
  var TEST_ORDER = ['ussr', 'songs', 'kino', 'quotes', 'actors', 'cartoons', 'newyear', 'transport', 'cities', 'nature', 'memory'];

  var CFG = window.APP_CONFIG || {};
  var PF = window.Platform || null;      // площадка (platform.js); без неё — работаем как в браузере
  var AN = window.Analytics || { init: function () {}, ready: function () {}, event: function () {}, once: function () {} };
  var HINTS_PER_RUN = CFG.HINTS_PER_RUN == null ? 1 : CFG.HINTS_PER_RUN;   // «50 на 50» за прохождение

  var app = document.getElementById('app');
  var toastEl = document.getElementById('toast');
  var tests = sortTests((window.QUIZ_TESTS || []).filter(validTest));

  var state = null;      // текущее прохождение
  var screen = 'home';   // home | intro | question | result
  var timers = [];       // таймеры текущего экрана (чистим при переходе)

  /* ---------- мелочи ---------- */

  function validTest(t) {
    var ok = t && t.id && t.title && Array.isArray(t.questions) && t.questions.length &&
      Array.isArray(t.ranks) && t.ranks.length;
    if (!ok && window.console) console.warn('Тест пропущен, неверный формат:', t && t.id);
    return ok;
  }

  function sortTests(list) {
    var pos = function (t) { var i = TEST_ORDER.indexOf(t.id); return i < 0 ? TEST_ORDER.length : i; };
    return list.map(function (t, i) { return { t: t, i: i }; })
      .sort(function (a, b) { return pos(a.t) - pos(b.t) || a.i - b.i; })
      .map(function (x) { return x.t; });
  }

  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k) || attrs[k] == null || attrs[k] === false) continue;
        if (k === 'class') el.className = attrs[k];
        else if (k === 'text') el.textContent = attrs[k];
        else if (k === 'style') el.setAttribute('style', attrs[k]);
        else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), attrs[k]);
        else el.setAttribute(k, attrs[k] === true ? '' : attrs[k]);
      }
    }
    (children || []).forEach(function (c) {
      if (c == null || c === false) return;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return el;
  }

  function shuffle(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  function clearTimers() { timers.forEach(clearTimeout); timers = []; }
  function later(fn, ms) { timers.push(setTimeout(fn, ms)); }

  // Только картинки-эмодзи (цифры сюда не входят — они рисуются обычным шрифтом)
  var EMOJI_RE = /^(?:\p{Extended_Pictographic}(?:\uFE0F|\u200D|\p{Emoji_Modifier})*)+$/u;
  function isEmojiOnly(s) { try { return EMOJI_RE.test(String(s).replace(/\s/g, '')); } catch (e) { return false; } }

  function rankFor(test, score) {
    var r = test.ranks[0];
    test.ranks.forEach(function (x) { if (score >= x.min) r = x; });
    return r;
  }

  function wordQuestions(n) {
    var m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return n + ' вопрос';
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return n + ' вопроса';
    return n + ' вопросов';
  }

  // Сколько вопросов в одном прохождении (из 50 в запасе берём 10)
  function runLength(test) {
    var n = parseInt(test.perRun, 10);
    if (!(n > 0)) n = PER_RUN;
    return Math.min(n, test.questions.length);
  }

  function bestOf(test) { return QuizStore.getBest(test.id, runLength(test)); }

  function setTheme(color) {
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', color);
    document.documentElement.style.setProperty('--accent', color);
  }

  /* Сообщение — вверху, там, где ему нечего закрывать (на вопросе — поверх верхней панели, на других
     экранах — под верхней строкой), и прозрачно для касаний (pointer-events: none в CSS):
     нажатие сквозь него доходит до кнопки под ним. */
  function placeToast() {
    toastEl.classList.remove('toast--bar');
    toastEl.style.left = toastEl.style.width = toastEl.style.minHeight = toastEl.style.maxHeight = '';
    // Экран вопроса: узкой строкой поверх верхней панели (кнопки «‹ Тесты», «Вопрос N из 10»,
    // полоска хода) — не закрывает ни вопрос, ни варианты, ни «Дальше».
    var bar = screen === 'question' && app.querySelector('.topbar__row');
    if (bar) {
      var r = bar.getBoundingClientRect();
      var prog = app.querySelector('.topbar .progress');
      var bottom = prog ? prog.getBoundingClientRect().bottom : r.bottom;
      var top0 = Math.max(4, r.top);
      toastEl.classList.add('toast--bar');
      toastEl.style.top = Math.round(top0) + 'px';
      toastEl.style.left = Math.round(r.left + r.width / 2) + 'px';
      toastEl.style.width = Math.round(r.width) + 'px';
      toastEl.style.minHeight = Math.round(r.height) + 'px';
      toastEl.style.maxHeight = Math.round(Math.max(r.height, bottom - top0)) + 'px';
      return;
    }
    var row = app.querySelector('.topbar__row, .result__top, .home__head');
    var top = row ? Math.max(8, row.getBoundingClientRect().bottom + 8) : 12;
    toastEl.style.top = Math.round(top) + 'px';
  }

  var toastTimer = null;
  function toast(text) {
    placeToast();
    toastEl.textContent = text;
    toastEl.hidden = false;
    // перезапуск появления
    toastEl.classList.remove('show');
    void toastEl.offsetWidth;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastEl.classList.remove('show');
      toastTimer = setTimeout(function () { toastEl.hidden = true; }, 300);
    }, 3500);
  }

  // Убрать подсказку сразу (и текст: это живая область для читалок — старое сообщение там не остаётся)
  function hideToast() {
    clearTimeout(toastTimer);
    toastEl.classList.remove('show');
    toastEl.textContent = '';
    toastEl.hidden = true;
  }

  function soundButton(extraClass) {
    var btn = h('button', {
      class: 'icon-btn sound-btn ' + (extraClass || ''), type: 'button',
      'aria-label': QuizSound.isOn() ? 'Выключить звук' : 'Включить звук',
      'aria-pressed': QuizSound.isOn() ? 'true' : 'false',
      'data-sound': QuizSound.isOn() ? 'on' : 'off',
      onclick: function () {
        var on = QuizSound.toggle();
        btn.textContent = on ? '🔊' : '🔇';
        btn.setAttribute('aria-label', on ? 'Выключить звук' : 'Включить звук');
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        btn.setAttribute('data-sound', on ? 'on' : 'off');
      }
    }, [QuizSound.isOn() ? '🔊' : '🔇']);
    return btn;
  }

  function backButton(light) {
    return h('button', { class: 'icon-btn back-btn' + (light ? ' back-btn--light' : ''), type: 'button',
      'data-action': 'back', 'aria-label': 'К списку тестов', onclick: goHome }, ['‹ Тесты']);
  }

  /* ---------- защита от двойного нажатия ---------- */

  var lockUntil = 0, lockTimer = null;
  function lockInput(ms) {
    lockUntil = Date.now() + ms;
    app.setAttribute('data-input', 'locked');
    clearTimeout(lockTimer);
    lockTimer = setTimeout(function () { app.setAttribute('data-input', 'ready'); }, ms);
  }
  function inputLocked() { return Date.now() < lockUntil; }

  // Ловим нажатия раньше всех: пока экран «свежий», клики по нему не доходят до кнопок.
  window.addEventListener('click', function (e) {
    if (inputLocked() && app.contains(e.target)) { e.stopPropagation(); e.preventDefault(); }
  }, true);

  function render(node, name) {
    clearTimers();
    if (window.QuizShare && QuizShare.closeDialog) QuizShare.closeDialog();
    if (toastEl.textContent) hideToast();   // сообщение прошлого экрана не висит на новом
    updateBanner();
    screen = name;
    app.innerHTML = '';
    app.setAttribute('data-screen', name);
    document.body.className = 'on-' + name;
    app.appendChild(node);
    window.scrollTo(0, 0);
    fitMemGrids();
    fitScreen(false);
    lockInput(INPUT_LOCK_MS);
  }

  /* ---------- всё главное — над баннером, без прокрутки ---------- */
  /* Невысокий экран (360×640, телефон в альбоме) плюс баннер 90 px: варианты ответа, картинка
     «запомни» с «Готово» и кнопки результата должны помещаться над баннером. Если не помещаются,
     экран по ступеням «уплотняется» (fit-1, fit-2, fit-3 — классы в CSS: меньше отступы, шрифт
     вопроса не меньше 20 px, кнопки ответа не ниже 52 px; в альбоме — вопрос сбоку от вариантов).
     Помещается сразу (большой экран) — ничего не меняется. */
  function bannerReserve() {
    var css = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--banner-h')) || 0;
    var plan = PF && PF.banner && PF.banner.mode && PF.banner.mode !== 'none' ? (PF.banner.reservePx || 0) : 0;
    return Math.max(css, plan);
  }
  function visibleBottom() { return window.innerHeight - bannerReserve() - 4; }
  function docBottom(el) { return el.getBoundingClientRect().bottom + (window.pageYOffset || 0); }
  function fitsOnScreen(el) { return !el || docBottom(el) <= visibleBottom(); }

  function setFitLevel(main, lvl) {
    for (var k = 1; k <= 3; k++) main.classList.toggle('fit-' + k, k <= lvl);
    main.setAttribute('data-fit', String(lvl));
  }
  // keep = не «разуплотнять» (тот же экран: подсказка сработала и т.п. — чтобы кнопки не прыгали)
  function fitLevels(main, target, max, keep) {
    if (!target) return;
    var from = keep ? (parseInt(main.getAttribute('data-fit'), 10) || 0) : 0;
    for (var lvl = from; lvl <= max; lvl++) {
      setFitLevel(main, lvl);
      if (fitsOnScreen(target)) return;
    }
  }

  function fitScreen(keep) {
    var main = app.firstElementChild;
    if (!main || !main.classList) return;
    if (screen === 'question' && state && state.phase === 'memorize') fitMemorize(main, keep);
    else if (screen === 'question' && state && state.phase === 'ask') {
      placeHint();
      var as = app.querySelectorAll('.ask .answer');
      fitLevels(main, as[as.length - 1], 3, keep);
    } else if (screen === 'result') {
      var bs = app.querySelectorAll('.result__actions .btn');
      fitLevels(main, bs[bs.length - 1], 2, keep);
    }
  }

  // «Запомни»: сначала уплотняем подписи, потом уменьшаем картинку по оставшейся высоте
  function fitMemorize(main, keep) {
    var grid = app.querySelector('.memorize .mem-grid');
    var ready = app.querySelector('[data-action="ready"]');
    if (!grid || !ready) return;
    if (!keep) { grid.style.maxWidth = ''; grid.style.removeProperty('--cell'); }
    var bottom = function () { return Math.max(docBottom(ready), docBottom(grid)); };
    var cols = parseInt(grid.style.getPropertyValue('--cols'), 10) || 3;
    var rows = parseInt(grid.style.getPropertyValue('--rows'), 10) || 1;
    var gap = parseFloat(getComputedStyle(grid).columnGap) || 8;
    var memo = app.querySelector('.memorize');
    var side = getComputedStyle(memo).display === 'grid';   // альбом: картинка слева
    var setCell = function (px) {
      if (side) grid.style.setProperty('--cell', px + 'px');
      else grid.style.maxWidth = (cols * px + (cols - 1) * gap + 1) + 'px';
    };
    if (!keep) setFitLevel(main, 0);
    if (side && !keep) {
      // Альбом: клетки — сколько позволяет высота над баннером (крест 3×3 на 640×360 — ~50 px, а не 35),
      // но не шире половины экрана и не больше 84 px
      var byHeight = function () {
        var avail = visibleBottom() - (grid.getBoundingClientRect().top + (window.pageYOffset || 0));
        return Math.floor((avail - (rows - 1) * gap) / rows);
      };
      var byWidth = Math.floor((memo.clientWidth * 0.55 - (cols - 1) * gap) / cols);
      if (byHeight() < 64) setFitLevel(main, 1);
      setCell(Math.max(36, Math.min(84, byWidth, byHeight())));
    }
    if (bottom() > visibleBottom()) setFitLevel(main, 1);
    if (bottom() <= visibleBottom()) { fitMemGrids(); return; }
    var cell = grid.querySelector('.mem-cell');
    var cw = Math.floor(cell ? cell.getBoundingClientRect().width : 80);
    // Уменьшаем клетки, пока картинка и «Готово» не встанут над баннером (в альбоме меньшая
    // картинка ещё и даёт место правой колонке — заголовок и кнопка перестают переноситься).
    for (var px = cw - 4; px >= 36; px -= 4) {
      setCell(px);
      if (bottom() <= visibleBottom()) break;
    }
    fitMemGrids();
  }

  /* ---------- адрес и кнопка «назад» ---------- */
  // В адресе только ?test=<id>; остальные параметры (например, от ВК) не трогаем.

  function urlWithTest(id) {
    try {
      var u = new URL(location.href);
      if (id) u.searchParams.set('test', id); else u.searchParams.delete('test');
      return u.pathname + u.search + u.hash;
    } catch (e) { return null; }
  }
  function testFromUrl() {
    try {
      var id = new URL(location.href).searchParams.get('test');
      return id && tests.filter(function (x) { return x.id === id; })[0] || null;
    } catch (e) { return null; }
  }
  function pushTest(t) {
    var u = urlWithTest(t.id);
    try { if (u) history.pushState({ quiz: t.id }, '', u); } catch (e) { /* ничего */ }
  }
  function replaceHome() {
    var u = urlWithTest(null);
    try { if (u) history.replaceState(null, '', u); } catch (e) { /* ничего */ }
  }

  /* Посреди теста (уже ответил хотя бы на один вопрос) уйти можно только через вопрос
     «Выйти из теста?»: «‹ Тесты», Esc, «назад» браузера и телефона. До первого ответа
     и на экране результата — уходим сразу. */
  function midTest() {
    return !!(state && !state.ended && screen === 'question' &&
      (state.phase === 'ask' || state.phase === 'memorize') && (state.idx > 0 || state.answered));
  }

  var exitDlg = null;
  function askExit() {
    if (exitDlg) return;
    var stay = h('button', { class: 'btn btn--primary', type: 'button', 'data-action': 'exit-stay', onclick: closeExit }, ['Остаться']);
    var leave = h('button', { class: 'btn btn--ghost', type: 'button', 'data-action': 'exit-leave',
      onclick: function () { closeExit(); leaveTest(); } }, ['Выйти']);
    var box = h('div', { class: 'exit-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'exit-title' }, [
      h('div', { class: 'exit-dialog__box' }, [
        h('p', { class: 'exit-dialog__title', id: 'exit-title', text: 'Выйти из теста?' }),
        h('p', { class: 'exit-dialog__text', text: 'Ответы не сохранятся.' }),
        h('div', { class: 'exit-dialog__btns' }, [stay, leave])
      ])
    ]);
    box.addEventListener('click', function (e) { if (e.target === box) closeExit(); });   // мимо окна — «Остаться»
    function trap(e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeExit(); return; }
      if (e.key === 'Tab') {   // фокус не уходит из окна
        e.preventDefault();
        (document.activeElement === stay ? leave : stay).focus();
      }
    }
    document.addEventListener('keydown', trap, true);
    document.body.appendChild(box);
    document.body.classList.add('is-modal');
    app.setAttribute('inert', '');
    exitDlg = { box: box, trap: trap };
    updateBanner();   // окно — над зоной баннера, а сам баннер на это время спрятан
    try { stay.focus({ preventScroll: true }); } catch (e) { stay.focus(); }
  }
  function closeExit() {
    if (!exitDlg) return;
    document.removeEventListener('keydown', exitDlg.trap, true);
    exitDlg.box.remove();
    exitDlg = null;
    document.body.classList.remove('is-modal');
    app.removeAttribute('inert');
    updateBanner();
  }
  function leaveTest() { navigateHome(); }

  // «‹ Тесты», «Другие тесты», Esc: шаг назад по истории (как кнопка «назад» телефона)
  function goHome() {
    if (midTest()) { askExit(); return; }
    navigateHome();
  }
  function navigateHome() {
    noteAbandon('back');
    if (history.state && history.state.quiz) {
      var before = screen;
      try { history.back(); } catch (e) { /* ничего */ }
      // если «назад» не сработал (бывает во встроенных окнах) — уходим сами
      setTimeout(function () { if (screen === before && screen !== 'home') { replaceHome(); showHome(); } }, 350);
    } else {
      replaceHome();
      showHome();
    }
  }

  // «Назад» браузера/телефона уже сработал — возвращаем запись теста в историю, чтобы
  // следующий «назад» снова спросил, а не выкинул из теста.
  function restoreTestEntry() { if (state && state.test) pushTest(state.test); }

  window.addEventListener('popstate', function () {
    // «Назад» закрывает верхнее окно: пока ждём рекламу — это «Отмена» (остаёмся на вопросе)
    if (adBusy && PF && PF.isWaitingRewarded && PF.isWaitingRewarded()) { restoreTestEntry(); userCancel(); return; }
    if (exitDlg) { restoreTestEntry(); closeExit(); return; }               // «назад» в окне «Выйти?» = «Остаться»
    if (midTest()) { restoreTestEntry(); askExit(); return; }
    noteAbandon('back');
    var t = testFromUrl();
    if (t) { introSource = 'home'; showIntro(t); } else showHome();
  });

  /* Человек бросил тест посреди вопросов: «‹ Тесты», «назад», Esc (back) или закрыл приложение (exit).
     Номер вопроса — где бросил. Одна отметка за прохождение. */
  function noteAbandon(reason) {
    if (!state || state.ended || (state.phase !== 'ask' && state.phase !== 'memorize')) return;
    state.ended = true;
    AN.event('progression_failed', { level_id: state.test.id, step_index: state.idx + 1, reason: reason });
  }

  /* ---------- главный экран ---------- */

  var introSource = 'home';   // откуда пришли на заставку: home (список тестов) / daily («Тест дня») / link (ссылка)
  function openTest(t, source) {
    introSource = source || 'home';
    pushTest(t);
    showIntro(t);
  }

  /* ---------- «Тест дня» (повод заходить каждый день) ---------- */
  /* Каждый день — один из тестов, без сервера: по номеру дня из постоянного «перемешанного» круга
     всех тестов (как «Сон дня» в «Соннике»). За N дней (N — число тестов) ни один не повторится,
     два дня подряд — всегда разные. Пройден сегодня — на карточке «Пройден сегодня: 8 из 10». */
  function dayNumber(date) {
    return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000);
  }
  function today() { return dayNumber(new Date()); }
  function dateLabel(date) {
    try { return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }); } catch (e) { return ''; }
  }
  var dailyOrder = null;
  function dailyTest(date) {
    if (!tests.length) return null;
    if (!dailyOrder) {
      dailyOrder = tests.map(function (t) { return t.id; }).sort();
      var seed = 20261111;
      var rnd = function () {   // mulberry32: один и тот же порядок у всех
        seed = (seed + 0x6D2B79F5) | 0;
        var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      for (var i = dailyOrder.length - 1; i > 0; i--) {
        var j = Math.floor(rnd() * (i + 1));
        var x = dailyOrder[i]; dailyOrder[i] = dailyOrder[j]; dailyOrder[j] = x;
      }
    }
    var n = dayNumber(date || new Date()), L = dailyOrder.length;
    var id = dailyOrder[((n % L) + L) % L];
    return tests.filter(function (t) { return t.id === id; })[0] || null;
  }
  // Результат теста дня за сегодня ({ day, test, score, total }) или null
  function dailyDone() {
    var r = QuizStore.get('daily'), t = dailyTest();
    return r && typeof r === 'object' && t && r.day === today() && r.test === t.id && typeof r.score === 'number' ? r : null;
  }
  // Пройден тест — если это сегодняшний тест дня, запомнить (лучший результат за сегодня)
  function noteDaily(t, score, total) {
    var d = dailyTest();
    if (!d || d.id !== t.id) return;
    var prev = dailyDone();
    if (!prev) AN.event('daily_completed', { level_id: t.id, score: score, total: total });
    if (!prev || score > prev.score) QuizStore.set('daily', { day: today(), test: t.id, score: score, total: total }, true);
  }

  var dailyShownDay = null;
  function dailyCard() {
    var t = dailyTest();
    if (!t) return null;
    dailyShownDay = today();
    var done = dailyDone();
    var total = runLength(t);
    return h('button', {
      class: 'daily-card' + (done ? ' daily-card--done' : ''), type: 'button', 'data-action': 'daily', 'data-test': t.id,
      style: '--c1:' + t.color + ';--c2:' + (t.color2 || t.color),
      'aria-label': 'Тест дня, ' + dateLabel(new Date()) + ': «' + t.title + '»' + (done ? '. Пройден сегодня: ' + done.score + ' из ' + done.total : ''),
      onclick: function () {
        AN.event('daily_opened', { level_id: t.id, done: !!done });
        openTest(t, 'daily');
      }
    }, [
      h('span', { class: 'daily-card__label', text: '⭐ Тест дня · ' + dateLabel(new Date()) }),
      h('span', { class: 'daily-card__main' }, [
        h('span', { class: 'test-card__emoji daily-card__emoji', 'aria-hidden': 'true', text: t.emoji }),
        h('span', { class: 'daily-card__body' }, [
          h('span', { class: 'daily-card__title', text: t.title }),
          h('span', { class: 'daily-card__state', text: done
            ? 'Пройден сегодня: ' + done.score + ' из ' + done.total + ', завтра новый'
            : wordQuestions(total) + ' · завтра будет новый' })
        ])
      ])
    ]);
  }
  // Наступила полночь, а человек на главном — карточка дня меняется сама
  setInterval(function () {
    if (screen !== 'home' || document.hidden || dailyShownDay === today()) return;
    var old = app.querySelector('.daily-card'), fresh = dailyCard();
    if (old && fresh) old.parentNode.replaceChild(fresh, old);
  }, 60000);

  /* ---------- «Добавить в избранное / на главный экран» ---------- */
  /* Не с порога: только на настоящей площадке, которая это умеет (Platform.favoritesKind), когда
     человек заходит уже 3-й день или больше и в этот раз прошёл тест — на главном, куда он вернулся.
     Предложили и человек ничего не нажал — снова не раньше, чем через 3 дня. Нажал «Добавить»
     (добавил или передумал в окне площадки) или «Не надо» — больше не предлагаем. */
  var FAV_MIN_DAYS = 3, FAV_REPEAT_DAYS = 3;
  var passedThisRun = false, favShownNow = false;
  function noteVisit() {
    var v = QuizStore.get('visits'), d = today();
    if (!v || typeof v !== 'object') v = { days: 0, last: null };
    if (v.last === d) return;
    QuizStore.set('visits', { days: (parseInt(v.days, 10) || 0) + 1, last: d });
  }
  function favOffer() {
    var kind = PF && PF.favoritesKind ? PF.favoritesKind() : '';
    if (!kind || !passedThisRun) return null;
    var f = QuizStore.get('fav') || {};
    var v = QuizStore.get('visits') || {};
    if (f.state) return null;
    if ((parseInt(v.days, 10) || 0) < FAV_MIN_DAYS) return null;
    if (!favShownNow && f.offered != null && today() - f.offered < FAV_REPEAT_DAYS) return null;
    if (!favShownNow) {
      favShownNow = true;
      QuizStore.set('fav', { offered: today() }, true);
      AN.event('favorites_offered', { kind: kind });
    }
    var row;
    var finish = function (st) { QuizStore.set('fav', { offered: today(), state: st }, true); favShownNow = false; if (row) row.remove(); };
    var yes = h('button', { class: 'btn fav-offer__yes', type: 'button', 'data-action': 'fav-yes', onclick: function () {
      AN.event('favorites_clicked', { kind: kind });
      yes.disabled = true;
      PF.addToFavorites().then(function (ok) {
        if (ok) {
          AN.event('favorites_added', { kind: kind });
          toast(kind === 'favorites' ? 'Готово: викторины в избранном.' : 'Готово: викторины на главном экране.');
        }
        finish(ok ? 'yes' : 'no');
      });
    } }, [kind === 'favorites' ? '⭐ Добавить в избранное' : '📲 Добавить на главный экран']);
    var no = h('button', { class: 'fav-offer__no', type: 'button', 'data-action': 'fav-no', 'aria-label': 'Не надо, больше не предлагать',
      onclick: function () { finish('no'); } }, ['Не надо']);
    row = h('div', { class: 'fav-offer', 'data-fav': kind }, [
      h('p', { class: 'fav-offer__text', text: kind === 'favorites' ? 'Нравятся викторины? Добавьте их в избранное — будет легко найти.' : 'Нравятся викторины? Добавьте их на главный экран телефона.' }),
      h('div', { class: 'fav-offer__btns' }, [yes, no])
    ]);
    return row;
  }

  function showHome() {
    state = null;
    setTheme(HOME_COLOR);
    var cards = tests.map(function (t, i) {
      var best = bestOf(t);
      var total = runLength(t);
      return h('button', {
        class: 'test-card', type: 'button', 'data-test': t.id,
        style: '--c1:' + t.color + ';--c2:' + (t.color2 || t.color),
        onclick: function () { openTest(t); }
      }, [
        h('span', { class: 'test-card__emoji', 'aria-hidden': 'true', text: t.emoji }),
        h('span', { class: 'test-card__body' }, [
          h('span', { class: 'test-card__title', text: t.title }),
          h('span', { class: 'test-card__sub', text: t.subtitle || '' }),
          h('span', { class: 'test-card__meta' }, [
            // «Новинка»: тест помечен в данных (isNew) и человек его ещё не проходил (нет рекорда)
            t.isNew && best == null ? h('span', { class: 'chip chip--new', text: 'Новинка' }) : null,
            h('span', { class: 'chip', text: wordQuestions(total) }),
            best != null ? h('span', { class: 'chip chip--best', text: '🏆 ' + best + ' из ' + total }) : null
          ])
        ]),
        i < HOME_KEYS ? h('span', { class: 'test-card__key', 'aria-hidden': 'true', text: String((i + 1) % 10) }) : null
      ]);
    });

    render(h('main', { class: 'home' }, [
      h('header', { class: 'home__head' }, [
        h('div', { class: 'home__logo', 'aria-hidden': 'true', text: '?' }),
        h('div', { class: 'home__titles' }, [
          h('h1', { class: 'home__title', text: 'Викторины' }),
          h('p', { class: 'home__sub', text: 'Выберите тест — и проверьте себя!' })
        ]),
        soundButton('sound-btn--home')
      ]),
      dailyCard(),
      favOffer(),
      h('div', { class: 'cards' }, cards)
    ]), 'home');
  }

  /* ---------- заставка теста ---------- */

  function freshLine(t) {
    var gen = t.questions.some(function (q) { return typeof q.make === 'function'; });
    if (gen) return h('p', { class: 'intro__fresh', text: 'Каждый раз — новые картинки' });
    if (t.questions.length > runLength(t)) return h('p', { class: 'intro__fresh', text: 'Каждый раз — новые вопросы' });
    return null;
  }

  function showIntro(t) {
    state = null;
    setTheme(t.color);
    document.body.style.setProperty('--c1', t.color);
    document.body.style.setProperty('--c2', t.color2 || t.color);
    var best = bestOf(t);
    var startBtn = h('button', { class: 'btn btn--primary btn--start', type: 'button', 'data-action': 'start',
      onclick: function () { startTest(t, introSource); } }, ['Начать']);
    render(h('main', { class: 'intro' }, [
      h('div', { class: 'result__top' }, [backButton(true), soundButton('sound-btn--light')]),
      h('section', { class: 'intro__card' }, [
        h('div', { class: 'intro__emoji', 'aria-hidden': 'true', text: t.emoji }),
        h('h1', { class: 'intro__title', text: t.title }),
        h('p', { class: 'intro__count', text: wordQuestions(runLength(t)) }),
        freshLine(t),
        h('p', { class: 'intro__text', text: t.intro || t.subtitle || '' }),
        best != null ? h('p', { class: 'intro__best', text: '🏆 Ваш лучший результат: ' + best + ' из ' + runLength(t) }) : null,
        startBtn
      ])
    ]), 'intro');
  }

  /* ---------- прохождение ---------- */

  /* Вопросы на это прохождение.
     Тест, где вопросов не больше perRun (10): берём все; «запомни» генерируются заново,
     обычные перемешиваются внутри первой и второй половины (лёгкие остаются в начале).
     Тест с запасом (50 вопросов): берём случайные 4 лёгких (d:1) + 4 средних (d:2) +
     2 трудных (d:3), идут от лёгких к трудным, внутри группы перемешаны. В первую
     очередь — те, что не показывали в двух прошлых прохождениях (помним в QuizStore). */
  function prepareQuestions(test) {
    var n = runLength(test);
    var qs;
    if (test.questions.length <= n) {
      qs = test.questions.slice();
      if (!test.keepOrder) {
        var half = Math.ceil(qs.length / 2);
        qs = shuffle(qs.slice(0, half)).concat(shuffle(qs.slice(half)));
      }
    } else {
      qs = pickQuestions(test, n);
    }
    return qs.map(function (q) { return typeof q.make === 'function' ? q.make() : q; });
  }

  function levelOf(q) { var d = parseInt(q.d, 10); return d === 1 || d === 3 ? d : 2; }

  // Короткая метка вопроса для памяти «что уже показывали» (не зависит от порядка в файле)
  function questionKey(q, i) {
    var s = String(q.id || q.q || ('#' + i)), x = 5381;
    for (var k = 0; k < s.length; k++) x = ((x * 33) ^ s.charCodeAt(k)) >>> 0;
    return x.toString(36);
  }

  var RECENT_RUNS = 2;
  function loadRecent(testId) {
    try {
      var v = QuizStore.get('recent:' + testId);
      if (typeof v === 'string') v = JSON.parse(v);   // на всякий случай: строка в старом виде
      if (!Array.isArray(v)) return [];
      return v.slice(0, RECENT_RUNS).map(function (r) { return Array.isArray(r) ? r.map(String) : []; });
    } catch (e) { return []; }
  }
  function saveRecent(testId, recent) {
    try { QuizStore.set('recent:' + testId, recent.slice(0, RECENT_RUNS)); } catch (e) { /* ничего */ }
  }

  // Сколько брать из каждой группы: для 10 — 4/4/2. Не хватает в группе — добираем из соседней.
  function quotas(n, have) {
    var q3 = Math.round(n * 0.2), q1 = Math.round(n * 0.4);
    var want = { 1: q1, 2: n - q1 - q3, 3: q3 };
    var take = {};
    [1, 2, 3].forEach(function (d) { take[d] = Math.min(want[d], have[d]); });
    var order = { 1: [2, 3], 2: [1, 3], 3: [2, 1] };
    [1, 2, 3].forEach(function (d) {
      var miss = want[d] - Math.min(want[d], have[d]);
      order[d].forEach(function (nb) {
        var extra = Math.min(miss, have[nb] - take[nb]);
        if (extra > 0) { take[nb] += extra; miss -= extra; }
      });
    });
    return take;
  }

  function pickQuestions(test, n) {
    var recent = loadRecent(test.id);
    // 0 — давно не показывали, 1 — было в позапрошлый раз, 2 — было в прошлый раз
    var age = {};
    for (var r = recent.length - 1; r >= 0; r--) recent[r].forEach(function (k) { age[k] = RECENT_RUNS - r; });
    var groups = { 1: [], 2: [], 3: [] };
    test.questions.forEach(function (q, i) {
      groups[levelOf(q)].push({ q: q, key: questionKey(q, i), age: age[questionKey(q, i)] || 0 });
    });
    var take = quotas(n, { 1: groups[1].length, 2: groups[2].length, 3: groups[3].length });
    var chosen = [], keys = [];
    // Вопросы одной группы (поле group, например два вопроса про один балет: один подсказывает
    // ответ на другой) — не больше одного за прохождение. Не хватает без повтора группы — добираем.
    var usedGroups = {};
    [1, 2, 3].forEach(function (d) {
      var g = shuffle(groups[d]).map(function (x, i) { x.pos = i; return x; });
      g.sort(function (a, b) { return a.age - b.age || a.pos - b.pos; });
      var part = [], rest = [];
      g.forEach(function (x) {
        var gr = x.q.group;
        if (part.length < take[d] && !(gr && usedGroups[gr])) { part.push(x); if (gr) usedGroups[gr] = true; }
        else rest.push(x);
      });
      while (part.length < take[d] && rest.length) part.push(rest.shift());
      shuffle(part).forEach(function (x) { chosen.push(x.q); keys.push(x.key); });
    });
    saveRecent(test.id, [keys].concat(recent));
    return chosen;
  }

  function startTest(test, source) {
    QuizSound.unlock();
    setTheme(test.color);
    var qs = prepareQuestions(test);
    state = { test: test, questions: qs, idx: 0, score: 0, total: qs.length, answered: false,
      hintsLeft: HINTS_PER_RUN, hintPending: false, hintUsed: false, hintOffered: false };
    AN.event('progression_started', { level_id: test.id, source: source || 'home' });
    showQuestion();
  }

  function topBar(extra) {
    var t = state.test;
    var n = state.idx + 1;
    return h('div', { class: 'topbar' }, [
      h('div', { class: 'topbar__row' }, [
        backButton(false),
        h('div', { class: 'topbar__count', text: 'Вопрос ' + n + ' из ' + state.total }),
        extra || null,
        soundButton()
      ]),
      h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(state.total), 'aria-valuenow': String(n - 1) }, [
        h('div', { class: 'progress__fill', style: 'width:' + ((n - 1) / state.total * 100) + '%' })
      ]),
      h('div', { class: 'topbar__test', text: t.emoji + ' ' + t.title })
    ]);
  }

  /* Клетки «запомни». Без процентной высоты (Safari считает её нулём):
     квадрат клетки держит ::before с padding-top:100%, содержимое — слой на всю клетку
     (position:absolute; inset:0), кружок — SVG, размер эмодзи считает fitMemGrids() от ширины клетки. */
  var SVG_NS = 'http://www.w3.org/2000/svg';
  function colorDot(color) {
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 100 100');
    svg.setAttribute('class', 'mem-dot');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    var c = document.createElementNS(SVG_NS, 'circle');
    c.setAttribute('cx', '50'); c.setAttribute('cy', '50'); c.setAttribute('r', '34');
    c.setAttribute('fill', color);
    var shade = document.createElementNS(SVG_NS, 'path'); // тень снизу, как раньше
    shade.setAttribute('d', 'M16 50 A34 34 0 0 0 84 50 A34 30 0 0 1 16 50 Z');
    shade.setAttribute('fill', 'rgba(0,0,0,0.15)');
    svg.appendChild(c); svg.appendChild(shade);
    return svg;
  }

  function memoryGrid(q, small) {
    var cols = q.cols || Math.min(q.show.length, 4);
    var rows = Math.ceil(q.show.length / cols);
    return h('div', { class: 'mem-grid' + (small ? ' mem-grid--small' : ''), style: '--cols:' + cols + ';--rows:' + rows }, q.show.map(function (it) {
      if (it === '' || it == null) return h('div', { class: 'mem-cell mem-cell--empty' });
      var inner = typeof it === 'object' && it.color ? colorDot(it.color) : h('span', { class: 'mem-emoji', text: String(it) });
      return h('div', { class: 'mem-cell' }, [h('div', { class: 'mem-in' }, [inner])]);
    }));
  }

  // Размер эмодзи и кружка — от настоящей ширины клетки (а не от ширины экрана)
  var EMOJI_PART = 0.55;
  function fitMemGrids() {
    var cells = app.querySelectorAll('.mem-cell');
    for (var i = 0; i < cells.length; i++) {
      var w = cells[i].clientWidth; // без рамки
      if (!(w > 0)) continue;
      var em = cells[i].querySelector('.mem-emoji');
      if (em) em.style.fontSize = Math.max(12, Math.round(w * EMOJI_PART)) + 'px';
      var dot = cells[i].querySelector('.mem-dot');
      if (dot) { dot.style.width = w + 'px'; dot.style.height = w + 'px'; } // точный размер, без процентов
    }
  }
  var fitTimer = null;
  function refit() { clearTimeout(fitTimer); fitTimer = setTimeout(function () { fitScreen(false); fitMemGrids(); }, 60); }
  window.addEventListener('resize', refit);
  window.addEventListener('orientationchange', refit);

  function showQuestion() {
    var q = state.questions[state.idx];
    state.answered = false;
    if (q.type === 'memory') showMemorize(q);
    else showAsk(q);
  }

  /* Тип «запомни»: сначала показываем набор на q.seconds секунд.
     leftMs — после паузы (свернули, реклама): показываем оставшееся время, но не меньше 1,5 с —
     честный игрок, которого отвлекли, успеет глянуть, а «разглядывать бесконечно» нельзя. */
  function showMemorize(q, leftMs) {
    var full = (q.seconds || 5) * 1000;
    var left = leftMs == null ? full : Math.min(full, Math.max(MEMO_MIN_LEFT_MS, leftMs));
    var readyIn = Math.min(READY_DELAY_MS, left);
    state.phase = 'memorize';
    state.memoInterrupted = false;
    state.readyAt = Date.now() + readyIn;
    var endAt = state.memoEndAt = Date.now() + left;
    var bar = h('div', { class: 'timer__fill', style: 'animation-duration:' + (full / 1000) + 's;animation-delay:-' + ((full - left) / 1000) + 's' });
    var secsEl = h('b', { class: 'memorize__secs', text: String(Math.ceil(left / 1000)) });
    var go = function () { if (state && state.phase === 'memorize') showAsk(q); };
    var ready = h('button', { class: 'btn btn--ghost', type: 'button', 'data-action': 'ready', disabled: true,
      onclick: function () { if (Date.now() >= state.readyAt) go(); } }, ['Готово, спрашивайте!']);
    render(h('main', { class: 'quiz' }, [
      topBar(),
      h('section', { class: 'memorize' }, [
        h('h2', { class: 'memorize__title', text: 'Запомните картинку!' }),
        h('p', { class: 'memorize__hint' }, ['Исчезнет через ', secsEl, ' сек.']),
        memoryGrid(q),
        h('div', { class: 'timer' }, [bar]),
        ready
      ])
    ]), 'question');
    later(function () { ready.disabled = false; }, readyIn);
    (function tick() {
      var sec = Math.max(0, Math.ceil((endAt - Date.now()) / 1000));
      secsEl.textContent = String(sec);
      if (sec > 0) later(tick, Math.min(1000, endAt - Date.now() - (sec - 1) * 1000 + 5));
    })();
    later(go, left);
  }

  function showAsk(q) {
    state.phase = 'ask';
    var answers = q.a.map(function (text, i) { return { text: text, correct: i === (q.correct || 0) }; });
    var order = shuffle(answers);
    state.order = order;
    var emojiAnswers = order.every(function (a) { return isEmojiOnly(a.text); });
    var numAnswers = !emojiAnswers && order.every(function (a) { return /^\d{1,3}$/.test(a.text); });
    var tiles = emojiAnswers || numAnswers;

    var buttons = order.map(function (a, i) {
      return h('button', {
        class: 'answer' + (tiles ? ' answer--tile' : '') + (emojiAnswers ? ' answer--emoji' : '') + (numAnswers ? ' answer--num' : ''),
        type: 'button', 'data-index': String(i),
        onclick: function () { choose(i); }
      }, [
        h('span', { class: 'answer__key', 'aria-hidden': 'true', text: String(i + 1) }),
        h('span', { class: 'answer__text', text: a.text })
      ]);
    });

    var slot = hintSlot();
    var hint = hintButton(slot);
    render(h('main', { class: 'quiz' }, [
      topBar(slot === 'top' ? hint : null),
      h('section', { class: 'ask' }, [
        h('h2', { class: 'question', text: q.q }),
        slot === 'above' ? hint : null,
        h('div', { class: 'answers' + (tiles ? ' answers--tiles' : '') }, buttons),
        slot === 'below' ? hint : null,
        h('div', { class: 'feedback', hidden: true })
      ])
    ]), 'question');
    // Подсказка, досмотренная, когда отвечать было нечего (опоздавшая реклама), — на этот вопрос
    if (state.hintPending) { state.hintPending = false; applyHint(); }
  }

  function choose(i) {
    if (!state || state.phase !== 'ask' || state.answered || adBusy) return;
    if (state.order[i] && state.order[i].out) return;     // убран подсказкой «50 на 50»
    QuizSound.unlock();
    state.answered = true;
    var q = state.questions[state.idx];
    var picked = state.order[i];
    var right = picked.correct;
    if (right) { state.score++; QuizSound.correct(); } else { QuizSound.wrong(); }

    // Кнопка подсказки больше не нужна. Над вариантами и вверху — только прячем (место остаётся,
    // варианты не прыгают), под вариантами — убираем (там сейчас появится «Дальше»).
    var hb = app.querySelector('.hint-btn');
    if (hb) {
      if (hb.getAttribute('data-slot') === 'below') hb.remove();
      else { hb.disabled = true; hb.style.visibility = 'hidden'; hb.setAttribute('aria-hidden', 'true'); }
    }
    var btns = app.querySelectorAll('.answer');
    Array.prototype.forEach.call(btns, function (b, k) {
      b.disabled = true;
      var a = state.order[k];
      if (a.correct) b.classList.add('is-correct');
      else if (k === i) b.classList.add('is-wrong');
      else if (!a.out) b.classList.add('is-dim');
      if (k === i) b.setAttribute('aria-label', (right ? 'Верно: ' : 'Неверно: ') + a.text);
    });

    var last = state.idx + 1 >= state.total;
    var fb = app.querySelector('.feedback');
    fb.hidden = false;
    fb.className = 'feedback ' + (right ? 'feedback--ok' : 'feedback--bad');
    var correctText = state.order.filter(function (a) { return a.correct; })[0].text;
    var children = [
      h('div', { class: 'feedback__verdict', text: right ? '✓ Верно!' : '✗ Не угадали' })
    ];
    if (!right && !isEmojiOnly(correctText)) {
      children.push(h('div', { class: 'feedback__right', text: 'Правильный ответ: ' + correctText }));
    }
    if (q.type === 'memory') {
      children.push(h('div', { class: 'feedback__label', text: 'Вот что было на картинке:' }));
      children.push(memoryGrid(q, true));
    }
    if (q.fact) {
      children.push(h('div', { class: 'feedback__fact' }, [
        h('b', { text: 'А вы знали? ' }), q.fact
      ]));
    }
    var next = h('button', { class: 'btn btn--primary next-btn', type: 'button', 'data-action': 'next', onclick: nextQuestion },
      [last ? 'Узнать результат' : 'Дальше →']);
    children.push(next);
    children.forEach(function (c) { fb.appendChild(c); });
    if (q.type === 'memory') fitMemGrids();

    var fill = app.querySelector('.progress__fill');
    if (fill) fill.style.width = ((state.idx + 1) / state.total * 100) + '%';

    // Ответ — тоже «смена экрана»: короткая защита от второго тапа по месту «Дальше»
    lockInput(INPUT_LOCK_MS);
    try { next.focus({ preventScroll: true }); } catch (e) { next.focus(); }
    later(function () {
      try { next.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e) { /* ничего */ }
    }, 60);
  }

  function nextQuestion() {
    if (!state || !state.answered || inputLocked()) return;
    state.idx++;
    if (state.idx >= state.total) showResult();
    else showQuestion();
  }

  /* ---------- подсказка «50 на 50» за рекламу ---------- */
  /* Решение Романа 11 ноя: за досмотренную рекламу (rewarded) два неверных варианта убираются.
     Кнопка — на экране вопроса до ответа (на «запомни» — только после картинки), не больше
     HINTS_PER_RUN (1) раза за прохождение. Награда — только за досмотренную рекламу. Опоздавшая
     реклама (началась после «не загрузилась» или «Отмены»), досмотренная до конца, даёт подсказку
     на текущий вопрос, если он ещё не отвечен, иначе — на следующий вопрос этого же прохождения.
     Ушёл из прохождения (другой тест, «Пройти ещё раз», к списку) или тест уже закончен — подсказки нет. */
  var adBusy = false;      // ждём рекламу (окно «Загружаем рекламу…»)
  var adShowing = false;   // реклама на экране (в том числе опоздавшая)
  var adGrants = 0;        // сколько подсказок выдано за этот запуск (для автотеста)
  var userCancelled = false;   // человек сам отменил ожидание: «Отмена», Esc или «назад»
  var AD_CANCEL_TEXT = 'Вы отменили рекламу — подсказки нет.';
  var AD_FAIL_TEXT = {
    closed: 'Реклама закрыта раньше конца — подсказки нет. Можно попробовать ещё раз.',
    error: 'Реклама сейчас недоступна. Попробуйте чуть позже.',
    timeout: 'Реклама не загрузилась. Попробуйте чуть позже.'
  };

  function hintAvailable() {
    return !!(state && state.hintsLeft > 0 && PF && PF.rewardedAvailable && PF.rewardedAvailable());
  }

  /* Где кнопка подсказки: на большом экране — под вариантами (крупная); на невысоком (≤ 700 px) —
     узкой строкой над вариантами; телефон в альбоме — в верхней строке, между «Вопрос N» и звуком.
     Так варианты ответа не уезжают под баннер из-за подсказки. */
  function hintSlot() {
    var w = window.innerWidth, hh = window.innerHeight;
    if (w > hh && hh <= 520) return 'top';
    if (hh <= 700) return 'above';
    return 'below';
  }
  function slotClass(base, slot) { return base + ' ' + base + '--' + slot; }

  function hintButton(slot) {
    if (!hintAvailable() || state.hintPending) return null;
    if (!state.hintOffered) {
      state.hintOffered = true;
      AN.event('hint_offered', { level_id: state.test.id, step_index: state.idx + 1 });
    }
    return h('button', { class: 'btn btn--ghost ' + slotClass('hint-btn', slot), type: 'button', 'data-action': 'hint', 'data-slot': slot,
      'aria-label': 'Подсказка «50 на 50» за просмотр рекламы', onclick: startHintAd }, [
      h('span', { class: 'hint-btn__icon', 'aria-hidden': 'true', text: '½' }),
      // в верхней строке (альбом) места мало: «50 на 50» и под ним мелко «▶ реклама» — видно до нажатия
      slot === 'top'
        ? h('span', { class: 'hint-btn__label' }, [
          h('span', { class: 'hint-btn__text', text: '50 на 50' }),
          h('span', { class: 'hint-btn__ad', text: '▶ реклама' })
        ])
        : h('span', { class: 'hint-btn__text', text: '50 на 50 (за рекламу)' })
    ]);
  }
  function hintNote(slot) {
    return h('p', { class: slotClass('hint-note', slot), role: 'status', 'data-slot': slot,
      text: slot === 'top' ? '½ Два неверных убраны' : '½ Подсказка: два неверных ответа убраны' });
  }

  // Поставить кнопку (или строку «подсказка сработала») на место для текущего размера экрана
  function placeHint() {
    var el = app.querySelector('.hint-btn, .hint-note');
    if (!el) return;
    var slot = hintSlot();
    if (el.getAttribute('data-slot') === slot) return;
    var isBtn = el.classList.contains('hint-btn');
    var fresh = isBtn ? hintButton(slot) : hintNote(slot);
    if (!fresh) return;
    if (isBtn && el.disabled) { fresh.disabled = true; fresh.style.visibility = 'hidden'; }
    el.remove();
    insertHint(fresh, slot);
  }
  function insertHint(el, slot) {
    if (slot === 'top') {
      var snd = app.querySelector('.topbar__row .sound-btn');
      if (snd) snd.parentNode.insertBefore(el, snd);
    } else {
      var ans = app.querySelector('.ask .answers');
      if (ans) ans.insertAdjacentElement(slot === 'above' ? 'beforebegin' : 'afterend', el);
    }
  }

  // Убрать два неверных варианта на текущем вопросе
  function applyHint() {
    if (!state || state.phase !== 'ask' || state.answered) { if (state) state.hintPending = true; return; }
    var wrong = [];
    state.order.forEach(function (a, k) { if (!a.correct && !a.out) wrong.push(k); });
    shuffle(wrong).slice(0, 2).forEach(function (k) {
      state.order[k].out = true;
      var b = app.querySelector('.answer[data-index="' + k + '"]');
      if (b) { b.classList.add('is-out'); b.disabled = true; b.setAttribute('aria-hidden', 'true'); b.tabIndex = -1; }
    });
    state.hintUsed = true;
    var hb = app.querySelector('.hint-btn');
    var slot = hb ? hb.getAttribute('data-slot') : hintSlot();
    if (!app.querySelector('.hint-note')) {
      var note = hintNote(slot);
      if (hb) hb.parentNode.replaceChild(note, hb); else insertHint(note, slot);
    } else if (hb) hb.remove();
    fitScreen(true);
  }

  function userCancel() { userCancelled = true; if (PF) PF.cancelRewarded(); }

  // Опоздавшая реклама досмотрена, а подсказку уже не к чему применить — сказать, почему её нет
  function lateRewardUseless(run) {
    var text = 'Реклама досмотрена, но вы уже вышли из теста — подсказка не пригодилась.';
    if (state && state !== run && state.test === run.test) text = 'Реклама досмотрена, но тест уже начат заново — подсказка не пригодилась.';
    else if (state === run && (run.ended || lastAnswered(run))) text = 'Реклама досмотрена, но тест уже закончен — подсказка не пригодилась.';
    toast(text);
  }

  // На последний вопрос уже ответили — следующего не будет, подсказку не к чему применить
  function lastAnswered(run) { return run.answered && run.idx + 1 >= run.total; }

  function grantHint(run, late) {
    // Ушёл из этого прохождения или тест уже закончен — подсказки нет (её не к чему применить)
    if (!state || run !== state || state.ended || state.hintsLeft <= 0 || lastAnswered(state)) return false;
    state.hintsLeft--;
    adGrants++;
    AN.event('hint_granted', { level_id: state.test.id, step_index: state.idx + 1, late: !!late });
    hideToast();
    if (state.phase === 'ask' && !state.answered) applyHint();
    else {
      state.hintPending = true;   // сработает на следующем вопросе (или после картинки «запомни»)
      if (state.answered) toast('Реклама досмотрена. Подсказка сработает на следующем вопросе.');
    }
    return true;
  }

  // Окно «ждём рекламу»: всё остальное не нажимается, есть «Отмена» (и Esc).
  function adWaitOverlay() {
    var cancel = h('button', { class: 'btn btn--ghost', type: 'button', 'data-action': 'ad-cancel',
      onclick: userCancel }, ['Отмена']);
    var box = h('div', { class: 'ad-wait', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Загружаем рекламу' }, [
      h('div', { class: 'ad-wait__box' }, [
        h('div', { class: 'spinner', 'aria-hidden': 'true' }),
        h('p', { role: 'status', text: 'Загружаем рекламу…' }),
        cancel
      ])
    ]);
    function trap(e) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); userCancel(); } }
    document.addEventListener('keydown', trap, true);
    document.body.appendChild(box);
    document.body.classList.add('is-ad-wait');
    app.setAttribute('inert', '');
    try { cancel.focus({ preventScroll: true }); } catch (e) { /* ничего */ }
    return function () {
      document.removeEventListener('keydown', trap, true);
      box.remove();
      document.body.classList.remove('is-ad-wait');
      app.removeAttribute('inert');
    };
  }

  // Пауза, пока показывают картинку «запомни» (опоздавшая реклама, свернули приложение, скрыли
  // вкладку): таймер не идёт. После паузы картинка — на оставшееся время (не меньше 1,5 с).
  function interruptMemorize() {
    if (state && state.phase === 'memorize' && !state.memoInterrupted) {
      state.memoInterrupted = true;
      state.memoLeftMs = Math.max(0, (state.memoEndAt || 0) - Date.now());
      clearTimers();
    }
  }
  function setAdShowing(v) {
    adShowing = v;
    if (window.QuizSound && QuizSound.hold) QuizSound.hold('ad', v);
    updateBanner();
  }
  function resumeAfterAd() {
    updateBanner();
    if (state && state.phase === 'memorize' && state.memoInterrupted && !adShowing && !(PF && PF.isPaused && PF.isPaused())) {
      showMemorize(state.questions[state.idx], state.memoLeftMs);
    }
  }

  function startHintAd() {
    if (adBusy || !state || state.phase !== 'ask' || state.answered || !hintAvailable() || inputLocked()) return;
    var run = state;
    AN.event('hint_clicked', { level_id: run.test.id, step_index: run.idx + 1 });
    adBusy = true;
    userCancelled = false;
    updateBanner();
    var done = adWaitOverlay();
    PF.showRewarded({
      placement: 'hint',
      onOpen: function () { setAdShowing(true); },
      onLateOpen: function () { setAdShowing(true); hideToast(); interruptMemorize(); },
      onLateReward: function () { setAdShowing(false); if (!grantHint(run, true)) lateRewardUseless(run); resumeAfterAd(); },
      onLateFail: function (reason) {
        setAdShowing(false);
        AN.event('ad_reward_failed', { reason: AD_FAIL_TEXT[reason] ? reason : 'error', late: true });
        resumeAfterAd();
        if (run === state && !run.ended) toast(AD_FAIL_TEXT[reason] || AD_FAIL_TEXT.error);
      }
    }).then(function (res) {
      done();
      adBusy = false;
      setAdShowing(false);
      var good = !!(res && res.ok);
      var reason = good ? '' : (res && AD_FAIL_TEXT[res.reason] ? res.reason : 'error');
      if (good) grantHint(run, false);
      else AN.event('ad_reward_failed', { reason: reason, late: false });
      resumeAfterAd();
      // ушёл из прохождения — сообщать некому
      if (!good && run === state && !run.ended) toast(userCancelled ? AD_CANCEL_TEXT : AD_FAIL_TEXT[reason]);
      var hb = app.querySelector('.hint-btn');
      if (hb) { try { hb.focus({ preventScroll: true }); } catch (e) { /* ничего */ } }
    });
  }

  /* ---------- баннер внизу ---------- */
  // Баннер виден, только когда ему ничего не мешает: приложение готово, нет окна «Поделиться»
  // и «Выйти из теста?», не ждём и не показываем рекламу за награду. Сами окна и так стоят выше
  // зоны баннера (--banner-zone), если площадка его не успела спрятать. Место под баннер держит CSS (--banner-h).
  var appReady = false;
  function updateBanner() {
    if (!PF || !PF.banner) return;
    var dialogOpen = window.QuizShare && QuizShare.isDialogOpen && QuizShare.isDialogOpen();
    if (appReady && !dialogOpen && !exitDlg && !adBusy && !adShowing) PF.banner.show(); else PF.banner.hide();
  }

  /* ---------- результат ---------- */

  function showResult() {
    var t = state.test;
    var score = state.score, total = state.total;
    var rank = rankFor(t, score);
    var prev = bestOf(t);
    var isRecord = prev != null && score > prev;
    if (prev == null || score > prev) QuizStore.setBest(t.id, score);
    var best = Math.max(prev == null ? score : prev, score);

    var result = { test: t, score: score, total: total, rank: rank };
    state.result = result;
    state.phase = 'result';
    state.ended = true;
    AN.event('progression_completed', { level_id: t.id, score: score, total: total, hint_used: !!state.hintUsed, record: isRecord });
    noteDaily(t, score, total);
    passedThisRun = true;
    QuizShare.prepare(result);

    var bestLine = null;
    if (isRecord) bestLine = h('p', { class: 'result__best result__best--new', text: '🎉 Новый рекорд! Было ' + prev + ' из ' + total });
    else if (prev != null) bestLine = h('p', { class: 'result__best', text: '🏆 Ваш лучший результат: ' + best + ' из ' + total });

    var shareBtn = h('button', { class: 'btn btn--primary', type: 'button', 'data-action': 'share', onclick: function () { doShare(shareBtn); } },
      ['📤 Поделиться результатом']);

    document.body.style.setProperty('--c1', t.color);
    document.body.style.setProperty('--c2', t.color2 || t.color);
    render(h('main', { class: 'result' }, [
      h('div', { class: 'result__top' }, [backButton(true), soundButton('sound-btn--light')]),
      h('section', { class: 'result__card' }, [
        h('p', { class: 'result__test' }, [h('span', { class: 'result__emoji', 'aria-hidden': 'true', text: t.emoji }), ' Тест «' + t.title + '»']),
        h('p', { class: 'result__score' }, [
          h('span', { class: 'result__num', text: String(score) }), ' из ' + total
        ]),
        h('p', { class: 'result__rank', text: rank.title }),
        h('p', { class: 'result__text', text: rank.text }),
        bestLine
      ]),
      h('div', { class: 'result__actions' }, [
        shareBtn,
        h('button', { class: 'btn btn--light', type: 'button', 'data-action': 'again', onclick: function () {
          AN.event('replay_clicked', { level_id: t.id, score: score });
          startTest(t, 'again');
        } }, ['🔄 Пройти ещё раз']),
        h('button', { class: 'btn btn--light', type: 'button', 'data-action': 'home', onclick: goHome }, ['📋 Другие тесты'])
      ])
    ]), 'result');
    if (isRecord || score >= 9) QuizSound.correct();
  }

  function doShare(btn) {
    if (!state || !state.result || btn.disabled) return;
    btn.disabled = true;
    var id = state.test.id;
    QuizShare.share(state.result, {
      toast: toast,
      mark: function (ch) { AN.event('share_clicked', { channel: ch, level_id: id }); },
      onOpen: updateBanner,
      onClose: updateBanner
    }).then(null, function () {
      toast('Не получилось поделиться. Попробуйте ещё раз.');
    }).then(function () { btn.disabled = false; });
  }

  /* ---------- клавиатура: 1–4 ответы, Enter — дальше, Esc — к тестам ---------- */

  document.addEventListener('keydown', function (e) {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (adBusy) return;   // ждём рекламу: клавиши слушает окно «Загружаем рекламу» (Esc — отмена)
    if (exitDlg) return;  // окно «Выйти из теста?» слушает клавиши само (Esc — остаться)
    if (QuizShare.isDialogOpen && QuizShare.isDialogOpen()) return; // окно «Поделиться» само слушает клавиши
    var key = e.key;
    var activeKey = key === 'Enter' || key === ' ' || /^[0-9]$/.test(key);
    // Зажатая клавиша и нажатия сразу после смены экрана не считаются
    if (activeKey && (e.repeat || inputLocked())) { e.preventDefault(); return; }
    var focusedButton = document.activeElement && document.activeElement.tagName === 'BUTTON';

    if (key === 'Escape') {
      if (screen !== 'home') { e.preventDefault(); goHome(); }
      return;
    }
    if (screen === 'home') {
      if (/^Arrow(Up|Down|Left|Right)$/.test(key)) { e.preventDefault(); moveCardFocus(key); return; }
      var n = key === '0' ? 10 : parseInt(key, 10);
      if (n >= 1 && n <= Math.min(tests.length, HOME_KEYS)) { e.preventDefault(); openTest(tests[n - 1]); }
      return;
    }
    if (screen === 'intro') {
      if ((key === 'Enter' || key === ' ') && !focusedButton) {
        e.preventDefault();
        var b = app.querySelector('[data-action="start"]');
        if (b) b.click();
      }
      return;
    }
    if (screen !== 'question' || !state) return;

    if (state.phase === 'ask' && !state.answered && /^[1-9]$/.test(key)) {
      var idx = parseInt(key, 10) - 1;
      if (idx < state.order.length) { e.preventDefault(); choose(idx); }
      return;
    }
    if (key === 'Enter' || key === ' ') {
      if (focusedButton) return; // нажатие на кнопку в фокусе браузер обработает сам
      if (state.phase === 'memorize') {
        e.preventDefault();
        if (Date.now() >= state.readyAt) showAsk(state.questions[state.idx]);
      } else if (state.phase === 'ask' && state.answered) { e.preventDefault(); nextQuestion(); }
    }
  }, true);

  // Главный экран: стрелки водят фокус по карточкам тестов (до 11-го и дальше), Enter — открыть
  function moveCardFocus(key) {
    var cards = Array.prototype.slice.call(app.querySelectorAll('.test-card'));
    if (!cards.length) return;
    var i = cards.indexOf(document.activeElement);
    var cols = cards.filter(function (c) { return c.offsetTop === cards[0].offsetTop; }).length || 1;
    var j = 0;
    if (i >= 0) {
      var step = key === 'ArrowDown' ? cols : key === 'ArrowUp' ? -cols : key === 'ArrowRight' ? 1 : -1;
      j = Math.max(0, Math.min(cards.length - 1, i + step));
    }
    try { cards[j].focus({ preventScroll: true }); } catch (e) { cards[j].focus(); }
    try { cards[j].scrollIntoView({ block: 'nearest' }); } catch (e) { /* ничего */ }
  }

  /* ---------- запуск ---------- */

  // Какие ключи хранилища читаем при запуске (одним вызовом)
  function storeKeys() {
    var keys = ['sound', 'daily', 'visits', 'fav'];
    tests.forEach(function (t) { keys.push('best:' + t.id, 'recent:' + t.id); });
    return keys;
  }

  // Ссылка из площадки: во ВК всё после # в адресе приложения приходит как payload («test=ussr»)
  function testFromPayload() {
    var pl = PF && PF.payload;
    if (typeof pl !== 'string') return null;
    var m = pl.replace(/^[#?]/, '').match(/^(?:test=)?([a-z0-9_-]{1,40})$/i);
    return m && tests.filter(function (x) { return x.id === m[1]; })[0] || null;
  }

  function boot() {
    if (!tests.length) {
      app.appendChild(h('p', { class: 'noscript', text: 'Тесты не найдены.' }));
      return;
    }
    var t = testFromUrl();
    if (!t) {
      t = testFromPayload();
      if (t) { try { history.replaceState(null, '', urlWithTest(t.id)); } catch (e) { /* ничего */ } }
    }
    var returning = tests.some(function (x) { return bestOf(x) != null; });
    noteVisit();
    AN.event('app_opened', { entry: t ? 'test' : 'home', returning: returning });
    if (t) {
      // Пришли по ссылке ?test=…: под заставкой кладём главный экран,
      // чтобы «назад» вёл к списку тестов, а не прочь из приложения.
      introSource = 'link';
      if (!(history.state && history.state.quiz === t.id)) { replaceHome(); pushTest(t); }
      showIntro(t);
    } else {
      if (location.search.indexOf('test=') >= 0) replaceHome(); // неизвестный тест — убираем из адреса
      showHome();
    }
  }

  function start() {
    AN.init(PF && PF.hasBridge ? PF.bridge : null, { appVersion: CFG.version || '' });
    if (PF && PF.onPause) PF.onPause(function (paused) {
      if (paused) interruptMemorize(); else resumeAfterAd();
    });
    window.addEventListener('pagehide', function () { noteAbandon('exit'); });
    // Свернули приложение / скрыли вкладку — картинка «запомни» на паузе (и на площадке без Bridge)
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) interruptMemorize(); else resumeAfterAd();
    });
    QuizStore.init(storeKeys()).then(null, function () { /* без сохранённого */ }).then(function () {
      boot();
      appReady = true;
      updateBanner();
      if (PF && PF.gameReady) PF.gameReady();
      AN.ready();
    });
  }

  // Для проверочных скриптов tools/check.js и tools/check-platform.js (ничего не меняет в работе приложения).
  window.QuizApp = {
    tests: tests,
    screen: function () { return screen; },
    state: function () { return state; },
    prepareQuestions: prepareQuestions,
    runLength: runLength,
    levelOf: levelOf,
    order: TEST_ORDER.slice(),
    isReady: function () { return appReady; },
    adGrants: function () { return adGrants; },
    adBusy: function () { return adBusy; },
    exitAsked: function () { return !!exitDlg; },
    dailyTest: dailyTest,
    dayNumber: dayNumber
  };

  start();
})();
