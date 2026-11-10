/* «Поделиться результатом».
   Всё идёт через одну функцию QuizShare.share(result).
   Сейчас (прототип, без SDK): системное «Поделиться» телефона (Web Share, с картинкой,
   если браузер умеет), иначе — скачать картинку и скопировать текст со ссылкой.
   Потом сюда встанет VK Bridge (VKWebAppShowWallPostBox) и ОК — см. пометку ниже.

   result = { test, score, total, rank: { title, text } } */
window.QuizShare = (function () {
  var APP_URL = 'https://romangerasimov71-spec.github.io/quiz-time/';
  var SIZE = 1080;
  var FONT = "'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";
  var EMOJI_FONT = "'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', sans-serif";

  function shareUrl(result) { return APP_URL + '?test=' + encodeURIComponent(result.test.id); }

  function shareText(result) {
    return 'Мой результат в тесте «' + result.test.title + '»: ' + result.score + ' из ' +
      result.total + ' — «' + result.rank.title + '»! А ты сколько наберёшь?';
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

  function cardBlob(result) {
    return new Promise(function (resolve) {
      var c = makeCard(result);
      if (c.toBlob) c.toBlob(function (b) { resolve(b); }, 'image/png');
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

  function download(blob, result) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'viktoriny-' + result.test.id + '-' + result.score + '.png';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
  }

  function copyText(text) {
    function legacy() {
      try {
        var ta = document.createElement('textarea');
        ta.value = text; ta.setAttribute('readonly', '');
        ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        var ok = document.execCommand('copy');
        ta.remove();
        return ok;
      } catch (e) { return false; }
    }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text).then(function () { return true; }, legacy);
      }
    } catch (e) { /* ничего */ }
    return Promise.resolve(legacy());
  }

  /* Главная функция. Возвращает Promise с одним из:
     'shared' — отправлено через «Поделиться», 'cancelled' — человек передумал,
     'saved+copied' / 'saved' — картинка скачана (и текст скопирован). */
  function share(result) {
    var text = shareText(result);
    var url = shareUrl(result);
    var blobPromise = (prepared && prepared.result === result) ? prepared.blob : cardBlob(result);

    // === Здесь потом: ВК — VKWebAppShowWallPostBox, ОК — FAPI.UI.postMediatopic ===

    return blobPromise.then(function (blob) {
      var file = null;
      try { if (blob) file = new File([blob], 'viktoriny-result.png', { type: 'image/png' }); } catch (e) { file = null; }

      var tryShare = null;
      if (file && navigator.canShare && navigator.share) {
        try { if (navigator.canShare({ files: [file] })) tryShare = { files: [file], title: 'Викторины', text: text + ' ' + url }; } catch (e) { /* ничего */ }
      }
      if (!tryShare && navigator.share && isTouchDevice()) {
        tryShare = { title: 'Викторины', text: text, url: url };
      }

      if (tryShare) {
        return navigator.share(tryShare).then(function () { return 'shared'; }, function (err) {
          if (err && err.name === 'AbortError') return 'cancelled';
          return fallback(blob, text + ' ' + url, result);
        });
      }
      return fallback(blob, text + ' ' + url, result);
    });
  }

  function fallback(blob, fullText, result) {
    if (blob) download(blob, result);
    return copyText(fullText).then(function (ok) {
      return blob ? (ok ? 'saved+copied' : 'saved') : (ok ? 'copied' : 'failed');
    });
  }

  function isTouchDevice() {
    try { return window.matchMedia('(pointer: coarse)').matches; } catch (e) { return false; }
  }

  return { share: share, prepare: prepare, makeCard: makeCard, shareText: shareText, shareUrl: shareUrl, APP_URL: APP_URL };
})();
