#!/usr/bin/env node
/* Проверка прототипа «Викторины» в настоящем браузере (Playwright + Chromium).

   Запуск из корня репозитория:
     node tools/check.js                 — все проверки
     node tools/check.js --shots /путь   — плюс скриншоты всех экранов в эту папку
     node tools/check.js --only memory   — только один тест (по id) на основных экранах
     node tools/check.js --extra-only    — только блок «Дополнительно» (быстро, ~2 мин)

   Что делает:
   - поднимает маленький локальный сервер с папкой репозитория;
   - на трёх экранах (телефон-портрет 390×844, телефон-альбом 844×390, компьютер 1280×800)
     проходит ВСЕ тесты до конца: тапом, мышью и клавиатурой (1–4, Enter), с заставкой;
   - проверяет: заставку теста, «Вопрос N из 10», цвет верного/неверного, «А вы знали?»,
     перемешивание вариантов и вопросов, генерацию вопросов «запомни» (ответ верен по картинке),
     обратный отсчёт секунд, защиту от двойного тапа и зажатого Enter, итоговый счёт и звание,
     «Пройти ещё раз», «Другие тесты», кнопку «назад» браузера, лучший результат,
     кнопку звука, размеры и контраст, узкий экран 280px, «Поделиться» на 360×640 без прокрутки,
     работу без localStorage, испорченный рекорд, ссылку ?test=…, работу внутри чужого iframe;
   - «Поделиться»: системное меню (картинка 1080×1080 уходит файлом) и окно с картинкой
     (скачать / подержать палец, скопировать текст со ссылкой);
   - любая ошибка в консоли браузера = провал.
   Код выхода 0 — всё хорошо, 1 — есть проблемы (они перечислены). */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const APP_URL = 'https://romangerasimov71-spec.github.io/quiz-time/';
const args = process.argv.slice(2);
const argVal = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const SHOTS = argVal('--shots');
const ONLY = argVal('--only');
const EXTRA_ONLY = args.includes('--extra-only'); // только «Дополнительно» (быстрее)
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const problems = [];
function fail(where, msg) { problems.push(`[${where}] ${msg}`); console.log(`  ✗ [${where}] ${msg}`); }
function check(cond, where, msg) { if (!cond) fail(where, msg); return !!cond; }

/* ---------- локальный сервер (+ страница с чужим iframe) ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon' };
function startServer() {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/__frame.html') {
      const src = u.searchParams.get('src');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(`<!doctype html><meta charset="utf-8"><body style="margin:0"><iframe id="f" src="${src}" style="border:0;width:390px;height:844px"></iframe>`);
    }
    let p = decodeURIComponent(u.pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = path.join(ROOT, p);
    if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    resolve({ server, port, url: `http://127.0.0.1:${port}/` });
  }));
}

/* ---------- размеры картинок из заголовков ---------- */
function imageSize(buf) {
  if (buf.slice(0, 8).toString('hex') === '89504e470d0a1a0a') return { type: 'png', w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const m = buf[i + 1];
      if (m >= 0xc0 && m <= 0xc3) return { type: 'jpeg', h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return null;
}

/* ---------- контраст (WCAG) ---------- */
function rgb(hex) { hex = hex.replace('#', ''); return [0, 2, 4].map((i) => parseInt(hex.substr(i, 2), 16)); }
function lum(c) { const v = c.map((x) => x / 255).map((x) => (x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4))); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; }
function contrast(a, b) { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
function parseCss(c) { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(',').map((s) => parseFloat(s)); return { c: p.slice(0, 3), a: p.length > 3 ? p[3] : 1 }; }
function blend(top, a, under) { return top.map((v, i) => v * a + under[i] * (1 - a)); }

/* Заглушки для «Поделиться» */
const SHARE_STUB = `
  window.__shared = null;
  Object.defineProperty(navigator, 'canShare', { configurable: true, value: (d) => !!(d && d.files && d.files.length) });
  Object.defineProperty(navigator, 'share', { configurable: true, value: async (d) => {
    const f = d.files && d.files[0];
    let w = 0, h = 0, type = '', size = 0;
    if (f) { const bmp = await createImageBitmap(f); w = bmp.width; h = bmp.height; type = f.type; size = f.size; }
    window.__shared = { text: d.text || '', title: d.title || '', url: d.url || '', w, h, type, size, files: d.files ? d.files.length : 0 };
  }});
`;
const NO_SHARE_STUB = `
  window.__copied = null;
  Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
  Object.defineProperty(navigator, 'canShare', { configurable: true, value: undefined });
  try {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: (t) => { window.__copied = t; return Promise.resolve(); } } });
  } catch (e) {}
`;
const NO_STORAGE_STUB = `
  Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new Error('storage blocked'); } });
`;

const VIEWPORTS = [
  { name: 'телефон-портрет 390×844', short: 'phone', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, mode: 'touch', share: 'web-share', waitTimer: true },
  { name: 'телефон-альбом 844×390 (без системного «Поделиться»)', short: 'land', viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, mode: 'touch', share: 'dialog-touch' },
  { name: 'компьютер 1280×800', short: 'desk', viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1, mode: 'mouse+keys', share: 'dialog-desk' }
];

async function shot(page, name) {
  if (!SHOTS || !page.screenshot) return;
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(SHOTS, name + '.png') });
}

/* Ждём, пока экран «остынет» (защита от двойного нажатия снята) */
async function ready(page) { await page.waitForSelector('#app[data-input="ready"]', { timeout: 5000 }); }

async function noHorizontalScroll(page, where) {
  const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: window.innerWidth }));
  check(r.sw <= r.w + 1, where, `горизонтальная прокрутка: ширина страницы ${r.sw} > экрана ${r.w}`);
}

async function press(page, selector, how) {
  await ready(page);
  if (how === 'touch') await page.tap(selector);
  else await page.click(selector);
}

function testParam(page) { try { return new URL(page.url()).searchParams.get('test'); } catch (e) { return '?'; } }

/* Проверка, что ответ вопроса «запомни» действительно следует из картинки */
function checkMemoryQuestion(q, where) {
  const shown = q.show.filter((x) => x !== '' && x != null);
  const key = (x) => (typeof x === 'object' ? x.name : x);
  const keys = shown.map(key);
  const cnt = (v) => keys.filter((k) => k === v).length;
  const a = q.a;
  check(new Set(a).size === 4, where, `варианты повторяются: ${a.join(' ')}`);
  switch (q.kind) {
    case 'missing':
      check(cnt(a[0]) === 0 && a.slice(1).every((x) => cnt(x) > 0), where, `«чего не было»: ответ ${a[0]} был на картинке, или неверные варианты не с картинки`); break;
    case 'color-missing':
      check(cnt(a[0]) === 0 && a.slice(1).every((x) => cnt(x) > 0), where, `«какого цвета не было»: ответ ${a[0]} неверен`); break;
    case 'middle':
      check(q.show.length === 3 && a[0] === q.show[1], where, `«посередине»: ${a[0]} не в середине`); break;
    case 'center':
      check(q.show.length === 9 && a[0] === q.show[4], where, `«в центре»: ${a[0]} не в центре`); break;
    case 'last':
      check(a[0] === q.show[q.show.length - 1] && a.slice(1).every((x) => cnt(x) === 1), where, `«последний справа»: ${a[0]} не последний`); break;
    case 'twice':
      check(cnt(a[0]) === 2 && a.slice(1).every((x) => cnt(x) === 1), where, `«два раза»: ${a[0]} встречается ${cnt(a[0])} раз`); break;
    case 'count':
      check(String(cnt(q.target)) === a[0] && a.slice(1).every((x) => x !== a[0]), where, `«сколько»: показано ${cnt(q.target)}, ответ ${a[0]}`); break;
    default:
      if (q.kind) fail(where, `неизвестный шаблон вопроса ${q.kind}`);
  }
}

/* Заставка теста */
async function checkIntro(page, vp, test, where) {
  await page.waitForSelector('[data-action="start"]');
  const info = await page.evaluate(() => ({
    title: (document.querySelector('.intro__title') || {}).textContent,
    count: (document.querySelector('.intro__count') || {}).textContent,
    text: (document.querySelector('.intro__text') || {}).textContent,
    emoji: (document.querySelector('.intro__emoji') || {}).textContent
  }));
  check(info.title === test.title, where, `заставка: название «${info.title}»`);
  check(info.count === `${test.questions.length} вопросов`, where, `заставка: «${info.count}»`);
  check(info.emoji === test.emoji && info.text && info.text.length > 10, where, 'заставка: нет эмодзи или строки о тесте');
  check(testParam(page) === test.id, where, `в адресе нет ?test=${test.id}`);
}

/* Пройти один тест (с экрана первого вопроса). targetScore — сколько ответить верно. */
async function playTest(page, vp, test, targetScore, opts) {
  const where = `${vp.short}/${test.id}`;
  const total = test.questions.length;
  const how = vp.mode === 'touch' ? 'touch' : 'mouse';
  let correctAtFirst = 0;
  const qs = await page.evaluate(() => JSON.parse(JSON.stringify(window.QuizApp.state().questions)));
  check(qs.length === total, where, `в прохождении ${qs.length} вопросов`);
  if (!test.keepOrder) {
    const half = Math.ceil(total / 2);
    const firstHalf = new Set(test.questions.slice(0, half).map((q) => q.q));
    check(qs.slice(0, half).every((q) => firstHalf.has(q.q)), where, 'перемешивание вынесло трудный вопрос в первую половину');
  }
  for (let i = 0; i < total; i++) {
    const q = qs[i];
    const useKeys = opts.keys;

    await page.waitForSelector('.topbar__count');
    const counter = (await page.textContent('.topbar__count')).trim();
    check(counter === `Вопрос ${i + 1} из ${total}`, where, `счётчик «${counter}», ожидался «Вопрос ${i + 1} из ${total}»`);

    if (q.type === 'memory') {
      checkMemoryQuestion(q, `${where}/вопрос ${i + 1}`);
      await page.waitForSelector('.memorize .mem-grid');
      const cells = await page.$$eval('.memorize .mem-cell', (els) => els.length);
      check(cells === q.show.length, where, `вопрос ${i + 1}: на картинке ${cells} клеток, ожидалось ${q.show.length}`);
      check(!(await page.$('.answer')), where, `вопрос ${i + 1}: варианты видны, пока картинка показана`);
      check(await page.$eval('[data-action="ready"]', (b) => b.disabled), where, `вопрос ${i + 1}: «Готово» активна сразу, без паузы`);
      if (opts.shotsPrefix && i === 0) await shot(page, `${opts.shotsPrefix}-memorize`);
      if (opts.waitTimer && i === 0) {
        // Надпись с секундами уменьшается, картинка исчезает сама по таймеру
        const s0 = parseInt(await page.textContent('.memorize__secs'), 10);
        await page.waitForTimeout(1300);
        const s1 = parseInt(await page.textContent('.memorize__secs'), 10);
        check(s0 === q.seconds && s1 === q.seconds - 1, where, `обратный отсчёт: было ${s0}, через 1,3 с — ${s1} (ожидалось ${q.seconds} → ${q.seconds - 1})`);
        const t0 = Date.now() - 1300;
        await page.waitForSelector('.answer', { timeout: q.seconds * 1000 + 3000 });
        const dt = (Date.now() - t0) / 1000;
        check(dt >= q.seconds - 0.6, where, `картинка исчезла слишком рано: через ${dt.toFixed(1)} c`);
      } else if (useKeys) {
        await page.waitForSelector('[data-action="ready"]:not([disabled])');
        await ready(page);
        await page.keyboard.press('Enter');
      } else {
        await page.waitForSelector('[data-action="ready"]:not([disabled])');
        await press(page, '[data-action="ready"]', how);
      }
    }

    await page.waitForSelector('.answer');
    const qText = (await page.textContent('.question')).trim();
    check(qText === q.q, where, `вопрос ${i + 1}: текст «${qText}» не совпал с данными`);
    const order = await page.evaluate(() => window.QuizApp.state().order.map((a) => ({ text: a.text, correct: a.correct })));
    const labels = await page.$$eval('.answer .answer__text', (els) => els.map((e) => e.textContent));
    check(labels.length === 4, where, `вопрос ${i + 1}: вариантов ${labels.length}, нужно 4`);
    check(JSON.stringify(labels) === JSON.stringify(order.map((o) => o.text)), where, `вопрос ${i + 1}: кнопки не совпадают с вариантами`);
    const correctIdx = order.findIndex((o) => o.correct);
    if (correctIdx === 0) correctAtFirst++;
    check(order[correctIdx].text === q.a[q.correct || 0], where, `вопрос ${i + 1}: «верный» вариант не тот, что в данных`);

    if (vp.short === 'phone' && i === 0) {
      const sizes = await page.evaluate(() => ({
        q: parseFloat(getComputedStyle(document.querySelector('.question')).fontSize),
        btn: Math.min(...[...document.querySelectorAll('.answer')].map((b) => b.getBoundingClientRect().height))
      }));
      check(sizes.q >= 22, where, `шрифт вопроса ${sizes.q}px < 22px`);
      check(sizes.btn >= 56, where, `высота кнопки ответа ${sizes.btn}px < 56px`);
    }
    if (opts.shotsPrefix && i === (q.type === 'memory' ? 0 : 1)) await shot(page, `${opts.shotsPrefix}-question`);

    const wantRight = i < targetScore;
    const pick = wantRight ? correctIdx : (correctIdx + 1) % 4;
    if (useKeys) { await ready(page); await page.keyboard.press(String(pick + 1)); }
    else await press(page, `.answer[data-index="${pick}"]`, how);

    await page.waitForSelector('.feedback:not([hidden]) .next-btn');
    const cls = await page.$$eval('.answer', (els) => els.map((e) => e.className));
    check(cls[correctIdx].includes('is-correct'), where, `вопрос ${i + 1}: верный ответ не подсвечен зелёным`);
    if (!wantRight) check(cls[pick].includes('is-wrong'), where, `вопрос ${i + 1}: неверный ответ не подсвечен красным`);
    const verdict = (await page.textContent('.feedback__verdict')).trim();
    check(wantRight ? verdict.includes('Верно') : verdict.includes('Не угадали'), where, `вопрос ${i + 1}: надпись «${verdict}» не соответствует ответу`);
    if (q.fact) check(!!(await page.$('.feedback__fact')), where, `вопрос ${i + 1}: нет строки «А вы знали?»`);
    if (q.type === 'memory') check(!!(await page.$('.feedback .mem-grid')), where, `вопрос ${i + 1}: после ответа не показано, что было на картинке`);
    const allDisabled = await page.$$eval('.answer', (els) => els.every((e) => e.disabled));
    check(allDisabled, where, `вопрос ${i + 1}: после ответа можно нажать другой вариант`);

    if (vp.short === 'phone') {
      await page.waitForTimeout(500);
      const visible = await page.evaluate(() => {
        const r = document.querySelector('.next-btn').getBoundingClientRect();
        return r.top >= 0 && r.bottom <= window.innerHeight + 1;
      });
      check(visible, where, `вопрос ${i + 1}: кнопка «Дальше» не видна без прокрутки`);
      await noHorizontalScroll(page, where);
      if (i === 1) {
        // Контраст бледных (невыбранных) вариантов после ответа
        const dim = await page.evaluate(() => {
          const b = document.querySelector('.answer.is-dim');
          if (!b) return null;
          const cs = getComputedStyle(b);
          return { color: cs.color, bg: cs.backgroundColor, opacity: cs.opacity };
        });
        if (dim) {
          const c = parseCss(dim.color), bg = parseCss(dim.bg);
          const ratio = contrast(c.c, bg.c);
          check(ratio >= 4.5 && parseFloat(dim.opacity) === 1, where, `бледный вариант после ответа: контраст ${ratio.toFixed(2)}:1, прозрачность ${dim.opacity}`);
        }
      }
    }
    if (opts.shotsPrefix && i === (q.type === 'memory' ? 0 : 1)) await shot(page, `${opts.shotsPrefix}-feedback`);

    const nextLabel = (await page.textContent('.next-btn')).trim();
    if (i === total - 1) check(nextLabel === 'Узнать результат', where, `на последнем вопросе кнопка «${nextLabel}»`);
    if (useKeys) { await ready(page); await page.keyboard.press('Enter'); }
    else await press(page, '.next-btn', how);
  }
  check(correctAtFirst < total, where, 'варианты ответов не перемешиваются (верный всегда первый)');
}

function expectedRank(test, score) {
  let r = test.ranks[0];
  for (const x of test.ranks) if (score >= x.min) r = x;
  return r;
}

async function checkResult(page, vp, test, score) {
  const where = `${vp.short}/${test.id}`;
  await page.waitForSelector('.result__card');
  const num = (await page.textContent('.result__num')).trim();
  const scoreLine = (await page.textContent('.result__score')).replace(/\s+/g, ' ').trim();
  check(num === String(score), where, `на экране результата ${num}, ожидалось ${score}`);
  check(scoreLine === `${score} из ${test.questions.length}`, where, `строка счёта «${scoreLine}»`);
  const rank = expectedRank(test, score);
  const rankText = (await page.textContent('.result__rank')).trim();
  check(rankText === rank.title, where, `звание «${rankText}», ожидалось «${rank.title}»`);
  check((await page.textContent('.result__text')).trim() === rank.text, where, 'фраза под званием не та');
  for (const a of ['share', 'again', 'home']) check(!!(await page.$(`[data-action="${a}"]`)), where, `нет кнопки ${a} на экране результата`);
  await noHorizontalScroll(page, where);
}

function expectedShareText(test, score) {
  const rank = expectedRank(test, score);
  return `Мой результат в тесте «${test.title}»: ${score} из ${test.questions.length} — «${rank.title}»! А ты сколько наберёшь? Пройди тест: ${APP_URL}?test=${test.id}`;
}

async function checkShare(page, vp, test, score, downloadsDir) {
  const where = `${vp.short}/${test.id}/поделиться`;
  const how = vp.mode === 'touch' ? 'touch' : 'mouse';
  const wantText = expectedShareText(test, score);
  if (vp.share === 'web-share') {
    await page.evaluate(() => { window.__shared = null; });
    await press(page, '[data-action="share"]', how);
    await page.waitForFunction(() => window.__shared, null, { timeout: 5000 }).catch(() => {});
    const s = await page.evaluate(() => window.__shared);
    if (check(s, where, 'системное «Поделиться» не вызвано')) {
      check(s.files === 1 && s.type === 'image/jpeg', where, `файл не JPEG (${s.type}, файлов: ${s.files})`);
      check(s.w === 1080 && s.h === 1080, where, `картинка ${s.w}×${s.h}, нужно 1080×1080`);
      check(s.size > 20000 && s.size < 350000, where, `размер картинки ${Math.round(s.size / 1024)} КБ`);
      check(s.text === wantText, where, `текст «${s.text}», ожидался «${wantText}»`);
      if (test.id === 'ussr') console.log(`    (картинка для «Поделиться»: ${Math.round(s.size / 1024)} КБ)`);
    }
    check(!(await page.$('[data-share-dialog]')), where, 'при работающем системном «Поделиться» открылось ещё и окно');
    return;
  }
  // Окно с картинкой
  await page.evaluate(() => { window.__copied = null; });
  await press(page, '[data-action="share"]', how);
  await page.waitForSelector('[data-share-dialog] .share-dialog__img', { timeout: 5000 }).catch(() => {});
  if (!check(await page.$('[data-share-dialog]'), where, 'не открылось окно с картинкой')) return;
  const img = await page.$eval('.share-dialog__img', async (im) => { if (!im.complete) await new Promise((r) => { im.onload = r; }); return { w: im.naturalWidth, h: im.naturalHeight }; });
  check(img.w === 1080 && img.h === 1080, where, `картинка в окне ${img.w}×${img.h}`);
  const textInDialog = (await page.textContent('.share-dialog__text')).trim();
  check(textInDialog === wantText, where, `текст в окне «${textInDialog}»`);
  if (vp.share === 'dialog-touch') {
    const hint = await page.$('.share-dialog__hint');
    check(hint && (await hint.textContent()).includes('подержите'), where, 'на телефоне нет подсказки «нажмите и подержите»');
    check(!(await page.$('[data-action="download"]')), where, 'на телефоне показана кнопка «Скачать» (в окнах ВК/ОК она часто не работает)');
  } else {
    if (check(await page.$('[data-action="download"]'), where, 'на компьютере нет кнопки «Скачать картинку»')) {
      const [dl] = await Promise.all([
        page.waitForEvent('download', { timeout: 5000 }).catch(() => null),
        page.click('[data-action="download"]')
      ]);
      if (check(dl, where, 'картинка не скачалась')) {
        const file = path.join(downloadsDir, `${vp.short}-${test.id}.jpg`);
        await dl.saveAs(file);
        const sz = imageSize(fs.readFileSync(file));
        check(sz && sz.w === 1080 && sz.h === 1080, where, `скачанная картинка ${sz ? sz.type + ' ' + sz.w + '×' + sz.h : 'не картинка'}`);
        if (SHOTS) fs.copyFileSync(file, path.join(SHOTS, `card-${test.id}.jpg`));
      }
    }
  }
  await page.click('[data-action="copy"]');
  await page.waitForFunction(() => window.__copied, null, { timeout: 3000 }).catch(() => {});
  const copied = await page.evaluate(() => window.__copied);
  check(copied === wantText, where, `скопирован текст «${copied}»`);
  await page.waitForSelector('#toast.show', { timeout: 3000 }).catch(() => {});
  const toast = await page.textContent('#toast');
  check(toast.includes('скопирован'), where, `подсказка после копирования: «${toast}»`);
  if (test.id === 'ussr') await shot(page, `${vp.short}-share-dialog`);
  // Закрыть: Esc на компьютере, крестик на телефоне
  if (vp.share === 'dialog-desk') await page.keyboard.press('Escape'); else await page.tap('[data-action="close"]');
  await page.waitForSelector('[data-share-dialog]', { state: 'detached', timeout: 3000 }).catch(() => fail(where, 'окно не закрылось'));
  check(await page.$('.result__card'), where, 'после закрытия окна пропал экран результата');
}

function attachErrorWatch(page, where) {
  page.on('console', (m) => { if (m.type() === 'error' || (m.type() === 'warning' && /Permissions policy|violation/i.test(m.text()))) fail(where, `ошибка в консоли: ${m.text()}`); });
  page.on('pageerror', (e) => fail(where, `ошибка JS: ${e.message}`));
  page.on('requestfailed', (r) => { if (!r.url().endsWith('favicon.ico')) fail(where, `не загрузилось: ${r.url()}`); });
  page.on('request', (r) => {
    const u = r.url();
    if (!/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(u) && !u.startsWith('data:') && !u.startsWith('blob:')) fail(where, `запрос во внешний интернет: ${u}`);
  });
}

async function newContext(browser, vp, init) {
  const ctx = await browser.newContext({ viewport: vp.viewport, isMobile: vp.isMobile, hasTouch: vp.hasTouch, deviceScaleFactor: vp.deviceScaleFactor || 1, acceptDownloads: true, locale: 'ru-RU' });
  if (init) await ctx.addInitScript(init);
  return ctx;
}

async function runViewport(browser, base, vp, tests, downloadsDir) {
  console.log(`\n=== ${vp.name} ===`);
  const ctx = await newContext(browser, vp, vp.share === 'web-share' ? SHARE_STUB : NO_SHARE_STUB);
  const page = await ctx.newPage();
  attachErrorWatch(page, vp.short);
  await page.goto(base);
  await page.waitForSelector('.test-card');
  const how = vp.mode === 'touch' ? 'touch' : 'mouse';

  // Главный экран
  const cards = await page.$$eval('.test-card', (els) => els.map((e) => e.getAttribute('data-test')));
  check(cards.length === tests.length, vp.short, `карточек тестов ${cards.length}, ожидалось ${tests.length}`);
  check(!(await page.$('.chip--best')), vp.short, 'на чистом запуске уже показан лучший результат');
  await noHorizontalScroll(page, vp.short);
  await shot(page, `${vp.short}-home`);

  // Кнопка звука: выключить, перезагрузить — должна остаться выключенной, потом включить
  await press(page, '.sound-btn', how);
  check((await page.getAttribute('.sound-btn', 'data-sound')) === 'off', vp.short, 'кнопка звука не выключилась');
  await page.reload(); await page.waitForSelector('.test-card');
  check((await page.getAttribute('.sound-btn', 'data-sound')) === 'off', vp.short, 'выключенный звук не запомнился после перезагрузки');
  await press(page, '.sound-btn', how);
  check((await page.getAttribute('.sound-btn', 'data-sound')) === 'on', vp.short, 'кнопка звука не включилась обратно');

  const targets = [10, 7, 5, 2, 8, 9, 3, 6]; // покрывают все 4 ступени званий
  for (let ti = 0; ti < tests.length; ti++) {
    const test = tests[ti];
    if (ONLY && test.id !== ONLY) continue;
    const where = `${vp.short}/${test.id}`;
    const target = targets[ti % targets.length];
    const keys = vp.mode === 'mouse+keys' && ti % 2 === 1; // на компьютере каждый второй тест — клавиатурой
    process.stdout.write(`  ${test.title}: ${keys ? 'клавиатура' : vp.mode === 'touch' ? 'тап' : 'мышь'}, цель ${target}/10 … `);

    if (keys) { await ready(page); await page.keyboard.press(String(ti + 1)); }
    else await press(page, `.test-card[data-test="${test.id}"]`, how);
    await checkIntro(page, vp, test, where);
    if (ti === 0 || test.id === 'memory') await shot(page, `${vp.short}-${test.id}-intro`);
    if (keys) { await ready(page); await page.keyboard.press('Enter'); }
    else await press(page, '[data-action="start"]', how);

    const prefix = SHOTS && (ti === 0 || test.questions[0].type === 'memory' || test.id === 'memory') ? `${vp.short}-${test.id}` : null;
    await playTest(page, vp, test, target, { keys, waitTimer: vp.waitTimer && test.id === 'memory', shotsPrefix: prefix });
    await checkResult(page, vp, test, target);
    await shot(page, `${vp.short}-${test.id}-result`);
    await checkShare(page, vp, test, target, downloadsDir);

    const stored = await page.evaluate((id) => localStorage.getItem('quiz-time:best:' + id), test.id);
    check(stored === String(target), where, `лучший результат в хранилище «${stored}», ожидалось ${target}`);

    if (ti === 0) {
      // «Пройти ещё раз»: тест начинается заново (без заставки), рекорд не затирается худшим результатом
      await press(page, '[data-action="again"]', how);
      await page.waitForSelector('.topbar__count');
      check((await page.textContent('.topbar__count')).trim() === `Вопрос 1 из ${test.questions.length}`, where, '«Пройти ещё раз» не начал тест с первого вопроса');
      await playTest(page, vp, test, 4, { keys: false });
      await checkResult(page, vp, test, 4);
      const best = (await page.textContent('.result__best')) || '';
      check(best.includes(`${target} из`), where, `после худшей попытки не показан прежний лучший результат: «${best}»`);
    }

    // «Другие тесты» — к списку, ?test= убран из адреса
    await press(page, '[data-action="home"]', how);
    await page.waitForSelector(`.test-card[data-test="${test.id}"]`);
    check(testParam(page) === null, where, `после «Другие тесты» в адресе остался ?test=${testParam(page)}`);
    const chip = await page.$eval(`.test-card[data-test="${test.id}"]`, (e) => (e.querySelector('.chip--best') || {}).textContent || '');
    check(chip.includes(`${target} из ${test.questions.length}`), where, `на карточке лучший результат «${chip}», ожидалось ${target} из ${test.questions.length}`);
    console.log('готово');
  }
  await shot(page, `${vp.short}-home-after`);

  // Кнопка «назад» браузера/телефона посреди теста и на результате — к списку тестов
  if (!ONLY) {
    const t = tests[0];
    await press(page, `.test-card[data-test="${t.id}"]`, how);
    await page.waitForSelector('[data-action="start"]');
    await press(page, '[data-action="start"]', how);
    await page.waitForSelector('.answer, .memorize');
    await page.evaluate(() => history.back());
    await page.waitForSelector('.test-card', { timeout: 3000 }).catch(() => fail(vp.short, '«назад» посреди теста не вернул к списку тестов'));
    check(testParam(page) === null, vp.short, 'после «назад» в адресе остался ?test=');
    check(page.url().startsWith(base), vp.short, `«назад» увёл из приложения: ${page.url()}`);
    // «‹ Тесты» на заставке
    await press(page, `.test-card[data-test="${t.id}"]`, how);
    await page.waitForSelector('[data-action="start"]');
    await press(page, '[data-action="back"]', how);
    await page.waitForSelector('.test-card', { timeout: 3000 }).catch(() => fail(vp.short, '«‹ Тесты» на заставке не вернул к списку'));
    check(testParam(page) === null, vp.short, 'после «‹ Тесты» в адресе остался ?test=');
  }
  // Esc с вопроса — на главный (компьютер)
  if (vp.mode === 'mouse+keys') {
    await ready(page);
    await page.keyboard.press('1');
    await page.waitForSelector('[data-action="start"]');
    await ready(page);
    await page.keyboard.press('Escape');
    await page.waitForSelector('.test-card', { timeout: 2000 }).catch(() => fail(vp.short, 'Esc не возвращает к списку тестов'));
  }
  await ctx.close();
}

/* Быстро пройти тест до результата (без подробных проверок) */
async function quickPlay(page, score, how) {
  const total = await page.evaluate(() => window.QuizApp.state().total);
  for (let i = 0; i < total; i++) {
    const phase = await page.evaluate(() => window.QuizApp.state().phase);
    if (phase === 'memorize') {
      await page.waitForSelector('[data-action="ready"]:not([disabled])');
      await press(page, '[data-action="ready"]', how);
    }
    await page.waitForSelector('.answer');
    const order = await page.evaluate(() => window.QuizApp.state().order.map((a) => a.correct));
    const c = order.indexOf(true);
    await press(page, `.answer[data-index="${i < score ? c : (c + 1) % 4}"]`, how);
    await press(page, '.next-btn', how);
  }
  await page.waitForSelector('.result__card');
}

async function extraChecks(browser, base, tests, port) {
  console.log('\n=== Дополнительно ===');
  const phoneVp = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
  const memory = tests.find((t) => t.id === 'memory');
  const regular = tests.find((t) => !t.keepOrder);

  // 1) Повтор — не копия: «запомни» генерируются заново, обычные вопросы перемешиваются
  {
    const ctx = await newContext(browser, phoneVp);
    const page = await ctx.newPage();
    attachErrorWatch(page, 'повтор');
    await page.goto(base);
    await page.waitForSelector('.test-card');
    const res = await page.evaluate(() => {
      const out = {};
      for (const t of window.QuizApp.tests) {
        const runs = [];
        for (let i = 0; i < 40; i++) runs.push(window.QuizApp.prepareQuestions(t));
        out[t.id] = runs;
      }
      return JSON.parse(JSON.stringify(out));
    });
    for (const t of tests) {
      const runs = res[t.id];
      const sigs = new Set(runs.map((r) => JSON.stringify(r.map((q) => [q.q, q.show, q.a]))));
      check(sigs.size >= 35, `повтор/${t.id}`, `из 40 прохождений разных только ${sigs.size}`);
      if (t.id === 'memory') {
        const ladder = [3, 3, 4, 4, 5, 5, 5, 6, 6, 7];
        runs.forEach((r, k) => r.forEach((q, i) => {
          const n = q.show.filter((x) => x !== '').length;
          check(n === ladder[i], `повтор/memory`, `прохождение ${k + 1}, вопрос ${i + 1}: предметов ${n}, по лестнице ${ladder[i]}`);
          checkMemoryQuestion(q, `повтор/memory/вопрос ${i + 1}`);
        }));
        const firstShows = new Set(runs.map((r) => JSON.stringify(r[0].show)));
        check(firstShows.size >= 10, 'повтор/memory', `первый вопрос почти не меняется: вариантов ${firstShows.size} из 40`);
      }
    }
    console.log('  повтор: «запомни» каждый раз новые (ответы верны по картинке), обычные вопросы перемешаны внутри половин');
    await ctx.close();
  }

  // 2) Двойной тап по «Дальше», зажатый Enter, «Готово» не раньше 1,5 с
  {
    const ctx = await newContext(browser, { viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    attachErrorWatch(page, 'двойной-тап');
    // память: двойной тап по «Дальше» не должен пропустить картинку
    await page.goto(base + '?test=memory');
    await press(page, '[data-action="start"]', 'touch');
    await page.waitForSelector('[data-action="ready"]:not([disabled])');
    await press(page, '[data-action="ready"]', 'touch');
    await press(page, '.answer[data-index="0"]', 'touch');
    await ready(page);
    const nb = await (await page.$('.next-btn')).boundingBox();
    const x = nb.x + nb.width / 2, y = nb.y + nb.height / 2;
    await page.touchscreen.tap(x, y);
    await page.waitForTimeout(60);
    await page.touchscreen.tap(x, y);
    await page.waitForTimeout(100);
    let st = await page.evaluate(() => ({ idx: window.QuizApp.state().idx, phase: window.QuizApp.state().phase }));
    check(st.idx === 1 && st.phase === 'memorize', 'двойной-тап', `двойной тап по «Дальше»: вопрос ${st.idx + 1}, фаза ${st.phase} (картинку пропустили?)`);
    // Enter сразу (до 1,5 с) — картинка остаётся
    await page.waitForTimeout(450);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(100);
    st = await page.evaluate(() => window.QuizApp.state().phase);
    check(st === 'memorize', 'двойной-тап', 'Enter раньше 1,5 с пропустил картинку');
    // зажатый Enter на «Дальше» — только один шаг
    await page.waitForSelector('[data-action="ready"]:not([disabled])');
    await press(page, '[data-action="ready"]', 'touch');
    await press(page, '.answer[data-index="0"]', 'touch');
    await ready(page);
    await page.keyboard.down('Enter');
    await page.waitForTimeout(450);
    await page.keyboard.down('Enter'); // повтор (repeat)
    await page.keyboard.down('Enter');
    await page.keyboard.up('Enter');
    await page.waitForTimeout(100);
    st = await page.evaluate(() => ({ idx: window.QuizApp.state().idx, phase: window.QuizApp.state().phase }));
    check(st.idx === 2 && st.phase === 'memorize', 'двойной-тап', `зажатый Enter: вопрос ${st.idx + 1}, фаза ${st.phase}`);
    // обычный тест: второй тап по месту «Дальше» не отвечает на следующий вопрос
    await page.goto(base + '?test=' + regular.id);
    await press(page, '[data-action="start"]', 'touch');
    await press(page, '.answer[data-index="0"]', 'touch');
    await ready(page);
    const nb2 = await (await page.$('.next-btn')).boundingBox();
    for (let k = 0; k < 2; k++) { await page.touchscreen.tap(nb2.x + nb2.width / 2, nb2.y + nb2.height / 2); await page.waitForTimeout(80); }
    st = await page.evaluate(() => ({ idx: window.QuizApp.state().idx, answered: window.QuizApp.state().answered }));
    check(!st.answered, 'двойной-тап', `второй тап ответил на вопрос ${st.idx + 1} сам`);
    console.log('  двойной тап и зажатый Enter не проскакивают экраны, «Готово» ждёт 1,5 с');
    await ctx.close();
  }

  // 3) Без localStorage (приватный режим / запрет) — всё работает
  {
    const ctx = await newContext(browser, phoneVp, NO_STORAGE_STUB + SHARE_STUB);
    const page = await ctx.newPage();
    attachErrorWatch(page, 'без-хранилища');
    await page.goto(base);
    await page.waitForSelector('.test-card');
    await press(page, `.test-card[data-test="${regular.id}"]`, 'touch');
    await press(page, '[data-action="start"]', 'touch');
    await quickPlay(page, 6, 'touch');
    await checkResult(page, { short: 'nostore' }, regular, 6);
    await press(page, '.sound-btn', 'touch');
    console.log('  без localStorage: тест проходится, звук переключается');
    await ctx.close();
  }

  // 4) Испорченный рекорд («99 из 10») не показывается
  {
    const ctx = await newContext(browser, phoneVp, `try { localStorage.setItem('quiz-time:best:${regular.id}', '99'); localStorage.setItem('quiz-time:best:${memory.id}', '-3'); } catch (e) {}`);
    const page = await ctx.newPage();
    attachErrorWatch(page, 'рекорд');
    await page.goto(base);
    await page.waitForSelector('.test-card');
    const chips = await page.$$eval('.chip--best', (els) => els.map((e) => e.textContent));
    check(chips.length === 0, 'рекорд', `показан испорченный рекорд: ${chips.join(', ')}`);
    console.log('  испорченный рекорд в хранилище не показывается');
    await ctx.close();
  }

  // 5) Ссылка ?test=id: заставка, «назад» — к списку тестов, а не прочь из приложения
  {
    const ctx = await newContext(browser, phoneVp);
    const page = await ctx.newPage();
    attachErrorWatch(page, 'ссылка');
    await page.goto(base + 'index.html?vk_app_id=1&test=' + regular.id);
    await checkIntro(page, { short: 'ссылка' }, regular, 'ссылка');
    await page.evaluate(() => history.back());
    await page.waitForSelector('.test-card', { timeout: 3000 }).catch(() => fail('ссылка', '«назад» с заставки по ссылке не открыл список тестов'));
    check(testParam(page) === null, 'ссылка', 'после «назад» в адресе остался ?test=');
    check(new URL(page.url()).searchParams.get('vk_app_id') === '1', 'ссылка', 'чужие параметры адреса (от ВК) потерялись');
    await page.goto(base + '?test=nesushchestvuet');
    await page.waitForSelector('.test-card').catch(() => fail('ссылка', 'неизвестный ?test= не открыл главный экран'));
    check(testParam(page) === null, 'ссылка', 'неизвестный ?test= остался в адресе');
    // назад с результата
    await page.goto(base + '?test=' + regular.id);
    await press(page, '[data-action="start"]', 'touch');
    await quickPlay(page, 5, 'touch');
    await page.evaluate(() => history.back());
    await page.waitForSelector('.test-card', { timeout: 3000 }).catch(() => fail('ссылка', '«назад» на результате не вернул к списку'));
    console.log('  ссылка ?test=… открывает заставку, «назад» ведёт к списку тестов');
    await ctx.close();
  }

  // 6) Узкий экран 280px и невысокий 360×640
  {
    const ctx = await newContext(browser, { viewport: { width: 280, height: 653 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, SHARE_STUB);
    const page = await ctx.newPage();
    attachErrorWatch(page, '280px');
    await page.goto(base);
    await page.waitForSelector('.test-card');
    await noHorizontalScroll(page, '280px/главный');
    await shot(page, 'w280-home');
    await press(page, `.test-card[data-test="${memory.id}"]`, 'touch');
    await page.waitForSelector('[data-action="start"]');
    await noHorizontalScroll(page, '280px/заставка');
    await press(page, '[data-action="start"]', 'touch');
    await page.waitForSelector('.memorize');
    await noHorizontalScroll(page, '280px/запомни');
    await quickPlay(page, 9, 'touch');
    await noHorizontalScroll(page, '280px/результат');
    await shot(page, 'w280-result');
    await ctx.close();

    // 360×640: на результате кнопка «Поделиться» видна без прокрутки (самое длинное звание + строка рекорда)
    const seed = tests.map((t) => `localStorage.setItem('quiz-time:best:${t.id}', '10');`).join('');
    const ctx2 = await newContext(browser, { viewport: { width: 360, height: 640 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, SHARE_STUB + `try { ${seed} } catch (e) {}`);
    const page2 = await ctx2.newPage();
    attachErrorWatch(page2, '360×640');
    for (const t of tests) {
      const longest = t.ranks.reduce((a, b) => (b.title.length > a.title.length ? b : a));
      const score = Math.min(t.questions.length, longest.min === 0 ? 1 : longest.min);
      await page2.goto(base + '?test=' + t.id);
      await press(page2, '[data-action="start"]', 'touch');
      await quickPlay(page2, score, 'touch');
      const r = await page2.evaluate(() => ({ b: document.querySelector('[data-action="share"]').getBoundingClientRect().bottom, h: window.innerHeight, best: !!document.querySelector('.result__best') }));
      check(r.b <= r.h, `360×640/${t.id}`, `«Поделиться результатом» ниже экрана: ${Math.round(r.b)} > ${r.h} (звание «${longest.title}»)`);
      check(r.best, `360×640/${t.id}`, 'нет строки лучшего результата (проверка неполная)');
      if (t.id === tests[0].id) await shot(page2, 'w360-result');
    }
    await ctx2.close();
    console.log('  280px без прокрутки вбок; на 360×640 «Поделиться» видно сразу');
  }

  // 7) Внутри чужого iframe (как в ВК/ОК): ни одной ошибки в консоли, «Поделиться» работает
  {
    const ctx = await browser.newContext({ viewport: { width: 400, height: 860 }, locale: 'ru-RU' });
    const page = await ctx.newPage();
    attachErrorWatch(page, 'iframe');
    await page.goto(`http://localhost:${port}/__frame.html?src=` + encodeURIComponent(base + '?test=' + regular.id));
    const frame = await (await page.waitForSelector('#f')).contentFrame();
    await frame.waitForSelector('[data-action="start"]');
    const policy = await frame.evaluate(() => { const p = document.permissionsPolicy || document.featurePolicy; return p ? p.allowsFeature('clipboard-write') : 'нет API'; });
    check(policy === false, 'iframe', `проверка неполная: в iframe запись в буфер разрешена (${policy})`);
    await press(frame, '[data-action="start"]', 'mouse');
    await quickPlay(frame, 7, 'mouse');
    await press(frame, '[data-action="share"]', 'mouse');
    await frame.waitForSelector('[data-share-dialog] .share-dialog__img', { timeout: 5000 }).catch(() => fail('iframe', 'не открылось окно с картинкой'));
    await frame.click('[data-action="copy"]');
    await frame.waitForSelector('#toast.show', { timeout: 3000 }).catch(() => fail('iframe', 'нет подсказки после копирования'));
    await page.waitForTimeout(300);
    await frame.click('[data-action="close"]');
    await press(frame, '[data-action="home"]', 'mouse');
    await frame.waitForSelector('.test-card', { timeout: 3000 }).catch(() => fail('iframe', '«Другие тесты» в iframe не открыли список'));
    console.log(`  в чужом iframe: без ошибок в консоли, «Поделиться» открывает окно, копирование: «${(await frame.textContent('#toast')).trim()}»`);
    await ctx.close();
  }

  // 8) Данные тестов: 10 вопросов, 4 разных варианта, звания покрывают 0–10, контраст цветов
  for (const t of tests) {
    const w = `данные/${t.id}`;
    check(t.questions.length === 10, w, `вопросов ${t.questions.length}, нужно 10`);
    check(!!t.intro, w, 'нет строки для заставки (intro)');
    t.questions.forEach((q, i) => {
      if (q.make) return; // генерируемые проверены выше
      check(Array.isArray(q.a) && q.a.length === 4, w, `вопрос ${i + 1}: вариантов не 4`);
      check(new Set(q.a).size === q.a.length, w, `вопрос ${i + 1}: повторяются варианты`);
      if (q.type === 'memory') check(Array.isArray(q.show) && q.show.length >= 3, w, `вопрос ${i + 1}: пустая картинка`);
      else check(!!q.fact, w, `вопрос ${i + 1}: нет пояснения «А вы знали?»`);
    });
    check(t.ranks.length === 4 && t.ranks[0].min === 0, w, 'званий не 4 или первое не с 0');
    for (const c of [t.color, t.color2 || t.color]) {
      const r = contrast([255, 255, 255], rgb(c));
      check(r >= 4.5, w, `белый текст на цвете ${c}: контраст ${r.toFixed(2)}:1 < 4,5`);
      // кнопки «Пройти ещё раз»/«Другие тесты»: белый на 22% чёрного поверх цвета
      const under = blend([0, 0, 0], 0.22, rgb(c));
      const r2 = contrast([255, 255, 255], under);
      check(r2 >= 4.5, w, `кнопки на результате: контраст ${r2.toFixed(2)}:1`);
    }
  }
  const accent = contrast([255, 255, 255], rgb('#bf360c'));
  check(accent >= 4.5, 'данные', `--accent главного экрана: ${accent.toFixed(2)}:1`);
  console.log('  данные тестов и контраст цветов в порядке');

  // 9) Картинки для ссылки и значок
  {
    const og = imageSize(fs.readFileSync(path.join(ROOT, 'img/og-cover.png')));
    check(og && og.w === 1200 && og.h === 630, 'картинки', `og-cover ${og && og.w}×${og && og.h}`);
    const ic = imageSize(fs.readFileSync(path.join(ROOT, 'img/apple-touch-icon.png')));
    check(ic && ic.w === 180 && ic.h === 180, 'картинки', `apple-touch-icon ${ic && ic.w}×${ic && ic.h}`);
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    check(html.includes(`property="og:image" content="${APP_URL}img/og-cover.png"`), 'картинки', 'нет og:image с полным адресом');
    check(html.includes('name="twitter:card" content="summary_large_image"'), 'картинки', 'нет twitter:card');
    check(html.includes('rel="apple-touch-icon"'), 'картинки', 'нет apple-touch-icon');
    console.log('  og:image 1200×630, значок 180×180 и метатеги на месте');
  }
}

(async () => {
  const { server, url, port } = await startServer();
  const downloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quiz-dl-'));
  const browser = await chromium.launch();
  try {
    // Тесты берём прямо из приложения — так проверка сама подхватит новые тесты.
    const p0 = await browser.newPage();
    await p0.goto(url);
    await p0.waitForSelector('.test-card');
    const tests = await p0.evaluate(() => window.QuizApp.tests.map((t) => Object.assign({}, t, {
      questions: t.questions.map((q) => (q.make ? { make: true } : q))
    })));
    await p0.close();
    console.log(`Тестов найдено: ${tests.length} (${tests.map((t) => t.title).join(', ')})`);

    if (!EXTRA_ONLY) for (const vp of VIEWPORTS) await runViewport(browser, url, vp, tests, downloadsDir);
    if (!ONLY) await extraChecks(browser, url, tests, port);
  } catch (e) {
    fail('скрипт', 'проверка прервалась: ' + (e && e.stack || e));
  } finally {
    await browser.close();
    server.close();
  }

  console.log('\n' + (problems.length ? `ПРОБЛЕМ: ${problems.length}` : 'ВСЁ ХОРОШО: проблем не найдено'));
  problems.forEach((p) => console.log(' - ' + p));
  if (SHOTS) console.log(`Скриншоты: ${SHOTS}`);
  process.exit(problems.length ? 1 : 0);
})();
