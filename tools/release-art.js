/* Картинки для ВК и ОК, нарисованные кодом (SVG -> Chromium). Higgsfield не используется.
   Запуск: NODE_PATH=/opt/node-tools/node_modules node tools/release-art.js
   Кладёт в release/vk/: icons/icon-576.png (и 278, 150, 75), favicon-32.png, snippet-1120x630.png. */
"use strict";
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const OUT = path.resolve(__dirname, "..", "release", "vk");
fs.mkdirSync(path.join(OUT, "icons"), { recursive: true });

const SANS = "'DejaVu Sans', Arial, sans-serif";
const DEFS = `<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e5531a"/><stop offset="1" stop-color="#8a1f40"/></linearGradient>
  <radialGradient id="sun"><stop offset="0" stop-color="#ffe9b0" stop-opacity=".55"/><stop offset="1" stop-color="#ffe9b0" stop-opacity="0"/></radialGradient>
  <linearGradient id="gold" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffe08a"/><stop offset="1" stop-color="#f5a623"/></linearGradient></defs>`;

/* Большой знак вопроса в круге (без текста-слов; сам «?» — рисунок) */
const QMARK = (cx, cy, r) => `
  <circle cx="${cx}" cy="${cy}" r="${r * 1.7}" fill="url(#sun)"/>
  <circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#gold)"/>
  <circle cx="${cx}" cy="${cy}" r="${r * 0.9}" fill="none" stroke="#fff6d8" stroke-width="${r * 0.05}" opacity=".7"/>
  <text x="${cx}" y="${cy + r * 0.52}" text-anchor="middle" font-family="${SANS}" font-weight="700" font-size="${r * 1.45}" fill="#7a1d12">?</text>`;
function iconSvg(n) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${n}" height="${n}" viewBox="0 0 576 576">${DEFS}
  <rect width="576" height="576" fill="url(#bg)"/>
  <path d="M0 0H576V200Q290 290 0 170z" fill="#fff" opacity=".07"/>
  ${QMARK(288, 275, 175)}
  </svg>`;
}
function faviconSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">${DEFS}
  <rect width="32" height="32" rx="7" fill="#c8431a"/>
  <circle cx="16" cy="16" r="12.5" fill="url(#gold)"/>
  <text x="16" y="23.2" text-anchor="middle" font-family="${SANS}" font-weight="700" font-size="20" fill="#7a1d12">?</text></svg>`;
}
function snippetSvg() {
  const W = 1120, H = 630;
  const card = (x, y, c, e, t) => `<g transform="translate(${x} ${y})"><rect width="290" height="84" rx="18" fill="#fff" opacity=".96"/>
    <rect width="14" height="84" rx="7" fill="${c}"/><text x="34" y="56" font-size="38">${e}</text>
    <text x="88" y="52" font-family="${SANS}" font-weight="700" font-size="22" fill="#2b1a14">${t}</text></g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${DEFS}
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <path d="M0 0H1120V150Q560 260 0 120z" fill="#fff" opacity=".06"/>
  <text x="70" y="235" font-family="${SANS}" font-weight="700" font-size="96" fill="#fff6d8">Викторины</text>
  <text x="76" y="310" font-family="${SANS}" font-size="40" fill="#ffe9c9">Узнайте, сколько вы помните</text>
  <text x="76" y="372" font-family="${SANS}" font-size="30" fill="#ffd9b0">11 тестов  ·  больше 500 вопросов</text>
  <rect x="76" y="420" width="380" height="76" rx="38" fill="url(#gold)"/>
  <text x="266" y="470" text-anchor="middle" font-family="${SANS}" font-weight="700" font-size="32" fill="#4a1408">Пройти тест</text>
  <g transform="translate(780 90)">
    ${card(0, 0, "#b83a12", "🚀", "СССР")}
    ${card(30, 110, "#6a1b9a", "🎬", "Кино")}
    ${card(0, 220, "#a14a00", "🐻", "Мультфильмы")}
    ${card(30, 330, "#c62828", "🎄", "Новый год")}
    ${card(0, 440, "#ad1457", "🎭", "Актёры")}
  </g>
  </svg>`;
}

(async () => {
  const b = await chromium.launch();
  async function render(svg, w, h, file) {
    const p = await b.newPage({ viewport: { width: w, height: h } });
    await p.setContent(`<body style="margin:0;background:#000">${svg}</body>`);
    await p.screenshot({ path: path.join(OUT, file), clip: { x: 0, y: 0, width: w, height: h } });
    await p.close();
  }
  for (const n of [576, 278, 150, 75]) await render(iconSvg(n), n, n, `icons/icon-${n}.png`);
  await render(faviconSvg(), 32, 32, "favicon-32.png");
  await render(snippetSvg(), 1120, 630, "snippet-1120x630.png");
  await b.close();
  console.log("готово");
})();
