#!/usr/bin/env node
// Interactive sprite pixel editor -- see README.md.
// Upload an image -> auto-converted to a locked 64x64 palette grid -> paint/erase pixels by
// hand -> save as art/<name>.json (or load/edit an existing one).
//
// Usage: npm run sprite-editor  (or: node tools/sprite-editor/server.mjs)

import { exec } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EXPORTS_DIR,
  exportPathFor,
  gridToScss,
  imageInputToGrid,
  isValidSpriteName,
  LEGEND_PATH,
  loadAllSpriteRecords,
  MAX_DIMENSION,
  MIN_DIMENSION,
  nativeGridSize,
  PALETTE_ENTRIES,
  PALETTE_HEX_PATH,
  reloadPaletteFromDisk,
  spritePathFor,
  writeGridImage,
} from "../../scripts/lib/pixel-grid.mjs";

const PORT = Number.parseInt(process.env.PORT ?? "5787", 10);
const PUBLIC_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "public");
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

// The color-simplify slider in public/app.js imports its perceptual-distance/clustering logic
// from shared/color-reduce.mjs -- the same module scripts/lib/pixel-grid.mjs uses server-side for
// the import pipeline, so the two never drift into two different "keep top-N" implementations
// again. That file lives outside PUBLIC_DIR (it's shared with Node, not editor-only), so it needs
// one explicit route rather than widening serveStatic's path-traversal surface with a second
// static root.
const SHARED_COLOR_REDUCE_PATH = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
  "..",
  "shared",
  "color-reduce.mjs",
);

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > MAX_UPLOAD_BYTES) {
        req.destroy();
        reject(new Error("upload too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function listSprites() {
  return loadAllSpriteRecords()
    .map((data) => ({ name: data.name, width: data.width, height: data.height }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Every char currently in use across every saved sprite -- row pixels and each sprite's own
// local-palette keys -- so a newly assigned global palette char never collides with (and silently
// reinterprets) a color some old sprite already saved under that char.
function usedCharsAcrossAllSprites() {
  const used = new Set();
  for (const data of loadAllSpriteRecords()) {
    for (const row of data.rows) for (const ch of row) used.add(ch);
    for (const ch of Object.keys(data.localPalette ?? {})) used.add(ch);
  }
  return used;
}

// Sprite names whose `rows` actually paint the given char -- used to block deleting a palette
// color still in use (gridToBoxShadow silently drops any pixel whose char has no matching global
// or local color entry, so an unguarded delete would orphan those pixels rather than erroring).
function spriteNamesUsingChar(char) {
  return loadAllSpriteRecords()
    .filter((data) => data.rows.some((row) => row.includes(char)))
    .map((data) => data.name);
}

const NEW_COLOR_CHAR_CANDIDATES =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@%&*+=";

function pickUnusedGlobalChar() {
  const reserved = new Set(PALETTE_ENTRIES.map((e) => e.char));
  const used = usedCharsAcrossAllSprites();
  for (const ch of NEW_COLOR_CHAR_CANDIDATES) {
    if (!reserved.has(ch) && !used.has(ch)) return ch;
  }
  return null;
}

// Validates the { width, height, rows, localPalette } shape shared by the sprite-save endpoint
// and the export endpoints below -- one check instead of four near-identical copies. Returns an
// error string, or null when the payload is valid.
function validateGridPayload({ width, height, rows, localPalette }) {
  const dimsValid =
    Number.isInteger(width) &&
    Number.isInteger(height) &&
    width >= MIN_DIMENSION &&
    width <= MAX_DIMENSION &&
    height >= MIN_DIMENSION &&
    height <= MAX_DIMENSION;
  const rowsValid =
    Array.isArray(rows) &&
    rows.length === height &&
    rows.every((r) => typeof r === "string" && r.length === width);
  if (!dimsValid || !rowsValid) {
    return `grid dimensions must be ${MIN_DIMENSION}-${MAX_DIMENSION}px and rows must match width/height`;
  }
  const localPaletteValid =
    localPalette === undefined ||
    (typeof localPalette === "object" &&
      localPalette !== null &&
      !Array.isArray(localPalette) &&
      Object.values(localPalette).every((v) => typeof v === "string"));
  return localPaletteValid ? null : "localPalette must be a char->hex object";
}

// art/legend.json is hand-edited per docs/drawing-workflow.md -- a syntax error left there while
// editing shouldn't crash the whole (long-lived) server the next time a palette endpoint reads it.
// Throws a clear, specific error instead; the top-level try/catch around the request handler below
// turns that into a clean 500 rather than an unhandled rejection.
function readLegend() {
  try {
    return JSON.parse(readFileSync(LEGEND_PATH, "utf8"));
  } catch (err) {
    throw new Error(`art/legend.json is invalid JSON: ${err.message}`);
  }
}

function slugify(label) {
  return label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function uniqueCssVar(label) {
  const base = `--color-${slugify(label) || "custom"}`;
  const existing = new Set(PALETTE_ENTRIES.map((e) => e.cssVar));
  if (!existing.has(base)) return base;
  let i = 2;
  while (existing.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

function serveStatic(req, res) {
  const urlPath = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  const filePath = join(PUBLIC_DIR, urlPath);
  const insidePublic = filePath === PUBLIC_DIR || filePath.startsWith(PUBLIC_DIR + sep);
  if (!insidePublic || !existsSync(filePath)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  const type = CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream";
  res.writeHead(200, { "Content-Type": type });
  res.end(readFileSync(filePath));
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/palette") {
    sendJson(
      res,
      200,
      PALETTE_ENTRIES.map(({ char, hex, cssVar }) => ({ char, hex, cssVar })),
    );
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/palette") {
    let payload;
    try {
      const body = await readBody(req);
      payload = JSON.parse(body.toString("utf8"));
    } catch {
      sendJson(res, 400, { error: "invalid JSON body" });
      return true;
    }
    const { hex, label } = payload;
    if (typeof hex !== "string" || !/^#[0-9a-fA-F]{6}$/.test(hex)) {
      sendJson(res, 400, { error: "hex must be a #rrggbb color" });
      return true;
    }
    if (typeof label !== "string" || label.trim().length === 0 || label.length > 60) {
      sendJson(res, 400, { error: "label must be 1-60 characters" });
      return true;
    }
    const char = pickUnusedGlobalChar();
    if (!char) {
      sendJson(res, 400, { error: "no free color slots left" });
      return true;
    }
    const cssVar = uniqueCssVar(label);
    const normalizedHex = hex.toLowerCase();

    const legend = readLegend();
    legend[char] = cssVar;
    writeFileSync(LEGEND_PATH, `${JSON.stringify(legend, null, 2)}\n`);

    const hexLines = readFileSync(PALETTE_HEX_PATH, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    hexLines.push(normalizedHex.slice(1));
    writeFileSync(PALETTE_HEX_PATH, `${hexLines.join("\n")}\n`);

    reloadPaletteFromDisk();
    sendJson(res, 200, { char, hex: normalizedHex, cssVar });
    return true;
  }

  const paletteDeleteMatch = url.pathname.match(/^\/api\/palette\/([^/]+)$/);
  if (req.method === "DELETE" && paletteDeleteMatch) {
    const char = decodeURIComponent(paletteDeleteMatch[1]);
    const legend = readLegend();
    if (char.length !== 1 || char === "." || !(char in legend) || char === "_comment") {
      sendJson(res, 404, { error: "not found" });
      return true;
    }
    const inUse = spriteNamesUsingChar(char);
    if (inUse.length > 0) {
      sendJson(res, 409, { error: "color is in use", sprites: inUse });
      return true;
    }

    const chars = Object.keys(legend).filter((k) => k !== "_comment" && k !== ".");
    const index = chars.indexOf(char);
    delete legend[char];
    writeFileSync(LEGEND_PATH, `${JSON.stringify(legend, null, 2)}\n`);

    const hexLines = readFileSync(PALETTE_HEX_PATH, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    hexLines.splice(index, 1);
    writeFileSync(PALETTE_HEX_PATH, `${hexLines.join("\n")}\n`);

    reloadPaletteFromDisk();
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/sprites") {
    sendJson(res, 200, listSprites());
    return true;
  }

  const spriteMatch = url.pathname.match(/^\/api\/sprites\/([^/]+)$/);
  if (spriteMatch) {
    const name = decodeURIComponent(spriteMatch[1]);
    const path = spritePathFor(name);
    if (!path) {
      sendJson(res, 400, { error: "invalid sprite name" });
      return true;
    }

    if (req.method === "GET") {
      if (!existsSync(path)) {
        sendJson(res, 404, { error: "not found" });
        return true;
      }
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(readFileSync(path));
      return true;
    }

    if (req.method === "POST") {
      let payload;
      try {
        const body = await readBody(req);
        payload = JSON.parse(body.toString("utf8"));
      } catch {
        sendJson(res, 400, { error: "invalid JSON body" });
        return true;
      }
      const { width, height, rows, overwrite, localPalette } = payload;
      const validationError = validateGridPayload({ width, height, rows, localPalette });
      if (validationError) {
        sendJson(res, 400, { error: validationError });
        return true;
      }
      if (existsSync(path) && overwrite !== true) {
        sendJson(res, 409, { exists: true });
        return true;
      }
      const out = { name, width, height, rows, localPalette: localPalette ?? {} };
      writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`);
      sendJson(res, 200, { ok: true });
      return true;
    }
  }

  if (req.method === "POST" && url.pathname === "/api/import") {
    try {
      const body = await readBody(req);
      if (body.length === 0) {
        sendJson(res, 400, { error: "empty upload" });
        return true;
      }
      const colorMode = url.searchParams.get("mode") === "conform" ? "conform" : "precise";
      const size = await nativeGridSize(body, { maxDimension: MAX_DIMENSION });
      const grid = await imageInputToGrid(body, { size, colorMode });
      sendJson(res, 200, {
        width: grid.width,
        height: grid.height,
        rows: grid.rows,
        localPalette: grid.localPalette,
        colorMode: grid.colorMode,
        reduction: grid.reduction,
      });
    } catch (err) {
      sendJson(res, 400, { error: `couldn't decode image: ${err.message}` });
    }
    return true;
  }

  const exportMatch = url.pathname.match(/^\/api\/export\/([^/]+)$/);
  if (req.method === "POST" && exportMatch) {
    const format = exportMatch[1];
    if (!["png", "webp", "scss"].includes(format)) {
      sendJson(res, 400, { error: "format must be png, webp, or scss" });
      return true;
    }
    let payload;
    try {
      const body = await readBody(req);
      payload = JSON.parse(body.toString("utf8"));
    } catch {
      sendJson(res, 400, { error: "invalid JSON body" });
      return true;
    }
    const { name, width, height, rows, overwrite, localPalette } = payload;
    if (!isValidSpriteName(name)) {
      sendJson(res, 400, { error: "invalid sprite name" });
      return true;
    }
    const validationError = validateGridPayload({ width, height, rows, localPalette });
    if (validationError) {
      sendJson(res, 400, { error: validationError });
      return true;
    }
    const outPath = exportPathFor(name, format);
    if (!outPath) {
      sendJson(res, 400, { error: "invalid sprite name" });
      return true;
    }
    if (existsSync(outPath) && overwrite !== true) {
      sendJson(res, 409, { exists: true });
      return true;
    }
    mkdirSync(EXPORTS_DIR, { recursive: true });
    try {
      if (format === "scss") {
        writeFileSync(outPath, gridToScss({ name, rows, localPalette }));
      } else {
        await writeGridImage({ rows, localPalette }, format, outPath);
      }
    } catch (err) {
      sendJson(res, 500, { error: `export failed: ${err.message}` });
      return true;
    }
    sendJson(res, 200, { ok: true, path: `exports/${name}.${format}` });
    return true;
  }

  return false;
}

const server = createServer(async (req, res) => {
  // Backstop: node:http never awaits or catches what an async request listener's promise does,
  // so any uncaught throw/rejection in here (readLegend() above being the concrete case that
  // motivated this) would otherwise become an unhandled rejection and crash the whole process --
  // taking the editor down for a single bad request instead of just failing that request.
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (url.pathname === "/shared/color-reduce.mjs") {
      res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
      res.end(readFileSync(SHARED_COLOR_REDUCE_PATH));
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      const handled = await handleApi(req, res, url);
      if (!handled) sendJson(res, 404, { error: "not found" });
      return;
    }
    serveStatic(req, res);
  } catch (err) {
    console.error("Request handler error:", err);
    if (!res.headersSent) sendJson(res, 500, { error: err.message });
  }
});

// Explicit host: omitting it binds to all interfaces (0.0.0.0-equivalent), which would expose
// this tool's unauthenticated read/write/delete API -- your sprite data and palette -- to anyone
// else on the same network (public wifi, office LAN, etc). This is a local-only dev tool.
server.listen(PORT, "127.0.0.1", () => {
  const url = `http://localhost:${PORT}`;
  console.log(`Sprite editor running at ${url}`);
  const openCmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  exec(`${openCmd} ${url}`, () => {});
});
