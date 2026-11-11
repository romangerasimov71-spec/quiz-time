// Adapter for kits/ads-test (the ads test kit) — how to drive Ornament Sort.
//   node kits/ads-test/run.js --url http://127.0.0.1:8765/index.html --adapter tests/ads-adapter.js
const path = require('path');
const R = require(path.join(__dirname, '..', 'js', 'rules.js'));
const dbg = (page) => page.evaluate(() => OSGame.debug());
async function tapBox(page, i, wait = 50) {
  const r = (await dbg(page)).rects[i];
  await page.mouse.click(r.x + r.w / 2, r.y + r.h * 0.6);
  await page.waitForTimeout(wait);
}

async function solveLevel(page) {
  const d = await dbg(page);
  const sol = R.solveShortest(d.boxes, d.cap, 300000) || R.solve(d.boxes, d.cap);
  for (const [a, b] of sol) { await tapBox(page, a, 40); await tapBox(page, b, 40); }
  await page.waitForSelector('#win-modal:not(.hidden)', { timeout: 10000 });
}

module.exports = {
  name: 'Ornament Sort',
  viewport: { width: 390, height: 844 },
  rewardTimeoutMs: 12000,            // the game gives up waiting for a silent ad after 12 s

  // rewarded cases: level 13 ("+1 box" is there); interstitial cases: level 2, solved, then "Next"
  async prepare(page, { kind }) {
    await page.waitForFunction(() => window.OSGame && OSGame.debug().mode === 'title');
    const lv = kind === 'rewarded' ? 13 : 2;
    await page.evaluate((l) => bridge.storage.set(['os_unlocked', 'os_level'], [String(l), String(l)]), lv);
    await page.reload();
    await page.waitForFunction(() => window.__adsKit && window.__adsKit.installed && window.OSGame && OSGame.debug().mode === 'title');
    await page.click('#btn-play', { force: true });       // also the first tap that unlocks the sound
    await page.waitForTimeout(500);
  },

  async clickRewarded(page) { await page.click('#btn-extra'); },

  // the reward is one extra empty box: boxes on the board now minus the boxes of the level itself
  // (works on any level, so "an interstitial gives no reward" is really checked on the next level too)
  async rewardCount(page) {
    return page.evaluate(() => { const d = OSGame.debug(); return d.boxes.length - window.OS_LEVELS[d.level - 1].b.length; });
  },

  async triggerInterstitial(page) {
    await solveLevel(page);
    await page.click('#btn-next');                         // the natural pause between levels
  },

  // late-* cases: the player leaves the attempt while the ad is late
  async restartLevel(page) { await page.click('#btn-restart'); await page.waitForTimeout(200); },
  async winLevel(page) { await solveLevel(page); },
  async switchLevel(page) {
    const d = await dbg(page);
    await page.click('#btn-levels');
    await page.click(`#levels-grid [data-level="${d.level - 2}"]`);   // the level before this one
    await page.waitForTimeout(200);
  },

  async isPaused(page) { return (await dbg(page)).paused; },

  // the board reacts: pick a box with ornaments, then put it back
  async boardWorks(page) {
    const d = await dbg(page);
    const i = d.boxes.findIndex((b) => b.length);
    await tapBox(page, i, 80);
    const picked = (await dbg(page)).selected === i;
    await tapBox(page, i, 80);
    return picked && (await dbg(page)).selected === -1;
  },

  // Restart, Levels, Settings are on, the level window really opens, no "waiting for the ad" state
  async buttonsWork(page) {
    const on = await page.evaluate(() => !document.body.classList.contains('ad-wait') &&
      ['btn-restart', 'btn-levels', 'btn-settings'].every((id) => !document.getElementById(id).disabled));
    if (!on) return false;
    await page.click('#btn-levels');
    await page.waitForTimeout(150);
    const opened = await page.isVisible('#levels-modal');
    await page.click('#btn-close-levels');
    await page.waitForTimeout(150);
    return opened;
  }
};
