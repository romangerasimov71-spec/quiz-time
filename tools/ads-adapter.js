// Адаптер набора проверки рекламы (tools/ads-test, копия kits/ads-test из game-studio) для «Викторин».
//   python3 -m http.server 8790 --bind 127.0.0.1 &
//   NODE_PATH=/opt/node-tools/node_modules node tools/ads-test/run.js --url "http://127.0.0.1:8790/index.html?test=ussr" --adapter tools/ads-adapter.js
//
// Награда — подсказка «50 на 50» (кнопка .hint-btn на экране вопроса, убирает два неверных ответа).
// Одна подсказка за прохождение (10 вопросов), поэтому rewardCount — сколько подсказок выдано за запуск.
// Опоздавшая реклама (началась после «не загрузилась»), досмотренная до конца, даёт подсказку,
// если человек всё ещё в том же прохождении (решение Романа 11 ноя). Ушёл из прохождения —
// «Заново» (тот же тест с начала), прошёл тест до результата, открыл другой тест — подсказки нет.
// Межстраничной рекламы в «Викторинах» нет — случаи interstitial-* не проверяются (SKIP).
const trial = async (loc) => {
  try { await loc.click({ trial: true, timeout: 500 }); return true; } catch (e) { return false; }
};
const ready = (page) => page.waitForFunction(() => window.QuizApp && QuizApp.isReady(), null, { timeout: 15000 });
const settled = (page) => page.waitForSelector('#app[data-input="ready"]', { timeout: 5000 });

// С главного экрана: открыть тест и нажать «Начать»
async function startTest(page, id) {
  await page.waitForSelector(`.test-card[data-test="${id}"]`);
  await settled(page);
  await page.click(`.test-card[data-test="${id}"]`);
  await page.waitForSelector('[data-action="start"]');
  await settled(page);
  await page.click('[data-action="start"]');
  await page.waitForSelector('.answer');
  await settled(page);
}
async function toHome(page) {
  await settled(page);
  await page.click('[data-action="back"]');
  await page.waitForSelector('.test-card');
}

module.exports = {
  name: 'Викторины',
  viewport: { width: 390, height: 844 },
  contextOptions: { locale: 'ru-RU', hasTouch: true },
  rewardTimeoutMs: 12000,          // config.js REWARDED_WAIT_SEC
  lateRewardGranted: true,

  async prepare(page) {
    await ready(page);
    await page.waitForSelector('[data-action="start"]');   // адрес с ?test=ussr — заставка теста
    await settled(page);
    await page.click('[data-action="start"]');
    await page.waitForSelector('.hint-btn');
    await settled(page);
  },

  async clickRewarded(page) { await page.click('.hint-btn'); },

  // сколько подсказок выдано за этот запуск
  async rewardCount(page) { return page.evaluate(() => QuizApp.adGrants()); },

  // Ответы нажимаются (ничем не закрыты): первый не убранный подсказкой вариант
  async boardWorks(page) {
    if (await page.evaluate(() => document.body.classList.contains('is-ad-wait'))) return false;
    const answer = page.locator('.answer:not(.is-out):not([disabled])').first();
    if (await answer.count()) return trial(answer);
    return trial(page.locator('.next-btn, [data-action="start"], .test-card').first());
  },

  // «‹ Тесты» нажимается, нет окна «Загружаем рекламу»
  async buttonsWork(page) {
    if (await page.evaluate(() => document.body.classList.contains('is-ad-wait'))) return false;
    return trial(page.locator('[data-action="back"]').first());
  },

  // «Заново»: к списку тестов и снова тот же тест — это новое прохождение
  async restartLevel(page) { await toHome(page); await startTest(page, 'ussr'); },

  // Тест пройден до конца (на экране результат)
  async winLevel(page) {
    for (let i = 0; i < 10; i++) {
      await page.waitForSelector('.answer');
      await settled(page);
      await page.click('.answer:not(.is-out)');
      await page.waitForSelector('.next-btn');
      await settled(page);
      await page.click('.next-btn');
    }
    await page.waitForSelector('.result__card');
  },

  // Другой тест
  async switchLevel(page) { await toHome(page); await startTest(page, 'kino'); },

  async isPaused(page) { return page.evaluate(() => Platform.isPaused()); },
};
