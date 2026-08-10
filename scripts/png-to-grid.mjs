#!/usr/bin/env node
// Converts a drawn/generated PNG (any size) into an art/<name>.json pixel grid at our
// locked sprite resolution. Dev-only tool -- see docs/drawing-workflow.md.
//
// Usage: node scripts/png-to-grid.mjs <input.png> <sprite-name> [--size=64] [--mode=precise|conform] [--debug]
//   --size=N   target grid size (default 64, matches the locked sprite grid)
//   --mode     "precise" (default) keeps each pixel's exact sampled color; "conform" recolors
//              every pixel to the nearest palette family's hue/saturation while keeping its own
//              lightness, generating tones/subtones that read as "our palette" without flattening
//              to one fixed shade per family. Neither mode forces pixels onto only the 20 shared
//              tokens -- colors outside that set are stored in the sprite's own `localPalette`.
//   --debug    also write art/<name>.debug.png, the resized/colored result scaled back up, so you
//              can eyeball it before trusting the JSON
//
// No auto-crop, no automatic background-color removal: expects the source to already be
// reasonably framed with a real alpha channel (both were footguns that clipped or mis-detected
// real content on some sources -- see the pipeline comments below). If a source has an opaque background
// baked in, use the sprite editor's manual "Remove background" button after importing instead.
// Pipeline (scripts/lib/pixel-grid.mjs): fit the whole image into <size>x<size> with
// nearest-neighbor sampling, preserving aspect ratio and padding with transparency rather than
// cropping or stretching -> color each pixel per --mode -> write art/<name>.json.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";
import {
  ART_DIR,
  imageInputToGrid,
  MAX_DIMENSION,
  MIN_DIMENSION,
  PALETTE_ENTRIES,
} from "./lib/pixel-grid.mjs";

const GLOBAL_HEX = new Map(PALETTE_ENTRIES.map((e) => [e.char, e.hex]));

function parseArgs(argv) {
  const [inputPath, spriteName, ...rest] = argv;
  const opts = { size: 64, colorMode: "precise", debug: false };
  for (const arg of rest) {
    if (arg === "--debug") opts.debug = true;
    else if (arg.startsWith("--size=")) opts.size = Number.parseInt(arg.slice(7), 10);
    else if (arg.startsWith("--mode=")) opts.colorMode = arg.slice(7);
  }
  return { inputPath, spriteName, opts };
}

function writeDebugPng(spriteName, { width, height, rows, localPalette }) {
  const scale = Math.max(1, Math.floor(512 / width));
  const debugPng = new PNG({ width: width * scale, height: height * scale });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const ch = rows[y][x];
      const hex = ch === "." ? null : (GLOBAL_HEX.get(ch) ?? localPalette[ch]);
      const n = hex ? Number.parseInt(hex.slice(1), 16) : null;
      const [r, g, b] = n !== null ? [(n >> 16) & 255, (n >> 8) & 255, n & 255] : [230, 230, 230];
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const px = x * scale + dx;
          const py = y * scale + dy;
          const i = (debugPng.width * py + px) << 2;
          debugPng.data[i] = r;
          debugPng.data[i + 1] = g;
          debugPng.data[i + 2] = b;
          debugPng.data[i + 3] = hex ? 255 : 120;
        }
      }
    }
  }
  const debugPath = join(ART_DIR, `${spriteName}.debug.png`);
  writeFileSync(debugPath, PNG.sync.write(debugPng));
  console.log(`Wrote ${debugPath} for visual inspection.`);
}

async function main() {
  const { inputPath, spriteName, opts } = parseArgs(process.argv.slice(2));
  const usage =
    "Usage: node scripts/png-to-grid.mjs <input.png> <sprite-name> [--size=64] [--mode=precise|conform] [--debug]";
  if (!inputPath || !spriteName) {
    console.error(usage);
    process.exit(1);
  }
  // Without this, a bad --size (0, negative, non-numeric, or past MAX_DIMENSION) reached sharp's
  // resize() directly and surfaced as a raw, unrelated-looking internal error instead of a clear
  // CLI usage message.
  if (!Number.isInteger(opts.size) || opts.size < MIN_DIMENSION || opts.size > MAX_DIMENSION) {
    console.error(
      `--size must be an integer between ${MIN_DIMENSION} and ${MAX_DIMENSION} (got "${opts.size}").\n${usage}`,
    );
    process.exit(1);
  }
  if (opts.colorMode !== "precise" && opts.colorMode !== "conform") {
    console.error(`--mode must be "precise" or "conform" (got "${opts.colorMode}").\n${usage}`);
    process.exit(1);
  }

  const { width, height, rows, localPalette } = await imageInputToGrid(inputPath, {
    size: opts.size,
    colorMode: opts.colorMode,
  });

  const out = { name: spriteName, width, height, rows, localPalette };
  const outPath = join(ART_DIR, `${spriteName}.json`);
  writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`);
  const localCount = Object.keys(localPalette).length;
  console.log(
    `Wrote ${outPath} (${width}x${height}, ${opts.colorMode} mode, ${localCount} local color${localCount === 1 ? "" : "s"})`,
  );

  if (opts.debug) writeDebugPng(spriteName, { width, height, rows, localPalette });
}

main();
