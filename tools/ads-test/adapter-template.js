// Adapter template for the ads test kit. Copy it next to your game's tests (e.g. tests/ads-adapter.js)
// and fill in the functions for YOUR game. The kit (fakeads.js + run.js) stays the same for every game.
// A working example: tests/ads-adapter.js of the game "ornament-sort".
//
// Until a function is filled in, it throws "адаптер не заполнен": the kit then prints FAIL, never PASS.
const notFilled = (name) => { throw new Error(`адаптер не заполнен: ${name}()`); };

module.exports = {
  name: 'My Game',
  viewport: { width: 390, height: 844 },   // phone portrait
  // contextOptions: { hasTouch: true, isMobile: true, locale: 'ru-RU' },

  // How long the game itself waits for a rewarded ad that never answers before it gives up (ms).
  // The kit waits this long (+0.8 s) in the "silent" and "late" cases.
  rewardTimeoutMs: 12000,
  // How long to wait after an interstitial that never answers (ms).
  interstitialSilentWaitMs: 3000,
  // An ad that opens after rewardTimeoutMs and is watched to the end gives the reward (true by default)
  // when the player is still on the same attempt. After a restart / a win / another level: never.
  lateRewardGranted: true,
  // While the game waits for the rewarded ad, the board and the buttons must not react (checked with
  // boardWorks / buttonsWork, they must answer false then). Set false only if your game is meant to keep them on.
  // waitLocks: false,

  // Bring the game to the place where the reward button / the interstitial is reachable.
  // kind = 'rewarded' | 'interstitial'. The page is already open, fakeads.js is in place.
  async prepare(page, { kind, caseName }) {
    // await page.click('#play');
  },

  // Press the button "watch an ad for a reward".
  async clickRewarded(page) {
    // await page.click('#btn-reward');
  },

  // How many rewards the player has right now on the current level / attempt (coins, lives, extra
  // boxes...). Any number that grows by 1 for one reward is fine.
  async rewardCount(page) {
    // return page.evaluate(() => window.game.coins / 50);
    notFilled('rewardCount');
  },

  // Do what shows an interstitial (finish a level and press "Next"...). Leave it out to skip those cases.
  async triggerInterstitial(page) {
    // await page.click('#btn-next');
  },

  // The late-* cases: the player leaves the attempt while the ad is late. Leave a function out to skip
  // its case (the kit prints SKIP).
  // async restartLevel(page) { await page.click('#btn-restart'); },      // "Restart"
  // async winLevel(page) { /* finish the current level */ },              // the level is won
  // async switchLevel(page) { /* open the level list, pick another */ }, // another level

  // The board reacts to the player: make a harmless action and check the game answered. true / false.
  // While the game waits for an ad it must answer false (nothing reacts).
  async boardWorks(page) {
    notFilled('boardWorks');
  },

  // The buttons are on (not greyed out, a menu opens). true / false. While the game waits for an ad: false.
  // Delete the function only if the game has no such buttons (the kit then prints SKIP).
  async buttonsWork(page) {
    notFilled('buttonsWork');
  },

  // Optional: is the game paused right now? true / false. Without it the kit prints SKIP
  // ("пауза не проверялась").
  // async isPaused(page) { return page.evaluate(() => window.game.paused); },

  // Optional: is the sound off right now? By default the kit looks at AudioContext / <audio> / Howler
  // itself; a game that mutes only with a volume (gain) node needs its own check here.
  // async soundOff(page) { return page.evaluate(() => window.game.masterVolume === 0); },
};
