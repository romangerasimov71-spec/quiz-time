#!/usr/bin/env node
/* Рисует кодом картинки для ссылки и значка и кладёт их в img/:
     img/og-cover.png        — 1200×630, превью ссылки в ВК/ОК/мессенджерах (og:image)
     img/apple-touch-icon.png — 180×180, значок на экране «Домой» у iPhone
   Запуск из корня репозитория: node tools/make-images.js
   Названия, эмодзи и цвета тестов берутся из tests/*.js (список — из index.html). */
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'img');
fs.mkdirSync(OUT, { recursive: true });

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const testFiles = [...html.matchAll(/<script src="(tests\/[^"]+)"><\/script>/g)].map((m) => m[1]);

const FONT = "'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";
const EMOJI = "'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', sans-serif";

const COVER = (tests) => `<!doctype html><html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; margin: 0; }
  body { width: 1200px; height: 630px; overflow: hidden; font-family: ${FONT};
    background: linear-gradient(135deg, #fff4e3, #ffe2bd); color: #2f2217; position: relative; }
  .dot { position: absolute; border-radius: 50%; background: rgba(191, 54, 12, 0.08); }
  .head { position: absolute; left: 70px; top: 64px; display: flex; align-items: center; gap: 28px; }
  .logo { width: 128px; height: 128px; border-radius: 36px; background: linear-gradient(135deg, #e0561f, #bf360c);
    color: #fff; font-size: 92px; font-weight: 900; display: grid; place-items: center; transform: rotate(-6deg);
    box-shadow: 0 8px 0 rgba(120, 30, 0, 0.25); }
  h1 { font-size: 104px; font-weight: 900; letter-spacing: -2px; line-height: 1; }
  .sub { font-size: 40px; font-weight: 700; color: #6d5a48; margin-top: 10px; }
  .tiles { position: absolute; left: 70px; right: 70px; bottom: 70px; display: flex; gap: 22px; }
  .tile { flex: 1; height: 210px; border-radius: 34px; color: #fff; padding: 22px 16px 18px; text-align: center;
    display: flex; flex-direction: column; align-items: center; justify-content: space-between;
    box-shadow: 0 8px 0 rgba(0, 0, 0, 0.16); }
  .em { width: 104px; height: 104px; border-radius: 28px; background: rgba(255, 255, 255, 0.94);
    display: grid; place-items: center; font-family: ${EMOJI}; font-size: 66px; }
  .name { font-size: 27px; font-weight: 800; line-height: 1.1; }
</style></head><body>
  <div class="dot" style="width:360px;height:360px;right:-90px;top:-130px"></div>
  <div class="dot" style="width:140px;height:140px;right:300px;top:40px"></div>
  <div class="head"><div class="logo">?</div><div><h1>Викторины</h1>
    <div class="sub">10 вопросов — и ваше звание. А вы сколько наберёте?</div></div></div>
  <div class="tiles">${tests.map((t) => `<div class="tile" style="background:linear-gradient(135deg,${t.color},${t.color2 || t.color})">
    <div class="em">${t.emoji}</div><div class="name">${t.title}</div></div>`).join('')}</div>
</body></html>`;

const ICON = `<!doctype html><html><head><meta charset="utf-8"><style>
  * { margin: 0; }
  body { width: 180px; height: 180px; overflow: hidden; display: grid; place-items: center;
    background: linear-gradient(135deg, #e0561f, #bf360c); font-family: ${FONT}; }
  div { color: #fff; font-size: 132px; font-weight: 900; line-height: 1; transform: rotate(-6deg) translateY(4px);
    text-shadow: 0 6px 0 rgba(90, 20, 0, 0.3); }
</style></head><body><div>?</div></body></html>`;

(async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
    // Данные тестов — прямо из их файлов
    await page.setContent('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>');
    for (const f of testFiles) await page.addScriptTag({ path: path.join(ROOT, f) });
    const tests = await page.evaluate(() => window.QUIZ_TESTS.map((t) => ({ title: t.title, emoji: t.emoji, color: t.color, color2: t.color2 })));

    await page.setContent(COVER(tests));
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(OUT, 'og-cover.png') });

    await page.setViewportSize({ width: 180, height: 180 });
    await page.setContent(ICON);
    await page.waitForTimeout(100);
    await page.screenshot({ path: path.join(OUT, 'apple-touch-icon.png') });

    for (const f of ['og-cover.png', 'apple-touch-icon.png']) {
      console.log(`img/${f}: ${Math.round(fs.statSync(path.join(OUT, f)).size / 1024)} КБ`);
    }
  } finally {
    await browser.close();
  }
})();
