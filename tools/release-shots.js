/* Скриншоты для ВК и ОК: 600x1200, книжные, с настоящих экранов приложения.
   Запуск (из корня репозитория):
     python3 -m http.server 8791 --bind 127.0.0.1 &
     NODE_PATH=/opt/node-tools/node_modules node tools/release-shots.js
   Кладёт в release/vk/screens/. */
"use strict";
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const OUT = path.resolve(__dirname, "..", "release", "vk", "screens");
fs.mkdirSync(OUT, { recursive: true });
const BASE = "http://127.0.0.1:8791/index.html?nobanner";
const settled = (p) => p.waitForSelector('#app[data-input="ready"]', { timeout: 8000 });

(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 400, height: 800 }, deviceScaleFactor: 1.5, locale: "ru-RU", hasTouch: true });
  const p = await ctx.newPage();
  const shot = (name) => p.screenshot({ path: path.join(OUT, name), clip: { x: 0, y: 0, width: 400, height: 800 } });

  await p.goto(BASE); await p.waitForSelector(".daily-card"); await settled(p); await p.waitForTimeout(400);
  await shot("1-glavnaya.png");

  // тест «СССР»: вопрос с кнопкой подсказки
  await p.click('.test-card[data-test="ussr"]'); await p.waitForSelector('[data-action="start"]'); await settled(p);
  await p.click('[data-action="start"]'); await p.waitForSelector(".answer"); await settled(p); await p.waitForTimeout(400);
  await shot("2-vopros.png");

  // проходим тест: 8 верных из 10, нужные ответы берём из данных теста
  let prevQ = "";
  for (let i = 0; i < 10; i++) {
    if (i) { for (let k = 0; k < 40 && (await p.textContent(".question")) === prevQ; k++) await p.waitForTimeout(150);
      await settled(p); }
    prevQ = await p.textContent(".question");
    await settled(p); await p.waitForTimeout(500);
    const idx = await p.evaluate((wrong) => {
      const q = document.querySelector(".question").textContent;
      const t = QUIZ_TESTS.find((x) => x.id === "ussr");
      const item = t.questions.find((x) => x.q === q);
      const texts = [...document.querySelectorAll(".answer__text")].map((e) => e.textContent);
      const good = texts.indexOf(item.a[0]);
      return wrong ? (good + 1) % texts.length : good;
    }, i === 3 || i === 7);
    await p.locator(".answer").nth(idx).click();
    if (i === 4) { await p.waitForTimeout(500); await shot("tmp-otvet.png"); }
    await p.waitForSelector('[data-action="next"]'); await settled(p); await p.waitForTimeout(600); await p.click('[data-action="next"]');
  }
  await p.waitForSelector(".result__card"); await settled(p); await p.waitForTimeout(800);
  await shot("3-rezultat.png");

  // «Поделиться»
  await p.click('[data-action="share"]'); await p.waitForSelector("[data-share-dialog]"); await p.waitForTimeout(800);
  await shot("4-podelitsya.png");
  await p.keyboard.press("Escape"); await p.waitForTimeout(300);

  // «Проверь память»
  await p.goto(BASE + "&test=memory"); await p.waitForSelector('[data-action="start"]'); await settled(p);
  await p.click('[data-action="start"]'); await p.waitForSelector(".memorize"); await p.waitForTimeout(700);
  await shot("5-pamyat.png");
  await b.close();
  console.log("готово");
})();
