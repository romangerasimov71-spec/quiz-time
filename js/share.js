/* «Поделиться результатом».
   Всё идёт через одну функцию QuizShare.share(result).
   Сейчас (прототип, без SDK): системное «Поделиться» телефона (Web Share с картинкой-файлом),
   а если так нельзя — окно с самой картинкой (сохранить / скачать) и кнопкой
   «Скопировать текст со ссылкой». Потом сюда встанет VK Bridge (VKWebAppShowWallPostBox)
   и ОК — см. пометку в share().

   result = { test, score, total, rank: { title, text } } */
window.QuizShare = (function () {
  var APP_URL = 'https://romangerasimov71-spec.github.io/quiz-time/';
  var SIZE = 1080;
  var FONT = "'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";
  var EMOJI_FONT = "'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', sans-serif";

  function shareUrl(result) { return APP_URL + '?test=' + encodeURIComponent(result.test.id); }

  function shareText(result) {
    return 'Мой результат в тесте «' + result.test.title + '»: ' + result.score + ' из ' +
      result.total + ' — «' + result.rank.title + '»! А ты сколько наберёшь? Пройди тест: ' + shareUrl(result);
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /* Разбить текст на строки по ширине; если не влезает в maxLines — уменьшить шрифт. */
  function fitLines(ctx, text, maxWidth, size, weight, maxLines) {
    for (var s = size; s >= 28; s -= 4) {
      ctx.font = weight + ' ' + s + 'px ' + FONT;
      var words = text.split(' '), lines = [], line = '';
      for (var i = 0; i < words.length; i++) {
        var test = line ? line + ' ' + words[i] : words[i];
        if (ctx.measureText(test).width > maxWidth && line) { lines.push(line); line = words[i]; }
        else line = test;
      }
      if (line) lines.push(line);
      var tooWide = lines.some(function (l) { return ctx.measureText(l).width > maxWidth; });
      if (lines.length <= maxLines && !tooWide) return { lines: lines, size: s };
    }
    return { lines: lines, size: 28 };
  }

  function drawLines(ctx, fit, cx, y, lineHeight) {
    for (var i = 0; i < fit.lines.length; i++) ctx.fillText(fit.lines[i], cx, y + i * fit.size * lineHeight);
    return y + fit.lines.length * fit.size * lineHeight;
  }

  /* Картинка-карточка результата 1080×1080, нарисованная кодом. */
  function makeCard(result) {
    var t = result.test;
    var c = document.createElement('canvas');
    c.width = SIZE; c.height = SIZE;
    var ctx = c.getContext('2d');
    var cx = SIZE / 2;

    // Фон — цвет теста
    var g = ctx.createLinearGradient(0, 0, SIZE, SIZE);
    g.addColorStop(0, t.color); g.addColorStop(1, t.color2 || t.color);
    ctx.fillStyle = g; ctx.fillRect(0, 0, SIZE, SIZE);

    // Праздничные кружочки
    var dots = [[90, 120, 46], [990, 90, 30], [1010, 980, 60], [70, 960, 34], [960, 520, 18], [120, 560, 22]];
    ctx.fillStyle = 'rgba(255,255,255,0.16)';
    dots.forEach(function (d) { ctx.beginPath(); ctx.arc(d[0], d[1], d[2], 0, Math.PI * 2); ctx.fill(); });

    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';

    // Название приложения
    ctx.fillStyle = '#ffffff';
    ctx.font = '800 50px ' + FONT;
    ctx.fillText('ВИКТОРИНЫ', cx, 108);

    // Белая карточка
    var cardX = 90, cardY = 160, cardW = SIZE - 180, cardH = 690;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.25)'; ctx.shadowBlur = 40; ctx.shadowOffsetY = 12;
    ctx.fillStyle = '#fffaf2';
    roundRect(ctx, cardX, cardY, cardW, cardH, 56); ctx.fill();
    ctx.restore();

    // Эмодзи теста
    ctx.font = '130px ' + EMOJI_FONT;
    ctx.fillText(t.emoji, cx, cardY + 165);

    // Название теста
    ctx.fillStyle = '#3a2a1c';
    var titleFit = fitLines(ctx, 'Тест «' + t.title + '»', cardW - 100, 58, '700', 1);
    ctx.font = '700 ' + titleFit.size + 'px ' + FONT;
    drawLines(ctx, titleFit, cx, cardY + 255, 1.2);

    // Счёт
    ctx.fillStyle = t.color;
    ctx.font = '900 190px ' + FONT;
    ctx.fillText(result.score + ' из ' + result.total, cx, cardY + 450);

    // Звание
    ctx.fillStyle = '#3a2a1c';
    var rankFit = fitLines(ctx, '«' + result.rank.title + '»', cardW - 100, 66, '800', 2);
    ctx.font = '800 ' + rankFit.size + 'px ' + FONT;
    var rankY = rankFit.lines.length > 1 ? cardY + 545 : cardY + 580;
    drawLines(ctx, rankFit, cx, rankY, 1.15);

    // Призыв
    ctx.fillStyle = '#ffffff';
    ctx.font = '800 64px ' + FONT;
    ctx.fillText('А ты сколько наберёшь?', cx, 950);
    ctx.font = '500 34px ' + FONT;
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fillText(APP_URL.replace(/^https:\/\//, '').replace(/\/$/, ''), cx, 1020);

    return c;
  }

  /* Картинка — JPEG: в 5–6 раз легче PNG, на вид то же самое. */
  var CARD_TYPE = 'image/jpeg', CARD_EXT = 'jpg', CARD_QUALITY = 0.9;

  function cardBlob(result) {
    return new Promise(function (resolve) {
      var c = makeCard(result);
      if (c.toBlob) c.toBlob(function (b) { resolve(b); }, CARD_TYPE, CARD_QUALITY);
      else resolve(null);
    });
  }

  /* Готовим картинку заранее (при показе результата), чтобы «Поделиться»
     срабатывало сразу по нажатию — некоторые телефоны требуют этого. */
  var prepared = null;
  function prepare(result) {
    prepared = { result: result, blob: cardBlob(result) };
    return prepared.blob;
  }

  /* Разрешено ли странице (например, внутри чужого iframe) пользоваться функцией.
     Если не спросить заранее, браузер пишет ошибку в консоль. */
  function policyAllows(feature) {
    try {
      var p = document.permissionsPolicy || document.featurePolicy;
      if (p && typeof p.allowsFeature === 'function') {
        // Браузер не знает такой функции (например, нет web-share на компьютере) — решает сам вызов
        if (typeof p.features === 'function' && p.features().indexOf(feature) === -1) return true;
        return p.allowsFeature(feature);
      }
    } catch (e) { /* ничего */ }
    return true;
  }

  function copyText(text) {
    function legacy() {
      try {
        var ta = document.createElement('textarea');
        ta.value = text; ta.setAttribute('readonly', '');
        ta.style.position = 'fixed'; ta.style.top = '0'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        var ok = document.execCommand('copy');
        ta.remove();
        return !!ok;
      } catch (e) { return false; }
    }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext !== false && policyAllows('clipboard-write')) {
        return navigator.clipboard.writeText(text).then(function () { return true; }, legacy);
      }
    } catch (e) { /* ничего */ }
    return Promise.resolve(legacy());
  }

  function isTouchDevice() {
    try { return window.matchMedia('(hover: none) and (pointer: coarse)').matches; } catch (e) { return false; }
  }

  function canShareFile(file) {
    if (!file || !navigator.share || !navigator.canShare || !policyAllows('web-share')) return false;
    try { return navigator.canShare({ files: [file] }); } catch (e) { return false; }
  }
  function canShareText() { return !!navigator.share && policyAllows('web-share'); }

  /* ---------- окно с картинкой (если системное «Поделиться» с файлом недоступно) ---------- */
  var dialog = null;

  function closeDialog() {
    if (!dialog) return;
    var d = dialog; dialog = null;
    document.removeEventListener('keydown', d.onKey, true);
    d.el.remove();
    setTimeout(function () { URL.revokeObjectURL(d.url); }, 1000);
    if (d.returnFocus && d.returnFocus.isConnected) { try { d.returnFocus.focus({ preventScroll: true }); } catch (e) { /* ничего */ } }
  }

  function el(tag, attrs, kids) {
    var e = document.createElement(tag);
    for (var k in (attrs || {})) {
      if (k === 'text') e.textContent = attrs[k];
      else if (k === 'class') e.className = attrs[k];
      else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), attrs[k]);
      else e.setAttribute(k, attrs[k]);
    }
    (kids || []).forEach(function (c) { if (c) e.appendChild(c); });
    return e;
  }

  function openDialog(blob, result, fullText, toast) {
    closeDialog();
    var url = URL.createObjectURL(blob);
    var touch = isTouchDevice();
    var textEl = el('p', { class: 'share-dialog__text', text: fullText });
    var copyBtn = el('button', { class: 'btn btn--ghost', type: 'button', 'data-action': 'copy', text: '📋 Скопировать текст со ссылкой',
      onclick: function () {
        copyText(fullText).then(function (ok) {
          if (ok) toast('Текст со ссылкой скопирован — вставьте его в сообщение другу.');
          else {
            toast('Не получилось скопировать. Выделите текст над кнопкой и скопируйте вручную.');
            try { var r = document.createRange(); r.selectNodeContents(textEl); var s = window.getSelection(); s.removeAllRanges(); s.addRange(r); } catch (e) { /* ничего */ }
          }
        });
      } });
    var sendBtn = canShareText() ? el('button', { class: 'btn btn--ghost', type: 'button', 'data-action': 'send-link', text: '📤 Отправить ссылку',
      onclick: function () {
        try { navigator.share({ title: 'Викторины', text: fullText }).then(null, function () { /* передумал — ничего */ }); } catch (e) { /* ничего */ }
      } }) : null;
    var download = touch ? null : el('a', { class: 'btn btn--primary', href: url, download: 'viktoriny-' + result.test.id + '-' + result.score + '.' + CARD_EXT,
      'data-action': 'download', text: '⬇ Скачать картинку' });
    var closeBtn = el('button', { class: 'share-dialog__close', type: 'button', 'data-action': 'close', 'aria-label': 'Закрыть', text: '✕', onclick: closeDialog });

    var box = el('div', { class: 'share-dialog__box', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Поделиться результатом' }, [
      closeBtn,
      el('h2', { class: 'share-dialog__title', text: 'Ваша картинка с результатом' }),
      el('img', { class: 'share-dialog__img', src: url, alt: 'Тест «' + result.test.title + '»: ' + result.score + ' из ' + result.total + ' — «' + result.rank.title + '»' }),
      touch ? el('p', { class: 'share-dialog__hint', text: 'Нажмите на картинку и подержите палец — телефон предложит сохранить её или отправить.' }) : null,
      download,
      el('p', { class: 'share-dialog__label', text: 'Текст для друзей:' }),
      textEl,
      copyBtn,
      sendBtn
    ]);
    var wrap = el('div', { class: 'share-dialog', 'data-share-dialog': '', onclick: function (e) { if (e.target === wrap) closeDialog(); } }, [box]);
    var onKey = function (e) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeDialog(); } };
    document.addEventListener('keydown', onKey, true);
    dialog = { el: wrap, url: url, onKey: onKey, returnFocus: document.activeElement };
    document.body.appendChild(wrap);
    try { (download || copyBtn).focus({ preventScroll: true }); } catch (e) { /* ничего */ }
  }

  /* Главная функция. Возвращает Promise с одним из:
     'shared' — отправлено через системное «Поделиться», 'cancelled' — человек передумал,
     'dialog' — открыто окно с картинкой и текстом. opts.toast(text) — показать подсказку. */
  function share(result, opts) {
    var toast = (opts && opts.toast) || function () {};
    var fullText = shareText(result);
    var blobPromise = (prepared && prepared.result === result) ? prepared.blob : cardBlob(result);

    // === Здесь потом: ВК — VKWebAppShowWallPostBox, ОК — FAPI.UI.postMediatopic ===

    return blobPromise.then(function (blob) {
      var file = null;
      try { if (blob) file = new File([blob], 'viktoriny-result.' + CARD_EXT, { type: CARD_TYPE }); } catch (e) { file = null; }

      if (canShareFile(file)) {
        return navigator.share({ files: [file], title: 'Викторины', text: fullText }).then(function () { return 'shared'; }, function (err) {
          if (err && err.name === 'AbortError') return 'cancelled';
          openDialog(blob, result, fullText, toast);
          return 'dialog';
        });
      }
      if (!blob) { // совсем старый браузер: хотя бы текст
        return copyText(fullText).then(function (ok) {
          toast(ok ? 'Текст со ссылкой скопирован — вставьте его в сообщение другу.' : 'Не получилось поделиться на этом устройстве.');
          return 'text';
        });
      }
      openDialog(blob, result, fullText, toast);
      return 'dialog';
    });
  }

  return {
    share: share, prepare: prepare, makeCard: makeCard, shareText: shareText, shareUrl: shareUrl,
    closeDialog: closeDialog, isDialogOpen: function () { return !!dialog; }, APP_URL: APP_URL
  };
})();
