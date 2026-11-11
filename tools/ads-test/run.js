#!/usr/bin/env node
/*
 * Ads test kit runner (Playwright + Chromium).
 *
 *   node run.js --url http://127.0.0.1:8765/index.html --adapter ./my-game-adapter.js [--only rewarded-ok,interstitial-fail] [--show]
 *   --show: print the ad states of every case; --standalone: do not use Bridge internals (tests the kit itself)
 *
 * Cases (12):
 *   rewarded-ok, rewarded-cancel, rewarded-fail, rewarded-silent, rewarded-late, rewarded-double,
 *   rewarded-late-restart, rewarded-late-win, rewarded-late-switch,
 *   interstitial-ok, interstitial-fail, interstitial-silent.
 * Each case runs in a fresh page with fakeads.js loaded before the game. The kit checks:
 *   - the reward is given only for an ad watched to the end, never twice (also when "rewarded" comes twice
 *     inside one show), and never for an attempt the player already left (restart, win, another level);
 *   - while the game waits for the ad, the board and the buttons do not react;
 *   - the game does not hang: after the case the board and the buttons work again, the game is not paused;
 *   - while the ad is open the game is paused and nothing can be heard; after it the sound is back;
 *   - no errors in the console.
 * Lines: PASS (good), FAIL (bad), SKIP (not checked, with the reason). Exit code 0 when nothing failed.
 */
'use strict';
const fs = require('fs');
const path = require('path');

function args() {
  const a = process.argv.slice(2), o = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--show') o.show = true;
    else if (a[i] === '--standalone') o.standalone = true;
    else if (a[i].startsWith('--')) o[a[i].slice(2)] = a[++i];
  }
  return o;
}
const opt = args();
const URL = opt.url || process.env.GAME_URL;
if (!URL || !opt.adapter) {
  console.log('Запуск: node run.js --url <адрес игры> --adapter <адаптер.js> [--only случай1,случай2] [--show]');
  process.exit(2);
}
const A = require(path.resolve(opt.adapter));
let chromium;
try { ({ chromium } = require('playwright')); } catch (e) {
  try { ({ chromium } = require(require.resolve('playwright', { paths: [process.cwd(), path.dirname(path.resolve(opt.adapter))] }))); } catch (e2) {
    console.log('Нет Playwright. Укажи, где он лежит: NODE_PATH=/путь/к/node_modules node kits/ads-test/run.js ...');
    console.log('или поставь его: npm i -D playwright && npx playwright install chromium');
    process.exit(2);
  }
}
const FAKE = fs.readFileSync(path.join(__dirname, 'fakeads.js'), 'utf8');
const CASES = ['rewarded-ok', 'rewarded-cancel', 'rewarded-fail', 'rewarded-silent', 'rewarded-late', 'rewarded-double',
  'rewarded-late-restart', 'rewarded-late-win', 'rewarded-late-switch',
  'interstitial-ok', 'interstitial-fail', 'interstitial-silent'];
const only = opt.only ? opt.only.split(',') : CASES;
const REWARD_TIMEOUT = A.rewardTimeoutMs || 15000;       // the game's own wait for an ad that never answers
const INTER_SILENT_WAIT = A.interstitialSilentWaitMs || 3000;
const SETTLE = 400;
// the late-* cases: what the player does after the game stopped waiting and before the late ad shows
const LATE_ACTIONS = {
  restart: { fn: 'restartLevel', what: 'после «Заново»' },
  win: { fn: 'winLevel', what: 'после победы на уровне' },
  switch: { fn: 'switchLevel', what: 'после смены уровня' }
};

const results = [];
const skips = [];
function check(caseName, what, ok, extra) {
  results.push({ caseName, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${caseName}] ${what}${extra ? '  (' + extra + ')' : ''}`);
}
function skip(caseName, what) {
  skips.push({ caseName, what });
  console.log(`SKIP  [${caseName}] ${what}`);
}
const wait = (page, ms) => page.waitForTimeout(ms);
const kitLog = (page) => page.evaluate(() => window.__adsKit.log.slice());
async function waitLog(page, entry, ms = 10000) {
  await page.waitForFunction((e) => window.__adsKit && window.__adsKit.log.includes(e), entry, { timeout: ms });
}

// adapter helpers
const soundOff = (page) => A.soundOff ? A.soundOff(page) : page.evaluate(() => window.__adsKit.soundOff());
const isPaused = (page) => A.isPaused ? A.isPaused(page) : Promise.resolve(null);
async function tryCall(name, page) {
  try { return { v: await A[name](page) }; } catch (e) { return { err: e.message.split('\n')[0] }; }
}
async function gameWorks(page, caseName, when) {
  const board = await tryCall('boardWorks', page);
  const buttons = A.buttonsWork ? await tryCall('buttonsWork', page) : { v: true };
  if (!A.buttonsWork) skip(caseName, `${when}: кнопки не проверялись (в адаптере нет buttonsWork)`);
  const paused = await isPaused(page);
  if (paused === null) skip(caseName, `${when}: пауза не проверялась (в адаптере нет isPaused)`);
  const why = [board.err, buttons.err].filter(Boolean).join(', ');
  check(caseName, `${when}: поле и кнопки работают, игра не на паузе`, board.v === true && buttons.v === true && paused !== true,
    `поле ${board.v}, кнопки ${buttons.v}, пауза ${paused}${why ? ', ' + why : ''}`);
}
// while the game waits for the ad (it did not open yet): the board and the buttons must not react
async function lockedWhileWaiting(page, caseName) {
  if (A.waitLocks === false) { skip(caseName, 'блокировка на время ожидания не проверялась (в адаптере waitLocks: false)'); return; }
  await wait(page, 600);
  const board = await tryCall('boardWorks', page);
  const buttons = A.buttonsWork ? await tryCall('buttonsWork', page) : null;
  if (!buttons) skip(caseName, 'пока ждём рекламу: кнопки не проверялись (в адаптере нет buttonsWork)');
  const why = [board.err, buttons && buttons.err].filter(Boolean).join(', ');
  check(caseName, 'пока ждём рекламу, поле и кнопки заблокированы', board.v === false && (!buttons || buttons.v === false),
    `поле ответило: ${board.v}${buttons ? ', кнопки ответили: ' + buttons.v : ''}${why ? ', ' + why : ''}`);
}
// while the ad is open: paused + silent
async function checkDuringAd(page, caseName, kind) {
  await waitLog(page, kind + ':opened');
  await wait(page, 300);
  const off = await soundOff(page);
  const paused = await isPaused(page);
  check(caseName, 'пока открыта реклама, звука нет', off === true, JSON.stringify(await page.evaluate(() => window.__adsKit.soundInfo())));
  if (paused !== null) check(caseName, 'пока открыта реклама, игра на паузе', paused === true);
  else skip(caseName, 'пока открыта реклама: пауза не проверялась (в адаптере нет isPaused)');
}
// after the ad: the sound is back (only when it was on before the ad)
async function soundBack(page, caseName, wasOn, when) {
  if (!wasOn) { skip(caseName, `${when}: возврат звука не проверялся (звук был выключен ещё до рекламы)`); return; }
  const off = await soundOff(page);
  check(caseName, `${when}: звук вернулся`, off === false, JSON.stringify(await page.evaluate(() => window.__adsKit.soundInfo())));
}

async function openCase(browser, caseName) {
  const ctx = await browser.newContext(Object.assign({ viewport: A.viewport || { width: 390, height: 844 }, deviceScaleFactor: 1 }, A.contextOptions || {}));
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  if (opt.standalone) await page.addInitScript(() => { window.__adsKitStandalone = true; });
  await page.addInitScript(FAKE);
  await page.goto(URL);
  await page.waitForFunction(() => window.__adsKit && window.__adsKit.installed, null, { timeout: 20000 })
    .catch(() => { throw new Error('набор не нашёл window.bridge / bridge.initialize() — игра точно на Playgama Bridge?'); });
  await A.prepare(page, { caseName, kind: caseName.split('-')[0] });
  return { ctx, page, errs };
}
const setMode = (page, kind, mode) => page.evaluate(([k, m]) => { window.__adsKit.mode[k] = m; }, [kind, mode]);

async function rewardedCase(browser, mode) {
  const caseName = 'rewarded-' + mode;
  const { ctx, page, errs } = await openCase(browser, caseName);
  await setMode(page, 'rewarded', mode);
  // the sound before anything happens (a stray "rewarded" below may already mute it on the platform side)
  const soundWasOn = (await soundOff(page)) === false;
  // a stray "rewarded" without any request must give nothing
  const r0 = await A.rewardCount(page);
  if (mode === 'ok') {
    await page.evaluate(() => window.__adsKit.sendRewarded('rewarded'));
    await wait(page, 200);
    check(caseName, 'событие «rewarded» без запроса игрока ничего не даёт', (await A.rewardCount(page)) === r0);
  }
  const before = await A.rewardCount(page);
  await A.clickRewarded(page);
  await page.waitForFunction(() => window.__adsKit.calls.rewarded > 0, null, { timeout: 3000 }).catch(() => {});
  const calls = await page.evaluate(() => window.__adsKit.calls.rewarded);
  check(caseName, 'кнопка награды просит у площадки рекламу за награду', calls === 1, `вызовов: ${calls}`);
  if (mode === 'ok' || mode === 'cancel' || mode === 'double') await checkDuringAd(page, caseName, 'rewarded');
  if (mode === 'ok' || mode === 'cancel' || mode === 'fail' || mode === 'double') {
    await waitLog(page, mode === 'fail' ? 'rewarded:failed' : 'rewarded:closed');
    await wait(page, SETTLE);
  } else {
    const t0 = Date.now();
    await lockedWhileWaiting(page, caseName);
    // silent / late: the game must stop waiting by itself
    await wait(page, Math.max(0, REWARD_TIMEOUT + 800 - (Date.now() - t0)));
  }
  const expect = mode === 'ok' || mode === 'double' ? 1 : 0;
  let got = (await A.rewardCount(page)) - before;
  check(caseName, mode === 'ok' ? 'досмотрена до конца → ровно одна награда'
    : mode === 'double' ? '«rewarded» дважды за один показ → ровно одна награда' : 'не досмотрена → награды нет', got === expect, `награда +${got}`);
  const after = mode === 'silent' || mode === 'late' ? `после ожидания игры (${REWARD_TIMEOUT / 1000} с)` : 'после рекламы';
  await soundBack(page, caseName, soundWasOn, after);
  await gameWorks(page, caseName, after);
  if (mode === 'late') {
    // the ad opens after the game stopped waiting and is watched to the end
    await page.evaluate(() => window.__adsKit.playPending('ok'));
    await checkDuringAd(page, caseName, 'rewarded');
    await waitLog(page, 'rewarded:closed');
    await wait(page, SETTLE);
    got = (await A.rewardCount(page)) - before;
    const want = A.lateRewardGranted === false ? 0 : 1;
    check(caseName, want ? 'опоздавшая реклама досмотрена → ровно одна награда' : 'опоздавшая реклама → без награды (так решила игра)', got === want, `награда +${got}`);
    await soundBack(page, caseName, soundWasOn, 'после опоздавшей рекламы');
    await gameWorks(page, caseName, 'после опоздавшей рекламы');
  }
  if (mode === 'ok' || mode === 'late' || mode === 'double') {
    // some platforms repeat the event: a second "rewarded" must not give a second reward
    const n = await A.rewardCount(page);
    await page.evaluate(() => { const k = window.__adsKit; k.sendRewarded('opened'); k.sendRewarded('rewarded'); k.sendRewarded('closed'); });
    await wait(page, SETTLE);
    check(caseName, 'повторное «rewarded» не даёт вторую награду', (await A.rewardCount(page)) === n);
    await gameWorks(page, caseName, 'после повторного события');
  }
  check(caseName, 'нет ошибок в консоли', errs.length === 0, errs.slice(0, 3).join(' | '));
  if (opt.show) console.log('   состояния:', (await kitLog(page)).join(' '));
  await ctx.close();
}

// the ad is late; meanwhile the player left that attempt (restart / win / another level): no reward then
async function lateAfterCase(browser, action) {
  const caseName = 'rewarded-late-' + action;
  const L = LATE_ACTIONS[action];
  const { ctx, page, errs } = await openCase(browser, caseName);
  await setMode(page, 'rewarded', 'late');
  const soundWasOn = (await soundOff(page)) === false;
  await A.clickRewarded(page);
  await page.waitForFunction(() => window.__adsKit.calls.rewarded > 0, null, { timeout: 3000 }).catch(() => {});
  await wait(page, REWARD_TIMEOUT + 800);              // the game stops waiting by itself
  await A[L.fn](page);
  await wait(page, SETTLE);
  const before = await A.rewardCount(page);
  await page.evaluate(() => window.__adsKit.playPending('ok'));
  await waitLog(page, 'rewarded:closed');
  await wait(page, SETTLE);
  const got = (await A.rewardCount(page)) - before;
  check(caseName, `опоздавшая награда ${L.what} → награды нет`, got === 0, `награда +${got}`);
  await soundBack(page, caseName, soundWasOn, 'после опоздавшей рекламы');
  if (action === 'win') skip(caseName, 'поле после победы не проверялось (уровень пройден, на экране итог)');
  else await gameWorks(page, caseName, 'после опоздавшей рекламы');
  check(caseName, 'нет ошибок в консоли', errs.length === 0, errs.slice(0, 3).join(' | '));
  if (opt.show) console.log('   состояния:', (await kitLog(page)).join(' '));
  await ctx.close();
}

async function interstitialCase(browser, mode) {
  const caseName = 'interstitial-' + mode;
  const { ctx, page, errs } = await openCase(browser, caseName);
  await setMode(page, 'interstitial', mode);
  const soundWasOn = (await soundOff(page)) === false;
  const before = await A.rewardCount(page);
  await A.triggerInterstitial(page);
  await page.waitForFunction(() => window.__adsKit.calls.interstitial > 0, null, { timeout: 3000 }).catch(() => {});
  const calls = await page.evaluate(() => window.__adsKit.calls.interstitial);
  check(caseName, 'игра просит у площадки межуровневую рекламу', calls >= 1, `${calls} call(s)`);
  if (mode === 'ok') { await checkDuringAd(page, caseName, 'interstitial'); await waitLog(page, 'interstitial:closed'); }
  if (mode === 'fail') await waitLog(page, 'interstitial:failed');
  await wait(page, mode === 'silent' ? INTER_SILENT_WAIT : SETTLE);
  check(caseName, 'межуровневая реклама награду не даёт', (await A.rewardCount(page)) === before);
  const after = mode === 'silent' ? `через ${INTER_SILENT_WAIT / 1000} с после рекламы, которая не ответила` : 'после рекламы';
  await soundBack(page, caseName, soundWasOn, after);
  await gameWorks(page, caseName, after);
  check(caseName, 'нет ошибок в консоли', errs.length === 0, errs.slice(0, 3).join(' | '));
  if (opt.show) console.log('   log:', (await kitLog(page)).join(' '));
  await ctx.close();
}

(async () => {
  const browser = await chromium.launch();
  console.log(`Набор проверки рекламы: ${A.name || opt.adapter}, ${URL}`);
  const caseResults = [];
  for (const c of CASES) {
    if (!only.includes(c)) continue;
    const n0 = results.length;
    const parts = c.split('-');
    const kind = parts[0], mode = parts[1], action = parts[2];
    try {
      if (kind === 'interstitial' && !A.triggerInterstitial) { skip(c, 'случай не проверялся: в адаптере нет triggerInterstitial()'); continue; }
      if (action && !A[LATE_ACTIONS[action].fn]) { skip(c, `случай не проверялся: в адаптере нет ${LATE_ACTIONS[action].fn}()`); continue; }
      if (kind === 'rewarded' && action) await lateAfterCase(browser, action);
      else if (kind === 'rewarded') await rewardedCase(browser, mode);
      else await interstitialCase(browser, mode);
    } catch (e) {
      check(c, 'случай прошёл до конца', false, e.message.split('\n')[0]);
    }
    caseResults.push({ c, ok: results.slice(n0).every((r) => r.ok) });
  }
  await browser.close();
  const passed = caseResults.filter((r) => r.ok).length;
  console.log(`\nСлучаев пройдено: ${passed} из ${caseResults.length}` + (passed < caseResults.length ? '  не прошли: ' + caseResults.filter((r) => !r.ok).map((r) => r.c).join(', ') : ''));
  if (skips.length) console.log(`Не проверено (SKIP): ${skips.length} — см. строки SKIP выше.`);
  process.exit(passed === caseResults.length ? 0 : 1);
})();
