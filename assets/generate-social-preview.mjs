// GitHub social preview generator for Squish (1280x640 PNG)
// Brutalist industrial design system: zero radius, mono type, #3B82F6 sparingly.
// Usage: bun run scripts/generate-social-preview.mjs   (or: node)

import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
// resvg lives in the sibling landing package's node_modules
const requireFromLanding = createRequire(
  join(repoRoot, "..", "squish-landing", "package.json"),
);
const { Resvg } = requireFromLanding("@resvg/resvg-js");

const W = 1280;
const H = 640;

// ---- palette -------------------------------------------------------------
const BG = "#080808";
const INK = "#F4F7FB"; // off-white
const INK_DIM = "#9FACBD";
const INK_FAINT = "rgba(244,247,251,0.55)";
const ACCENT = "#3B82F6";
const CHIP_BG = "#0C0C0C";

const FONT = "JetBrains Mono";

// monospace advance at a given px size (JBM advance = 0.6em)
const adv = (size, ls = 0) => size * 0.6 + ls;

// five-point star polygon (drawn manually; U+2605 not guaranteed in font)
function starPoints(rOut, rIn) {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? rOut : rIn;
    const a = (-90 + i * 36) * (Math.PI / 180);
    pts.push(`${(Math.cos(a) * r).toFixed(2)},${(Math.sin(a) * r).toFixed(2)}`);
  }
  return pts.join(" ");
}

// ---- stat chips ------------------------------------------------------------
const chips = [
  { label: "ECE ", value: "0.055" },
  { label: "CONFIDENT-WRONG ", value: "21 -> 4" },
  { label: "", value: "100% LOCAL" },
];
const CHIP_FS = 20;
const CHIP_LS = 2;
const CHIP_H = 58;
const CHIP_PAD_X = 22;
const CHIP_GAP = 20;

let chipX = 68;
const chipRects = [];
for (const c of chips) {
  const chars = (c.label + c.value).length;
  const w = Math.round(chars * adv(CHIP_FS, CHIP_LS)) + CHIP_PAD_X * 2;
  chipRects.push({ ...c, x: chipX, w });
  chipX += w + CHIP_GAP;
}

const CHIP_Y = 414;
const CHIP_TEXT_Y = CHIP_Y + 38;

const chipsSvg = chipRects
  .map((c, i) => {
    const tx = c.x + CHIP_PAD_X;
    const body =
      c.label === ""
        ? `<text x="${tx}" y="${CHIP_TEXT_Y}" font-family="${FONT}" font-size="${CHIP_FS}" font-weight="500" letter-spacing="${CHIP_LS}" fill="${INK}">${c.value}</text>`
        : `<text x="${tx}" y="${CHIP_TEXT_Y}" font-family="${FONT}" font-size="${CHIP_FS}" font-weight="500" letter-spacing="${CHIP_LS}">
      <tspan fill="#7E8AA0">${c.label}</tspan><tspan x="${tx + Math.round(c.label.length * adv(CHIP_FS, CHIP_LS))}" fill="${INK}">${c.value}</tspan>
    </text>`;
    return `
    <rect x="${c.x}" y="${CHIP_Y}" width="${c.w}" height="${CHIP_H}" fill="${CHIP_BG}" stroke="${INK}" stroke-width="2"/>
    ${body}
    <!-- chip index mark -->
    <rect x="${c.x}" y="${CHIP_Y}" width="4" height="${CHIP_H}" fill="rgba(59,130,246,${i === 0 ? "0.9" : "0"})"/>`;
  })
  .join("\n");

// ---- headline geometry ----------------------------------------------------
const HEAD_FS = 96;
const HEAD_ADV = adv(HEAD_FS);
const LINE1 = "MEMORY YOUR AGENT";
const LINE2 = "CAN TRUST";
const HX = 68;
const Y1 = 196;
const Y2 = 296;
const CURSOR_X = HX + Math.round(LINE2.length * HEAD_ADV) + 22;
const CURSOR_W = 40;
const CURSOR_H = 64;
const CURSOR_Y = Y2 - 66;

// ---- svg ------------------------------------------------------------------
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <pattern id="grid-minor" width="32" height="32" patternUnits="userSpaceOnUse">
      <path d="M 32 0 L 0 0 0 32" fill="none" stroke="rgba(244,247,251,0.028)" stroke-width="1"/>
    </pattern>
    <pattern id="grid-major" width="128" height="128" patternUnits="userSpaceOnUse">
      <path d="M 128 0 L 0 0 0 128" fill="none" stroke="rgba(244,247,251,0.055)" stroke-width="1"/>
    </pattern>
    <pattern id="scanlines" width="4" height="4" patternUnits="userSpaceOnUse">
      <rect x="0" y="0" width="4" height="1" fill="rgba(255,255,255,0.018)"/>
    </pattern>
  </defs>

  <!-- background layers -->
  <rect width="${W}" height="${H}" fill="${BG}"/>
  <rect width="${W}" height="${H}" fill="url(#grid-major)"/>
  <rect width="${W}" height="${H}" fill="url(#grid-minor)"/>
  <rect width="${W}" height="${H}" fill="url(#scanlines)"/>

  <!-- corner registration crosshairs -->
  <g stroke="rgba(244,247,251,0.28)" stroke-width="1.5">
    <path d="M 30 44 H 46 M 38 36 V 52"/>
    <path d="M 1234 44 H 1250 M 1242 36 V 52"/>
    <path d="M 30 596 H 46 M 38 588 V 604"/>
    <path d="M 1234 596 H 1250 M 1242 588 V 604"/>
  </g>

  <!-- brand chip: SQUISH -->
  <g>
    <rect x="48" y="40" width="186" height="44" fill="${BG}" stroke="${INK}" stroke-width="2"/>
    <rect x="64" y="55" width="14" height="14" fill="${ACCENT}"/>
    <text x="90" y="71" font-family="${FONT}" font-size="20" font-weight="500" letter-spacing="6" fill="${INK}">SQUISH</text>
  </g>

  <!-- top-right status -->
  <text x="1232" y="70" text-anchor="end" font-family="${FONT}" font-size="16" letter-spacing="4" fill="${INK_FAINT}">// MEMORY RUNTIME</text>

  <!-- headline -->
  <text x="${HX}" y="${Y1}" font-family="${FONT}" font-size="${HEAD_FS}" font-weight="500"
        letter-spacing="-1" fill="${INK}" stroke="${INK}" stroke-width="2" paint-order="stroke">${LINE1}</text>
  <text x="${HX}" y="${Y2}" font-family="${FONT}" font-size="${HEAD_FS}" font-weight="500"
        letter-spacing="-1" fill="${INK}" stroke="${INK}" stroke-width="2" paint-order="stroke">${LINE2}</text>
  <!-- terminal cursor block (accent) -->
  <rect x="${CURSOR_X}" y="${CURSOR_Y}" width="${CURSOR_W}" height="${CURSOR_H}" fill="${ACCENT}"/>

  <!-- subheadline -->
  <text x="${HX}" y="354" font-family="${FONT}" font-size="29" font-weight="400" letter-spacing="0.5" fill="${INK_DIM}">Local-first memory for AI agents</text>

  <!-- divider rule -->
  <line x1="68" y1="392" x2="1212" y2="392" stroke="rgba(244,247,251,0.14)" stroke-width="1"/>

  <!-- stat chips -->
  ${chipsSvg}

  <!-- footer: star + repo url -->
  <polygon transform="translate(78 580)" points="${starPoints(11, 4.6)}" fill="${ACCENT}"/>
  <text x="102" y="587" font-family="${FONT}" font-size="20" font-weight="400" letter-spacing="1" fill="${INK}">github.com/michielhdoteth/squish</text>

  <!-- right-edge vertical label -->
  <text transform="translate(1256 330) rotate(-90)" text-anchor="middle" font-family="${FONT}"
        font-size="13" letter-spacing="7" fill="rgba(244,247,251,0.22)">LOCAL MEMORY RUNTIME // SQUISH</text>
</svg>`;

// ---- render ----------------------------------------------------------------
const resvg = new Resvg(svg, {
  fitTo: { mode: "width", value: W },
  font: {
    loadSystemFonts: true,
    fontFiles: [
      "C:\\Users\\michi\\AppData\\Local\\Microsoft\\Windows\\Fonts\\JetBrainsMono-400.ttf",
      "C:\\Users\\michi\\AppData\\Local\\Microsoft\\Windows\\Fonts\\JetBrainsMono-500.ttf",
    ],
    defaultFontFamily: FONT,
  },
});

const png = resvg.render().asPng();
const outPath = join(here, "social-preview.png");
writeFileSync(outPath, png);

// ---- verify ----------------------------------------------------------------
const buf = png;
const sigOk = buf[0] === 0x89 && buf.toString("ascii", 1, 4) === "PNG";
const w = buf.readUInt32BE(16);
const h = buf.readUInt32BE(20);
console.log(JSON.stringify({
  path: outPath,
  bytes: buf.length,
  pngSignature: sigOk,
  width: w,
  height: h,
  dimensionsOk: w === 1280 && h === 640,
}));
