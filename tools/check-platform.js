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
// Без прокрутки (как открылся экран): все элементы sel — над баннером
async function aboveBanner(page, sel) {
  return page.evaluate((q) => {
    window.scrollTo(0, 0);
    const ban = document.querySelector(".fake-banner");
    const top = ban && getComputedStyle(ban).display !== "none" ? ban.getBoundingClientRect().top : window.innerHeight;
    const els = [...document.querySelectorAll(q)].filter((e) => e.getBoundingClientRect().height > 0 && getComputedStyle(e).visibility !== "hidden");
    const under = els.filter((e) => e.getBoundingClientRect().bottom > top + 0.5).map((e) => (e.getAttribute("data-action") || e.className) + " " + Math.round(e.getBoundingClientRect().bottom) + ">" + Math.round(top));
    return { n: els.length, under };
  }, sel);
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
  for (const vp of [{ width: 390, height: 844 }, { width: 360, height: 640 }, { width: 640, height: 360 }, { width: 844, height: 390 }, { width: 1280, height: 800 }]) {
    const label = vp.width + "×" + vp.height;
    const phone = vp.width < 900;
    const page = await open(browser, BASE + "?fakeadsec=1", vp);
    await bannerClear(page, label + " главная");
    await shot(page, "banner-" + label + "-home");
    await reload(page, BASE + "?fakeadsec=1&test=ussr");
    await bannerClear(page, label + " заставка");
    await tap(page, "[data-action='start']");
    await page.waitForSelector(".hint-btn");
    await bannerClear(page, label + " вопрос с кнопкой «50 на 50»");
    await shot(page, "banner-" + label + "-question");
    if (phone) {
      // все 10 вопросов: 4 варианта и кнопка подсказки над баннером сразу, без прокрутки
      const slot = await page.getAttribute(".hint-btn", "data-slot");
      const want = vp.width > vp.height ? "top" : vp.height <= 700 ? "above" : "below";
      ok(slot === want, label + ": кнопка «50 на 50» — " + ({ top: "в верхней строке", above: "узкой строкой над вариантами", below: "под вариантами" })[want] + " (" + slot + ")");
      const under = [];
      for (let i = 0; i < 10; i++) {
        if (i) { await answer(page, true); await nextQ(page); await page.waitForSelector(".answer"); }
        const r = await aboveBanner(page, ".answer" + (want === "below" ? "" : ", .hint-btn"));
        if (r.under.length || r.n < 4) under.push("вопрос " + (i + 1) + ": " + r.under.join(", "));
        const sz = await page.evaluate(() => ({ q: parseFloat(getComputedStyle(document.querySelector(".question")).fontSize), b: Math.min(...[...document.querySelectorAll(".answer")].map((x) => x.getBoundingClientRect().height)) }));
        if (sz.q < 20 || sz.b < 52) under.push("вопрос " + (i + 1) + ": шрифт " + sz.q + ", кнопка " + Math.round(sz.b));
      }
      ok(!under.length, label + ": на всех 10 вопросах 4 варианта над баннером без прокрутки (шрифт ≥ 20, кнопки ≥ 52) " + JSON.stringify(under.slice(0, 3)));
      await reload(page, BASE + "?fakeadsec=1&test=ussr");
      await tap(page, "[data-action='start']");
      await page.waitForSelector(".hint-btn");
    }
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
    if (phone) {
      const r = await aboveBanner(page, ".result__actions .btn");
      ok(r.n === 3 && !r.under.length, label + ": все три кнопки результата видно сразу, над баннером " + JSON.stringify(r.under));
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
      if (i === 0 || i === 9 || phone) await bannerClear(page, label + " «запомни», вопрос " + (i + 1), true);
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

  console.log("\nОкна целиком над зоной баннера (на площадке баннер рисует ВК/ОК поверх страницы):");
  for (const vp of [{ width: 568, height: 320 }, { width: 640, height: 360 }, { width: 844, height: 390 }, { width: 360, height: 640 }, { width: 1920, height: 1080 }]) {
    const label = vp.width + "×" + vp.height;
    const page = await open(browser, BASE + "?fakead=silent&test=ussr", vp, { touch: vp.width < 1200 });
    // всё в окне (рамка и кнопки) — выше зоны баннера; сама зона — сколько баннер может занять
    const inWin = (sel) => page.evaluate((q) => {
      const zone = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--banner-zone")) || 0;
      const lim = window.innerHeight - zone;
      const els = [...document.querySelectorAll(q)].filter((e) => e.getBoundingClientRect().height > 0);
      return { zone, n: els.length, under: els.filter((e) => e.getBoundingClientRect().bottom > lim + 0.5 || e.getBoundingClientRect().top < 0).map((e) => (e.getAttribute("data-action") || e.className) + " " + Math.round(e.getBoundingClientRect().bottom) + ">" + Math.round(lim)) };
    }, sel);
    await tap(page, "[data-action='start']");
    await answer(page, true); await nextQ(page); await page.waitForSelector(".answer");
    if (vp.width > vp.height && vp.height <= 520) ok(/реклама/.test(await page.textContent(".hint-btn")), label + ": на кнопке «50 на 50» в альбоме видно, что это за рекламу («" + (await page.textContent(".hint-btn")).trim() + "»)");
    await tap(page, "[data-action='back']"); await page.waitForSelector(".exit-dialog");
    let r = await inWin(".exit-dialog__box, .exit-dialog .btn");
    ok(r.zone === 90 && r.n === 3 && !r.under.length, label + ": «Выйти из теста?» с кнопками — над зоной баннера (" + r.zone + " px) " + JSON.stringify(r.under));
    ok(await bannerHidden(page), label + ": пока окно «Выйти?» открыто — баннер спрятан");
    await shot(page, "win-" + label + "-exit");
    await page.click("[data-action='exit-stay']"); await page.waitForTimeout(150);
    await tap(page, ".hint-btn"); await page.waitForSelector(".ad-wait");
    r = await inWin(".ad-wait__box, .ad-wait .btn");
    ok(r.n === 2 && !r.under.length, label + ": «Загружаем рекламу…» с «Отменой» — над зоной баннера " + JSON.stringify(r.under));
    await shot(page, "win-" + label + "-adwait");
    await page.click("[data-action='ad-cancel']"); await page.waitForSelector("#toast.show");
    await page.waitForTimeout(300);
    const tq = await page.evaluate(() => {
      const t = document.getElementById("toast").getBoundingClientRect();
      // в верхней панели (альбом) кнопка «50 на 50» — под сообщением: оно стоит «на её месте» и пропускает касания
      const hit = [...document.querySelectorAll(".question, .answer, .hint-btn--above, .hint-btn--below, .next-btn")].filter((e) => { const b = e.getBoundingClientRect(); return b.height && t.bottom > b.top + 0.5 && t.top < b.bottom - 0.5 && t.right > b.left && t.left < b.right; });
      return { pe: getComputedStyle(document.getElementById("toast")).pointerEvents, hit: hit.map((e) => e.className), box: Math.round(t.top) + "–" + Math.round(t.bottom) };
    });
    ok(tq.pe === "none" && !tq.hit.length, label + ": сообщение о рекламе (" + tq.box + ") — поверх верхней панели, не закрывает вопрос и варианты " + JSON.stringify(tq.hit));
    await shot(page, "win-" + label + "-toast");
    for (let i = 1; i < 10; i++) { await answer(page, true); await nextQ(page); }
    await page.waitForSelector(".result__card");
    await tap(page, "[data-action='share']"); await page.waitForSelector("[data-share-dialog]");
    const sh = await page.evaluate(() => {
      const zone = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--banner-zone")) || 0;
      const w = document.querySelector(".share-dialog").getBoundingClientRect();
      const band = getComputedStyle(document.querySelector(".share-dialog"), "::after");
      return { bottom: Math.round(w.bottom), lim: window.innerHeight - zone, band: band.position === "fixed" && Math.round(parseFloat(band.height)) === zone };
    });
    ok(sh.bottom <= sh.lim && sh.band, label + ": окно «Поделиться» листается только выше зоны баннера (низ " + sh.bottom + " ≤ " + sh.lim + "), зона закрыта тем же затемнением");
    await shot(page, "win-" + label + "-share");
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
    ok(/Вы отменили рекламу/.test(await page.textContent("#toast")), "Esc: сообщение «" + (await page.textContent("#toast")) + "»");
    await tap(page, ".hint-btn"); await page.waitForSelector(".ad-wait");
    await page.goBack(); await page.waitForTimeout(400);
    ok(await page.locator(".ad-wait").count() === 0 && (await st(page)).phase === "ask" && new URL(page.url()).searchParams.get("test") === "ussr", "«назад» во время ожидания = «Отмена»: ожидание закрыто, остались на вопросе");
    ok(/Вы отменили рекламу/.test(await page.textContent("#toast")), "«назад»: сообщение «Вы отменили рекламу — подсказки нет»");
    await tap(page, ".hint-btn"); await page.waitForSelector(".ad-wait");
    await page.click("[data-action='ad-cancel']"); await page.waitForSelector("#toast.show");
    ok(/Вы отменили рекламу/.test(await page.textContent("#toast")), "«Отмена»: сообщение «Вы отменили рекламу — подсказки нет»");
    ok(await page.evaluate(() => !QuizApp.adBusy()), "приложение не ждёт рекламу");
    await page.goBack(); await page.waitForSelector(".test-card", { timeout: 3000 }).catch(() => {});
    ok(await page.locator(".test-card").count() > 0, "следующий «назад» (до первого ответа) — к списку тестов, без вопроса «Выйти?»");
    const ev = await events(page);
    ok(ev.filter((e) => e.name === "ad_reward_failed" && e.data.reason === "closed").length === 3, "отметки ad_reward_failed closed (Esc, «назад», «Отмена»)");
    ok(ev.filter((e) => e.name === "progression_failed").length === 1 && ev.some((e) => e.name === "progression_failed" && e.data.reason === "back" && e.data.step_index === 1), "progression_failed — один раз, когда реально ушёл (вопрос 1)");
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
    ok(/сработает на следующем вопросе/.test(await page.textContent("#toast")), "…и сказано: «" + (await page.textContent("#toast")) + "»");
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
    ok(s.phase === "memorize" && secs >= 2 && secs <= want, "после рекламы картинка «запомни» снова на экране, на оставшееся время (" + secs + " из " + want + " с, не меньше 1,5 с)");
    await passMemorize(page);
    ok(await hintApplied(page), "подсказка — на вопросе после картинки");
    await page.context().close();
  }
  {
    // опоздала, а человек уже ответил на ПОСЛЕДНИЙ вопрос — подсказку не к чему применить
    const page = await open(browser, BASE + "?fakead=late&fakeadsec=1&test=ussr");
    await tap(page, "[data-action='start']");
    for (let i = 0; i < 9; i++) { await answer(page, true); await nextQ(page); }
    await page.waitForSelector(".hint-btn");
    await tap(page, ".hint-btn");
    await page.waitForSelector("#toast.show", { timeout: 15000 });
    await answer(page, true);
    await watchFakeAd(page);
    ok(await page.evaluate(() => QuizApp.adGrants()) === 0 && !(await st(page)).pending, "опоздала на последнем (уже отвеченном) вопросе — подсказка не выдана");
    ok(/тест уже закончен.*не пригодилась/.test(await page.textContent("#toast")), "…и сказано: «" + (await page.textContent("#toast")) + "»");
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
    ok(/Вы отменили рекламу/.test(await page.textContent("#toast")), "«Отмена» во время ожидания: окно закрылось, «Вы отменили рекламу — подсказки нет»");
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
    ok(/досмотрена.*не пригодилась/.test(await page.textContent("#toast")), "…и сказано почему: «" + (await page.textContent("#toast")) + "»");
    await tap(page, ".test-card[data-test='kino']"); await tap(page, "[data-action='start']");
    await page.waitForSelector(".answer");
    ok(await outCount(page) === 0 && await page.locator(".hint-btn").count() === 1, "в другом тесте подсказка не сработала сама, кнопка «50 на 50» доступна");
    await page.context().close();
  }

  console.log("\nСообщения, подсказка, «запомни» после паузы, «Выйти из теста?», клавиатура:");
  {
    // Сообщение после неудачной рекламы не закрывает ответы и «Дальше» и пропускает касания
    const page = await open(browser, BASE + "?fakead=fail&test=kino", { width: 360, height: 640 });
    await tap(page, "[data-action='start']");
    await tap(page, ".hint-btn");
    await page.waitForSelector("#toast.show", { timeout: 6000 });
    const t = await page.evaluate(() => {
      const r = document.getElementById("toast").getBoundingClientRect();
      const a = document.querySelector(".answers").getBoundingClientRect();
      return { pe: getComputedStyle(document.getElementById("toast")).pointerEvents, overlap: r.bottom > a.top && r.top < a.bottom, top: Math.round(r.top), bottom: Math.round(r.bottom), atop: Math.round(a.top) };
    });
    ok(t.pe === "none", "сообщение прозрачно для касаний (pointer-events: none)");
    ok(!t.overlap, "360×640: сообщение вверху (" + t.top + "–" + t.bottom + "), над вариантами (с " + t.atop + ")");
    await answer(page, true);
    await page.waitForTimeout(450);
    const shown = await page.evaluate(() => document.getElementById("toast").classList.contains("show"));
    const nr = await page.evaluate(() => { const n = document.querySelector(".next-btn").getBoundingClientRect(); const x = document.getElementById("toast").getBoundingClientRect(); return n.bottom > x.top && n.top < x.bottom; });
    await page.click(".next-btn");
    await page.waitForTimeout(200);
    ok(shown && (await st(page)).idx === 1, "сообщение ещё на экране, а ответ и «Дальше» нажимаются (вопрос 2)" + (nr ? " — сквозь сообщение" : ""));
    await page.context().close();
  }
  for (const vp of [{ width: 360, height: 640 }, { width: 640, height: 360 }, { width: 844, height: 390 }]) {
    // подсказка сработала — варианты остаются на месте и над баннером
    const label = vp.width + "×" + vp.height;
    const page = await open(browser, BASE + "?fakeadsec=1&test=ussr", vp);
    await tap(page, "[data-action='start']");
    const pos = () => page.evaluate(() => [...document.querySelectorAll(".answer")].map((b) => Math.round(b.getBoundingClientRect().top)).join(","));
    const before = await pos();
    await tap(page, ".hint-btn");
    await watchFakeAd(page);
    ok(await hintApplied(page), label + ": подсказка сработала");
    ok(await pos() === before, label + ": варианты не сдвинулись из-за подсказки (" + before + ")");
    const r = await aboveBanner(page, ".answer, .hint-note");
    ok(!r.under.length, label + ": варианты и строка «подсказка» над баннером " + JSON.stringify(r.under));
    await page.context().close();
  }
  {
    // «Запомни»: пауза (свернули / вкладка скрыта) не даёт полного времени заново
    const page = await open(browser, BASE + "?test=memory", PHONE);
    const hide = (v) => page.evaluate((h) => { Object.defineProperty(document, "hidden", { configurable: true, get: () => h }); document.dispatchEvent(new Event("visibilitychange")); }, v);
    await tap(page, "[data-action='start']");
    await page.waitForSelector(".memorize");
    const full = await page.evaluate(() => QuizApp.state().questions[0].seconds);
    await page.waitForTimeout(1600);
    await hide(true); await page.waitForTimeout(3000); await hide(false); await page.waitForTimeout(100);
    const secs = parseInt(await page.textContent(".memorize__secs"), 10);
    ok((await st(page)).phase === "memorize" && secs <= full - 1 && secs >= 2, "пауза на 3 с через 1,6 с: картинка на оставшееся время (" + secs + " из " + full + " с), а не заново на полное");
    await page.waitForSelector(".answer", { timeout: (full + 2) * 1000 });
    ok(true, "…и исчезает, когда оставшееся время вышло");
    await page.context().close();
    // пауза перед самым концом — после паузы ещё 1,5 с, чтобы успеть глянуть
    const p2 = await open(browser, BASE + "?test=memory", PHONE);
    await tap(p2, "[data-action='start']");
    await p2.waitForSelector(".memorize");
    const f2 = await p2.evaluate(() => QuizApp.state().questions[0].seconds);
    await p2.waitForTimeout(f2 * 1000 - 700);
    await p2.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, get: () => true }); document.dispatchEvent(new Event("visibilitychange")); });
    await p2.waitForTimeout(2000);
    await p2.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, get: () => false }); document.dispatchEvent(new Event("visibilitychange")); });
    await p2.waitForTimeout(1000);
    const ph1 = (await st(p2)).phase;
    await p2.waitForTimeout(900);
    const ph2 = (await st(p2)).phase;
    ok(ph1 === "memorize" && ph2 === "ask", "пауза за 0,7 с до конца: после неё картинка видна ещё ~1,5 с (" + ph1 + " → " + ph2 + ")");
    await p2.context().close();
  }
  {
    // Выход из теста посреди прохождения — только через «Выйти из теста?»
    const page = await open(browser, BASE + "?test=ussr", PHONE);
    await tap(page, "[data-action='start']");
    await page.waitForSelector(".answer");
    await page.keyboard.press("Escape");
    await page.waitForSelector(".test-card", { timeout: 3000 }).catch(() => {});
    ok(await page.locator(".test-card").count() > 0 && await page.locator(".exit-dialog").count() === 0, "до первого ответа Esc — сразу к списку тестов, без вопроса");
    await tap(page, ".test-card[data-test='ussr']"); await tap(page, "[data-action='start']");
    await answer(page, true); await nextQ(page); await page.waitForSelector(".answer");
    await tap(page, "[data-action='back']");
    await page.waitForSelector(".exit-dialog");
    const d = await page.evaluate(() => ({ title: document.querySelector(".exit-dialog__title").textContent, text: document.querySelector(".exit-dialog__text").textContent, size: parseFloat(getComputedStyle(document.querySelector(".exit-dialog__title")).fontSize), focus: document.activeElement.getAttribute("data-action"), first: document.querySelector(".exit-dialog .btn").getAttribute("data-action") }));
    ok(d.title === "Выйти из теста?" && /Ответы не сохранятся/.test(d.text) && d.size >= 24, "«‹ Тесты» посреди теста: крупно «Выйти из теста? Ответы не сохранятся.» (" + d.size + "px)");
    ok(d.first === "exit-stay" && d.focus === "exit-stay", "«Остаться» — первая и в фокусе");
    await page.keyboard.press("1"); await page.waitForTimeout(100);
    ok(!(await st(page)).answered, "пока окно открыто, клавиши ответов не работают");
    await page.keyboard.press("Enter"); await page.waitForTimeout(150);
    ok(await page.locator(".exit-dialog").count() === 0 && (await st(page)).idx === 1 && (await st(page)).phase === "ask", "Enter — «Остаться»: окно закрыто, тот же вопрос 2");
    await page.keyboard.press("Escape"); await page.waitForSelector(".exit-dialog");
    await page.keyboard.press("Escape"); await page.waitForTimeout(150);
    ok(await page.locator(".exit-dialog").count() === 0 && (await st(page)).idx === 1, "Esc спрашивает, второй Esc закрывает окно = остаться");
    await page.goBack(); await page.waitForTimeout(300);
    ok(await page.locator(".exit-dialog").count() === 1 && new URL(page.url()).searchParams.get("test") === "ussr", "«назад» браузера посреди теста — тоже вопрос, адрес теста на месте");
    await page.click("[data-action='exit-stay']"); await page.waitForTimeout(150);
    await page.goBack(); await page.waitForTimeout(300);
    ok(await page.locator(".exit-dialog").count() === 1, "после «Остаться» следующий «назад» снова спрашивает, а не выкидывает");
    let ev = await events(page);
    ok(ev.filter((e) => e.name === "progression_failed").length === 1, "пока не вышел — новой отметки progression_failed нет");
    await page.click("[data-action='exit-leave']");
    await page.waitForSelector(".test-card", { timeout: 3000 }).catch(() => {});
    ok(await page.locator(".test-card").count() > 0 && new URL(page.url()).searchParams.get("test") === null, "«Выйти» — список тестов, ?test= убран из адреса");
    ev = await events(page);
    const pf = ev.filter((e) => e.name === "progression_failed");
    ok(pf.length === 2 && pf[1].data.step_index === 2 && pf[1].data.reason === "back", "progression_failed — только при реальном выходе (вопрос 2, back)");
    ok(!page._errors.length, "ошибок в консоли нет " + JSON.stringify(page._errors));
    await page.context().close();
  }
  for (const vp of [{ width: 360, height: 640 }, { width: 320, height: 568 }, { width: 640, height: 360 }]) {
    const page = await open(browser, BASE + "?test=ussr", vp);
    const h1 = await page.evaluate(() => [...document.querySelectorAll(".back-btn, .sound-btn")].map((b) => Math.round(b.getBoundingClientRect().height)));
    await tap(page, "[data-action='start']"); await page.waitForSelector(".answer");
    const h2 = await page.evaluate(() => [...document.querySelectorAll(".back-btn, .sound-btn")].map((b) => Math.round(b.getBoundingClientRect().height)));
    ok([...h1, ...h2].every((x) => x >= 56), vp.width + "×" + vp.height + ": «‹ Тесты» и звук — не ниже 56 px (" + [...h1, ...h2].join(", ") + ")");
    await page.context().close();
  }
  {
    // Клавиатура: стрелки водят по всем карточкам (и до 11-го теста), 0 — десятый тест
    const page = await open(browser, BASE, { width: 1280, height: 800 }, { touch: false });
    await settled(page);
    const n = await page.locator(".test-card").count();
    const seen = new Set();
    await page.keyboard.press("ArrowDown"); seen.add(await page.evaluate(() => document.activeElement.getAttribute("data-test")));
    for (let i = 0; i < n; i++) { await page.keyboard.press(i % 2 ? "ArrowLeft" : "ArrowRight"); seen.add(await page.evaluate(() => document.activeElement.getAttribute("data-test"))); await page.keyboard.press("ArrowDown"); seen.add(await page.evaluate(() => document.activeElement.getAttribute("data-test"))); }
    ok(seen.size === n, "стрелки доводят фокус до всех " + n + " карточек (" + seen.size + ")");
    const last = await page.evaluate(() => { const c = [...document.querySelectorAll(".test-card")]; c[c.length - 1].focus(); return c[c.length - 1].getAttribute("data-test"); });
    await page.keyboard.press("ArrowUp"); await page.keyboard.press("ArrowDown");
    ok(await page.evaluate(() => document.activeElement.getAttribute("data-test")) === last, "стрелки вверх-вниз возвращаются на последнюю карточку");
    await page.keyboard.press("Enter");
    await page.waitForSelector("[data-action='start']");
    ok(new URL(page.url()).searchParams.get("test") === last, "Enter на 11-й карточке открывает «" + last + "»");
    await page.goBack(); await page.waitForSelector(".test-card");
    await settled(page);
    const tenth = await page.evaluate(() => document.querySelectorAll(".test-card")[9].getAttribute("data-test"));
    ok(await page.textContent(".test-card[data-test='" + tenth + "'] .test-card__key") === "0", "на 10-й карточке подсказка клавиши «0»");
    await page.keyboard.press("0");
    await page.waitForSelector("[data-action='start']");
    ok(new URL(page.url()).searchParams.get("test") === tenth, "клавиша 0 открывает 10-й тест «" + tenth + "»");
    await reload(page, BASE + "?test=memory");
    ok(/новые картинки/.test(await page.textContent(".intro__card")), "заставка «Проверь память»: «Каждый раз — новые картинки»");
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
    // Площадка не приняла запись (storage.set упал), а читать с неё можно: при следующем
    // запуске виден новый рекорд из localStorage (помечен «не доехало»), и он дописывается на площадку
    const page = await open(browser, BASE);
    const r = await page.evaluate(async () => {
      const cloud = { "quiz-time:best:ussr": "5" }, sets = [];
      let failSet = true;
      const fake = {
        get: (keys) => Promise.resolve(keys.map((k) => cloud[k] || "")),
        set: (k, v) => { sets.push(k.join(",")); if (failSet) return Promise.reject(new Error("net")); k.forEach((x, i) => { cloud[x] = v[i]; }); return Promise.resolve(); }
      };
      const saved = Platform.bridge.storage;
      Object.defineProperty(Platform.bridge, "storage", { configurable: true, get: () => fake });
      await Platform.save({ "quiz-time:best:ussr": 9 });
      const marked = JSON.parse(localStorage.getItem("__platform_unsynced") || "[]");
      failSet = false;
      const first = await Platform.load(["quiz-time:best:ussr", "quiz-time:sound"]);
      await new Promise((res) => setTimeout(res, 50));
      const after = { cloud: cloud["quiz-time:best:ussr"], mark: localStorage.getItem("__platform_unsynced") };
      const second = await Platform.load(["quiz-time:best:ussr"]);
      Object.defineProperty(Platform.bridge, "storage", { configurable: true, get: () => saved });
      return { marked, first, after, second, sets };
    });
    ok(r.marked.includes("quiz-time:best:ussr"), "запись на площадку упала — значение в localStorage с пометкой «не доехало»");
    ok(r.first["quiz-time:best:ussr"] === 9, "следующий запуск: виден новый рекорд 9, а не старый 5 с площадки");
    ok(r.after.cloud === "9" && r.after.mark === null, "непринятая запись дописана на площадку, пометка снята");
    ok(r.second["quiz-time:best:ussr"] === 9, "дальше рекорд читается с площадки: 9");
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
    ok(sh.length === 1 && sh[0].url === "" && /^Мой результат в тесте «Кино»: 7 из 10 — «.+»! А ты сколько наберёшь\?$/.test(sh[0].text),
      ch + ": адрес " + ch + " в config.js не вписан — окно площадки получило только текст, без ссылки (" + (sh[0] ? JSON.stringify(sh[0]) : "") + ")");
    const dlgText = await page.evaluate(() => document.querySelector("[data-share-dialog]").innerText + " " + [...document.querySelectorAll("[data-share-dialog] a[href]")].map((a) => a.href).join(" "));
    ok(!/github|https?:|Пройди тест:/.test(dlgText) && /Скопировать текст$/m.test(dlgText), ch + ": в окне нет github.io и ссылок, кнопка «Скопировать текст» (без «со ссылкой»)");
    const other = await page.locator(ch === "vk" ? ".share-dialog__nets .btn--ok" : ".share-dialog__nets .btn--vk").count();
    ok(other === 0, ch + ": кнопки другой сети нет (во ВК — ни слова про ОК, в ОК — про ВКонтакте)");
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
      APP_CONFIG.APP_URL.vk = ""; const vkEmpty = QuizShare.shareUrl(r), vkText = QuizShare.shareText(r);
      APP_CONFIG.APP_URL.ok = "https://ok.ru/game/456"; Platform.id = "ok"; const okUrl = QuizShare.shareUrl(r);
      APP_CONFIG.APP_URL.ok = ""; const okEmpty = QuizShare.shareUrl(r), okText = QuizShare.shareText(r);
      Platform.id = "mock"; const web = QuizShare.shareUrl(r);
      return { vk, vkEmpty, vkText, okUrl, okEmpty, okText, web };
    });
    ok(urls.vk === "https://vk.com/app123#test=kino", "во ВК ссылка из config.js: " + urls.vk);
    ok(urls.okUrl === "https://ok.ru/game/456#test=kino", "в ОК ссылка из config.js: " + urls.okUrl);
    ok(urls.vkEmpty === "" && urls.okEmpty === "" && !/github|https?:|Пройди тест/.test(urls.vkText + urls.okText),
      "адрес ВК/ОК ещё не вписан — внутри площадки ссылки нет вовсе (никакого github.io): «" + urls.okText + "»");
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

  console.log("\nПоддержка «Помощь и вопросы — пишите нам» и заставка:");
  const CFG_FILE = (() => { const w = {}; require("vm").runInNewContext(fs.readFileSync(path.join(ROOT, "config.js"), "utf8"), { window: w }); return w.APP_CONFIG; })();
  ok(CFG_FILE.SUPPORT && /^https:\/\/vk\.com\//.test(CFG_FILE.SUPPORT.vk) && /^https:\/\/ok\.ru\//.test(CFG_FILE.SUPPORT.ok) && /^https:\/\/vk\.com\//.test(CFG_FILE.SUPPORT.web),
    "config.js SUPPORT: vk — vk.com, ok — ok.ru, web — vk.com " + JSON.stringify(CFG_FILE.SUPPORT));
  for (const vp of [PHONE, { width: 360, height: 640 }, { width: 844, height: 390 }, { width: 1280, height: 800 }]) {
    const page = await open(browser, BASE, vp, { init: () => { window.open = (u, t) => { window.__opened = (window.__opened || []).concat([u + " " + t]); return {}; }; } });
    const label = vp.width + "×" + vp.height;
    const gone = await page.waitForSelector("#splash", { state: "detached", timeout: 2000 }).then(() => true, () => false);
    ok(gone, label + ": заставка «Загружаем…» убрана, когда главный экран готов");
    const r = await page.evaluate(async () => {
      const a = document.querySelector("main.home > .support-link:last-child");
      if (!a) return null;
      window.scrollTo(0, document.documentElement.scrollHeight); await new Promise((res) => setTimeout(res, 80));
      const b = a.getBoundingClientRect(), ban = document.querySelector(".fake-banner");
      const zone = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--banner-zone")) || 0;
      return { text: a.innerText.replace(/\s+/g, " ").trim(), href: a.href, bottom: b.bottom, h: b.height, banTop: ban ? ban.getBoundingClientRect().top : null,
        zoneTop: window.innerHeight - zone, font: parseFloat(getComputedStyle(a.querySelector(".support-link__title")).fontSize) };
    });
    ok(r && /Помощь и вопросы — пишите нам/.test(r.text) && !/vk\.com|ok\.ru|github|https?:/.test(r.text), label + ": внизу главного — строка «" + (r && r.text) + "» (адрес на экране не пишем)");
    ok(r && r.href === CFG_FILE.SUPPORT.web && r.h >= 56 && r.font >= 19, label + ": ведёт на " + (r && r.href) + ", крупно (высота " + (r && Math.round(r.h)) + ", шрифт " + (r && r.font) + ")");
    ok(r && r.banTop != null && r.bottom <= r.banTop + 0.5 && r.bottom <= r.zoneTop + 0.5, label + ": строка поддержки над баннером (" + (r && Math.round(r.bottom)) + " ≤ " + (r && Math.round(r.banTop)) + ")");
    if (vp === PHONE) {
      await page.evaluate(() => window.scrollTo(0, 0));
      await tap(page, ".support-link"); await page.waitForTimeout(100);
      const opened = await page.evaluate(() => window.__opened || []);
      ok(opened.length === 1 && opened[0] === CFG_FILE.SUPPORT.web + " _blank", "нажатие открывает сообщество в новом окне: " + JSON.stringify(opened));
      ok((await events(page)).some((e) => e.name === "support_clicked" && e.data.where === "web"), "отметка support_clicked where=web");
      ok(await page.locator(".support-link").count() === 1 && (await page.evaluate(() => QuizApp.screen())) === "home", "приложение осталось на главном");
    }
    ok(!page._errors.length, label + ": ошибок в консоли нет " + JSON.stringify(page._errors));
    await page.context().close();
  }
  {
    // Заставка видна, пока грузится площадка (движок задержан на 1,5 с)
    const ctx = await browser.newContext({ viewport: PHONE, locale: "ru-RU" });
    const page = await ctx.newPage();
    await page.route("**/js/app.js", async (r) => { await new Promise((res) => setTimeout(res, 1500)); r.continue(); });
    await page.goto(BASE, { waitUntil: "domcontentloaded" }); await page.waitForTimeout(300);
    const sp = await page.evaluate(() => { const e = document.getElementById("splash"); if (!e) return null; const b = e.getBoundingClientRect(); return { text: e.innerText.replace(/\s+/g, " ").trim(), full: b.width >= innerWidth && b.height >= innerHeight, imgs: e.querySelectorAll("img").length }; });
    ok(sp && /Викторины/.test(sp.text) && /Загружаем/.test(sp.text) && sp.full && !sp.imgs, "пока грузится — заставка на весь экран «" + (sp && sp.text) + "», без картинок");
    await readyApp(page);
    const gone = await page.waitForSelector("#splash", { state: "detached", timeout: 2000 }).then(() => true, () => false);
    ok(gone && await page.locator(".test-card").count() > 0, "…и исчезает, когда главный экран готов");
    await ctx.close();
  }
  {
    // Bridge 2.4.1: логотип Playgama на весь экран выключен
    const bc = JSON.parse(fs.readFileSync(path.join(ROOT, "playgama-bridge-config.json"), "utf8"));
    ok(bc.disableLoadingLogo === true, "playgama-bridge-config.json: disableLoadingLogo = true (нет логотипа «BRIDGE playgama»)");
  }
  // Запуск по-настоящему: площадку узнаём по параметрам адреса (Bridge 2.4.1 в ОК отвечает 'vk'), как в «Сонника».
  // fake — VK Bridge с unpkg подменён (Bridge поднимается), blocked — unpkg недоступен (Bridge не поднимается).
  const FAKE_VKB = "window.vkBridge={send:function(m,p){window.__vkb=(window.__vkb||[]).concat([{m:m,p:p}]);" +
    "if(m==='VKWebAppStorageGet')return Promise.resolve({keys:(p.keys||[]).map(function(k){return {key:k,value:''}})});" +
    "if(m==='VKWebAppGetUserInfo')return Promise.resolve({id:1});return Promise.resolve({result:true});}," +
    "subscribe:function(){},supports:function(){return true},isWebView:function(){return false}};";
  for (const [where, query] of [["ok", "?vk_app_id=54891122&vk_client=ok&vk_platform=mobile_web_ok&vk_language=ru"],
    ["ok", "?logged_user_id=1&application_key=X&api_server=https%3A%2F%2Fapi.ok.ru%2F&session_key=s"],
    ["vk", "?vk_app_id=54891122&vk_platform=mobile_android&vk_language=ru"]]) {
    for (const net of ["fake", "blocked"]) {
      const ctx = await browser.newContext({ viewport: PHONE, locale: "ru-RU" });
      await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => net === "fake" && /^https:\/\/unpkg\.com\//.test(r.request().url())
        ? r.fulfill({ contentType: "text/javascript", body: FAKE_VKB }) : r.abort());
      await ctx.addInitScript(() => { window.open = (u, t) => { window.__opened = (window.__opened || []).concat([u + " " + t]); return {}; }; });
      const page = await open(browser, BASE + query, null, { ctx });
      const label = where + " (" + net + ", " + query.slice(1, 28) + "…)";
      const s0 = await page.evaluate(() => ({ id: Platform.id, launch: Platform.launch, social: Platform.socialId(), sup: Platform.supportUrl(), url: Platform.appUrl(), links: Platform.externalLinksAllowed() }));
      ok(s0.launch === where && s0.social === where && s0.id !== (where === "ok" ? "vk" : "ok"), label + ": площадка " + JSON.stringify(s0));
      ok(s0.url === "" && !s0.links, label + ": адрес приложения не вписан — ссылки нет, ссылки наружу запрещены");
      const href = await page.getAttribute(".support-link", "href");
      ok(href === CFG_FILE.SUPPORT[where], label + ": «Помощь и вопросы» ведёт на " + href);
      // Окно «Поделиться» (результат подставлен) — текст без ссылки и без github.io
      await page.evaluate(() => {
        const t = QuizApp.tests.find((x) => x.id === "kino");
        QuizShare.share({ test: t, score: 7, total: 10, rank: t.ranks[2] }, { toast: () => {}, mark: () => {} });
      });
      await page.waitForSelector("[data-share-dialog]");
      const all = await page.evaluate(() => document.body.innerHTML + " " + document.body.innerText + " " + [...document.querySelectorAll("a[href]")].map((a) => a.href).join(" "));
      const shareTxt = await page.textContent(".share-dialog__text");
      ok(!/github|https?:|Пройди тест/.test(shareTxt), label + ": текст «Поделиться» без ссылки и github.io: «" + shareTxt + "»");
      if (where === "ok") ok(!/vk\.com|ВКонтакте|github\.io|connect\.ok/i.test(all), label + ": в ОК нигде в странице нет vk.com, «ВКонтакте», github.io");
      else ok(!/ok\.ru|Одноклассник|github\.io/i.test(all), label + ": во ВК нигде нет ok.ru, «Одноклассники», github.io");
      ok(await page.locator("[data-share-dialog] a[target=_blank]").count() === 0, label + ": в окне «Поделиться» нет ссылок наружу");
      if (net === "fake" && await page.evaluate(() => Platform.nativeShareChannel())) {
        await page.locator(".share-dialog__nets .btn").first().click(); await page.waitForTimeout(200);
        const calls = await page.evaluate(() => (window.__vkb || []).filter((c) => c.m === "VKWebAppShare"));
        ok(calls.length === 1 && !calls[0].p.link, label + ": VKWebAppShare без ссылки (площадка делится самим приложением) " + JSON.stringify(calls[0] && calls[0].p));
      }
      await page.keyboard.press("Escape"); await page.waitForTimeout(100);
      await tap(page, ".support-link"); await page.waitForTimeout(100);
      const opened = await page.evaluate(() => window.__opened || []);
      ok(opened.length === 1 && opened[0] === CFG_FILE.SUPPORT[where] + " _blank", label + ": нажатие открывает " + JSON.stringify(opened));
      ok((await events(page)).some((e) => e.name === "support_clicked" && e.data.where === where), label + ": отметка support_clicked where=" + where);
      ok(page._errors.filter((e) => !/Failed to load resource|ERR_FAILED|unpkg|api\.ok\.ru/.test(e)).length === 0, label + ": ошибок нет " + JSON.stringify(page._errors.slice(0, 3)));
      await ctx.close();
    }
  }

  console.log("\nОтметки для статистики:");
  {
    const page = await open(browser, BASE + "?fakeadsec=1");
    await page.mouse.click(5, 300); await page.waitForTimeout(50);
    await tap(page, ".test-card[data-test='songs']");
    await tap(page, "[data-action='start']");
    await answer(page, true); await nextQ(page); await answer(page, false); await nextQ(page);
    await tap(page, "[data-action='back']");
    await page.waitForSelector("[data-action='exit-leave']");
    await page.click("[data-action='exit-leave']");
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
    const allowed = ["app_opened", "first_input", "progression_started", "progression_completed", "progression_failed", "replay_clicked", "share_clicked", "hint_offered", "hint_clicked", "hint_granted", "ad_reward_failed", "performance_sample",
      "daily_opened", "daily_completed", "favorites_offered", "favorites_clicked", "favorites_added", "support_clicked"];
    const names = [...new Set(ev.map((x) => x.name))].sort();
    ok(names.every((n) => allowed.includes(n)), "только события из docs/analytics.md: " + names.join(", "));
    ok(!ev.some((x) => /answer|question/.test(x.name)), "отметок на каждый ответ нет");
    const sent = await page.evaluate(() => typeof bridge.analytics.send === "function" && Analytics.event("app_opened", { entry: "home", returning: false }));
    ok(sent === true, "отметки уходят через bridge.analytics.send");
    ok(!page._errors.length, "ошибок в консоли нет " + JSON.stringify(page._errors));
    await page.context().close();
  }

  console.log("\n«Новинка», «Тест дня», «Добавить в избранное»:");
  // Подмена даты в странице: «сегодня» = target (мс), часы идут дальше как обычно
  const atDate = (target) => ({ init: (t) => {
    const RD = Date, off = t - RD.now();
    function F(...a) { if (!(this instanceof F)) return RD(); return a.length ? new RD(...a) : new RD(RD.now() + off); }
    F.prototype = RD.prototype; F.now = () => RD.now() + off; F.UTC = RD.UTC; F.parse = RD.parse;
    window.Date = F;
  }, arg: target });
  async function openAt(url, vp, target, extra) {
    const ctx = (extra && extra.ctx) || await browser.newContext({ viewport: vp || PHONE, deviceScaleFactor: 1, hasTouch: true, isMobile: true, locale: "ru-RU" });
    if (target) { const d = atDate(target); await ctx.addInitScript(d.init, d.arg); }
    if (extra && extra.init) await ctx.addInitScript(extra.init, extra.arg);
    return open(browser, url, vp, { ctx });
  }
  async function playAll(page, testId, right) {
    await reload(page, BASE + "?test=" + testId);
    await tap(page, "[data-action='start']");
    for (let i = 0; i < 10; i++) { if (i) await nextQ(page); await passMemorize(page); await answer(page, i < right); }
    await nextQ(page); await page.waitForSelector(".result__card");
  }
  const D11 = Date.UTC(2026, 10, 11, 9, 0, 0);   // 11 ноября 2026, утро (UTC)
  const DAY = 86400000;
  {
    const page = await openAt(BASE, PHONE, D11);
    const chips = await page.evaluate(() => [...document.querySelectorAll(".test-card")].filter((c) => c.querySelector(".chip--new")).map((c) => c.getAttribute("data-test")).sort().join(","));
    const want = await page.evaluate(() => QuizApp.tests.filter((t) => t.isNew).map((t) => t.id).sort().join(","));
    ok(chips === want && chips.split(",").length === 6 && chips.split(",").length < await page.locator(".test-card").count(), "«Новинка» на первом запуске — только на новых тестах (" + chips + "), не на всех");
    const d = await page.evaluate(() => { const c = document.querySelector(".daily-card"); const r = c.getBoundingClientRect(); const first = document.querySelector(".test-card").getBoundingClientRect(); return { id: c.getAttribute("data-test"), label: c.querySelector(".daily-card__label").textContent, top: r.top < first.top, h: Math.round(r.height), want: QuizApp.dailyTest(new Date()).id }; });
    ok(d.id === d.want && /Тест дня · 11 ноября/.test(d.label) && d.top && d.h >= 100, "главный: сверху крупная карточка «" + d.label + "» — «" + d.id + "» (" + d.h + " px)");
    await bannerClear(page, "главный с «Тестом дня»");
    await shot(page, "home-daily-390x844");
    // по дате, без сервера: один и тот же у всех, два дня подряд — разные, за 11 дней — все 11
    const seq = await page.evaluate((t0) => { const out = []; for (let i = 0; i < 40; i++) out.push(QuizApp.dailyTest(new Date(t0 + i * 86400000)).id); return out; }, D11);
    const n = await page.locator(".test-card").count();
    ok(seq.every((x, i) => i === 0 || x !== seq[i - 1]) && new Set(seq.slice(0, n)).size === n, "«Тест дня» по номеру дня: два дня подряд разные, за " + n + " дней — все " + n + " (" + seq.slice(0, 4).join(", ") + " …)");
    // «Новинка» исчезает после прохождения; «Тест дня» пройден — «Пройден сегодня: N из 10»
    const daily = d.id;
    const newTest = await page.evaluate((dl) => QuizApp.tests.find((t) => t.isNew && t.id !== dl).id, daily);
    await playAll(page, newTest, 6);
    await tap(page, "[data-action='home']"); await page.waitForSelector(".test-card");
    ok(await page.locator(".test-card[data-test='" + newTest + "'] .chip--new").count() === 0 && await page.locator(".chip--new").count() === 5, "«Новинка» исчезла с пройденного «" + newTest + "», на других осталась");
    await tap(page, ".daily-card"); await page.waitForSelector("[data-action='start']");
    ok(new URL(page.url()).searchParams.get("test") === daily, "нажал «Тест дня» — заставка теста «" + daily + "»");
    await tap(page, "[data-action='start']");
    for (let i = 0; i < 10; i++) { if (i) await nextQ(page); await passMemorize(page); await answer(page, i < 8); }
    await nextQ(page); await page.waitForSelector(".result__card");
    await tap(page, "[data-action='home']"); await page.waitForSelector(".daily-card");
    const doneTxt = await page.textContent(".daily-card__state");
    ok(/Пройден сегодня: 8 из 10, завтра новый/.test(doneTxt), "после прохождения: «" + doneTxt + "»");
    await shot(page, "home-daily-done-390x844");
    let ev = await events(page);
    ok(ev.some((e) => e.name === "daily_opened" && e.data.level_id === daily && e.data.done === false), "отметка daily_opened level_id=" + daily);
    ok(ev.filter((e) => e.name === "daily_completed").length === 1 && ev.some((e) => e.name === "daily_completed" && e.data.level_id === daily && e.data.score === 8), "отметка daily_completed (одна, score=8)");
    ok(ev.some((e) => e.name === "progression_started" && e.data.source === "daily"), "progression_started source=daily");
    ok(!page._errors.length, "ошибок в консоли нет " + JSON.stringify(page._errors));
    // тот же день, новый запуск — «пройден» помнится; на следующий день — другой тест и снова «не пройден»
    const ctx = page.context();
    const same = await openAt(BASE, PHONE, D11 + 3600000, { ctx });
    ok(/Пройден сегодня: 8 из 10/.test(await same.textContent(".daily-card__state")) && await same.getAttribute(".daily-card", "data-test") === daily, "тот же день, новый запуск: тот же тест дня, «Пройден сегодня» помнится");
    const ctx2 = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 1, hasTouch: true, isMobile: true, locale: "ru-RU", storageState: await ctx.storageState() });
    const next = await openAt(BASE, PHONE, D11 + DAY, { ctx: ctx2 });
    const nd = await next.evaluate(() => ({ id: document.querySelector(".daily-card").getAttribute("data-test"), label: document.querySelector(".daily-card__label").textContent, state: document.querySelector(".daily-card__state").textContent }));
    ok(nd.id !== daily && /12 ноября/.test(nd.label) && !/Пройден/.test(nd.state), "на следующий день (подменили дату): «" + nd.label + "» — другой тест «" + nd.id + "», не пройден");
    await ctx2.close();
    await ctx.close();
  }
  {
    // 360×640: главный с «Тестом дня» и «Новинкой»
    const page = await openAt(BASE, { width: 360, height: 640 }, D11);
    await bannerClear(page, "360×640 главный с «Тестом дня»");
    await shot(page, "home-daily-360x640");
    await page.context().close();
    const pl = await openAt(BASE, { width: 640, height: 360 }, D11);
    await bannerClear(pl, "640×360 главный с «Тестом дня»");
    ok(await noSideScroll(pl), "640×360: нет прокрутки вбок");
    await shot(pl, "home-daily-640x360");
    await pl.context().close();
  }
  {
    // Обёртка Platform над Bridge: вне площадки — ничего; во ВК (isReal) — то, что умеет social
    const page = await open(browser, BASE);
    const w = await page.evaluate(async () => {
      const out = { off: Platform.favoritesKind() };
      // bridge.social подменяем целиком (свойства настоящего модуля Bridge оборачивает и запоминает)
      const saved = Platform.isReal, realSoc = bridge.social;
      const set = (fav, home, fails) => {
        const soc = {
          isAddToFavoritesSupported: fav, isAddToHomeScreenSupported: home,
          addToFavorites: () => { out.calledFav = true; return fails ? Promise.reject(new Error("no")) : Promise.resolve(); },
          addToHomeScreen: () => { out.calledHome = true; return Promise.resolve(); }
        };
        Object.defineProperty(bridge, "social", { configurable: true, get: () => soc });
      };
      Platform.isReal = true;
      set(true, true, false); out.both = Platform.favoritesKind(); out.addOk = await Platform.addToFavorites();
      set(true, false, true); out.addNo = await Platform.addToFavorites();
      set(false, true, false); out.home = Platform.favoritesKind(); out.addHome = await Platform.addToFavorites();
      set(false, false, false); out.none = Platform.favoritesKind();
      Platform.isReal = saved;
      Object.defineProperty(bridge, "social", { configurable: true, get: () => realSoc });
      return out;
    });
    ok(w.off === "", "вне площадки (GitHub Pages) избранное не предлагается: favoritesKind = ''");
    ok(w.both === "favorites" && w.addOk === true && w.calledFav && w.addNo === false, "площадка умеет избранное: bridge.social.addToFavorites (добавил — true, передумал — false)");
    ok(w.home === "home_screen" && w.addHome === true && w.calledHome && w.none === "", "умеет только главный экран — bridge.social.addToHomeScreen; ничего не умеет — ''");
    await page.context().close();
  }
  {
    // Предложение «в избранное»: не на первом заходе, не вне площадки, на 3-м заходе (дне) после теста;
    // «Не надо» — больше не предлагаем; ничего не нажал — снова не раньше, чем через 3 дня
    const seedVisits = { init: (a) => { if (!sessionStorage.getItem("seeded")) { sessionStorage.setItem("seeded", "1"); localStorage.setItem("quiz-time:visits", JSON.stringify({ days: a.days, last: Math.floor(a.t / 86400000) - 1 })); } }, arg: { days: 2, t: D11 } };
    const fake = (page, ok2) => page.evaluate((good) => { window.__fav = 0; Platform.favoritesKind = () => "favorites"; Platform.addToFavorites = () => { window.__fav++; return Promise.resolve(good); }; }, ok2);
    // 1-й заход на площадке
    let page = await openAt(BASE, PHONE, D11);
    await fake(page, true);
    await playAll(page, "nature", 5); await fake(page, true);
    await tap(page, "[data-action='home']"); await page.waitForSelector(".test-card");
    ok(await page.locator(".fav-offer").count() === 0, "1-й заход: после теста «в избранное» не предлагаем");
    await page.context().close();
    // вне площадки, хоть и 5-й день
    page = await openAt(BASE, PHONE, D11, { init: seedVisits.init, arg: { days: 4, t: D11 } });
    await playAll(page, "nature", 5);
    await tap(page, "[data-action='home']"); await page.waitForSelector(".test-card");
    ok(await page.locator(".fav-offer").count() === 0, "вне площадки (5-й день) — не предлагаем");
    await page.context().close();
    // 3-й день на площадке: до теста — нет, после теста на главном — есть; «Не надо» — больше никогда
    page = await openAt(BASE, PHONE, D11, seedVisits);
    await fake(page, true);
    ok(await page.locator(".fav-offer").count() === 0 && await page.evaluate(() => QuizStore.get("visits").days) === 3, "3-й день: с порога (до теста) не предлагаем");
    await playAll(page, "nature", 5); await fake(page, true);
    await tap(page, "[data-action='home']"); await page.waitForSelector(".test-card");
    ok(await page.locator(".fav-offer [data-action='fav-yes']").count() === 1 && /в избранное/.test(await page.textContent(".fav-offer")), "3-й день, прошёл тест, вернулся на главный — строка «⭐ Добавить в избранное»");
    await bannerClear(page, "главный с предложением «в избранное»");
    await shot(page, "home-fav-390x844");
    let ev = await events(page);
    ok(ev.filter((e) => e.name === "favorites_offered").length === 1 && ev.some((e) => e.name === "favorites_offered" && e.data.kind === "favorites"), "отметка favorites_offered kind=favorites (одна)");
    await tap(page, "[data-action='fav-no']"); await page.waitForTimeout(100);
    ok(await page.locator(".fav-offer").count() === 0 && (await page.evaluate(() => QuizStore.get("fav"))).state === "no", "«Не надо» — строка убрана, отказ запомнен");
    await playAll(page, "nature", 6);
    await tap(page, "[data-action='home']"); await page.waitForSelector(".test-card");
    ok(await page.locator(".fav-offer").count() === 0, "после «Не надо» больше не предлагаем");
    const p2 = await openAt(BASE, PHONE, D11 + 5 * DAY, { ctx: page.context() });
    await fake(p2, true); await playAll(p2, "nature", 5); await fake(p2, true);
    await tap(p2, "[data-action='home']"); await p2.waitForSelector(".test-card");
    ok(await p2.locator(".fav-offer").count() === 0, "после «Не надо» не предлагаем и через 5 дней");
    await page.context().close();
    // «Добавить»: окно площадки, добавил — отметки и больше не предлагаем
    page = await openAt(BASE, PHONE, D11, seedVisits);
    await fake(page, true); await playAll(page, "nature", 5); await fake(page, true);
    await tap(page, "[data-action='home']"); await page.waitForSelector(".fav-offer");
    await tap(page, "[data-action='fav-yes']"); await page.waitForTimeout(150);
    ev = await events(page);
    ok(await page.evaluate(() => window.__fav) === 1 && ev.some((e) => e.name === "favorites_clicked") && ev.some((e) => e.name === "favorites_added" && e.data.kind === "favorites"), "«Добавить в избранное» — окно площадки, отметки favorites_clicked и favorites_added");
    ok(await page.locator(".fav-offer").count() === 0 && (await page.evaluate(() => QuizStore.get("fav"))).state === "yes", "добавил — строка убрана, больше не предлагаем");
    await page.context().close();
    // предложили, ничего не нажал: в тот же день снова — нет; через 3 дня — снова
    page = await openAt(BASE, PHONE, D11, seedVisits);
    await fake(page, true); await playAll(page, "nature", 5); await fake(page, true);
    await tap(page, "[data-action='home']"); await page.waitForSelector(".fav-offer");
    const ctx = page.context();
    const again = await openAt(BASE, PHONE, D11 + 3600000, { ctx });
    await fake(again, true); await playAll(again, "nature", 5); await fake(again, true);
    await tap(again, "[data-action='home']"); await again.waitForSelector(".test-card");
    ok(await again.locator(".fav-offer").count() === 0, "ничего не нажал — в тот же день при новом запуске не предлагаем");
    const later = await openAt(BASE, PHONE, D11 + 3 * DAY, { ctx });
    await fake(later, true); await playAll(later, "nature", 5); await fake(later, true);
    await tap(later, "[data-action='home']"); await later.waitForSelector(".test-card");
    ok(await later.locator(".fav-offer").count() === 1, "…а через 3 дня — снова (не чаще раза в несколько дней)");
    ok(!later._errors.length, "ошибок в консоли нет " + JSON.stringify(later._errors));
    await ctx.close();
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
