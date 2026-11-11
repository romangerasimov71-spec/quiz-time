/*
 * analytics.js — отметки для статистики (общий шаблон мини-приложений студии).
 *
 * Отправляет события приложения только через уже запущенный Playgama Bridge
 * (bridge.analytics.send). Ничего про само приложение здесь нет: что и когда отмечать,
 * решает приложение. Сессии, время, рекламу и покупки Bridge записывает сам — их здесь
 * не повторяем. Без Bridge (или без его модуля статистики) всё молча ничего не делает.
 * Никаких личных данных, своих session_id, адресов, текстов ошибок.
 *
 *   Analytics.init(bridge, { appVersion: '1.0.0' }) — после запуска Bridge
 *   Analytics.ready()                  — приложение готово (рядом с game_ready)
 *   Analytics.event('имя', { поле: значение })   — значения: короткие строки, числа, да/нет
 *   Analytics.once('имя', данные)      — не чаще одного раза за запуск
 *
 * Сам модуль отправляет:
 *   first_input        — первое действие человека: input (touch/mouse/keyboard), seconds — секунд
 *                        от начала загрузки страницы, seconds_since_ready — от готовности.
 *   performance_sample — скорость по правилам Playgama (гайд телеметрии 1.1.2). В мини-приложении
 *                        нет «игрового процесса», поэтому кадры меряются только пока человек
 *                        что-то делает (касается, листает, жмёт клавиши — и 3 секунды после),
 *                        а вкладка видна. Один образец примерно раз в 30 секунд видимого времени,
 *                        если за это время набралось хотя бы 20 кадров.
 * Список событий конкретного приложения — в его docs/analytics.md.
 */
(function () {
  "use strict";

  var WINDOW_MS = 30000;      // образец скорости — раз в ~30 с видимого времени
  var ACTIVE_AFTER_INPUT = 3000;
  var GAP_MS = 1000;          // промежуток между кадрами больше секунды — это не кадр, а простой
  var MIN_FRAMES = 20;

  var bridge = null;
  var opts = { appVersion: "", targetFps: 60 };
  var sentOnce = {};
  var readyAt = -1;
  var firstInputDone = false;

  function now() { return (window.performance && performance.now) ? performance.now() : Date.now(); }
  function r1(v) { return Math.round(v * 10) / 10; }

  function transport() {
    try {
      var a = bridge && bridge.analytics;
      return a && typeof a.send === "function" ? a : null;
    } catch (e) { return null; }
  }

  // Плоский объект: короткие строки, конечные числа, да/нет.
  function clean(data) {
    var out = {};
    if (!data || typeof data !== "object") return out;
    Object.keys(data).forEach(function (k) {
      var v = data[k];
      if (typeof v === "string") out[k] = v.slice(0, 40);
      else if (typeof v === "number" && isFinite(v)) out[k] = v;
      else if (typeof v === "boolean") out[k] = v;
    });
    return out;
  }

  var log = [];   // для автотестов: что было бы отправлено (последние 200)
  function event(name, data) {
    if (typeof name !== "string" || !name) return false;
    var d = clean(data);
    log.push({ name: name, data: d });
    if (log.length > 200) log.shift();
    var a = transport();
    if (!a) return false;
    try { a.send(name, d); return true; } catch (e) { return false; }
  }

  function once(name, data) {
    if (sentOnce[name]) return false;
    sentOnce[name] = true;
    return event(name, data);
  }

  /* ---------------- first_input ---------------- */

  function onFirstInput(kind) {
    if (firstInputDone || readyAt < 0) return;
    firstInputDone = true;
    var t = now();
    event("first_input", {
      input: kind,
      seconds: r1(t / 1000),
      seconds_since_ready: r1((t - readyAt) / 1000)
    });
  }

  /* ---------------- performance_sample ---------------- */

  var win = null, lastTs = 0, lastInput = -1e9, looping = false;
  var counters = { errors: 0, rejections: 0, lt: 0, ltTotal: 0, ltMax: 0 };
  var longTasks = false;

  function newWindow() {
    win = { start: now(), active: 0, times: [] };
    counters.errors = 0; counters.rejections = 0;
    counters.lt = 0; counters.ltTotal = 0; counters.ltMax = 0;
  }
  function pct(sorted, p) {
    if (!sorted.length) return 0;
    var i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
    return sorted[i];
  }
  function flush() {
    var ts = win.times;
    if (ts.length < MIN_FRAMES) { newWindow(); return; }
    var s = ts.slice().sort(function (a, b) { return a - b; });
    var over = function (ms) { var n = 0; for (var i = 0; i < ts.length; i++) if (ts[i] > ms) n++; return n; };
    var data = {
      target_fps: opts.targetFps,
      window_ms: Math.round(now() - win.start),
      active_ms: Math.round(win.active),
      frame_count: ts.length,
      fps_avg: r1(ts.length * 1000 / Math.max(1, win.active)),
      fps_p10: r1(1000 / Math.max(0.1, pct(s, 0.9))),
      frame_time_p50_ms: r1(pct(s, 0.5)),
      frame_time_p95_ms: r1(pct(s, 0.95)),
      frame_time_p99_ms: r1(pct(s, 0.99)),
      frame_time_max_ms: r1(s[s.length - 1] || 0),
      frames_over_50ms: over(50),
      frames_over_100ms: over(100),
      frames_over_250ms: over(250),
      frames_over_500ms: over(500),
      frames_over_1000ms: over(1000),
      js_error_count: counters.errors,
      unhandled_rejection_count: counters.rejections
    };
    if (longTasks) {
      data.long_task_count = counters.lt;
      data.long_task_total_ms = Math.round(counters.ltTotal);
      data.long_task_max_ms = Math.round(counters.ltMax);
    }
    if (opts.appVersion) data.game_version = opts.appVersion;
    event("performance_sample", data);
    newWindow();
  }

  function frame(ts) {
    if (document.hidden || now() - lastInput > ACTIVE_AFTER_INPUT) { looping = false; lastTs = 0; return; }
    if (lastTs) {
      var dt = ts - lastTs;
      if (dt > 0 && dt < GAP_MS) { win.times.push(dt); win.active += dt; }
    }
    lastTs = ts;
    requestAnimationFrame(frame);
  }
  function activity() {
    lastInput = now();
    if (!looping && !document.hidden && window.requestAnimationFrame) { looping = true; lastTs = 0; requestAnimationFrame(frame); }
  }

  function bindPerf() {
    newWindow();
    ["pointerdown", "touchmove", "wheel", "keydown", "scroll"].forEach(function (n) {
      window.addEventListener(n, activity, { capture: true, passive: true });
    });
    document.addEventListener("visibilitychange", function () {
      lastTs = 0;
      if (document.hidden) flush();      // скрытое время в образец не попадает
      else newWindow();
    });
    setInterval(function () { if (!document.hidden && now() - win.start >= WINDOW_MS) flush(); }, 2000);
    window.addEventListener("error", function () { counters.errors++; });
    window.addEventListener("unhandledrejection", function () { counters.rejections++; });
    try {
      if (window.PerformanceObserver && (PerformanceObserver.supportedEntryTypes || []).indexOf("longtask") >= 0) {
        new PerformanceObserver(function (list) {
          list.getEntries().forEach(function (e) {
            counters.lt++; counters.ltTotal += e.duration; counters.ltMax = Math.max(counters.ltMax, e.duration);
          });
        }).observe({ entryTypes: ["longtask"] });
        longTasks = true;
      }
    } catch (e) { longTasks = false; }
  }

  window.Analytics = {
    init: function (b, o) {
      bridge = b || null;
      if (o) {
        if (o.appVersion) opts.appVersion = String(o.appVersion);
        if (o.targetFps) opts.targetFps = o.targetFps;
      }
      window.addEventListener("pointerdown", function (e) {
        onFirstInput(e.pointerType === "touch" || e.pointerType === "pen" ? "touch" : "mouse");
      }, true);
      window.addEventListener("keydown", function () { onFirstInput("keyboard"); }, true);
      bindPerf();
      return !!transport();
    },
    ready: function () { if (readyAt < 0) readyAt = now(); },
    event: event,
    once: once,
    _log: log,
    _flush: function () { flush(); }
  };
})();
