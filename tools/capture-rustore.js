#!/usr/bin/env node
/* Скриншоты карточки RuStore: телефон, книжные 1080×1920 PNG, режим Android-приложения
   (признак QuizTimeAndroid в user agent: без рекламы, баннера и ссылок; «50 на 50» — бесплатно).
   Запуск: NODE_PATH=/opt/node-tools/node_modules node tools/capture-rustore.js
   Кладёт release/rustore/screenshots/1-home, 2-question, 3-answer, 4-result -1080x1920.png. */
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'release', 'rustore', 'screenshots');
const WWW = fs.mkdtempSync(path.join(os.tmpdir(), 'quiz-shots-'));
execFileSync(path.join(ROOT, 'tools', 'build-web.sh'), [WWW], { stdio: 'ignore' });
const VERSION = /version:\s*"([^"]+)"/.exec(fs.readFileSync(path.join(ROOT, 'config.js'), 'utf8'))[1];
const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.0.0 Mobile Safari/537.36 QuizTimeAndroid/' + VERSION;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png' };

(async () => {
  const srv = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0].split('#')[0]);
      if (p.endsWith('/')) p += 'index.html';
      const file = path.join(WWW, p);
      if (!file.startsWith(WWW) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = 'http://127.0.0.1:' + srv.address().port + '/index.html';
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  // 360×640 CSS-пикселей × 3 = 1080×1920
  const ctx = await browser.newContext({ viewport: { width: 360, height: 640 }, deviceScaleFactor: 3, locale: 'ru-RU', userAgent: UA, hasTouch: true, isMobile: true });
  await ctx.addInitScript(() => {
    window.AppShare = { shareText() { return true; }, shareImage() { return true; } };
    // «как у игрока»: пара пройденных тестов с рекордами
    if (!localStorage.getItem('quiz-time:best:kino')) {
      localStorage.setItem('quiz-time:best:kino', '8');
      localStorage.setItem('quiz-time:best:cartoons', '9');
      localStorage.setItem('quiz-time:visits', JSON.stringify({ n: 2, last: 0 }));
    }
  });
  const page = await ctx.newPage();
  const settled = () => page.waitForSelector("#app[data-input='ready']", { timeout: 5000 });
  async function shot(name) {
    await page.waitForTimeout(600);
    const bad = await page.evaluate(() => /реклам|vk\.com|ok\.ru|ВКонтакте|Одноклассник/i.test(document.body.innerText) || !!document.querySelector('.fake-banner, .fake-ad, .support-link'));
    if (bad) throw new Error('реклама / ВК / ОК на экране ' + name);
    await page.screenshot({ path: path.join(OUT, name + '-1080x1920.png') });
    console.log('  ' + name);
  }
  await page.goto(base);
  await page.waitForFunction(() => window.QuizApp && QuizApp.isReady && QuizApp.isReady(), null, { timeout: 15000 });
  await settled();
  await shot('1-home');
  await page.click('.test-card[data-test="ussr"]');
  await settled();
  await page.click("[data-action='start']");
  await page.waitForSelector('.answer');
  await settled();
  await shot('2-question');
  await page.click('.hint-btn');
  await page.waitForTimeout(300);
  const right = await page.evaluate(() => QuizApp.state().order.findIndex((a) => a.correct));
  await page.click(`.answer[data-index="${right}"]`);
  await page.waitForSelector('.next-btn');
  await page.waitForTimeout(600);
  // экран сам докручивает до «Дальше»: начинаем кадр со строки «Подсказка: два неверных ответа убраны»
  await page.evaluate(() => { const n = document.querySelector('.hint-note'); if (n) window.scrollTo(0, n.getBoundingClientRect().top + scrollY - 24); });
  await shot('3-answer');
  for (let i = 0; i < 40 && await page.evaluate(() => QuizApp.screen() !== 'result'); i++) {
    await settled();
    if (await page.$('.next-btn')) { await page.click('.next-btn'); await page.waitForTimeout(250); continue; }
    const k = await page.evaluate((n) => { const s = QuizApp.state(); const c = s.order.findIndex((a) => a.correct); return n === 3 ? s.order.findIndex((a, j) => j !== c && !a.out) : c; }, i);
    await page.click(`.answer[data-index="${k}"]`);
    await page.waitForSelector('.next-btn');
  }
  await page.waitForFunction(() => QuizApp.screen() === 'result');
  await settled();
  await shot('4-result');
  await browser.close();
  srv.close();
  fs.rmSync(WWW, { recursive: true, force: true });
})().catch((e) => { console.error(e); process.exit(1); });
