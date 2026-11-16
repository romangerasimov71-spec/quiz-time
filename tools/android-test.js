#!/usr/bin/env node
/* Режим Android-приложения (RuStore): WebView дописывает «QuizTimeAndroid/<версия>» к user agent.
   Проверяет веб-сборку, которая лежит в APK (tools/build-web.sh), на 127.0.0.1 — «проверочном» адресе, где в браузере
   была бы имитация рекламы и баннера: в Android-режиме их быть не должно.
   - запуск без Bridge (Playgama initialize не вызывается, даже с параметрами ВК в адресе), id = 'android';
   - нет рекламы, баннера и зоны под него (--banner-zone 0), нет «в избранное», нет поддержки vk.com / ok.ru,
     ни слова о ВК/ОК и рекламе, ни одной ссылки наружу;
   - «50 на 50» бесплатно и один раз за прохождение (решение Романа 16 ноя), «Пройти ещё раз» — снова одна;
   - «Поделиться результатом» — системное меню через мост window.AppShare: картинка JPEG + текст без ссылки;
   - рекорд в localStorage переживает перезапуск;
   - QuizApp.back(): посреди теста — «Выйти из теста?», ещё раз — «Остаться», с заставки — к списку, на главном — false;
   - QuizApp.appPause(): картинка «запомни» на паузе и звук придержан, потом всё продолжается;
   - внешних запросов и ошибок в консоли нет.
   Запуск: NODE_PATH=/opt/node-tools/node_modules node tools/android-test.js   (сам делает tools/build-web.sh во временную папку) */
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const WWW = fs.mkdtempSync(path.join(os.tmpdir(), 'quiz-android-'));
execFileSync(path.join(ROOT, 'tools', 'build-web.sh'), [WWW], { stdio: 'ignore' });
const VERSION = /version:\s*"([^"]+)"/.exec(fs.readFileSync(path.join(ROOT, 'config.js'), 'utf8'))[1];
const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.0.0 Mobile Safari/537.36 QuizTimeAndroid/' + VERSION;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg' };

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0].split('#')[0]);
      if (p.endsWith('/')) p += 'index.html';
      const file = path.join(WWW, p);
      if (!file.startsWith(WWW) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      fs.createReadStream(file).pipe(res);
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

let fails = 0;
function ok(cond, msg, extra) {
  if (cond) console.log('  ok   ' + msg + (extra ? '  ' + extra : ''));
  else { fails++; console.log('  FAIL ' + msg + (extra ? '  ' + extra : '')); }
}
const FORBIDDEN = /vk\.com|ok\.ru|github\.io|https?:\/\/|ВКонтакте|Одноклассник|реклам|Уютные игры/i;
const readyApp = (page) => page.waitForFunction(() => window.QuizApp && QuizApp.isReady && QuizApp.isReady(), null, { timeout: 15000 });
const settled = (page) => page.waitForSelector("#app[data-input='ready']", { timeout: 5000 });
const st = (page) => page.evaluate(() => { const s = QuizApp.state(); return s && { idx: s.idx, phase: s.phase, answered: s.answered, hintsLeft: s.hintsLeft, total: s.total }; });
const text = (page) => page.evaluate(() => document.body.innerText + ' ' + Array.from(document.querySelectorAll('a[href]')).map((a) => a.getAttribute('href')).join(' '));
async function tap(page, sel) { await settled(page); await page.click(sel); }

async function open(browser, base, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, userAgent: opts.ua === undefined ? UA : opts.ua,
    locale: 'ru-RU', hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  await ctx.addInitScript(() => {
    window.__share = [];
    window.AppShare = {
      shareText(title, text) { window.__share.push({ kind: 'text', title, text }); return true; },
      shareImage(data, name, text, title) { window.__share.push({ kind: 'image', data: data.slice(0, 30), len: data.length, name, text, title }); return true; }
    };
    window.__init = 0;
    let pg;
    Object.defineProperty(window, 'bridge', { configurable: true, get: () => pg, set: (v) => {
      pg = v;
      try { const orig = v.initialize.bind(v); v.initialize = function () { window.__init++; return orig.apply(null, arguments); }; } catch (e) { /* без Bridge */ }
    } });
  });
  const page = await ctx.newPage();
  const w = { errors: [], external: [] };
  page.on('console', (m) => { if (m.type() === 'error') w.errors.push(m.text()); });
  page.on('pageerror', (e) => w.errors.push(String(e)));
  page.on('request', (r) => { if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(r.url()) && !/^(data|blob):/.test(r.url())) w.external.push(r.url()); });
  const t0 = Date.now();
  await page.goto(base + (opts.query || ''));
  await readyApp(page);
  return { ctx, page, w, ms: Date.now() - t0 };
}
async function answer(page, right) {
  await settled(page);
  const i = await page.evaluate((r) => { const s = QuizApp.state(); const c = s.order.findIndex((a) => a.correct); if (r) return c; return s.order.findIndex((a, k) => k !== c && !a.out); }, right);
  await page.click(`.answer[data-index="${i}"]`);
  await page.waitForSelector('.next-btn');
}
async function startTest(page, id) {
  await tap(page, `.test-card[data-test="${id}"]`);
  await tap(page, "[data-action='start']");
  await page.waitForFunction(() => { const s = QuizApp.state(); return s && (s.phase === 'ask' || s.phase === 'memorize'); });
}
const noBanner = (page) => page.evaluate(() => !document.querySelector('.fake-banner') && !document.documentElement.classList.contains('has-banner') &&
  !(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--banner-h')) > 0) &&
  !(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--banner-zone')) > 0) && Platform.banner.mode === 'none');

(async () => {
  const srv = await serve();
  const base = 'http://127.0.0.1:' + srv.address().port + '/index.html';
  const browser = await chromium.launch();
  try {
    console.log('Запуск (с параметрами ВК в адресе — всё равно без площадки)');
    let { ctx, page, w, ms } = await open(browser, base, { query: '?vk_app_id=1&vk_platform=mobile_android' });
    ok(ms < 4000, 'главный экран без ожидания площадки', ms + ' мс');
    ok(await page.evaluate(() => Platform.id === 'android' && Platform.isAndroid && !Platform.hasBridge && !Platform.isReal && Platform.launch === '' && Platform.socialId() === ''),
      'Platform.id = android, Bridge нет, это не ВК/ОК');
    ok(await page.evaluate(() => window.__init === 0), 'Playgama Bridge initialize не вызывался');
    ok(await page.evaluate(() => !Platform.rewardedAvailable() && Platform.favoritesKind() === '' && !Platform.externalLinksAllowed() && Platform.appUrl() === '' && Platform.supportUrl() === ''),
      'реклама, «в избранное», ссылки наружу, адрес приложения и поддержка выключены');
    ok(await noBanner(page), 'нет баннера и зоны под него');
    ok(!(await page.$('.support-link')) && !(await page.$('.fav-offer')), 'нет строки поддержки и предложения «в избранное»');
    let t = await text(page);
    ok(!FORBIDDEN.test(t), 'главный: ни ссылок, ни ВК/ОК, ни рекламы', t.match(FORBIDDEN) ? t.match(FORBIDDEN)[0] : '');

    console.log('«50 на 50» — бесплатно, один раз за тест');
    await startTest(page, 'ussr');
    let btn = await page.$('.hint-btn');
    ok(!!btn, 'кнопка подсказки на первом вопросе');
    const label = btn ? (await btn.innerText()) + ' ' + (await btn.getAttribute('aria-label')) : '';
    ok(btn && /50 на 50/.test(label) && !/реклам/i.test(label), 'подпись без рекламы', label.replace(/\s+/g, ' '));
    await tap(page, '.hint-btn');
    await page.waitForTimeout(200);
    ok(await page.evaluate(() => document.querySelectorAll('.answer.is-out').length === 2 && !!document.querySelector('.hint-note') &&
      !document.querySelector('.fake-ad, .ad-wait')), 'сразу убраны два неверных, без окна рекламы');
    ok((await st(page)).hintsLeft === 0, 'подсказок за тест больше нет');
    ok(!FORBIDDEN.test(await text(page)), 'экран вопроса: ни ссылок, ни рекламы');
    ok(await noBanner(page), 'нет баннера (вопрос)');
    await answer(page, true);
    await tap(page, '.next-btn');
    await page.waitForFunction(() => QuizApp.state().idx === 1);
    ok(!(await page.$('.hint-btn')), 'на втором вопросе подсказки уже нет');

    console.log('«Назад» посреди теста');
    ok(await page.evaluate(() => QuizApp.back()) === true, 'back() = true');
    ok(await page.evaluate(() => QuizApp.exitAsked()), 'спросили «Выйти из теста?»');
    ok(await page.evaluate(() => QuizApp.back()) === true && await page.evaluate(() => !QuizApp.exitAsked() && QuizApp.screen() === 'question'), 'ещё раз «Назад» — «Остаться»');

    console.log('Конец теста, рекорд, «Поделиться»');
    for (;;) {
      const s = await st(page);
      if (!s || s.phase !== 'ask') break;
      await answer(page, true);
      await tap(page, '.next-btn');
      await page.waitForTimeout(150);
      if (await page.evaluate(() => QuizApp.screen()) === 'result') break;
    }
    await page.waitForFunction(() => QuizApp.screen() === 'result', null, { timeout: 5000 });
    t = await text(page);
    ok(!FORBIDDEN.test(t), 'экран результата: ни ссылок, ни ВК/ОК, ни рекламы', t.match(FORBIDDEN) ? t.match(FORBIDDEN)[0] : '');
    await tap(page, "[data-action='share']");
    await page.waitForFunction(() => window.__share.length > 0, null, { timeout: 5000 });
    let sh = await page.evaluate(() => window.__share.slice(-1)[0]);
    ok(sh && sh.kind === 'image' && sh.data.startsWith('data:image/jpeg;base64,') && sh.len > 20000 && /\.jpg$/.test(sh.name), 'картинка-результат через системное меню', sh ? Math.round(sh.len / 1024) + ' КБ' : '');
    ok(sh && /10 из 10/.test(sh.text) && !FORBIDDEN.test(sh.text), 'текст результата без ссылки', sh ? sh.text : '');
    ok(await page.evaluate(() => !QuizShare.isDialogOpen()), 'своего окна «Поделиться» нет');
    ok(await page.evaluate(() => localStorage.getItem('quiz-time:best:ussr') === '10'), 'рекорд записан в localStorage');
    await tap(page, "[data-action='again']");
    await page.waitForFunction(() => { const s = QuizApp.state(); return s && s.phase === 'ask' && s.idx === 0; });
    ok(!!(await page.$('.hint-btn')) && (await st(page)).hintsLeft === 1, '«Пройти ещё раз» — снова одна подсказка');

    console.log('«Назад» по экранам');
    ok(await page.evaluate(() => QuizApp.back()) === true, 'первый вопрос (ещё не отвечал) → back() = true');
    await page.waitForTimeout(500);
    ok(await page.evaluate(() => QuizApp.screen() !== 'question'), 'ушли с вопроса без вопроса «Выйти?»', await page.evaluate(() => QuizApp.screen()));
    for (let i = 0; i < 3 && await page.evaluate(() => QuizApp.screen() !== 'home'); i++) { await page.evaluate(() => QuizApp.back()); await page.waitForTimeout(500); }
    ok(await page.evaluate(() => QuizApp.screen() === 'home'), 'дошли до главного');
    ok(await page.evaluate(() => QuizApp.back()) === false, 'на главном back() = false (приложение закрывается)');

    console.log('Перезапуск — рекорд на месте');
    await page.reload(); await readyApp(page);
    ok(/10 из 10|Рекорд|10\/10/.test(await page.evaluate(() => document.querySelector('.test-card[data-test="ussr"]').innerText)), 'рекорд «СССР» виден на карточке');

    console.log('Свернули на «запомни» — пауза и тишина');
    await startTest(page, 'memory');
    if ((await st(page)).phase === 'memorize') {
      await page.evaluate(() => QuizApp.appPause(true));
      await page.waitForTimeout(300);
      ok(await page.evaluate(() => QuizApp.state().memoInterrupted === true), 'appPause(true): картинка «запомни» на паузе');
      await page.evaluate(() => QuizApp.appPause(false));
      await page.waitForTimeout(300);
      ok(await page.evaluate(() => QuizApp.state().phase === 'memorize' && !QuizApp.state().memoInterrupted), 'appPause(false): картинка снова идёт');
    } else ok(false, 'тест «память» начался не с картинки');
    ok(w.external.length === 0, 'внешних запросов нет', w.external.slice(0, 3).join(' '));
    ok(w.errors.length === 0, 'ошибок в консоли нет', w.errors.slice(0, 3).join(' | '));
    await ctx.close();

    console.log('Контроль: обычный браузер (без признака) — как раньше');
    ({ ctx, page, w } = await open(browser, base, { ua: '' }));
    ok(await page.evaluate(() => Platform.id !== 'android' && !Platform.isAndroid && Platform.banner.mode === 'fake' && Platform.rewardedAvailable() && Platform.supportUrl() !== ''),
      'в браузере на проверочном адресе — имитация рекламы и баннера, поддержка, как было');
    await startTest(page, 'ussr');
    const lb = await page.$eval('.hint-btn', (b) => b.innerText);
    ok(/реклам/.test(lb), 'в браузере подсказка — за рекламу', lb.replace(/\s+/g, ' '));
    await ctx.close();
  } finally {
    await browser.close();
    srv.close();
    fs.rmSync(WWW, { recursive: true, force: true });
  }
  console.log(fails ? '\nИТОГ: ошибок ' + fails : '\nИТОГ: всё ок');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

