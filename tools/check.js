#!/usr/bin/env node
/* Проверка прототипа «Викторины» в настоящем браузере (Playwright + Chromium).

   Запуск из корня репозитория:
     node tools/check.js                 — все проверки
     node tools/check.js --shots /путь   — плюс скриншоты всех экранов в эту папку
     node tools/check.js --only memory   — только один тест (по id)

   Что делает:
   - поднимает маленький локальный сервер с папкой репозитория;
   - на трёх экранах (телефон-портрет 390×844, телефон-альбом 844×390, компьютер 1280×800)
     проходит ВСЕ тесты до конца: тапом, мышью и клавиатурой (1–4, Enter);
   - проверяет: «Вопрос N из 10», цвет верного/неверного, «А вы знали?», перемешивание
     вариантов, итоговый счёт и звание, «Пройти ещё раз», «Другие тесты», лучший результат
     на карточке, кнопку звука (и что она запоминается), размеры шрифта и кнопок на телефоне,
     отсутствие горизонтальной прокрутки, работу без localStorage, ссылку ?test=…;
   - «Поделиться»: через системное меню (картинка 1080×1080 уходит файлом) и запасной
     путь (картинка скачивается, текст со ссылкой копируется);
   - любая ошибка в консоли браузера = провал.
   Код выхода 0 — всё хорошо, 1 — есть проблемы (они перечислены). */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const argVal = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const SHOTS = argVal('--shots');
const ONLY = argVal('--only');
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const problems = [];
const notes = [];
function fail(where, msg) { problems.push(`[${where}] ${msg}`); console.log(`  ✗ ${msg}`); }
function ok(msg) { notes.push(msg); }
function check(cond, where, msg) { if (!cond) fail(where, msg); return !!cond; }

/* ---------- локальный сервер ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon' };
function startServer() {
  const external = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
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
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, external, url: `http://127.0.0.1:${server.address().port}/` })));
}

/* ---------- PNG: размер из заголовка ---------- */
function pngSize(buf) {
  const sig = '89504e470d0a1a0a';
  if (buf.slice(0, 8).toString('hex') !== sig) return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

/* Заглушки для «Поделиться»: запоминаем, что приложение отдало системе. */
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
  { name: 'телефон-альбом 844×390', short: 'land', viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, mode: 'touch', share: 'web-share' },
  { name: 'компьютер 1280×800', short: 'desk', viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1, mode: 'mouse+keys', share: 'fallback' }
];

async function shot(page, name) {
  if (!SHOTS) return;
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(SHOTS, name + '.png') });
}

async function noHorizontalScroll(page, where) {
  const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: window.innerWidth }));
  check(r.sw <= r.w + 1, where, `горизонтальная прокрутка: ширина страницы ${r.sw} > экрана ${r.w}`);
}

async function press(page, vp, selector, how) {
  if (how === 'touch') await page.tap(selector);
  else await page.click(selector);
}

/* Пройти один тест. targetScore — сколько ответить верно (первые targetScore вопросов). */
async function playTest(page, vp, test, targetScore, opts) {
  const where = `${vp.short}/${test.id}`;
  const total = test.questions.length;
  let correctAtFirst = 0;
  for (let i = 0; i < total; i++) {
    const q = test.questions[i];
    const useKeys = opts.keys;
    const how = vp.mode === 'touch' ? 'touch' : 'mouse';

    await page.waitForSelector('.topbar__count');
    const counter = (await page.textContent('.topbar__count')).trim();
    check(counter === `Вопрос ${i + 1} из ${total}`, where, `счётчик «${counter}», ожидался «Вопрос ${i + 1} из ${total}»`);

    if (q.type === 'memory') {
      await page.waitForSelector('.memorize .mem-grid');
      const cells = await page.$$eval('.memorize .mem-cell', (els) => els.length);
      check(cells === q.show.length, where, `вопрос ${i + 1}: на картинке ${cells} клеток, ожидалось ${q.show.length}`);
      check(!(await page.$('.answer')), where, `вопрос ${i + 1}: варианты видны, пока картинка показана`);
      if (opts.shotsPrefix && i === 0) await shot(page, `${opts.shotsPrefix}-memorize`);
      if (opts.waitTimer && i === 0) {
        // Ждём, пока картинка исчезнет сама (по таймеру)
        const t0 = Date.now();
        await page.waitForSelector('.answer', { timeout: (q.seconds || 5) * 1000 + 3000 });
        const dt = (Date.now() - t0) / 1000;
        check(dt >= (q.seconds || 5) - 1, where, `картинка исчезла слишком рано: через ${dt.toFixed(1)} c`);
      } else if (useKeys) {
        await page.keyboard.press('Enter');
      } else {
        await press(page, vp, '[data-action="ready"]', how);
      }
      await page.waitForSelector('.answer');
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
    if (useKeys) await page.keyboard.press(String(pick + 1));
    else await press(page, vp, `.answer[data-index="${pick}"]`, how);

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
    }
    if (opts.shotsPrefix && i === (q.type === 'memory' ? 0 : 1)) await shot(page, `${opts.shotsPrefix}-feedback`);

    const nextLabel = (await page.textContent('.next-btn')).trim();
    if (i === total - 1) check(nextLabel === 'Узнать результат', where, `на последнем вопросе кнопка «${nextLabel}»`);
    if (useKeys) await page.keyboard.press('Enter');
    else await press(page, vp, '.next-btn', how);
  }
  check(correctAtFirst < total, where, 'варианты ответов не перемешиваются (верный всегда первый)');
  return correctAtFirst;
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

async function checkShare(page, vp, test, score, downloadsDir) {
  const where = `${vp.short}/${test.id}/поделиться`;
  if (vp.share === 'web-share') {
    await page.evaluate(() => { window.__shared = null; });
    await press(page, vp, '[data-action="share"]', vp.mode === 'touch' ? 'touch' : 'mouse');
    await page.waitForFunction(() => window.__shared, null, { timeout: 5000 }).catch(() => {});
    const s = await page.evaluate(() => window.__shared);
    if (check(s, where, 'системное «Поделиться» не вызвано')) {
      check(s.files === 1 && s.type === 'image/png', where, `файл не PNG (${s.type}, файлов: ${s.files})`);
      check(s.w === 1080 && s.h === 1080, where, `картинка ${s.w}×${s.h}, нужно 1080×1080`);
      check(s.text.includes(`${score} из ${test.questions.length}`) && s.text.includes(test.title), where, `текст без счёта/названия: «${s.text}»`);
      check(s.text.includes('https://romangerasimov71-spec.github.io/quiz-time/'), where, 'в тексте нет ссылки на приложение');
    }
  } else {
    await page.evaluate(() => { window.__copied = null; });
    const [dl] = await Promise.all([
      page.waitForEvent('download', { timeout: 5000 }).catch(() => null),
      press(page, vp, '[data-action="share"]', 'mouse')
    ]);
    if (check(dl, where, 'картинка не скачалась (нет системного «Поделиться»)')) {
      const file = path.join(downloadsDir, `${vp.short}-${test.id}.png`);
      await dl.saveAs(file);
      const sz = pngSize(fs.readFileSync(file));
      check(sz && sz.w === 1080 && sz.h === 1080, where, `скачанная картинка ${sz ? sz.w + '×' + sz.h : 'не PNG'}`);
      if (SHOTS) fs.copyFileSync(file, path.join(SHOTS, `card-${test.id}.png`));
    }
    await page.waitForFunction(() => window.__copied, null, { timeout: 3000 }).catch(() => {});
    const copied = await page.evaluate(() => window.__copied);
    check(copied && copied.includes('https://romangerasimov71-spec.github.io/quiz-time/') && copied.includes(`${score} из`), where, `текст со ссылкой не скопирован: «${copied}»`);
    await page.waitForSelector('#toast.show', { timeout: 3000 }).catch(() => fail(where, 'не показана подсказка «картинка сохранена»'));
  }
}

function attachErrorWatch(page, where) {
  page.on('console', (m) => { if (m.type() === 'error') fail(where, `ошибка в консоли: ${m.text()}`); });
  page.on('pageerror', (e) => fail(where, `ошибка JS: ${e.message}`));
  page.on('requestfailed', (r) => fail(where, `не загрузилось: ${r.url()}`));
  page.on('request', (r) => {
    const u = r.url();
    if (!u.startsWith('http://127.0.0.1') && !u.startsWith('data:') && !u.startsWith('blob:')) fail(where, `запрос во внешний интернет: ${u}`);
  });
}

async function runViewport(browser, base, vp, tests, downloadsDir) {
  console.log(`\n=== ${vp.name} ===`);
  const ctx = await browser.newContext({ viewport: vp.viewport, isMobile: vp.isMobile, hasTouch: vp.hasTouch, deviceScaleFactor: vp.deviceScaleFactor, acceptDownloads: true, locale: 'ru-RU' });
  await ctx.addInitScript(vp.share === 'web-share' ? SHARE_STUB : NO_SHARE_STUB);
  const page = await ctx.newPage();
  attachErrorWatch(page, vp.short);
  await page.goto(base);
  await page.waitForSelector('.test-card');

  // Главный экран
  const cards = await page.$$eval('.test-card', (els) => els.map((e) => e.getAttribute('data-test')));
  check(cards.length === tests.length, vp.short, `карточек тестов ${cards.length}, ожидалось ${tests.length}`);
  check(!(await page.$('.chip--best')), vp.short, 'на чистом запуске уже показан лучший результат');
  await noHorizontalScroll(page, vp.short);
  await shot(page, `${vp.short}-home`);

  // Кнопка звука: выключить, перезагрузить — должна остаться выключенной, потом включить
  await press(page, vp, '.sound-btn', vp.mode === 'touch' ? 'touch' : 'mouse');
  check((await page.getAttribute('.sound-btn', 'data-sound')) === 'off', vp.short, 'кнопка звука не выключилась');
  await page.reload(); await page.waitForSelector('.test-card');
  check((await page.getAttribute('.sound-btn', 'data-sound')) === 'off', vp.short, 'выключенный звук не запомнился после перезагрузки');
  await press(page, vp, '.sound-btn', vp.mode === 'touch' ? 'touch' : 'mouse');
  check((await page.getAttribute('.sound-btn', 'data-sound')) === 'on', vp.short, 'кнопка звука не включилась обратно');

  const targets = [10, 7, 5, 2, 8, 9, 3, 6]; // покрывают все 4 ступени званий
  for (let ti = 0; ti < tests.length; ti++) {
    const test = tests[ti];
    if (ONLY && test.id !== ONLY) continue;
    const target = targets[ti % targets.length];
    const keys = vp.mode === 'mouse+keys' && ti % 2 === 1; // на компьютере каждый второй тест — клавиатурой
    process.stdout.write(`  ${test.title}: ${keys ? 'клавиатура' : vp.mode === 'touch' ? 'тап' : 'мышь'}, цель ${target}/10 … `);

    if (keys) await page.keyboard.press(String(ti + 1));
    else await press(page, vp, `.test-card[data-test="${test.id}"]`, vp.mode === 'touch' ? 'touch' : 'mouse');

    const prefix = SHOTS && (ti === 0 || test.questions[0].type === 'memory') ? `${vp.short}-${test.id}` : null;
    await playTest(page, vp, test, target, { keys, waitTimer: vp.waitTimer, shotsPrefix: prefix });
    await checkResult(page, vp, test, target);
    await shot(page, `${vp.short}-${test.id}-result`);
    await checkShare(page, vp, test, target, downloadsDir);

    // Лучший результат сохраняется и виден на карточке
    const stored = await page.evaluate((id) => localStorage.getItem('quiz-time:best:' + id), test.id);
    check(stored === String(target), `${vp.short}/${test.id}`, `лучший результат в хранилище «${stored}», ожидалось ${target}`);

    if (ti === 0) {
      // «Пройти ещё раз»: тест начинается заново, рекорд не затирается худшим результатом
      await press(page, vp, '[data-action="again"]', vp.mode === 'touch' ? 'touch' : 'mouse');
      await page.waitForSelector('.topbar__count');
      check((await page.textContent('.topbar__count')).trim() === `Вопрос 1 из ${test.questions.length}`, `${vp.short}/${test.id}`, '«Пройти ещё раз» не начал тест с первого вопроса');
      await playTest(page, vp, test, 4, { keys: false });
      await checkResult(page, vp, test, 4);
      const best = (await page.textContent('.result__best')) || '';
      check(best.includes(`${target} из`), `${vp.short}/${test.id}`, `после худшей попытки не показан прежний лучший результат: «${best}»`);
    }

    await press(page, vp, '[data-action="home"]', vp.mode === 'touch' ? 'touch' : 'mouse');
    await page.waitForSelector(`.test-card[data-test="${test.id}"]`);
    const chip = await page.$eval(`.test-card[data-test="${test.id}"]`, (e) => (e.querySelector('.chip--best') || {}).textContent || '');
    check(chip.includes(`${target} из ${test.questions.length}`), `${vp.short}/${test.id}`, `на карточке лучший результат «${chip}», ожидалось ${target} из ${test.questions.length}`);
    console.log('готово');
  }
  await shot(page, `${vp.short}-home-after`);

  // Esc с вопроса — на главный (компьютер)
  if (vp.mode === 'mouse+keys') {
    await page.keyboard.press('1');
    await page.waitForSelector('.topbar__count');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.test-card', { timeout: 2000 }).catch(() => fail(vp.short, 'Esc не возвращает к списку тестов'));
  }
  await ctx.close();
}

async function extraChecks(browser, base, tests) {
  console.log('\n=== Дополнительно ===');
  // 1) Без localStorage (приватный режим / запрет) — всё работает
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await ctx.addInitScript(NO_STORAGE_STUB + SHARE_STUB);
    const page = await ctx.newPage();
    attachErrorWatch(page, 'без-хранилища');
    await page.goto(base);
    await page.waitForSelector('.test-card');
    const test = tests.find((t) => t.questions[0].type !== 'memory') || tests[0];
    await page.tap(`.test-card[data-test="${test.id}"]`);
    await playTest(page, { short: 'nostore', mode: 'touch' }, test, 6, { keys: false });
    await checkResult(page, { short: 'nostore' }, test, 6);
    await page.tap('.sound-btn');
    console.log('  без localStorage: тест проходится, звук переключается');
    await ctx.close();
  }
  // 2) Ссылка из «Поделиться» (?test=id) сразу открывает тот же тест
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    attachErrorWatch(page, 'ссылка');
    const t = tests[1] || tests[0];
    await page.goto(base + '?test=' + t.id);
    await page.waitForSelector('.topbar__test');
    const label = (await page.textContent('.topbar__test')).trim();
    check(label.includes(t.title), 'ссылка', `?test=${t.id} открыл «${label}»`);
    await page.goto(base + '?test=nesushchestvuet');
    await page.waitForSelector('.test-card').catch(() => fail('ссылка', 'неизвестный ?test= не открыл главный экран'));
    console.log('  ссылка ?test=… открывает нужный тест');
    await ctx.close();
  }
  // 3) Данные тестов: 10 вопросов, 4 разных варианта, звания покрывают 0–10
  for (const t of tests) {
    const w = `данные/${t.id}`;
    check(t.questions.length === 10, w, `вопросов ${t.questions.length}, нужно 10`);
    t.questions.forEach((q, i) => {
      check(Array.isArray(q.a) && q.a.length === 4, w, `вопрос ${i + 1}: вариантов не 4`);
      check(new Set(q.a).size === q.a.length, w, `вопрос ${i + 1}: повторяются варианты`);
      if (q.type === 'memory') check(Array.isArray(q.show) && q.show.length >= 3, w, `вопрос ${i + 1}: пустая картинка`);
      else check(!!q.fact, w, `вопрос ${i + 1}: нет пояснения «А вы знали?»`);
    });
    check(t.ranks.length === 4 && t.ranks[0].min === 0, w, 'званий не 4 или первое не с 0');
  }
  console.log('  данные тестов в порядке');
}

(async () => {
  const { server, url } = await startServer();
  const downloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quiz-dl-'));
  const browser = await chromium.launch();
  try {
    // Тесты берём прямо из приложения — так проверка сама подхватит новые тесты.
    const p0 = await browser.newPage();
    await p0.goto(url);
    await p0.waitForSelector('.test-card');
    const tests = await p0.evaluate(() => JSON.parse(JSON.stringify(window.QuizApp.tests)));
    await p0.close();
    console.log(`Тестов найдено: ${tests.length} (${tests.map((t) => t.title).join(', ')})`);

    for (const vp of VIEWPORTS) await runViewport(browser, url, vp, tests, downloadsDir);
    await extraChecks(browser, url, tests);
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
