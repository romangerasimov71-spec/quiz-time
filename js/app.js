/* Движок викторин. Ничего не знает о конкретных тестах:
   берёт их из window.QUIZ_TESTS (каждый тест — свой файл в tests/). */
(function () {
  'use strict';

  var INPUT_LOCK_MS = 400;     // после смены экрана столько игнорируем нажатия (двойной тап)
  var READY_DELAY_MS = 1500;   // «Готово, спрашивайте!» активна не раньше, чем через столько
  var HOME_COLOR = '#bf360c';

  var app = document.getElementById('app');
  var toastEl = document.getElementById('toast');
  var tests = (window.QUIZ_TESTS || []).filter(validTest);

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

  var EMOJI_RE = /^(?:\p{Extended_Pictographic}|\p{Emoji_Component})+$/u;
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

  function bestOf(test) { return QuizStore.getBest(test.id, test.questions.length); }

  function setTheme(color) {
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', color);
    document.documentElement.style.setProperty('--accent', color);
  }

  var toastTimer = null;
  function toast(text) {
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
    screen = name;
    app.innerHTML = '';
    app.setAttribute('data-screen', name);
    document.body.className = 'on-' + name;
    app.appendChild(node);
    window.scrollTo(0, 0);
    lockInput(INPUT_LOCK_MS);
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

  // «‹ Тесты», «Другие тесты», Esc: шаг назад по истории (как кнопка «назад» телефона)
  function goHome() {
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

  window.addEventListener('popstate', function () {
    var t = testFromUrl();
    if (t) showIntro(t); else showHome();
  });

  /* ---------- главный экран ---------- */

  function openTest(t) {
    pushTest(t);
    showIntro(t);
  }

  function showHome() {
    state = null;
    setTheme(HOME_COLOR);
    var cards = tests.map(function (t, i) {
      var best = bestOf(t);
      var total = t.questions.length;
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
            h('span', { class: 'chip', text: wordQuestions(total) }),
            best != null ? h('span', { class: 'chip chip--best', text: '🏆 ' + best + ' из ' + total }) : null
          ])
        ]),
        h('span', { class: 'test-card__key', 'aria-hidden': 'true', text: String(i + 1) })
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
      h('div', { class: 'cards' }, cards)
    ]), 'home');
  }

  /* ---------- заставка теста ---------- */

  function showIntro(t) {
    state = null;
    setTheme(t.color);
    document.body.style.setProperty('--c1', t.color);
    document.body.style.setProperty('--c2', t.color2 || t.color);
    var best = bestOf(t);
    var startBtn = h('button', { class: 'btn btn--primary btn--start', type: 'button', 'data-action': 'start',
      onclick: function () { startTest(t); } }, ['Начать']);
    render(h('main', { class: 'intro' }, [
      h('div', { class: 'result__top' }, [backButton(true), soundButton('sound-btn--light')]),
      h('section', { class: 'intro__card' }, [
        h('div', { class: 'intro__emoji', 'aria-hidden': 'true', text: t.emoji }),
        h('h1', { class: 'intro__title', text: t.title }),
        h('p', { class: 'intro__count', text: wordQuestions(t.questions.length) }),
        h('p', { class: 'intro__text', text: t.intro || t.subtitle || '' }),
        best != null ? h('p', { class: 'intro__best', text: '🏆 Ваш лучший результат: ' + best + ' из ' + t.questions.length }) : null,
        startBtn
      ])
    ]), 'intro');
  }

  /* ---------- прохождение ---------- */

  // Готовим вопросы на это прохождение: «запомни» генерируются заново,
  // обычные перемешиваются внутри первой и второй половины (лёгкие остаются в начале).
  function prepareQuestions(test) {
    var qs = test.questions.map(function (q) { return typeof q.make === 'function' ? q.make() : q; });
    if (test.keepOrder) return qs;
    var half = Math.ceil(qs.length / 2);
    return shuffle(qs.slice(0, half)).concat(shuffle(qs.slice(half)));
  }

  function startTest(test) {
    QuizSound.unlock();
    setTheme(test.color);
    var qs = prepareQuestions(test);
    state = { test: test, questions: qs, idx: 0, score: 0, total: qs.length, answered: false };
    showQuestion();
  }

  function topBar() {
    var t = state.test;
    var n = state.idx + 1;
    return h('div', { class: 'topbar' }, [
      h('div', { class: 'topbar__row' }, [
        backButton(false),
        h('div', { class: 'topbar__count', text: 'Вопрос ' + n + ' из ' + state.total }),
        soundButton()
      ]),
      h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(state.total), 'aria-valuenow': String(n - 1) }, [
        h('div', { class: 'progress__fill', style: 'width:' + ((n - 1) / state.total * 100) + '%' })
      ]),
      h('div', { class: 'topbar__test', text: t.emoji + ' ' + t.title })
    ]);
  }

  function memoryGrid(q, small) {
    var cols = q.cols || Math.min(q.show.length, 4);
    return h('div', { class: 'mem-grid' + (small ? ' mem-grid--small' : ''), style: '--cols:' + cols }, q.show.map(function (it) {
      if (it === '' || it == null) return h('div', { class: 'mem-cell mem-cell--empty' });
      if (typeof it === 'object' && it.color) {
        return h('div', { class: 'mem-cell' }, [h('span', { class: 'mem-dot', style: 'background:' + it.color })]);
      }
      return h('div', { class: 'mem-cell' }, [h('span', { class: 'mem-emoji', text: String(it) })]);
    }));
  }

  function showQuestion() {
    var q = state.questions[state.idx];
    state.answered = false;
    if (q.type === 'memory') showMemorize(q);
    else showAsk(q);
  }

  /* Тип «запомни»: сначала показываем набор на q.seconds секунд. */
  function showMemorize(q) {
    var secs = q.seconds || 5;
    state.phase = 'memorize';
    state.readyAt = Date.now() + READY_DELAY_MS;
    var endAt = Date.now() + secs * 1000;
    var bar = h('div', { class: 'timer__fill', style: 'animation-duration:' + secs + 's' });
    var secsEl = h('b', { class: 'memorize__secs', text: String(secs) });
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
    later(function () { ready.disabled = false; }, READY_DELAY_MS);
    (function tick() {
      var left = Math.max(0, Math.ceil((endAt - Date.now()) / 1000));
      secsEl.textContent = String(left);
      if (left > 0) later(tick, Math.min(1000, endAt - Date.now() - (left - 1) * 1000 + 5));
    })();
    later(go, secs * 1000);
  }

  function showAsk(q) {
    state.phase = 'ask';
    var answers = q.a.map(function (text, i) { return { text: text, correct: i === (q.correct || 0) }; });
    var order = shuffle(answers);
    state.order = order;
    var emojiAnswers = order.every(function (a) { return isEmojiOnly(a.text); });

    var buttons = order.map(function (a, i) {
      return h('button', {
        class: 'answer' + (emojiAnswers ? ' answer--emoji' : ''), type: 'button', 'data-index': String(i),
        onclick: function () { choose(i); }
      }, [
        h('span', { class: 'answer__key', 'aria-hidden': 'true', text: String(i + 1) }),
        h('span', { class: 'answer__text', text: a.text })
      ]);
    });

    render(h('main', { class: 'quiz' }, [
      topBar(),
      h('section', { class: 'ask' }, [
        h('h2', { class: 'question', text: q.q }),
        h('div', { class: 'answers' + (emojiAnswers ? ' answers--emoji' : '') }, buttons),
        h('div', { class: 'feedback', hidden: true })
      ])
    ]), 'question');
  }

  function choose(i) {
    if (!state || state.phase !== 'ask' || state.answered) return;
    QuizSound.unlock();
    state.answered = true;
    var q = state.questions[state.idx];
    var picked = state.order[i];
    var right = picked.correct;
    if (right) { state.score++; QuizSound.correct(); } else { QuizSound.wrong(); }

    var btns = app.querySelectorAll('.answer');
    Array.prototype.forEach.call(btns, function (b, k) {
      b.disabled = true;
      var a = state.order[k];
      if (a.correct) b.classList.add('is-correct');
      else if (k === i) b.classList.add('is-wrong');
      else b.classList.add('is-dim');
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
        h('button', { class: 'btn btn--light', type: 'button', 'data-action': 'again', onclick: function () { startTest(t); } }, ['🔄 Пройти ещё раз']),
        h('button', { class: 'btn btn--light', type: 'button', 'data-action': 'home', onclick: goHome }, ['📋 Другие тесты'])
      ])
    ]), 'result');
    if (isRecord || score >= 9) QuizSound.correct();
  }

  function doShare(btn) {
    if (!state || !state.result || btn.disabled) return;
    btn.disabled = true;
    QuizShare.share(state.result, { toast: toast }).then(null, function () {
      toast('Не получилось поделиться. Попробуйте ещё раз.');
    }).then(function () { btn.disabled = false; });
  }

  /* ---------- клавиатура: 1–4 ответы, Enter — дальше, Esc — к тестам ---------- */

  document.addEventListener('keydown', function (e) {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
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
      var n = parseInt(key, 10);
      if (n >= 1 && n <= tests.length) { e.preventDefault(); openTest(tests[n - 1]); }
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

  /* ---------- запуск ---------- */

  function boot() {
    if (!tests.length) {
      app.appendChild(h('p', { class: 'noscript', text: 'Тесты не найдены.' }));
      return;
    }
    var t = testFromUrl();
    if (t) {
      // Пришли по ссылке ?test=…: под заставкой кладём главный экран,
      // чтобы «назад» вёл к списку тестов, а не прочь из приложения.
      if (!(history.state && history.state.quiz === t.id)) { replaceHome(); pushTest(t); }
      showIntro(t);
    } else {
      if (location.search.indexOf('test=') >= 0) replaceHome(); // неизвестный тест — убираем из адреса
      showHome();
    }
  }

  // Для проверочного скрипта tools/check.js (ничего не меняет в работе приложения).
  window.QuizApp = {
    tests: tests,
    screen: function () { return screen; },
    state: function () { return state; },
    prepareQuestions: prepareQuestions
  };

  boot();
})();
