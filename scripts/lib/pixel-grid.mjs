// Shared pixel-grid pipeline: palette loading, image -> grid conversion (fit/resize/color), and
// grid -> box-shadow CSS generation. Used by scripts/png-to-grid.mjs, scripts/build-sprites.mjs,
// and tools/sprite-editor/server.mjs -- one implementation, not several drifting copies.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { clusterPixels, reduceCandidates } from "../../shared/color-reduce.mjs";

/**
 * The canonical, versioned source format for a sprite -- see README.md's "The JSON pixel-grid
 * format" section. `rows[y][x]` is either "." (transparent), a char resolved via the shared
 * palette (art/legend.json), or a key in localPalette.
 * @typedef {Object} SpriteRecord
 * @property {string} name
 * @property {number} width
 * @property {number} height
 * @property {string[]} rows
 * @property {Record<string, string>} [localPalette] char -> "#rrggbb"
 */

/**
 * One shared-palette color, derived from art/legend.json + art/palette.hex.
 * @typedef {Object} PaletteEntry
 * @property {string} char
 * @property {string} hex
 * @property {[number, number, number]} rgb
 * @property {string} cssVar
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const ART_DIR = join(ROOT, "art");
export const LEGEND_PATH = join(ART_DIR, "legend.json");
export const PALETTE_HEX_PATH = join(ART_DIR, "palette.hex");
const LEGEND_EXAMPLE_PATH = join(ART_DIR, "legend.example.json");
const PALETTE_HEX_EXAMPLE_PATH = join(ART_DIR, "palette.example.hex");

// art/ is gitignored (it's per-project sprite data, not this repo's), so a fresh clone has no
// legend.json/palette.hex for loadPaletteEntries() to read -- only the two tracked *.example.*
// templates below. Seed the real files from those templates on first run instead of crashing;
// after that they're the user's own to edit (the sprite editor's palette endpoints rewrite them
// directly, and re-running this never overwrites files that already exist).
function ensurePaletteFilesExist() {
  mkdirSync(ART_DIR, { recursive: true });
  if (!existsSync(LEGEND_PATH)) {
    copyFileSync(LEGEND_EXAMPLE_PATH, LEGEND_PATH);
    console.log(
      `Created ${LEGEND_PATH} from legend.example.json (starter palette, no colors yet).`,
    );
  }
  if (!existsSync(PALETTE_HEX_PATH)) {
    copyFileSync(PALETTE_HEX_EXAMPLE_PATH, PALETTE_HEX_PATH);
    console.log(
      `Created ${PALETTE_HEX_PATH} from palette.example.hex (starter palette, no colors yet).`,
    );
  }
}
// Standalone exports (PNG/WebP/SCSS) from the sprite editor's "Export as" feature -- deliberately
// separate from ART_DIR (the JSON source of truth) and styles/sprites/ (build-sprites.mjs's
// generated pipeline output), so an export can never be mistaken for either.
export const EXPORTS_DIR = join(ROOT, "exports");

// Sprite pixel-dimension bounds, shared by server.mjs's save/import validation. 8px keeps a grid
// meaningful; 2048px lets the size slider reach large export/reference resolutions -- note that
// as an actual CSS box-shadow sprite (not just a JSON/PNG/WebP/SCSS export), anything much past
// 256px starts generating a LOT of box-shadow entries (2048x2048 is ~4.2 million), which gets
// heavy for real browser CSS painting.
export const MIN_DIMENSION = 8;
export const MAX_DIMENSION = 2048;

/** @param {string} hex @returns {[number, number, number]} */
function hexToRgb(hex) {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex(r, g, b) {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
}

const HEX_LINE_RE = /^[0-9a-fA-F]{6}$/;

// Palette is loaded from the two files that are the actual source of truth -- no hardcoded
// fourth copy. art/legend.json's key order (excluding "_comment" and ".") must match
// art/palette.hex's line order; both are hand-maintained together, see README.md.
function loadPaletteEntries() {
  const legend = JSON.parse(readFileSync(LEGEND_PATH, "utf8"));
  const hexLines = readFileSync(PALETTE_HEX_PATH, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  // Without this, a malformed line (wrong digit count, stray character) isn't rejected --
  // Number.parseInt on garbage yields NaN, and NaN >> 16 silently coerces to 0 in JS, so a typo
  // becomes solid black instead of a clear error. Worth catching explicitly since hand-editing
  // this file is a documented workflow (see docs/drawing-workflow.md).
  hexLines.forEach((line, i) => {
    if (!HEX_LINE_RE.test(line)) {
      throw new Error(`art/palette.hex line ${i + 1} ("${line}") isn't a valid 6-digit hex color.`);
    }
  });
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

// PALETTE_ENTRIES and everything derived from it below are mutable and recomputed by
// reloadPaletteFromDisk() (see computeDerivedPaletteState() further down) -- the sprite editor's
// palette add/delete endpoints rewrite legend.json/palette.hex on disk, and every consumer in
// this long-lived server process needs to see that without a restart. ES module named imports are
// live bindings, so `export let` here is enough for server.mjs's `import { PALETTE_ENTRIES }` to
// reflect a reload automatically.
/** @type {PaletteEntry[]} */
export let PALETTE_ENTRIES;
let EXACT_GLOBAL_MATCH;

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
const GRAYSCALE_SATURATION_THRESHOLD = 0.15;
let CONFORM_CHROMATIC_TARGETS;
let CONFORM_ACHROMATIC_TARGETS;

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
const LOCAL_CHAR_POOL_SOURCE = "aejlnoqrtvxyzADEHIJKLMNOQRTVXYZ0123456789";
let GLOBAL_CHARS;
let LOCAL_CHAR_POOL;
let LEGEND_CSS_VAR;
let LEGEND_HEX;

// Recomputes every value derived from legend.json/palette.hex -- called once at module load and
// again by reloadPaletteFromDisk() after the sprite editor's palette add/delete endpoints rewrite
// those two files, so a long-lived server process picks up the change without a restart.
function computeDerivedPaletteState() {
  PALETTE_ENTRIES = loadPaletteEntries();
  EXACT_GLOBAL_MATCH = new Map(PALETTE_ENTRIES.map((e) => [e.rgb.join(","), e.char]));
  GLOBAL_CHARS = new Set(PALETTE_ENTRIES.map((e) => e.char));
  LOCAL_CHAR_POOL = LOCAL_CHAR_POOL_SOURCE.split("").filter((c) => !GLOBAL_CHARS.has(c));
  CONFORM_CHROMATIC_TARGETS = PALETTE_ENTRIES.filter(
    (e) => !CONFORM_EXCLUDE.has(e.cssVar) && !CONFORM_ACHROMATIC_VARS.has(e.cssVar),
  ).map((e) => ({ ...e, hsl: rgbToHsl(...e.rgb) }));
  CONFORM_ACHROMATIC_TARGETS = PALETTE_ENTRIES.filter((e) =>
    CONFORM_ACHROMATIC_VARS.has(e.cssVar),
  ).map((e) => ({ ...e, hsl: rgbToHsl(...e.rgb) }));
  LEGEND_CSS_VAR = new Map(PALETTE_ENTRIES.map((e) => [e.char, e.cssVar]));
  LEGEND_HEX = new Map(PALETTE_ENTRIES.map((e) => [e.char, e.hex]));
}

ensurePaletteFilesExist();
computeDerivedPaletteState();

/** Re-reads art/legend.json + art/palette.hex and recomputes everything derived from them. */
export function reloadPaletteFromDisk() {
  computeDerivedPaletteState();
}

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

// Reads just the source image's own pixel dimensions and returns the single square grid size
// that should hold it at full resolution: its longer edge, capped at `maxDimension`. Used by the
// sprite editor's import endpoint to show an imported image at its full/native resolution (up to
// that cap) instead of always crushing it down to a fixed sprite size first -- imageInputToGrid
// below then letterboxes the (possibly non-square) source into that square, same as it always has.
/**
 * @param {string | Buffer} input a file path, or an image's raw bytes (e.g. an upload body)
 * @param {{ maxDimension?: number }} [options]
 * @returns {Promise<number>}
 */
export async function nativeGridSize(input, { maxDimension = MAX_DIMENSION } = {}) {
  const { width, height } = await sharp(input).metadata();
  return Math.max(MIN_DIMENSION, Math.min(maxDimension, Math.max(width, height)));
}

// Full pipeline: fit the whole input into size x size (nearest-neighbor, aspect-ratio preserved,
// transparent letterbox padding -- never crops, never distorts) -> color each pixel per
// `colorMode` -> return a grid + whatever local palette entries it needed. No auto-crop, no
// automatic background-color removal (both were footguns that clipped/mis-detected real content
// on some sources -- see the pipeline comments below); background removal is now an explicit, separate,
// user-triggered action in the sprite editor instead of an automatic import step.
// `input` is anything sharp() accepts: a file path string, or a Buffer (e.g. an upload body).
/**
 * @param {string | Buffer} input
 * @param {{ size?: number, colorMode?: "precise" | "conform" }} [options]
 * @returns {Promise<{
 *   width: number,
 *   height: number,
 *   rows: string[],
 *   localPalette: Record<string, string>,
 *   colorMode: string,
 *   reduction: { before: number, after: number } | null,
 * }>}
 */
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

  const assigner = makeLocalPaletteAssigner();
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
  let localPalette = assigner.localPalette;
  let reduction = null;

  // Pool exhausted (some pixel got `null` back from assign) -- reduce to the pool's capacity via
  // shared/color-reduce.mjs: perceptually cluster the pixels, then merge down to `n` colors by
  // always combining the most similar pair first (see reduceCandidates' doc comment), same logic
  // the editor's own color-simplify slider uses client-side (tools/sprite-editor/public/app.js's
  // reduceColors) via the same shared module.
  if (rows.some((row) => row.includes(null))) {
    const reduced = reduceToFit(pixels, LOCAL_CHAR_POOL.length);
    rows = reduced.rows;
    localPalette = reduced.localPalette;
    reduction = reduced.reduction;
  }

  return {
    width: info.width,
    height: info.height,
    rows: rows.map((row) => row.join("")),
    localPalette,
    colorMode,
    reduction,
  };
}

// Fallback for sources with more distinct colors than LOCAL_CHAR_POOL can hold. Uses
// shared/color-reduce.mjs (see its header comment for the full rationale) to: (1) perceptually
// cluster pixels so near-identical colors coalesce into one group regardless of anti-aliasing
// noise, instead of a fixed-grid quantization that can fragment them across several tiny buckets;
// (2) reduce to LOCAL_CHAR_POOL.length colors by always merging the most similar pair of clusters
// first (reduceCandidates), so a distinct color is only ever sacrificed once nothing more similar
// remains to consolidate instead -- not by how rare it is.
function reduceToFit(pixels, maxLocalColors) {
  const rgbList = [];
  for (const row of pixels) {
    for (const p of row) {
      if (p) rgbList.push(p);
    }
  }

  const { clusterIndexForPixel, clusters } = clusterPixels(rgbList, {
    maxClusters: Math.max(256, maxLocalColors * 6),
  });

  const candidates = clusters.map((c) => ({ rgb: c.rgb, count: c.count }));
  const { kept, representativeOf } = reduceCandidates(candidates, maxLocalColors);
  const resolvedClusterRgb = candidates.map((c) => representativeOf.get(c).rgb);

  const assigner = makeLocalPaletteAssigner();
  let pixelCursor = 0;
  const rows = pixels.map((row) =>
    row.map((p) => {
      if (!p) return ".";
      const clusterIndex = clusterIndexForPixel[pixelCursor++];
      const [r, g, b] = resolvedClusterRgb[clusterIndex];
      return assigner.assign(r, g, b);
    }),
  );

  return {
    rows,
    localPalette: assigner.localPalette,
    reduction: { before: clusters.length, after: kept.length },
  };
}

const SPRITE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** @param {string} name @returns {boolean} */
export function isValidSpriteName(name) {
  return typeof name === "string" && SPRITE_NAME_RE.test(name);
}

// Resolves a sprite name to its art/<name>.json path, or null if the name is invalid --
// regex-checked AND path-resolution-checked (defense in depth even if the regex ever loosens).
/** @param {string} name @returns {string | null} */
export function spritePathFor(name) {
  if (!isValidSpriteName(name)) return null;
  const resolved = resolve(ART_DIR, `${name}.json`);
  if (!resolved.startsWith(ART_DIR + sep)) return null;
  return resolved;
}

// Resolves a sprite name + extension to its exports/<name>.<ext> path, or null if the name is
// invalid -- same regex-checked-and-path-resolution-checked defense in depth as spritePathFor.
/** @param {string} name @param {string} ext @returns {string | null} */
export function exportPathFor(name, ext) {
  if (!isValidSpriteName(name)) return null;
  const resolved = resolve(EXPORTS_DIR, `${name}.${ext}`);
  if (!resolved.startsWith(EXPORTS_DIR + sep)) return null;
  return resolved;
}

const NON_SPRITE_JSON_FILES = new Set(["legend.json", "legend.example.json"]);

// Reads every art/*.json sprite record, skipping the palette file(s) by name and skipping (with a
// console.warn, not a throw) any file that fails to parse or doesn't look like a sprite (no `rows`
// array) -- used by both tools/sprite-editor/server.mjs (so one malformed sprite never breaks
// listing/using the others) and scripts/build-sprites.mjs (so one malformed sprite never blocks
// compiling every other sprite's CSS). Previously each had its own copy of this with different
// failure modes -- server.mjs's skipped bad files, build-sprites.mjs's didn't, so a single typo in
// one sprite could take down the whole `npm run build:sprites` -- same "one implementation, not
// several drifting copies" principle as everything else in this file.
/** @returns {SpriteRecord[]} */
export function loadAllSpriteRecords() {
  return readdirSync(ART_DIR)
    .filter((f) => f.endsWith(".json") && !NON_SPRITE_JSON_FILES.has(f))
    .map((f) => {
      try {
        const data = JSON.parse(readFileSync(join(ART_DIR, f), "utf8"));
        if (!Array.isArray(data.rows)) {
          console.warn(`Skipping art/${f}: no "rows" array -- not a sprite record?`);
          return null;
        }
        return data;
      } catch (err) {
        console.warn(`Skipping art/${f}: ${err.message}`);
        return null;
      }
    })
    .filter(Boolean);
}

// Converts a { rows, localPalette } grid into an ordered list of box-shadow entries, one per
// non-transparent pixel. By default, global-palette pixels use `var(--color-x)` (one edit point
// restyles every sprite) -- this is what scripts/build-sprites.mjs uses, always paired with the
// `:root` block it also generates in styles/abstracts/_palette-tokens.scss, so the variables
// actually resolve. Pass `{ hexOnly: true }` to force every entry to a literal hex value instead
// (used by gridToScss's standalone single-file export below): box-shadow is a single list-valued
// property, so even one entry referencing an undefined custom property invalidates the ENTIRE
// declaration at computed-value time -- not just that pixel, the whole sprite disappears. A
// standalone export that isn't guaranteed to ship alongside _palette-tokens.scss must never emit
// var() for exactly that reason. Local-palette pixels (from imageInputToGrid's precise/conform
// modes) always use their own raw hex regardless, since by definition they aren't shared tokens.
/**
 * @param {Pick<SpriteRecord, "rows" | "localPalette">} grid
 * @param {{ hexOnly?: boolean }} [options]
 * @returns {string[]} one `"Xpx Ypx <color>"` entry per non-transparent pixel
 */
export function gridToBoxShadow({ rows, localPalette }, { hexOnly = false } = {}) {
  const entries = [];
  rows.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      const cssVar = LEGEND_CSS_VAR.get(ch);
      if (cssVar && !hexOnly) {
        entries.push(`${x}px ${y}px var(${cssVar})`);
      } else if (cssVar && hexOnly) {
        entries.push(`${x}px ${y}px ${LEGEND_HEX.get(ch)}`);
      } else if (localPalette?.[ch]) {
        entries.push(`${x}px ${y}px ${localPalette[ch]}`);
      }
    });
  });
  return entries;
}

// Renders a { rows, localPalette } grid into a flat RGBA pixel buffer (width * height * 4 bytes,
// row-major, one pixel per grid cell) for sharp to encode as PNG/WebP -- used by the sprite
// editor's export endpoint. Same char-lookup precedence as gridToBoxShadow (global palette first,
// then the sprite's own local palette); `.` and any unrecognized char stay alpha 0 (the buffer
// starts zeroed), matching gridToBoxShadow's silently-skip-unknown-chars behavior rather than
// throwing.
/**
 * @param {Pick<SpriteRecord, "rows" | "localPalette">} grid
 * @returns {{ width: number, height: number, buffer: Buffer }}
 */
export function gridToRgba({ rows, localPalette }) {
  const height = rows.length;
  const width = rows[0]?.length ?? 0;
  const globalRgbByChar = new Map(PALETTE_ENTRIES.map((e) => [e.char, e.rgb]));
  const buffer = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const row = rows[y];
    for (let x = 0; x < width; x++) {
      const ch = row[x];
      if (ch === ".") continue;
      const rgb =
        globalRgbByChar.get(ch) ?? (localPalette?.[ch] ? hexToRgb(localPalette[ch]) : null);
      if (!rgb) continue;
      const idx = (y * width + x) * 4;
      buffer[idx] = rgb[0];
      buffer[idx + 1] = rgb[1];
      buffer[idx + 2] = rgb[2];
      buffer[idx + 3] = 255;
    }
  }
  return { width, height, buffer };
}

// Same box-shadow text format scripts/build-sprites.mjs's private scssFor() produces, callable
// directly for the sprite editor's standalone SCSS export (exports/<name>.scss) instead of
// duplicating the template.
/** @param {Pick<SpriteRecord, "name" | "rows" | "localPalette">} sprite @returns {string} */
export function gridToScss({ name, rows, localPalette }) {
  // hexOnly: true -- this file is meant to be dropped into any project standalone (see
  // gridToBoxShadow's comment above), so it can never depend on a `:root` block it doesn't ship.
  const entries = gridToBoxShadow({ rows, localPalette }, { hexOnly: true });
  const body = entries.length > 0 ? entries.join(",\n    ") : "none";
  return `.sprite-${name} {\n  box-shadow:\n    ${body};\n}\n`;
}

// Writes a { rows, localPalette } grid to disk as a PNG or WebP file at outPath, at exact 1:1
// pixel resolution (one image pixel per grid cell) -- used by the sprite editor's export
// endpoint. Keeps sharp usage centralized in this module rather than adding it as a direct
// server.mjs dependency.
/**
 * @param {Pick<SpriteRecord, "rows" | "localPalette">} grid
 * @param {"png" | "webp"} format
 * @param {string} outPath
 * @returns {Promise<void>}
 */
export async function writeGridImage({ rows, localPalette }, format, outPath) {
  const { width, height, buffer } = gridToRgba({ rows, localPalette });
  const image = sharp(buffer, { raw: { width, height, channels: 4 } });
  await (format === "webp" ? image.webp() : image.png()).toFile(outPath);
}
