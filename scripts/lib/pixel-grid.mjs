// Shared pixel-grid pipeline: palette loading, image -> grid conversion (fit/resize/color), and
// grid -> box-shadow CSS generation. Used by scripts/png-to-grid.mjs, scripts/build-sprites.mjs,
// and tools/sprite-editor/server.mjs -- one implementation, not several drifting copies.

import { readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const ART_DIR = join(ROOT, "art");

function hexToRgb(hex) {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex(r, g, b) {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
}

// Palette is loaded from the two files that are the actual source of truth -- no hardcoded
// fourth copy. art/legend.json's key order (excluding "_comment" and ".") must match
// art/palette.hex's line order; both are hand-maintained together, see README.md.
function loadPaletteEntries() {
  const legend = JSON.parse(readFileSync(join(ART_DIR, "legend.json"), "utf8"));
  const hexLines = readFileSync(join(ART_DIR, "palette.hex"), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const chars = Object.keys(legend).filter((k) => k !== "_comment" && k !== ".");
  if (chars.length !== hexLines.length) {
    throw new Error(
      `art/legend.json has ${chars.length} color chars but art/palette.hex has ${hexLines.length} lines -- they must stay in sync.`,
    );
  }
  return chars.map((char, i) => {
    const hex = `#${hexLines[i]}`;
    return { char, hex, rgb: hexToRgb(hex), cssVar: legend[char] };
  });
}

export const PALETTE_ENTRIES = loadPaletteEntries();

const EXACT_GLOBAL_MATCH = new Map(PALETTE_ENTRIES.map((e) => [e.rgb.join(","), e.char]));

// ---- HSL helpers, used only by "conform" mode's hue-family recolor ----

function rgbToHsl(r, g, b) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60;
  else if (max === gn) h = ((bn - rn) / d + 2) * 60;
  else h = ((rn - gn) / d + 4) * 60;
  return [h, s, l];
}

function hslToRgb(h, s, l) {
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const hue2rgb = (p, q, t) => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hn = h / 360;
  return [
    Math.round(hue2rgb(p, q, hn + 1 / 3) * 255),
    Math.round(hue2rgb(p, q, hn) * 255),
    Math.round(hue2rgb(p, q, hn - 1 / 3) * 255),
  ];
}

// "Conform" mode's eligible recolor targets. Excludes UI-only tones by default (bg/bg-raised
// would make sprite pixels blend into the page) -- add any of your own palette's reserved/
// UI-only tokens to this set if you swap in a custom palette.hex/legend.json. Split into
// chromatic (matched by hue) and achromatic (matched by lightness, since hue is meaningless
// noise for near-gray colors).
const CONFORM_EXCLUDE = new Set(["--color-bg", "--color-bg-raised"]);
const CONFORM_ACHROMATIC_VARS = new Set(["--color-ink", "--color-highlight", "--color-taupe"]);
const CONFORM_CHROMATIC_TARGETS = PALETTE_ENTRIES.filter(
  (e) => !CONFORM_EXCLUDE.has(e.cssVar) && !CONFORM_ACHROMATIC_VARS.has(e.cssVar),
).map((e) => ({ ...e, hsl: rgbToHsl(...e.rgb) }));
const CONFORM_ACHROMATIC_TARGETS = PALETTE_ENTRIES.filter((e) =>
  CONFORM_ACHROMATIC_VARS.has(e.cssVar),
).map((e) => ({ ...e, hsl: rgbToHsl(...e.rgb) }));
const GRAYSCALE_SATURATION_THRESHOLD = 0.15;

// Recolors one pixel to the nearest palette family's hue/saturation while keeping the pixel's
// own lightness (clamped so it never goes fully white/black and loses visibility) -- generates
// tones/subtones that read as "our palette" without flattening every pixel to one fixed shade.
function conformPixel(r, g, b) {
  const [h, s, l] = rgbToHsl(r, g, b);
  if (s < GRAYSCALE_SATURATION_THRESHOLD) {
    let best = CONFORM_ACHROMATIC_TARGETS[0];
    let bestDist = Number.POSITIVE_INFINITY;
    for (const t of CONFORM_ACHROMATIC_TARGETS) {
      const dist = Math.abs(l - t.hsl[2]);
      if (dist < bestDist) {
        bestDist = dist;
        best = t;
      }
    }
    return best.rgb;
  }
  let best = CONFORM_CHROMATIC_TARGETS[0];
  let bestDist = Number.POSITIVE_INFINITY;
  for (const t of CONFORM_CHROMATIC_TARGETS) {
    let dist = Math.abs(h - t.hsl[0]);
    if (dist > 180) dist = 360 - dist;
    if (dist < bestDist) {
      bestDist = dist;
      best = t;
    }
  }
  const clampedL = Math.min(0.85, Math.max(0.12, l));
  return hslToRgb(best.hsl[0], best.hsl[1], clampedL);
}

// ---- local per-sprite palette (colors a sprite needs beyond the 20 shared tokens) ----

// Pool of single-char codes for a sprite's local palette, disjoint from every char already used
// in art/legend.json (currently `.bBiHuUsSkmgGfFdpPcCw` -- see that file). Plenty for a typical
// stylized import; imageInputToGrid falls back to frequency-reducing the color count if a source
// ever has more distinct colors than this pool (see reduceToFit below).
const GLOBAL_CHARS = new Set(PALETTE_ENTRIES.map((e) => e.char));
const LOCAL_CHAR_POOL = "aejlnoqrtvxyzADEHIJKLMNOQRTVXYZ0123456789"
  .split("")
  .filter((c) => !GLOBAL_CHARS.has(c));

function makeLocalPaletteAssigner() {
  const charByRgbKey = new Map();
  const localPalette = {};
  let nextPoolIndex = 0;
  return {
    assign(r, g, b) {
      const key = `${r},${g},${b}`;
      const globalChar = EXACT_GLOBAL_MATCH.get(key);
      if (globalChar) return globalChar;
      const existing = charByRgbKey.get(key);
      if (existing) return existing;
      if (nextPoolIndex >= LOCAL_CHAR_POOL.length) return null; // pool exhausted, caller must reduce
      const char = LOCAL_CHAR_POOL[nextPoolIndex++];
      charByRgbKey.set(key, char);
      localPalette[char] = rgbToHex(r, g, b);
      return char;
    },
    localPalette,
    distinctCount: () => charByRgbKey.size,
  };
}

// Full pipeline: fit the whole input into size x size (nearest-neighbor, aspect-ratio preserved,
// transparent letterbox padding -- never crops, never distorts) -> color each pixel per
// `colorMode` -> return a grid + whatever local palette entries it needed. No auto-crop, no
// automatic background-color removal (both were footguns that clipped/mis-detected real content
// on some sources -- see the pipeline comments below); background removal is now an explicit, separate,
// user-triggered action in the sprite editor instead of an automatic import step.
// `input` is anything sharp() accepts: a file path string, or a Buffer (e.g. an upload body).
export async function imageInputToGrid(input, { size = 64, colorMode = "precise" } = {}) {
  const resized = await sharp(input)
    .ensureAlpha()
    .resize(size, size, {
      kernel: sharp.kernel.nearest,
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { data, info } = resized;
  const colorOf =
    colorMode === "conform" ? (r, g, b) => conformPixel(r, g, b) : (r, g, b) => [r, g, b];

  // sharp's raw() output is alpha-premultiplied whenever the pipeline composites onto a
  // background (our `fit: "contain"` letterbox always does) -- `info.premultiplied` confirms it.
  // Left as-is, any partially-transparent pixel (anti-aliased edges, semi-opaque source art) has
  // its RGB scaled down toward black by its own alpha before we ever see it: a vivid red at 40%
  // alpha reads back as near-black, not red. Un-premultiply here so sampled colors are the
  // pixel's actual color, independent of its transparency. Found by tracing a real source image
  // (a vividly red vinagrete bowl) through the pipeline step by step after the color it produced
  // didn't match the source at all -- not visible from reading the code alone.
  const unpremultiply = (channel, alpha) =>
    alpha === 0 || alpha === 255 ? channel : Math.min(255, Math.round((channel * 255) / alpha));

  let assigner = makeLocalPaletteAssigner();
  const pixels = [];
  for (let y = 0; y < info.height; y++) {
    const row = [];
    for (let x = 0; x < info.width; x++) {
      const idx = (info.width * y + x) * info.channels;
      const a = info.channels === 4 ? data[idx + 3] : 255;
      if (a < 128) {
        row.push(null);
        continue;
      }
      let [r, g, b] = [data[idx], data[idx + 1], data[idx + 2]];
      if (info.premultiplied) {
        r = unpremultiply(r, a);
        g = unpremultiply(g, a);
        b = unpremultiply(b, a);
      }
      row.push(colorOf(r, g, b));
    }
    pixels.push(row);
  }

  let rows = pixels.map((row) => row.map((p) => (p ? assigner.assign(...p) : ".")));

  // Pool exhausted (some pixel got `null` back from assign) -- reduce to the pool's capacity by
  // keeping the most-frequent colors and remapping the rest to their nearest kept neighbor,
  // same "keep top-N" strategy as the editor's own color-simplify slider.
  if (rows.some((row) => row.includes(null))) {
    rows = reduceToFit(pixels, LOCAL_CHAR_POOL.length);
    assigner = null; // localPalette below comes from reduceToFit's own assigner in that branch
  }

  return {
    width: info.width,
    height: info.height,
    rows: rows.map((row) => row.join("")),
    localPalette: assigner ? assigner.localPalette : rows.localPalette,
    colorMode,
  };
}

// Fallback for sources with more distinct colors than LOCAL_CHAR_POOL can hold: count frequency,
// keep the LOCAL_CHAR_POOL.length most-used colors (plus whatever already maps to a global
// token, which doesn't cost pool space), remap every other pixel to its nearest kept color.
// Groups colors into coarse buckets before ranking by frequency -- anti-aliased/softly-shaded
// source art can produce hundreds of near-identical exact RGB values along every edge, and exact
// -match frequency counting treats each as a separate, low-count color. That lets a whole smoothly
// -shaded region (e.g. red tomato bits with soft edges) lose out entirely to a smaller but
// perfectly uniform region (a crisp black outline), even though "reddish" pixels vastly outnumber
// "black" ones in aggregate. A ~24-value bucket per channel merges anti-aliasing noise into one
// color family while still keeping real distinctions (red vs. cream vs. black) apart.
const QUANTIZE_STEP = 24;

function quantizeKey(r, g, b) {
  return [
    Math.round(r / QUANTIZE_STEP),
    Math.round(g / QUANTIZE_STEP),
    Math.round(b / QUANTIZE_STEP),
  ].join(",");
}

function reduceToFit(pixels, maxLocalColors) {
  const buckets = new Map(); // quantizeKey -> { count, rSum, gSum, bSum }
  for (const row of pixels) {
    for (const p of row) {
      if (!p) continue;
      const [r, g, b] = p;
      const key = quantizeKey(r, g, b);
      const bucket = buckets.get(key) ?? { count: 0, rSum: 0, gSum: 0, bSum: 0 };
      bucket.count++;
      bucket.rSum += r;
      bucket.gSum += g;
      bucket.bSum += b;
      buckets.set(key, bucket);
    }
  }

  // Each kept bucket's representative color is the average of the pixels that landed in it, not
  // an arbitrary member -- a stable, de-noised stand-in for that whole color family.
  const kept = [...buckets.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, maxLocalColors)
    .map(([key, bucket]) => ({
      key,
      rgb: [
        Math.round(bucket.rSum / bucket.count),
        Math.round(bucket.gSum / bucket.count),
        Math.round(bucket.bSum / bucket.count),
      ],
    }));
  const keptByKey = new Map(kept.map((k) => [k.key, k.rgb]));

  const assigner = makeLocalPaletteAssigner();
  for (const { rgb } of kept) assigner.assign(...rgb);

  const nearestKept = (r, g, b) => {
    let best = kept[0].rgb;
    let bestDist = Number.POSITIVE_INFINITY;
    for (const { rgb: k } of kept) {
      const dist = (r - k[0]) ** 2 + (g - k[1]) ** 2 + (b - k[2]) ** 2;
      if (dist < bestDist) {
        bestDist = dist;
        best = k;
      }
    }
    return best;
  };

  const rows = pixels.map((row) =>
    row.map((p) => {
      if (!p) return ".";
      const [r, g, b] = p;
      const bucketRgb = keptByKey.get(quantizeKey(r, g, b));
      if (bucketRgb) return assigner.assign(...bucketRgb);
      return assigner.assign(...nearestKept(r, g, b));
    }),
  );
  rows.localPalette = assigner.localPalette;
  return rows;
}

const SPRITE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isValidSpriteName(name) {
  return typeof name === "string" && SPRITE_NAME_RE.test(name);
}

// Resolves a sprite name to its art/<name>.json path, or null if the name is invalid --
// regex-checked AND path-resolution-checked (defense in depth even if the regex ever loosens).
export function spritePathFor(name) {
  if (!isValidSpriteName(name)) return null;
  const resolved = resolve(ART_DIR, `${name}.json`);
  if (!resolved.startsWith(ART_DIR + sep)) return null;
  return resolved;
}

const LEGEND_CSS_VAR = new Map(PALETTE_ENTRIES.map((e) => [e.char, e.cssVar]));

// Converts a { rows, localPalette } grid into an ordered list of box-shadow entries, one per
// non-transparent pixel. Global-palette pixels use `var(--color-x)` (one edit point restyles
// every sprite); local-palette pixels (from imageInputToGrid's precise/conform modes) use their
// raw hex directly, since by definition they aren't one of the shared tokens.
export function gridToBoxShadow({ rows, localPalette }) {
  const entries = [];
  rows.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      const cssVar = LEGEND_CSS_VAR.get(ch);
      if (cssVar) {
        entries.push(`${x}px ${y}px var(${cssVar})`);
      } else if (localPalette?.[ch]) {
        entries.push(`${x}px ${y}px ${localPalette[ch]}`);
      }
    });
  });
  return entries;
}
