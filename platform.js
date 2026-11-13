/*
 * platform.js — площадочная часть мини-приложения (общий шаблон студии).
 *
 * Здесь только связь с площадкой через Playgama Bridge: одна сборка работает на Playgama,
 * во ВКонтакте и в Одноклассниках (Bridge сам понимает, где запущен). Ничего про сонник,
 * гадания или рецепты здесь нет — модуль можно копировать в любое мини-приложение как есть.
 *
 * Что умеет (window.Platform):
 *   Platform.init(opts)        — запустить Bridge и дождаться его (не дольше opts.timeoutMs).
 *                                Всегда завершается успешно: без Bridge приложение просто
 *                                работает «как в браузере».
 *   Platform.id                — где запущены: 'vk', 'ok', 'playgama', … ; 'mock' — обычный
 *                                браузер с Bridge (GitHub Pages); 'none' — Bridge не загрузился.
 *   Platform.isReal / isSocial — настоящая площадка / ВК или ОК.
 *   Platform.gameReady()       — сказать площадке «приложение готово» (game_ready).
 *   Platform.load(keys)        — прочитать сохранённое: { ключ: значение | null }.
 *   Platform.save({ключ: значение}) — сохранить все изменённые ключи одним вызовом.
 *                                Хранилище Bridge (во ВК и ОК — облако игрока); без Bridge —
 *                                запасной localStorage. Площадка не приняла запись — она ложится
 *                                в localStorage с пометкой «не доехало»: при следующем load()
 *                                берётся она (а не старое с площадки) и снова уходит на площадку. Во ВК/ОК ключ очищается до [A-Za-z0-9_-]
 *                                (правило ВК), в браузере остаётся как есть.
 *   Platform.rewardedAvailable() — можно ли показать рекламу за награду (кнопку иначе прятать).
 *   Platform.showRewarded(opts) — показать рекламу за награду. Ответ — Promise:
 *                                { ok: true } — досмотрена до конца (только тогда награда!);
 *                                { ok: false, reason } — 'closed' (закрыли раньше), 'error',
 *                                'timeout' (площадка не открыла рекламу за opts.waitMs).
 *                                Реклама «опоздала» (открылась после 'timeout' или после
 *                                cancelRewarded): opts.onLateOpen() — началась (убрать сообщение
 *                                «не загрузилась»); opts.onLateReward() — досмотрена, награду
 *                                ДАТЬ (один раз); opts.onLateFail(reason) — закрыта раньше / ошибка.
 *   Platform.cancelRewarded()  — человек сам передумал ждать рекламу («Отмена», «Назад»).
 *   Platform.banner.show() / .hide() — баннер внизу. Пока баннер на экране, у <html> есть
 *                                класс has-banner и CSS-переменная --banner-h (сколько места
 *                                оставить снизу), чтобы баннер не закрывал текст и кнопки.
 *   Platform.nativeShareChannel() — 'vk' / 'ok', если площадка умеет делиться сама, иначе ''.
 *   Platform.shareNative({text, url}) — окно «поделиться» самой площадки (Promise).
 *   Platform.externalLinksAllowed() — можно ли открывать ссылки на другие сайты.
 *   Platform.copyText(str)     — скопировать текст (Promise<true|false>).
 *   Platform.appUrl()          — адрес приложения в текущей площадке (из APP_CONFIG.APP_URL).
 *   Platform.payload           — данные из ссылки запуска (во ВК: всё после # в адресе).
 *   Platform.launch            — 'ok' / 'vk' по параметрам запуска в адресе (или ''), даже без Bridge.
 *                                Bridge 2.4.1 в Одноклассниках называет площадку 'vk', поэтому ОК
 *                                узнаём сами: vk_client=ok, vk_platform=*_ok, параметры ОК
 *                                (logged_user_id / application_key + api_server …) или переход с ok.ru
 *                                (как в «Соннике»).
 *   Platform.socialId()        — 'vk' / 'ok' — внутри ВК / ОК (по запуску или по Bridge), иначе ''.
 *   Platform.supportUrl()      — адрес поддержки своей площадки (APP_CONFIG.SUPPORT.vk|ok|web) или ''.
 *   Platform.openSupport()     — открыть поддержку в новом окне (true — открыли, false — не вышло:
 *                                приложение показывает адрес текстом).
 *   Platform.isPaused() / onPause(fn) — площадка поставила паузу (реклама, свернули вкладку).
 *   Platform.favoritesKind()   — 'favorites' / 'home_screen', если площадка умеет добавить приложение
 *                                в избранное / на главный экран; '' — не умеет или это не площадка.
 *   Platform.addToFavorites()  — окно площадки «добавить» (Promise<true|false>: добавил / нет).
 *   CSS-переменная --banner-zone — место под баннер, пока он возможен (окна держатся выше неё).
 *
 * Без площадки реклама за награду и баннер — имитация: своё окно «здесь будет реклама»
 * с отсчётом и серая полоска внизу. Имитация включается ТОЛЬКО на проверочных адресах:
 * *.github.io, localhost, 127.0.0.1 и при открытии файлом. На любом другом адресе (например,
 * внутри ВК/ОК, если Bridge не поднялся) рекламы нет: rewardedAvailable() = false, баннера нет.
 * Для проверки всех случаев: ?fakead=cancel | fail | silent | late (и ?fakeadsec=1).
 */
(function () {
  "use strict";

  var cfg = window.APP_CONFIG || {};
  var bridge = null;
  var paused = false;
  var pauseHandlers = [];
  var LS_PREFIX = "";

  var P = window.Platform = {
    id: "none",
    hasBridge: false,
    isReal: false,
    isSocial: false,
    payload: null,
    bridge: null
  };

  function now() { return Date.now(); }
  function safe(fn, fallback) { try { return fn(); } catch (e) { return fallback; } }
  function query(name) {
    return safe(function () { return new URLSearchParams(location.search).get(name); }, null);
  }
  // Проверочный адрес: здесь можно показывать имитацию рекламы.
  function testHost() {
    if (location.protocol === "file:") return true;
    var h = String(location.hostname || "").toLowerCase();
    return h === "localhost" || h === "127.0.0.1" || h === "" || /(^|\.)github\.io$/.test(h);
  }
  P.isTestHost = testHost;

  // Где запущены — по параметрам запуска (не по Bridge: в ОК он отвечает 'vk'). Из «Сонника».
  function launchPlatform() {
    var q = safe(function () { return location.search; }, "") || "";
    var has = function (name) { return new RegExp("[?&]" + name + "=").test(q); };
    var ref = safe(function () { return String(document.referrer || ""); }, "");
    var isOk = /[?&]vk_client=ok(&|$)/.test(q) || /[?&]vk_platform=[a-z_]+_ok(&|$)/.test(q) ||
      ((has("logged_user_id") || has("application_key")) &&
       (has("api_server") || has("apiconnection") || has("session_key") || has("auth_sig") || has("web_server"))) ||
      /^https?:\/\/([a-z0-9-]+\.)*(ok\.ru|odnoklassniki\.ru)(\/|$)/i.test(ref);
    if (isOk) return "ok";
    if (/[?&]vk_(app_id|platform|user_id|language)=/.test(q)) return "vk";
    return "";
  }
  P.launch = launchPlatform();

  /* ---------------- запуск ---------------- */

  function removeBridgeOverlay() {
    safe(function () { var ov = document.getElementById("loading-overlay"); if (ov) ov.remove(); });
  }

  P.init = function (opts) {
    opts = opts || {};
    LS_PREFIX = opts.localPrefix || "";
    var timeoutMs = opts.timeoutMs || 8000;
    // Общий предел от начала загрузки страницы (opts.deadlineMs, по умолчанию 10 с): если
    // скрипт Bridge грузился долго, на initialize остаётся меньше времени.
    var since = (window.performance && performance.now) ? performance.now() : 0;
    timeoutMs = Math.max(500, Math.min(timeoutMs, (opts.deadlineMs || 10000) - since));
    var b = window.bridge;
    var started = new Promise(function (resolve) {
      if (!b || typeof b.initialize !== "function") { resolve(false); return; }
      var done = false;
      // Bridge не ответил вовремя (во ВК/ОК — не загрузился VK Bridge с unpkg.com): работаем без него
      // и убираем его заставку, если она есть, иначе она закрывает приложение и не пускает нажатия.
      var timer = setTimeout(function () { if (!done) { done = true; removeBridgeOverlay(); resolve(false); } }, timeoutMs);
      var p;
      try { p = b.initialize(); } catch (e) { p = Promise.reject(e); }
      Promise.resolve(p).then(function () {
        if (done) return;
        done = true; clearTimeout(timer); resolve(true);
      }, function () {
        if (done) return;
        done = true; clearTimeout(timer); resolve(false);
      });
    });
    return started.then(function (ok) {
      if (ok) {
        bridge = b;
        P.bridge = b;
        P.hasBridge = true;
        P.id = String(safe(function () { return b.platform.id; }, "mock") || "mock");
        P.bridgeId = P.id;
        // В ОК Bridge работает через VK Bridge и называет площадку 'vk' — поправляем.
        if (P.launch === "ok" && P.id === "vk") P.id = "ok";
      }
      P.isReal = P.hasBridge && P.id !== "mock";
      P.isSocial = P.id === "vk" || P.id === "ok" || !!P.launch;
      P.payload = P.hasBridge ? safe(function () { return b.platform.payload; }, null) : null;
      if (P.hasBridge) listen();
      banner.setup(opts);
      return P;
    });
  };

  function on(module, eventKey, fallbackName, fn) {
    safe(function () {
      var name = (bridge.EVENT_NAME && bridge.EVENT_NAME[eventKey]) || fallbackName;
      bridge[module].on(name, fn);
    });
  }

  function listen() {
    on("advertisement", "REWARDED_STATE_CHANGED", "rewarded_state_changed", onRewardedState);
    on("advertisement", "BANNER_STATE_CHANGED", "banner_state_changed", function (s) { banner.onState(s); });
    on("platform", "PAUSE_STATE_CHANGED", "pause_state_changed", function (v) { setPaused(!!v); });
  }

  function setPaused(v) {
    if (paused === v) return;
    paused = v;
    pauseHandlers.forEach(function (f) { safe(function () { f(v); }); });
  }
  P.isPaused = function () { return paused; };
  P.onPause = function (fn) { pauseHandlers.push(fn); };

  P.gameReady = function () {
    if (!P.hasBridge) return;
    safe(function () { bridge.platform.sendMessage("game_ready"); });
  };

  /* ---------------- хранилище ---------------- */

  function lsGet(k) {
    return safe(function () {
      var v = window.localStorage.getItem(LS_PREFIX + k);
      return v == null ? null : JSON.parse(v);
    }, null);
  }
  function lsSet(k, v) {
    safe(function () {
      if (v == null) window.localStorage.removeItem(LS_PREFIX + k);
      else window.localStorage.setItem(LS_PREFIX + k, JSON.stringify(v));
    });
  }
  function decode(v) {
    if (typeof v !== "string") return v == null ? null : v;
    if (v === "") return null;
    try { return JSON.parse(v); } catch (e) { return v; }
  }

  // Ключ в хранилище площадки. ВК принимает только латиницу, цифры, «_» и «-» (VKWebAppStorageSet),
  // поэтому на настоящей площадке остальные знаки заменяются на «_» («quiz-time:best:ussr» →
  // «quiz-time_best_ussr»). В браузере (Bridge «mock» и запасной localStorage) ключ не меняется —
  // так сохранённое раньше не теряется. Ключи вида «sonnik_recent» не меняются нигде.
  function pkey(k) { return P.isReal ? String(k).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 100) : String(k); }

  // Записи, которые не доехали до хранилища площадки (bridge.storage.set упал) и лежат пока
  // только в localStorage. При следующем запуске берём их вместо площадочных (там старое)
  // и пробуем дописать на площадку ещё раз.
  var UNSYNCED = "__platform_unsynced";
  function unsynced() { var v = lsGet(UNSYNCED); return Array.isArray(v) ? v : []; }
  function markUnsynced(keys, on) {
    var list = unsynced().filter(function (k) { return keys.indexOf(k) < 0; });
    if (on) list = list.concat(keys);
    lsSet(UNSYNCED, list.length ? list : null);
  }

  // Прочитать все ключи одним вызовом. Ответ: { ключ: значение | null }.
  P.load = function (keys) {
    var fromLocal = function () {
      var out = {};
      keys.forEach(function (k) { out[k] = lsGet(k); });
      return out;
    };
    if (!P.hasBridge || !safe(function () { return bridge.storage; }, null)) return Promise.resolve(fromLocal());
    // Хранилище площадки молчит дольше 4 с — запускаемся без сохранённого (localStorage).
    var slow = new Promise(function (res) { setTimeout(function () { res("__slow"); }, 4000); });
    var got = Promise.resolve().then(function () { return bridge.storage.get(keys.map(pkey)); });
    return Promise.race([got, slow]).then(function (data) {
      if (data === "__slow") return fromLocal();
      var out = {}, retry = {}, late = unsynced();
      keys.forEach(function (k, i) {
        var v = Array.isArray(data) ? data[i] : (data && typeof data === "object" ? data[pkey(k)] : null);
        out[k] = decode(v);
        if (late.indexOf(k) >= 0) { out[k] = lsGet(k); retry[k] = out[k]; }   // не доехало — местное новее
      });
      if (Object.keys(retry).length) P.save(retry);
      return out;
    }, function () { return fromLocal(); });
  };

  // Сохранить изменённые ключи одним вызовом. Значения — любые (храним как JSON-строку).
  P.save = function (obj) {
    var keys = Object.keys(obj || {});
    if (!keys.length) return Promise.resolve(true);
    var toLocal = function () { keys.forEach(function (k) { lsSet(k, obj[k]); }); return true; };
    if (!P.hasBridge || !safe(function () { return bridge.storage; }, null)) return Promise.resolve(toLocal());
    var vals = keys.map(function (k) { return obj[k] == null ? "" : JSON.stringify(obj[k]); });
    return Promise.resolve().then(function () { return bridge.storage.set(keys.map(pkey), vals); })
      .then(function () { if (unsynced().length) markUnsynced(keys, false); return true; },
        function () { toLocal(); markUnsynced(keys, true); return true; });   // площадка не приняла — помним, что не доехало
  };

  /* ---------------- реклама за награду ---------------- */

  // req — текущая просьба о рекламе. status: 'waiting' (ждём, пока откроется), 'open' (идёт),
  // 'done' (ответ уже дан). late — реклама открылась уже после того, как мы перестали ждать.
  var req = null;
  var reqSeq = 0;

  function rewardedMode() {
    if (P.hasBridge && safe(function () { return bridge.advertisement.isRewardedSupported; }, false)) return "bridge";
    return !P.isReal && testHost() ? "fake" : "none";
  }
  P.rewardedAvailable = function () { return rewardedMode() !== "none"; };

  function finish(r, result) {
    if (r.status === "done") return;
    r.status = "done";
    clearTimeout(r.timer);
    r.resolve(result);
  }

  function onRewardedState(state) {
    var r = req;
    if (!r) return;                      // «rewarded» без просьбы игрока — ничего не даём
    if (r.status === "done") {
      // Мы уже ответили «не дождались» (timeout / «Отмена»). Реклама всё-таки пришла:
      // если её досмотрят до конца — награда положена (человек её честно посмотрел).
      if (!r.timedOut) return;
      if (state === "opened" && !r.lateOpened) { r.lateOpened = true; if (r.onLateOpen) safe(r.onLateOpen); return; }
      if (state === "rewarded") { r.rewarded = true; return; }
      if (state === "closed" || state === "failed") {
        req = null;
        if (r.lateDone) return;
        r.lateDone = true;
        if (r.rewarded) { if (r.onLateReward) safe(r.onLateReward); }
        else if (r.lateOpened && r.onLateFail) safe(function () { r.onLateFail(state === "failed" ? "error" : "closed"); });
      }
      return;
    }
    if (state === "loading") return;
    if (state === "opened") { r.status = "open"; clearTimeout(r.timer); if (r.onOpen) safe(r.onOpen); return; }
    if (state === "rewarded") { r.rewarded = true; return; }
    if (state === "closed") { finish(r, r.rewarded ? { ok: true } : { ok: false, reason: "closed" }); req = null; return; }
    if (state === "failed") { finish(r, r.rewarded ? { ok: true } : { ok: false, reason: "error" }); req = null; }
  }

  P.showRewarded = function (opts) {
    opts = opts || {};
    var mode = rewardedMode();
    if (mode === "none") return Promise.resolve({ ok: false, reason: "error" });
    if (req && req.status !== "done") return req.promise;   // уже ждём рекламу — второй раз не просим
    var waitMs = opts.waitMs || (cfg.REWARDED_WAIT_SEC || 12) * 1000;
    var r = { id: ++reqSeq, status: "waiting", rewarded: false, timedOut: false, lateOpened: false, lateDone: false,
      onOpen: opts.onOpen, onLateOpen: opts.onLateOpen, onLateReward: opts.onLateReward, onLateFail: opts.onLateFail, timer: 0 };
    r.promise = new Promise(function (resolve) { r.resolve = resolve; });
    req = r;
    r.timer = setTimeout(function () {
      if (r.status !== "waiting") return;
      r.timedOut = true;
      finish(r, { ok: false, reason: "timeout" });
    }, waitMs);
    if (mode === "bridge") {
      safe(function () {
        if (opts.placement) bridge.advertisement.showRewarded(opts.placement);
        else bridge.advertisement.showRewarded();
      }, null);
    } else {
      fakeAd.show(r);
    }
    return r.promise;
  };

  P.cancelRewarded = function () {
    var r = req;
    if (!r || r.status !== "waiting") return false;
    r.timedOut = true;                   // если реклама всё же придёт — это «опоздала»
    finish(r, { ok: false, reason: "closed" });
    return true;
  };
  P.isWaitingRewarded = function () { return !!(req && req.status === "waiting"); };

  /* ---------------- имитация рекламы (без площадки) ---------------- */

  var fakeAd = {
    show: function (r) {
      var how = (query("fakead") || "ok").toLowerCase();
      var sec = Math.max(1, Math.min(30, parseInt(query("fakeadsec"), 10) || 5));
      var send = function (s) { if (req === r) onRewardedState(s); };
      setTimeout(function () { send("loading"); }, 50);
      if (how === "silent") return;
      if (how === "fail") { setTimeout(function () { send("failed"); }, 400); return; }
      var openAfter = how === "late" ? (cfg.REWARDED_WAIT_SEC || 12) * 1000 + 1500 : 300;
      setTimeout(function () {
        if (req !== r) return;
        send("opened");
        fakeAd.overlay(sec, how === "cancel", send);
      }, openAfter);
    },
    // Окно «реклама»: отсчёт, потом «Награда получена»; «Закрыть» до конца — без награды.
    overlay: function (sec, autoCancel, send) {
      var box = document.createElement("div");
      box.className = "fake-ad";
      box.setAttribute("role", "dialog");
      box.setAttribute("aria-modal", "true");
      box.setAttribute("aria-label", "Реклама");
      box.style.cssText = "position:fixed;inset:0;z-index:1000;display:flex;flex-direction:column;align-items:center;" +
        "justify-content:center;gap:18px;padding:24px;background:#10131f;color:#fff;font:600 20px/1.4 system-ui,sans-serif;text-align:center";
      var t = document.createElement("p");
      t.style.margin = "0";
      var close = document.createElement("button");
      close.type = "button";
      close.className = "fake-ad-close";
      close.style.cssText = "min-height:52px;padding:10px 26px;border-radius:14px;border:2px solid #fff;background:transparent;color:#fff;font:inherit;cursor:pointer";
      close.textContent = "Закрыть рекламу";
      box.appendChild(t);
      box.appendChild(close);
      document.body.appendChild(box);
      close.focus();
      var left = sec, rewarded = false;
      function tick() {
        if (rewarded) return;
        if (left <= 0) {
          rewarded = true;
          send("rewarded");
          t.textContent = "Реклама (проверка) досмотрена. Награда получена.";
          close.textContent = "Закрыть";
          return;
        }
        t.textContent = "Здесь будет реклама площадки (это проверка). Осталось " + left + " с.";
        left--;
        timer = setTimeout(tick, 1000);
      }
      var timer;
      tick();
      close.addEventListener("click", function () {
        clearTimeout(timer);
        box.remove();
        send("closed");
      });
      if (autoCancel) setTimeout(function () { if (!rewarded) close.click(); }, 700);
    }
  };

  /* ---------------- баннер ---------------- */

  var banner = P.banner = {
    wanted: false,
    state: "hidden",
    mode: "none",               // 'bridge' | 'fake' | 'none'
    reservePx: 90,
    el: null,
    setup: function (opts) {
      this.reservePx = opts.bannerReservePx || cfg.BANNER_RESERVE_PX || 90;
      if (P.hasBridge && safe(function () { return bridge.advertisement.isBannerSupported; }, false)) this.mode = "bridge";
      else if (!P.isReal && testHost() && (opts.fakeBanner != null ? opts.fakeBanner : cfg.FAKE_BANNER) && query("nobanner") == null) this.mode = "fake";
      else this.mode = "none";
      // --banner-zone: сколько места снизу может занять баннер, пока он вообще возможен (даже когда
      // сейчас спрятан). По ней окна (вопрос, ожидание рекламы, «поделиться») встают целиком выше:
      // на площадке баннер рисует ВК/ОК поверх страницы, и на z-index полагаться нельзя.
      document.documentElement.style.setProperty("--banner-zone", this.mode !== "none" ? this.reservePx + "px" : "0px");
    },
    reserve: function (on) {
      var root = document.documentElement;
      root.classList.toggle("has-banner", !!on);
      root.style.setProperty("--banner-h", on ? this.reservePx + "px" : "0px");
    },
    onState: function (s) {
      this.state = s;
      this.reserve(s === "shown" && this.wanted);
    },
    // show/hide можно звать сколько угодно раз: площадку дёргаем только при смене.
    show: function () {
      if (this.wanted) return;
      this.wanted = true;
      if (this.mode === "bridge") {
        safe(function () { bridge.advertisement.showBanner("bottom"); });
      } else if (this.mode === "fake") {
        if (!this.el) {
          var el = this.el = document.createElement("div");
          el.className = "fake-banner";
          el.setAttribute("aria-hidden", "true");
          el.textContent = "Здесь будет баннер площадки";
          el.style.cssText = "position:fixed;left:0;right:0;bottom:0;z-index:40;display:flex;align-items:center;justify-content:center;" +
            "height:" + this.reservePx + "px;padding-bottom:env(safe-area-inset-bottom);background:#2a2f45;color:#c9cde0;" +
            "border-top:1px dashed #6b7194;font:15px/1.3 system-ui,sans-serif;pointer-events:none";
          document.body.appendChild(el);
        }
        this.el.style.display = "flex";
        this.onState("shown");
      }
    },
    hide: function () {
      if (!this.wanted) return;
      this.wanted = false;
      this.reserve(false);
      if (this.mode === "bridge") safe(function () { bridge.advertisement.hideBanner(); });
      else if (this.mode === "fake" && this.el) { this.el.style.display = "none"; this.state = "hidden"; }
    }
  };

  /* ---------------- «в избранное» / «на главный экран» ---------------- */

  // Что площадка умеет: 'favorites' (во ВК — «Добавить в избранное»), 'home_screen' (ярлык на
  // главный экран телефона) или '' — ничего (и всегда '' вне настоящей площадки: GitHub Pages,
  // обычный браузер). Предлагать это человеку — только когда он уже несколько раз заходил.
  P.favoritesKind = function () {
    if (!P.hasBridge || !P.isReal) return "";
    if (safe(function () { return bridge.social.isAddToFavoritesSupported; }, false)) return "favorites";
    if (safe(function () { return bridge.social.isAddToHomeScreenSupported; }, false)) return "home_screen";
    return "";
  };
  // Окно площадки «добавить». Promise<true> — добавил, <false> — передумал или ошибка.
  P.addToFavorites = function () {
    var kind = P.favoritesKind();
    return Promise.resolve().then(function () {
      if (kind === "favorites") return bridge.social.addToFavorites();
      if (kind === "home_screen") return bridge.social.addToHomeScreen();
      throw new Error("not supported");
    }).then(function () { return true; }, function () { return false; });
  };

  /* ---------------- поделиться, ссылки, буфер обмена ---------------- */

  // Внутри какой соцсети мы: 'vk' / 'ok' (по параметрам запуска, а без них — по Bridge), иначе ''.
  P.socialId = function () {
    if (P.launch) return P.launch;
    return P.id === "vk" || P.id === "ok" ? P.id : "";
  };

  // ОК внутри VK Bridge (Bridge называет площадку 'vk'): делимся через VKWebAppShare — в ОК он есть.
  function okViaVkBridge() { return P.id === "ok" && P.bridgeId === "vk"; }

  P.nativeShareChannel = function () {
    if (!P.hasBridge) return "";
    if (P.id === "vk" && safe(function () { return bridge.social.isShareSupported; }, false)) return "vk";
    if (okViaVkBridge() && safe(function () { return bridge.social.isShareSupported; }, false)) return "ok";
    if (P.id === "ok" && safe(function () { return bridge.social.isCreatePostSupported; }, false)) return "ok";
    return "";
  };

  // ВК: окно «Поделиться» ВКонтакте (ссылка). ОК: окно «Поделиться» ОК (через VK Bridge) или окно
  // новой заметки (текст + ссылка). Ссылки нет (адрес приложения не вписан) — площадка делится
  // самим приложением (ВК) или только текстом (заметка ОК).
  P.shareNative = function (data) {
    var ch = P.nativeShareChannel();
    var url = data.url || undefined;
    return Promise.resolve().then(function () {
      if (ch === "vk" || (ch === "ok" && okViaVkBridge())) return bridge.social.share(url ? { url: url } : {});
      if (ch === "ok") return bridge.social.createPost(url ? { text: data.text, url: url } : { text: data.text });
      throw new Error("share not supported");
    });
  };

  // Внутри ВК и ОК ссылки на другие сайты не открываем никогда (правила ВК, ОК п. 5.1).
  P.externalLinksAllowed = function () {
    if (P.socialId()) return false;
    if (!P.isReal) return true;
    return !!safe(function () { return bridge.platform.isExternalLinksAllowed; }, false);
  };

  // Адрес приложения для ссылок «Поделиться». Внутри ВК/ОК — только свой адрес из config.js;
  // не вписан — '' (ссылку не добавляем вовсе, никакого github.io). Вне площадок — web-адрес.
  P.appUrl = function () {
    var urls = cfg.APP_URL || {};
    var where = P.socialId();
    if (where === "ok") return urls.ok || "";
    if (where === "vk") return urls.vk || "";
    if (urls.web) return urls.web;
    return location.href.split("#")[0].split("?")[0];
  };

  /* ---------------- поддержка ---------------- */

  // Адрес поддержки своей площадки: во ВК — сообщество ВК, в ОК — группа ОК (никогда не ВК),
  // вне площадок — web. Старый вид SUPPORT строкой понимается как адрес для всех площадок.
  P.supportUrl = function () {
    var sup = cfg.SUPPORT;
    if (!sup) return "";
    if (typeof sup === "string") return /^https?:/.test(sup) ? sup : "https://" + sup;
    var where = P.socialId();
    if (where) return sup[where] || "";
    return sup.web || "";
  };

  // Открыть поддержку. Звать прямо из нажатия (иначе браузер не даст открыть окно).
  // Как Bridge во ВК («вступить в сообщество» — тоже window.open): новое окно/вкладка; во ВК и ОК
  // на телефоне площадка открывает его у себя. Не вышло — пробуем открыть во всём окне площадки
  // (а не внутри нашей рамки: сайты ВК/ОК в рамке не открываются). Совсем нельзя — false.
  P.openSupport = function () {
    var url = P.supportUrl();
    if (!url) return false;
    var w = null;
    try { w = window.open(url, "_blank"); } catch (e) { w = null; }
    if (w) { try { w.opener = null; } catch (e) { /* ничего */ } return true; }
    var inFrame = safe(function () { return window.top !== window.self; }, true);
    if (!inFrame) { try { location.href = url; return true; } catch (e) { return false; } }
    try { window.top.location.href = url; return true; } catch (e) { return false; }
  };

  function browserCopy(str) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(str).then(function () { return true; }, function () { return legacyCopy(str); });
    }
    return Promise.resolve(legacyCopy(str));
  }
  function legacyCopy(str) {
    var ta = document.createElement("textarea");
    ta.readOnly = true;
    ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;font-size:16px";
    ta.value = str;
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
    ta.remove();
    return ok;
  }
  P.copyText = function (str) {
    if (P.isReal && safe(function () { return bridge.clipboard.isSupported; }, false)) {
      return Promise.resolve().then(function () { return bridge.clipboard.write(str); })
        .then(function () { return true; }, function () { return browserCopy(str); });
    }
    return browserCopy(str);
  };
})();
