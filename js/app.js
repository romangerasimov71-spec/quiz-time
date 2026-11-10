/* Движок викторин. Ничего не знает о конкретных тестах:
   берёт их из window.QUIZ_TESTS (каждый тест — свой файл в tests/). */
(function () {
  'use strict';

  var TOTAL_DEFAULT = 10;
  var app = document.getElementById('app');
  var toastEl = document.getElementById('toast');
  var tests = (window.QUIZ_TESTS || []).filter(validTest);

  var state = null;      // текущее прохождение
  var screen = 'home';   // home | question | result
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

  function setTheme(color) {
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', color);
    document.documentElement.style.setProperty('--accent', color);
  }

  var toastTimer = null;
  function toast(text) {
    toastEl.textContent = text;
    toastEl.hidden = false;
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

  function render(node, name) {
    clearTimers();
    screen = name;
    app.innerHTML = '';
    app.setAttribute('data-screen', name);
    document.body.className = 'on-' + name;
    app.appendChild(node);
    window.scrollTo(0, 0);
  }

  /* ---------- главный экран ---------- */

  function showHome() {
    state = null;
    setTheme('#d84315');
    var cards = tests.map(function (t, i) {
      var best = QuizStore.getBest(t.id);
      var total = t.questions.length;
      return h('button', {
        class: 'test-card', type: 'button', 'data-test': t.id,
        style: '--c1:' + t.color + ';--c2:' + (t.color2 || t.color),
        onclick: function () { startTest(t); }
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

  /* ---------- прохождение ---------- */

  function startTest(test) {
    QuizSound.unlock();
    setTheme(test.color);
    state = { test: test, idx: 0, score: 0, total: test.questions.length, answered: false };
    showQuestion();
  }

  function topBar() {
    var t = state.test;
    var n = state.idx + 1;
    return h('div', { class: 'topbar' }, [
      h('div', { class: 'topbar__row' }, [
        h('button', { class: 'icon-btn back-btn', type: 'button', 'aria-label': 'К списку тестов', onclick: showHome }, ['‹ Тесты']),
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
    var q = state.test.questions[state.idx];
    state.answered = false;
    if (q.type === 'memory') showMemorize(q);
    else showAsk(q);
  }

  /* Тип «запомни»: сначала показываем набор на q.seconds секунд. */
  function showMemorize(q) {
    var secs = q.seconds || 5;
    state.phase = 'memorize';
    var bar = h('div', { class: 'timer__fill', style: 'animation-duration:' + secs + 's' });
    var go = function () { if (state && state.phase === 'memorize') showAsk(q); };
    render(h('main', { class: 'quiz' }, [
      topBar(),
      h('section', { class: 'memorize' }, [
        h('h2', { class: 'memorize__title', text: 'Запомните картинку!' }),
        h('p', { class: 'memorize__hint', text: 'Через ' + secs + ' сек. она исчезнет' }),
        memoryGrid(q),
        h('div', { class: 'timer' }, [bar]),
        h('button', { class: 'btn btn--ghost', type: 'button', 'data-action': 'ready', onclick: go }, ['Готово, спрашивайте!'])
      ])
    ]), 'question');
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
    var q = state.test.questions[state.idx];
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

    // Двигаем полоску прогресса
    var fill = app.querySelector('.progress__fill');
    if (fill) fill.style.width = ((state.idx + 1) / state.total * 100) + '%';

    try { next.focus({ preventScroll: true }); } catch (e) { next.focus(); }
    later(function () {
      try { next.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e) { /* ничего */ }
    }, 60);
  }

  function nextQuestion() {
    if (!state || !state.answered) return;
    state.idx++;
    if (state.idx >= state.total) showResult();
    else showQuestion();
  }

  /* ---------- результат ---------- */

  function showResult() {
    var t = state.test;
    var score = state.score, total = state.total;
    var rank = rankFor(t, score);
    var prev = QuizStore.getBest(t.id);
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
      h('div', { class: 'result__top' }, [
        h('button', { class: 'icon-btn back-btn back-btn--light', type: 'button', 'aria-label': 'К списку тестов', onclick: showHome }, ['‹ Тесты']),
        soundButton('sound-btn--light')
      ]),
      h('section', { class: 'result__card' }, [
        h('div', { class: 'result__emoji', 'aria-hidden': 'true', text: t.emoji }),
        h('p', { class: 'result__test', text: 'Тест «' + t.title + '»' }),
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
        h('button', { class: 'btn btn--light', type: 'button', 'data-action': 'home', onclick: showHome }, ['📋 Другие тесты'])
      ])
    ]), 'result');
    if (isRecord || score >= 9) QuizSound.correct();
  }

  function doShare(btn) {
    if (!state || !state.result || btn.disabled) return;
    btn.disabled = true;
    QuizShare.share(state.result).then(function (how) {
      if (how === 'saved+copied') toast('Картинка сохранена, а текст со ссылкой скопирован — вставьте его в сообщение другу.');
      else if (how === 'saved') toast('Картинка с результатом сохранена — отправьте её друзьям!');
      else if (how === 'copied') toast('Текст со ссылкой скопирован — вставьте его в сообщение другу.');
      else if (how === 'failed') toast('Не получилось поделиться. Попробуйте ещё раз.');
    }, function () {
      toast('Не получилось поделиться. Попробуйте ещё раз.');
    }).then(function () { btn.disabled = false; });
  }

  /* ---------- клавиатура: 1–4 ответы, Enter — дальше, Esc — к тестам ---------- */

  document.addEventListener('keydown', function (e) {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    var key = e.key;
    var focusedButton = document.activeElement && document.activeElement.tagName === 'BUTTON' && document.activeElement !== document.body;

    if (key === 'Escape') {
      if (screen !== 'home') { e.preventDefault(); showHome(); }
      return;
    }
    if (screen === 'home') {
      var n = parseInt(key, 10);
      if (n >= 1 && n <= tests.length) { e.preventDefault(); startTest(tests[n - 1]); }
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
      if (state.phase === 'memorize') { e.preventDefault(); showAsk(state.test.questions[state.idx]); }
      else if (state.phase === 'ask' && state.answered) { e.preventDefault(); nextQuestion(); }
    }
  });

  /* ---------- запуск ---------- */

  function boot() {
    if (!tests.length) {
      app.appendChild(h('p', { class: 'noscript', text: 'Тесты не найдены.' }));
      return;
    }
    var wanted = null;
    try { wanted = new URLSearchParams(location.search).get('test'); } catch (e) { wanted = null; }
    var t = wanted && tests.filter(function (x) { return x.id === wanted; })[0];
    if (t) startTest(t); else showHome();
  }

  // Для проверочного скрипта tools/check.js (ничего не меняет в работе приложения).
  window.QuizApp = {
    tests: tests,
    screen: function () { return screen; },
    state: function () { return state; }
  };

  boot();
})();
