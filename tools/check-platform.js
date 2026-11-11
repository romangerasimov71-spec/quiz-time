/* Проверка площадочной части «Викторин» (Playwright + Chromium), по образцу «Сонника»:
   баннер внизу, подсказка «50 на 50» за рекламу во всех случаях, хранилище через Bridge,
   «Поделиться» во ВК/ОК и на компьютере, ссылка из площадки, отметки для статистики.
   Запуск: NODE_PATH=/opt/node-tools/node_modules node tools/check-platform.js   (~8 мин: реклама ждёт по 12 с)
           SHOTS=/путь … — плюс скриншоты.
   Реклама здесь — имитация из platform.js (?fakead=ok|cancel|fail|silent|late, ?fakeadsec=1).
   Настоящие состояния Bridge проверяет набор tools/ads-test (см. tools/ads-adapter.js). */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const SHOTS = process.env.SHOTS || "";
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg" };

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split("?")[0]);
      if (p.endsWith("/")) p += "index.html";
      const file = path.join(ROOT, p);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end("not found"); }
      res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
      fs.createReadStream(file).pipe(res);
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

let fails = 0, oks = 0;
function ok(cond, msg) {
  if (cond) { oks++; console.log("  ok   " + msg); }
  else { fails++; console.log("  FAIL " + msg); }
}
async function shot(page, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, name + ".png"), fullPage: false });
}

const PHONE = { width: 390, height: 844 };
async function open(browser, url, vp, opts = {}) {
  const touch = opts.touch != null ? opts.touch : (vp || PHONE).width < 900;
  const ctx = opts.ctx || await browser.newContext({ viewport: vp || PHONE, deviceScaleFactor: 1, hasTouch: touch, isMobile: touch, locale: "ru-RU" });
  if (!opts.ctx && !opts.keepShare) await ctx.addInitScript(() => { try { delete Navigator.prototype.share; delete Navigator.prototype.canShare; } catch (e) {} });
  if (opts.init) await ctx.addInitScript(opts.init);
  const page = await ctx.newPage();
  page._errors = [];
  page.on("console", (m) => { if (m.type() === "error") page._errors.push(m.text()); });
  page.on("pageerror", (e) => page._errors.push(String(e)));
  await page.goto(url);
  await readyApp(page);
  return page;
}
const readyApp = (page) => page.waitForFunction(() => window.QuizApp && QuizApp.isReady && QuizApp.isReady(), null, { timeout: 15000 });
const settled = (page) => page.waitForSelector("#app[data-input='ready']", { timeout: 5000 });
const events = (page) => page.evaluate(() => window.Analytics._log.map((x) => ({ name: x.name, data: x.data })));
const st = (page) => page.evaluate(() => { const s = QuizApp.state(); return s && { idx: s.idx, phase: s.phase, answered: s.answered, hintsLeft: s.hintsLeft, pending: s.hintPending }; });
async function tap(page, sel) { await settled(page); await page.click(sel); }
async function reload(page, url) { await page.goto(url); await page.reload(); await readyApp(page); }

// Подсказка сработала: два неверных убраны, верный на месте, кнопки подсказки нет
async function hintApplied(page) {
  return page.evaluate(() => {
    const s = QuizApp.state();
    const btns = [...document.querySelectorAll(".answer")];
    const out = btns.filter((b) => b.classList.contains("is-out"));
    const correct = s.order.findIndex((a) => a.correct);
    return out.length === 2 && !btns[correct].classList.contains("is-out") && out.every((b) => b.disabled) &&
      !document.querySelector(".hint-btn") && !!document.querySelector(".hint-note");
  });
}
const outCount = (page) => page.evaluate(() => document.querySelectorAll(".answer.is-out").length);
async function answer(page, right) {
  await settled(page);
  const i = await page.evaluate((r) => { const s = QuizApp.state(); const c = s.order.findIndex((a) => a.correct); if (r) return c; return s.order.findIndex((a, k) => k !== c && !a.out); }, right);
  await page.click(`.answer[data-index="${i}"]`);
  await page.waitForSelector(".next-btn");
}
async function nextQ(page) { await tap(page, ".next-btn"); }
async function watchFakeAd(page) {
  await page.waitForSelector(".fake-ad", { timeout: 16000 });
  await page.waitForFunction(() => /досмотрена/.test(document.querySelector(".fake-ad p").textContent), null, { timeout: 8000 });
  await page.click(".fake-ad-close");
  await page.waitForTimeout(200);
}
// Пройти «запомни» до вопроса (кнопка «Готово»)
async function passMemorize(page) {
  if ((await st(page)).phase !== "memorize") return;
  await page.waitForSelector("[data-action='ready']:not([disabled])");
  await tap(page, "[data-action='ready']");
  await page.waitForSelector(".answer");
}

// Баннер не закрывает ничего в приложении. strict = без прокрутки (для «запомни»: таймер идёт);
// иначе — как в «Сonнике»: докрутили до конца, ни один текст и ни одна кнопка не под баннером.
async function bannerClear(page, label, strict) {
  const r = await page.evaluate(async (strictMode) => {
    if (!strictMode) { window.scrollTo(0, document.documentElement.scrollHeight); await new Promise((res) => setTimeout(res, 80)); }
    const ban = document.querySelector(".fake-banner");
    if (!ban || getComputedStyle(ban).display === "none") return { noBanner: true };
    const top = ban.getBoundingClientRect().top;
    const under = [];
    document.querySelectorAll("#app button, #app a, #app p, #app h1, #app h2, #app .mem-cell, #app .timer, #app .progress, #app .topbar__test").forEach((el) => {
      const b = el.getBoundingClientRect();
      if (!b.width || !b.height || el.offsetParent === null || getComputedStyle(el).visibility === "hidden") return;
      if (b.bottom > top + 0.5 && b.top < window.innerHeight) under.push((el.className || el.tagName) + " «" + el.textContent.trim().slice(0, 20) + "» " + Math.round(b.bottom) + ">" + Math.round(top));
    });
    window.scrollTo(0, 0);
    return { under, h: Math.round(ban.getBoundingClientRect().height) };
  }, !!strict);
  ok(!r.noBanner, label + ": баннер на экране");
  if (r.noBanner) return;
  ok(!r.under.length, label + ": баннер (" + r.h + "px) не закрывает текст и кнопки" + (strict ? " (без прокрутки)" : "") + (r.under.length ? " " + JSON.stringify(r.under.slice(0, 4)) : ""));
}
const bannerHidden = (page) => page.evaluate(() => { const b = document.querySelector(".fake-banner"); if (!b) return true; return getComputedStyle(b).display === "none" || b.getBoundingClientRect().height === 0; });
const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

(async () => {
  const srv = await serve();
  const BASE = "http://127.0.0.1:" + srv.address().port + "/";
  const browser = await chromium.launch();
  const t0 = Date.now();

  console.log("Площадка без ВК/ОК (как на GitHub Pages):");
  {
    const page = await open(browser, BASE);
    const s = await page.evaluate(() => ({ id: Platform.id, bridge: Platform.hasBridge, rew: Platform.rewardedAvailable(), banner: Platform.banner.mode }));
    ok(s.bridge && s.id === "mock", "Playgama Bridge запущен, площадка — обычный браузер (" + s.id + ")");
    ok(s.rew && s.banner === "fake", "реклама за награду и баннер — имитация");
    ok(await page.evaluate(() => document.documentElement.classList.contains("has-banner")), "баннер показан, место под него оставлено (has-banner)");
    ok(!page._errors.length, "ошибок в консоли нет " + JSON.stringify(page._errors));
    await page.context().close();
  }

  console.log("\nБаннер не закрывает вопрос, ответы, «Дальше», «Поделиться»:");
  for (const vp of [{ width: 390, height: 844 }, { width: 360, height: 640 }, { width: 844, height: 390 }, { width: 1280, height: 800 }]) {
    const label = vp.width + "×" + vp.height;
    const page = await open(browser, BASE + "?fakeadsec=1", vp);
    await bannerClear(page, label + " главная");
    await shot(page, "banner-" + label + "-home");
    await reload(page, BASE + "?fakeadsec=1&test=ussr");
    await bannerClear(page, label + " заставка");
    await tap(page, "[data-action='start']");
    await page.waitForSelector(".hint-btn");
    await bannerClear(page, label + " вопрос с кнопкой «50 на 50»");
    await shot(page, "banner-" + label + "-question");
    await answer(page, false);
    await page.waitForTimeout(500);
    // «Дальше» после ответа сам прокручивается на экран — и не под баннер
    const nextVisible = await page.evaluate(() => { const r = document.querySelector(".next-btn").getBoundingClientRect(); const b = document.querySelector(".fake-banner").getBoundingClientRect(); return r.top >= 0 && r.bottom <= b.top + 0.5; });
    ok(nextVisible, label + ": после ответа «Дальше» видно над баннером");
    await shot(page, "banner-" + label + "-feedback");
    await bannerClear(page, label + " ответ и «А вы знали?»");
    for (let i = 1; i < 10; i++) { await nextQ(page); await answer(page, i % 2 === 0); }
    await nextQ(page);
    await page.waitForSelector(".result__card");
    await bannerClear(page, label + " результат");
    await shot(page, "banner-" + label + "-result");
    if (vp.width === 360) {
      const r = await page.evaluate(() => ({ b: document.querySelector("[data-action='share']").getBoundingClientRect().bottom, top: document.querySelector(".fake-banner").getBoundingClientRect().top }));
      ok(r.b <= r.top + 0.5, label + ": «Поделиться результатом» видно сразу, над баннером (" + Math.round(r.b) + " ≤ " + Math.round(r.top) + ")");
    }
    // окно «Поделиться»: баннер убран, закрыли — вернулся
    await tap(page, "[data-action='share']");
    await page.waitForSelector("[data-share-dialog]");
    ok(await bannerHidden(page), label + ": окно «Поделиться» открыто — баннер убран");
    await page.click("[data-action='close']");
    await page.waitForTimeout(150);
    ok(!(await bannerHidden(page)), label + ": окно закрыли — баннер вернулся");
    // «Проверь память»: картинка, таймер и «Готово» над баннером без прокрутки
    await reload(page, BASE + "?fakeadsec=1&test=memory");
    await tap(page, "[data-action='start']");
    for (let i = 0; i < 10; i++) {
      await page.waitForSelector(".memorize");
      if (i === 0 || i === 9) await bannerClear(page, label + " «запомни», вопрос " + (i + 1), true);
      if (i === 9) await shot(page, "banner-" + label + "-memorize");
      await passMemorize(page);
      if (i === 0) ok(await page.locator(".hint-btn").count() === 1, label + ": на «запомни» кнопка подсказки — после картинки, на вопросе");
      await answer(page, true); await nextQ(page);
    }
    ok(await noSideScroll(page), label + ": нет прокрутки вбок");
    // окно «Загружаем рекламу»: баннер убран; тосты — над баннером
    await reload(page, BASE + "?fakead=silent&test=ussr");
    await tap(page, "[data-action='start']");
    await tap(page, ".hint-btn");
    await page.waitForSelector(".ad-wait");
    ok(await bannerHidden(page), label + ": пока ждём рекламу — баннер убран");
    await page.click("[data-action='ad-cancel']");
    await page.waitForSelector("#toast.show");
    ok(!(await bannerHidden(page)), label + ": отменили — баннер вернулся");
    const toastOk = await page.evaluate(() => document.getElementById("toast").getBoundingClientRect().bottom <= document.querySelector(".fake-banner").getBoundingClientRect().top + 1);
    ok(toastOk, label + ": сообщения (тосты) — над баннером");
    ok(!page._errors.length, label + ": ошибок в консоли нет " + JSON.stringify(page._errors));
    await page.context().close();
  }

  console.log("\n«50 на 50» — реклама досмотрена:");
  {
    const page = await open(browser, BASE + "?fakeadsec=1&test=ussr");
    await tap(page, "[data-action='start']");
    await page.waitForSelector(".hint-btn");
    ok((await page.locator(".hint-btn").textContent()).includes("50 на 50 (за рекламу)"), "кнопка «50 на 50 (за рекламу)» на вопросе до ответа");
    const h = await page.evaluate(() => document.querySelector(".hint-btn").getBoundingClientRect().height);
    ok(h >= 56, "кнопка подсказки крупная: " + Math.round(h) + "px");
    await tap(page, ".hint-btn");
    await page.waitForSelector(".fake-ad");
    ok(await outCount(page) === 0, "пока реклама идёт, подсказки ещё нет");
    await watchFakeAd(page);
    ok(await hintApplied(page), "досмотрена: два неверных ответа убраны, верный на месте");
    await shot(page, "hint-applied");
    ok(await page.evaluate(() => QuizApp.adGrants()) === 1, "выдана ровно одна подсказка");
    // убранный вариант не нажимается ни пальцем, ни клавишей
    const outIdx = await page.evaluate(() => [...document.querySelectorAll(".answer")].findIndex((b) => b.classList.contains("is-out")));
    await page.keyboard.press(String(outIdx + 1)); await page.waitForTimeout(100);
    ok(!(await st(page)).answered, "клавиша убранного варианта не отвечает");
    await answer(page, true);
    await nextQ(page);
    ok(await page.locator(".hint-btn").count() === 0, "одна подсказка за прохождение: на следующем вопросе кнопки нет");
    for (let i = 1; i < 10; i++) { if (i > 1) await nextQ(page); await answer(page, true); }
    await nextQ(page);
    await page.waitForSelector(".result__card");
    await tap(page, "[data-action='again']");
    await page.waitForSelector(".hint-btn");
    ok(true, "«Пройти ещё раз» — новое прохождение, подсказка снова доступна");
    const ev = await events(page);
    const names = ev.map((e) => e.name);
    ok(names.includes("hint_offered") && names.includes("hint_clicked") && ev.some((e) => e.name === "hint_granted" && e.data.late === false && e.data.level_id === "ussr" && e.data.step_index === 1), "отметки: hint_offered, hint_clicked, hint_granted (late=false, ussr, вопрос 1)");
    ok(ev.some((e) => e.name === "progression_completed" && e.data.hint_used === true && e.data.score === 10), "progression_completed: score=10, hint_used=true");
    ok(ev.filter((e) => e.name === "hint_offered").length === 2, "hint_offered — один раз за прохождение (2 прохождения — 2 отметки)");
    ok(!page._errors.length, "ошибок в консоли нет " + JSON.stringify(page._errors));
    await page.context().close();
  }

  console.log("\n«50 на 50» — реклама закрыта / ошибка: подсказки нет, не зависает:");
  for (const [mode, reason, text] of [["cancel", "closed", /закрыта раньше/], ["fail", "error", /недоступна/]]) {
    const page = await open(browser, BASE + "?fakead=" + mode + "&fakeadsec=2&test=ussr");
    await tap(page, "[data-action='start']");
    await tap(page, ".hint-btn");
    await page.waitForSelector("#toast.show", { timeout: 6000 });
    ok(await outCount(page) === 0 && await page.evaluate(() => QuizApp.adGrants()) === 0, mode + ": подсказки нет");
    ok(text.test(await page.textContent("#toast")), mode + ": понятное сообщение «" + (await page.textContent("#toast")).slice(0, 45) + "…»");
    ok(await page.locator(".ad-wait").count() === 0 && await page.locator(".hint-btn").isEnabled(), mode + ": не зависло, кнопку подсказки можно нажать снова");
    await answer(page, true);
    ok((await st(page)).answered, mode + ": на вопрос можно ответить");
    const ev = await events(page);
    ok(ev.some((e) => e.name === "ad_reward_failed" && e.data.reason === reason && e.data.late === false), mode + ": отметка ad_reward_failed reason=" + reason);
    ok(!ev.some((e) => e.name === "hint_granted"), mode + ": hint_granted нет");
    await page.context().close();
  }

  console.log("\n«50 на 50» — площадка молчит (ждём 12 с):");
  {
    const page = await open(browser, BASE + "?fakead=silent&test=ussr");
    await tap(page, "[data-action='start']");
    await tap(page, ".hint-btn");
    await page.waitForSelector(".ad-wait");
    await page.keyboard.press("1"); await page.waitForTimeout(100);
    ok(!(await st(page)).answered, "пока ждём рекламу, клавиши ответов не работают");
    const blocked = await page.locator(".answer").first().click({ trial: true, timeout: 400 }).then(() => false, () => true);
    ok(blocked, "пока ждём рекламу, ответы не нажимаются (окно «Загружаем рекламу…»)");
    await page.waitForSelector("#toast.show", { timeout: 15000 });
    ok(/не загрузилась/.test(await page.textContent("#toast")) && await page.locator(".ad-wait").count() === 0, "через 12 с: «Реклама не загрузилась», окно ожидания закрыто");
    ok(await outCount(page) === 0, "подсказки нет");
    await answer(page, false);
    ok((await st(page)).answered, "приложение не зависло: на вопрос можно ответить");
    ok((await events(page)).some((e) => e.name === "ad_reward_failed" && e.data.reason === "timeout"), "отметка ad_reward_failed reason=timeout");
    await page.context().close();
  }
  {
    // Esc и «назад» во время ожидания = «Отмена»
    const page = await open(browser, BASE + "?fakead=silent&test=ussr");
    await tap(page, "[data-action='start']");
    await tap(page, ".hint-btn"); await page.waitForSelector(".ad-wait");
    await page.keyboard.press("Escape"); await page.waitForTimeout(200);
    ok(await page.locator(".ad-wait").count() === 0 && (await st(page)).phase === "ask", "Esc во время ожидания: ожидание отменено, остались на вопросе");
    await tap(page, ".hint-btn"); await page.waitForSelector(".ad-wait");
    await page.goBack(); await page.waitForTimeout(400);
    ok(await page.locator(".ad-wait").count() === 0 && await page.locator(".test-card").count() > 0, "«назад» во время ожидания: ожидание отменено, открыт список тестов");
    ok(!(await page.evaluate(() => document.getElementById("toast").classList.contains("show") && /закрыта/.test(document.getElementById("toast").textContent))), "после «назад» устаревшего сообщения нет");
    ok(await page.evaluate(() => !QuizApp.adBusy()), "приложение не ждёт рекламу");
    const ev = await events(page);
    ok(ev.filter((e) => e.name === "ad_reward_failed" && e.data.reason === "closed").length === 2, "отметки ad_reward_failed closed (Esc и «назад»)");
    ok(ev.some((e) => e.name === "progression_failed" && e.data.reason === "back" && e.data.step_index === 1), "progression_failed: бросил на вопросе 1 (back)");
    await page.context().close();
  }

  console.log("\n«50 на 50» — реклама опоздала:");
  {
    // «не загрузилась» → реклама всё-таки началась → сообщение убрано → досмотрена → подсказка на этот же вопрос
    const page = await open(browser, BASE + "?fakead=late&fakeadsec=1&test=ussr");
    await tap(page, "[data-action='start']");
    await tap(page, ".hint-btn");
    await page.waitForSelector("#toast.show", { timeout: 15000 });
    ok(/не загрузилась/.test(await page.textContent("#toast")), "молчит 12 с: «Реклама не загрузилась»");
    await page.waitForSelector(".fake-ad", { timeout: 6000 });
    await page.waitForTimeout(100);
    ok(!(await page.evaluate(() => document.getElementById("toast").classList.contains("show"))), "реклама началась — сообщение «не загрузилась» убрано");
    ok(await outCount(page) === 0, "пока опоздавшая реклама идёт, подсказки нет");
    await watchFakeAd(page);
    ok(await hintApplied(page), "опоздавшая досмотрена, вопрос не отвечен — подсказка на этот вопрос");
    const ev = await events(page);
    ok(ev.some((e) => e.name === "ad_reward_failed" && e.data.reason === "timeout") && ev.some((e) => e.name === "hint_granted" && e.data.late === true), "отметки: ad_reward_failed timeout, затем hint_granted late=true");
    await page.context().close();
  }
  {
    // опоздала, а человек уже ответил (на экране «Дальше») — подсказка не теряется, сработает на следующем вопросе
    const page = await open(browser, BASE + "?fakead=late&fakeadsec=1&test=ussr");
    await tap(page, "[data-action='start']");
    await tap(page, ".hint-btn");
    await page.waitForSelector("#toast.show", { timeout: 15000 });
    await answer(page, true);
    await watchFakeAd(page);
    ok((await st(page)).pending === true && await page.evaluate(() => QuizApp.adGrants()) === 1, "вопрос уже отвечен — подсказка отложена на следующий вопрос");
    await nextQ(page);
    await page.waitForSelector(".answer");
    ok(await hintApplied(page) && (await st(page)).idx === 1, "на вопросе 2 два неверных ответа убраны сразу");
    await page.context().close();
  }
  {
    // опоздала и началась, пока показывают картинку «запомни»: время картинки не съедается рекламой
    const page = await open(browser, BASE + "?fakead=late&fakeadsec=1&test=memory");
    await tap(page, "[data-action='start']");
    await passMemorize(page);
    await tap(page, ".hint-btn");
    await page.waitForSelector("#toast.show", { timeout: 15000 });
    await answer(page, true); await nextQ(page);
    await page.waitForSelector(".memorize");
    await page.waitForSelector(".fake-ad", { timeout: 6000 });
    await page.waitForTimeout(2500);   // реклама идёт дольше, чем осталось бы картинке
    await watchFakeAd(page);
    const s = await st(page);
    const secs = await page.evaluate(() => { const e = document.querySelector(".memorize__secs"); return e ? parseInt(e.textContent, 10) : -1; });
    const want = await page.evaluate(() => QuizApp.state().questions[1].seconds);
    ok(s.phase === "memorize" && secs >= want - 1, "после рекламы картинка «запомни» показана заново с полным временем (" + secs + " из " + want + " с)");
    await passMemorize(page);
    ok(await hintApplied(page), "подсказка — на вопросе после картинки");
    await page.context().close();
  }
  {
    // «Отмена» во время ожидания, реклама пришла позже, но её закрыли раньше конца — подсказки нет
    const page = await open(browser, BASE + "?fakead=late&fakeadsec=5&test=ussr");
    await tap(page, "[data-action='start']");
    await tap(page, ".hint-btn");
    await page.waitForSelector(".ad-wait");
    await page.click("[data-action='ad-cancel']");
    await page.waitForSelector("#toast.show");
    ok(/закрыта раньше/.test(await page.textContent("#toast")), "«Отмена» во время ожидания: окно закрылось, сообщение есть");
    await page.waitForSelector(".fake-ad", { timeout: 16000 });
    await page.click(".fake-ad-close"); await page.waitForTimeout(300);
    ok(await outCount(page) === 0 && await page.evaluate(() => QuizApp.adGrants()) === 0, "опоздавшая закрыта раньше конца — подсказки нет");
    ok((await events(page)).some((e) => e.name === "ad_reward_failed" && e.data.reason === "closed" && e.data.late === true), "отметка ad_reward_failed closed late=true");
    await page.context().close();
  }
  {
    // опоздала, а человек ушёл из прохождения (к списку тестов) — подсказки нет
    const page = await open(browser, BASE + "?fakead=late&fakeadsec=1&test=ussr");
    await tap(page, "[data-action='start']");
    await tap(page, ".hint-btn");
    await page.waitForSelector("#toast.show", { timeout: 15000 });
    await tap(page, "[data-action='back']");
    await page.waitForSelector(".test-card");
    await watchFakeAd(page);
    ok(await page.evaluate(() => QuizApp.adGrants()) === 0, "ушёл к списку тестов — опоздавшая подсказка не выдана");
    await tap(page, ".test-card[data-test='kino']"); await tap(page, "[data-action='start']");
    await page.waitForSelector(".answer");
    ok(await outCount(page) === 0 && await page.locator(".hint-btn").count() === 1, "в другом тесте подсказка не сработала сама, кнопка «50 на 50» доступна");
    await page.context().close();
  }

  console.log("\nХранилище (рекорды, «какие вопросы были», звук):");
  {
    // записи прототипа (localStorage) читаются: рекорд не теряется
    const page = await open(browser, BASE, PHONE, { init: () => { if (!sessionStorage.getItem("seeded")) { sessionStorage.setItem("seeded", "1"); localStorage.setItem("quiz-time:best:ussr", "7"); localStorage.setItem("quiz-time:sound", "off"); localStorage.setItem("quiz-time:recent:kino", JSON.stringify([["abc"]])); } } });
    ok((await page.textContent(".test-card[data-test='ussr'] .chip--best")).includes("7 из 10"), "рекорд из прототипа (localStorage «7») показан: 7 из 10");
    ok(await page.getAttribute(".sound-btn", "data-sound") === "off", "выключенный в прототипе звук остался выключенным");
    // новый рекорд уходит через хранилище Bridge и переживает перезагрузку
    await reload(page, BASE + "?test=ussr");
    await tap(page, "[data-action='start']");
    for (let i = 0; i < 10; i++) { if (i) await nextQ(page); await answer(page, true); }
    await nextQ(page); await page.waitForSelector(".result__card");
    await page.waitForTimeout(300);
    const viaBridge = await page.evaluate(() => Platform.hasBridge && Platform.load(["quiz-time:best:ussr", "quiz-time:recent:ussr"]));
    ok(viaBridge && viaBridge["quiz-time:best:ussr"] === 10, "рекорд 10 сохранён через хранилище Bridge (ключ quiz-time:best:ussr)");
    ok(viaBridge && Array.isArray(viaBridge["quiz-time:recent:ussr"]) && viaBridge["quiz-time:recent:ussr"][0].length === 10, "«какие вопросы были» — массив через Bridge");
    await reload(page, BASE);
    ok((await page.textContent(".test-card[data-test='ussr'] .chip--best")).includes("10 из 10"), "после перезагрузки рекорд 10 из 10");
    await tap(page, ".sound-btn"); await page.reload(); await readyApp(page);
    ok(await page.getAttribute(".sound-btn", "data-sound") === "on", "звук включили — после перезагрузки включён");
    // запись — одним вызовом, не по ключу
    await page.evaluate(() => { window.__saves = []; const o = Platform.save; Platform.save = (x) => { window.__saves.push(Object.keys(x).sort().join(",")); return o(x); }; });
    await reload(page, BASE + "?test=kino");
    await page.evaluate(() => { window.__saves = []; const o = Platform.save; Platform.save = (x) => { window.__saves.push(Object.keys(x).sort().join(",")); return o(x); }; });
    await tap(page, "[data-action='start']");
    await page.waitForTimeout(1800);
    const saves = await page.evaluate(() => window.__saves);
    ok(saves.length === 1 && saves[0] === "quiz-time:recent:kino", "начало теста: «какие вопросы были» — одна запись " + JSON.stringify(saves));
    ok(!page._errors.length, "ошибок в консоли нет " + JSON.stringify(page._errors));
    await page.context().close();
  }
  {
    // Во ВК ключи хранилища — только [A-Za-z0-9_-]: «quiz-time:best:ussr» → «quiz-time_best_ussr»
    const page = await open(browser, BASE);
    const r = await page.evaluate(async () => {
      const got = {};
      const fake = { get: (keys) => { got.get = keys; return Promise.resolve(keys.map((k) => (k === "quiz-time_best_ussr" ? "8" : ""))); }, set: (k, v) => { got.set = k; got.vals = v; return Promise.resolve(); } };
      const saved = { isReal: Platform.isReal, storage: Platform.bridge.storage };
      Object.defineProperty(Platform.bridge, "storage", { configurable: true, get: () => fake });
      Platform.isReal = true;
      const data = await Platform.load(["quiz-time:best:ussr", "quiz-time:sound"]);
      await Platform.save({ "quiz-time:best:kino": 9 });
      Platform.isReal = saved.isReal;
      Object.defineProperty(Platform.bridge, "storage", { configurable: true, get: () => saved.storage });
      return { got, data };
    });
    ok(JSON.stringify(r.got.get) === '["quiz-time_best_ussr","quiz-time_sound"]' && JSON.stringify(r.got.set) === '["quiz-time_best_kino"]', "на площадке ключи по правилу ВК: " + JSON.stringify(r.got.get) + " / " + JSON.stringify(r.got.set));
    ok(r.data["quiz-time:best:ussr"] === 8 && r.data["quiz-time:sound"] === null, "прочитанное возвращается под ключами приложения");
    await page.context().close();
  }
  {
    // Bridge не загрузился (заблокирован) — запасной localStorage, всё работает
    const ctx = await browser.newContext({ viewport: PHONE, locale: "ru-RU" });
    await ctx.route("**/playgama-bridge.js", (r) => r.abort());
    const page = await open(browser, BASE + "?test=nature", null, { ctx });
    ok(await page.evaluate(() => Platform.id === "none" && !Platform.hasBridge), "без Bridge: приложение открылось на заставке теста");
    await tap(page, "[data-action='start']");
    for (let i = 0; i < 10; i++) { if (i) await nextQ(page); await answer(page, i < 6); }
    await nextQ(page); await page.waitForSelector(".result__card");
    await page.waitForTimeout(200);
    ok(await page.evaluate(() => localStorage.getItem("quiz-time:best:nature")) === "6", "без Bridge: рекорд в localStorage (quiz-time:best:nature = 6)");
    await reload(page, BASE);
    ok((await page.textContent(".test-card[data-test='nature'] .chip--best")).includes("6 из 10"), "без Bridge: рекорд после перезагрузки");
    ok(!page._errors.filter((e) => !/Failed to load resource|ERR_FAILED/.test(e)).length, "без Bridge: ошибок нет " + JSON.stringify(page._errors));
    await ctx.close();
  }

  console.log("\nДругой адрес (как внутри ВК/ОК без рекламы): имитации нет");
  for (const blockBridge of [false, true]) {
    const label = blockBridge ? "Bridge не загрузился" : "Bridge без рекламы";
    const ctx = await browser.newContext({ viewport: PHONE, locale: "ru-RU" });
    await ctx.route("http://quiz.example/**", async (route) => {
      let p = new URL(route.request().url()).pathname.slice(1) || "index.html";
      if (blockBridge && p === "playgama-bridge.js") return route.abort();
      const file = path.join(ROOT, p);
      if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: "" });
      route.fulfill({ status: 200, contentType: TYPES[path.extname(file)] || "application/octet-stream", body: fs.readFileSync(file) });
    });
    await ctx.route(/^(?!http:\/\/quiz\.example)/, (r) => r.abort());
    const page = await ctx.newPage();
    await page.goto("http://quiz.example/?test=ussr");
    await readyApp(page);
    const s = await page.evaluate(() => ({ id: Platform.id, rew: Platform.rewardedAvailable(), banner: Platform.banner.mode }));
    ok(!s.rew && s.banner === "none", label + " (" + s.id + "): реклама недоступна, баннера нет");
    await tap(page, "[data-action='start']");
    await page.waitForSelector(".answer, .memorize");
    ok(await page.locator(".hint-btn").count() === 0 && await page.locator(".fake-banner").count() === 0, label + ": нет кнопки «50 на 50» и серой полоски — тест проходится без рекламы");
    await ctx.close();
  }

  console.log("\n«Поделиться»: ВКонтакте и Одноклассники (Bridge подменён):");
  for (const ch of ["vk", "ok"]) {
    const page = await open(browser, BASE + "?test=kino", PHONE, { keepShare: true, init: () => {
      Object.defineProperty(navigator, "canShare", { configurable: true, value: () => true });
      Object.defineProperty(navigator, "share", { configurable: true, value: () => { window.__sys = true; return Promise.resolve(); } });
    } });
    await page.evaluate((c) => {
      window.__sh = [];
      Platform.id = c; Platform.isReal = true; Platform.isSocial = true;
      Platform.nativeShareChannel = () => c;
      Platform.externalLinksAllowed = () => c === "vk";
      Platform.shareNative = (d) => { window.__sh.push(d); return Promise.resolve(); };
    }, ch);
    await tap(page, "[data-action='start']");
    for (let i = 0; i < 10; i++) { if (i) await nextQ(page); await answer(page, i < 7); }
    await nextQ(page); await page.waitForSelector(".result__card");
    await tap(page, "[data-action='share']");
    await page.waitForSelector("[data-share-dialog] .share-dialog__img");
    ok(!(await page.evaluate(() => window.__sys)), ch + ": на площадке — наше окно, а не системное меню телефона");
    const first = (await page.locator(".share-dialog__nets .btn").first().textContent()).trim();
    ok(first === (ch === "vk" ? "Поделиться ВКонтакте" : "Поделиться в Одноклассниках"), ch + ": первая кнопка — «" + first + "»");
    await page.locator(".share-dialog__nets .btn").first().click(); await page.waitForTimeout(100);
    const sh = await page.evaluate(() => window.__sh);
    ok(sh.length === 1 && /\?test=kino$/.test(sh[0].url) && /^Мой результат в тесте «Кино»: 7 из 10/.test(sh[0].text), ch + ": окно площадки получило текст и ссылку на тест: " + (sh[0] ? sh[0].url : ""));
    const other = await page.locator(ch === "vk" ? ".share-dialog__nets .btn--ok" : ".share-dialog__nets .btn--vk").count();
    ok(ch === "vk" ? other === 1 : other === 0, ch + ": кнопка другой сети " + (ch === "vk" ? "есть (ссылки разрешены)" : "спрятана (ссылки наружу запрещены)"));
    ok(await page.locator(".share-dialog__img").count() === 1 && await page.locator(".share-dialog__hint").count() === 1, ch + ": картинка-карточка результата и подсказка, как её сохранить");
    ok((await events(page)).some((e) => e.name === "share_clicked" && e.data.channel === ch && e.data.level_id === "kino"), ch + ": отметка share_clicked channel=" + ch);
    await shot(page, "share-" + ch);
    await page.context().close();
  }
  {
    // Адрес приложения во ВК из config.js: ссылка …/app123#test=kino; ссылка из ВК (payload) открывает заставку теста
    const page = await open(browser, BASE);
    const urls = await page.evaluate(() => {
      const r = { test: QuizApp.tests.find((t) => t.id === "kino"), score: 5, total: 10, rank: { title: "x", text: "y" } };
      APP_CONFIG.APP_URL.vk = "https://vk.com/app123"; Platform.id = "vk";
      const vk = QuizShare.shareUrl(r);
      APP_CONFIG.APP_URL.vk = ""; const vkEmpty = QuizShare.shareUrl(r);
      Platform.id = "mock"; const web = QuizShare.shareUrl(r);
      return { vk, vkEmpty, web };
    });
    ok(urls.vk === "https://vk.com/app123#test=kino", "во ВК ссылка из config.js: " + urls.vk);
    ok(urls.vkEmpty === "https://romangerasimov71-spec.github.io/quiz-time/?test=kino", "адрес ВК ещё не вписан — ссылка на GitHub Pages: " + urls.vkEmpty);
    ok(urls.web === "https://romangerasimov71-spec.github.io/quiz-time/?test=kino", "вне площадок: " + urls.web);
    await page.context().close();
    // ссылка из площадки приходит в Bridge как payload (во ВК — всё после # в адресе приложения;
    // в браузере Bridge берёт его из ?payload=…)
    const ctx3 = await browser.newContext({ viewport: PHONE, locale: "ru-RU" });
    const p3 = await ctx3.newPage(); await p3.goto(BASE + "?payload=test%3Dcities"); await readyApp(p3);
    ok(await p3.evaluate(() => Platform.payload) === "test=cities" && await p3.locator(".intro__title").textContent() === "Города" && new URL(p3.url()).searchParams.get("test") === "cities", "ссылка из площадки (payload «test=cities») открывает заставку теста «Города»");
    await p3.evaluate(() => history.back()); await p3.waitForSelector(".test-card", { timeout: 3000 }).catch(() => {});
    ok(await p3.locator(".test-card").count() > 0, "…«назад» ведёт к списку тестов");
    ok((await events(p3)).some((e) => e.name === "app_opened" && e.data.entry === "test"), "отметка app_opened entry=test");
    await ctx3.close();
  }
  {
    // Компьютер вне площадок: наше окно, даже если браузер умеет системное «Поделиться»
    const page = await open(browser, BASE + "?test=ussr", { width: 1280, height: 800 }, { touch: false, keepShare: true, init: () => {
      Object.defineProperty(navigator, "canShare", { configurable: true, value: () => true });
      Object.defineProperty(navigator, "share", { configurable: true, value: () => { window.__sys = true; return Promise.resolve(); } });
    } });
    await tap(page, "[data-action='start']");
    for (let i = 0; i < 10; i++) { if (i) await nextQ(page); await answer(page, i < 4); }
    await nextQ(page); await page.waitForSelector(".result__card");
    await tap(page, "[data-action='share']");
    await page.waitForSelector("[data-share-dialog]");
    ok(!(await page.evaluate(() => window.__sys)), "компьютер: открыто наше окно (системное меню не вызвано)");
    const nets = await page.locator(".share-dialog__nets .btn").allTextContents();
    ok(nets.join("|") === "ВКонтакте|Одноклассники" && await page.locator("[data-action='download']").count() === 1, "компьютер: ВКонтакте, Одноклассники, «Скачать картинку»");
    const href = await page.getAttribute(".share-dialog__nets .btn--vk", "href");
    ok(/^https:\/\/vk\.com\/share\.php\?url=https%3A%2F%2Fromangerasimov71-spec\.github\.io%2Fquiz-time%2F%3Ftest%3Dussr/.test(href), "ссылка ВК ведёт на заставку теста");
    await page.locator(".share-dialog__nets .btn--vk").evaluate((a) => a.addEventListener("click", (e) => e.preventDefault()));
    await page.click(".share-dialog__nets .btn--vk");
    ok((await events(page)).some((e) => e.name === "share_clicked" && e.data.channel === "vk"), "отметка share_clicked channel=vk");
    await page.context().close();
  }

  console.log("\nОтметки для статистики:");
  {
    const page = await open(browser, BASE + "?fakeadsec=1");
    await page.mouse.click(5, 300); await page.waitForTimeout(50);
    await tap(page, ".test-card[data-test='songs']");
    await tap(page, "[data-action='start']");
    await answer(page, true); await nextQ(page); await answer(page, false); await nextQ(page);
    await tap(page, "[data-action='back']");
    await page.waitForSelector(".test-card");
    await tap(page, ".test-card[data-test='songs']");
    await tap(page, "[data-action='start']");
    for (let i = 0; i < 10; i++) { if (i) await nextQ(page); await answer(page, i < 5); }
    await nextQ(page); await page.waitForSelector(".result__card");
    await tap(page, "[data-action='share']"); await page.waitForSelector("[data-share-dialog]");
    await page.click("[data-action='copy']"); await page.waitForTimeout(100);
    await page.keyboard.press("Escape"); await page.waitForTimeout(100);
    await tap(page, "[data-action='again']");
    await page.waitForSelector(".answer");
    for (let i = 0; i < 15; i++) { await page.mouse.wheel(0, i % 2 ? 200 : -200); await page.waitForTimeout(100); }
    await page.evaluate(() => Analytics._flush());
    const ev = await events(page);
    const by = (n) => ev.filter((e) => e.name === n);
    ok(by("app_opened")[0] && by("app_opened")[0].data.entry === "home" && ev[0].name === "app_opened", "app_opened entry=home — первое событие");
    const fi = by("first_input")[0];
    ok(fi && fi.data.input === "mouse" && typeof fi.data.seconds === "number", "first_input: " + JSON.stringify(fi && fi.data));
    ok(by("progression_started").length === 3 && by("progression_started").every((e) => e.data.level_id === "songs") && by("progression_started")[2].data.source === "again", "progression_started ×3 (level_id=songs, последний source=again)");
    const pf = by("progression_failed")[0];
    ok(pf && pf.data.step_index === 3 && pf.data.reason === "back", "progression_failed: бросил на вопросе 3 (" + JSON.stringify(pf && pf.data) + ")");
    const pc = by("progression_completed")[0];
    ok(pc && pc.data.score === 5 && pc.data.total === 10 && pc.data.hint_used === false, "progression_completed: " + JSON.stringify(pc && pc.data));
    ok(by("replay_clicked").some((e) => e.data.level_id === "songs" && e.data.score === 5), "replay_clicked level_id=songs score=5");
    ok(by("share_clicked").some((e) => e.data.channel === "copy" && e.data.level_id === "songs"), "share_clicked channel=copy");
    const ps = by("performance_sample")[0];
    const need = ["target_fps", "window_ms", "active_ms", "frame_count", "fps_avg", "fps_p10", "frame_time_p50_ms", "frame_time_p95_ms", "frame_time_p99_ms", "frame_time_max_ms", "frames_over_50ms", "frames_over_100ms", "frames_over_250ms", "frames_over_500ms", "frames_over_1000ms", "game_version"];
    ok(ps && need.every((k) => k in ps.data), "performance_sample со всеми полями гайда: " + (ps ? "кадров " + ps.data.frame_count + ", fps " + ps.data.fps_avg + ", версия " + ps.data.game_version : "нет"));
    ok(ev.every((x) => Object.values(x.data).every((v) => typeof v !== "string" || (v.length <= 40 && !/https?:|@/.test(v)))), "в отметках нет адресов, почты, длинных текстов");
    const allowed = ["app_opened", "first_input", "progression_started", "progression_completed", "progression_failed", "replay_clicked", "share_clicked", "hint_offered", "hint_clicked", "hint_granted", "ad_reward_failed", "performance_sample"];
    const names = [...new Set(ev.map((x) => x.name))].sort();
    ok(names.every((n) => allowed.includes(n)), "только события из docs/analytics.md: " + names.join(", "));
    ok(!ev.some((x) => /answer|question/.test(x.name)), "отметок на каждый ответ нет");
    const sent = await page.evaluate(() => typeof bridge.analytics.send === "function" && Analytics.event("app_opened", { entry: "home", returning: false }));
    ok(sent === true, "отметки уходят через bridge.analytics.send");
    ok(!page._errors.length, "ошибок в консоли нет " + JSON.stringify(page._errors));
    await page.context().close();
  }

  console.log("\nОткрытие файлом:");
  {
    const ctx = await browser.newContext({ viewport: PHONE, locale: "ru-RU" });
    const page = await ctx.newPage();
    const errs = []; page.on("pageerror", (e) => errs.push(String(e)));
    await page.goto("file://" + path.join(ROOT, "index.html") + "?test=memory");
    await readyApp(page);
    ok(await page.locator(".intro__title").textContent() === "Проверь память", "file:// открывается, площадка: " + await page.evaluate(() => Platform.id));
    ok(!errs.length, "file://: ошибок нет " + JSON.stringify(errs));
    await ctx.close();
  }

  await browser.close();
  srv.close();
  console.log(`\nПроверок: ${oks + fails}, не прошло: ${fails}. Время: ${Math.round((Date.now() - t0) / 1000)} с`);
  console.log(fails ? "ПРОВАЛЕНО: " + fails : "Всё в порядке.");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
