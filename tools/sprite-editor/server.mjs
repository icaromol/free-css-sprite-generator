#!/usr/bin/env node
// Interactive sprite pixel editor -- see README.md.
// Upload an image -> auto-converted to a locked 64x64 palette grid -> paint/erase pixels by
// hand -> save as art/<name>.json (or load/edit an existing one).
//
// Usage: npm run sprite-editor  (or: node tools/sprite-editor/server.mjs)

import { exec } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ART_DIR,
  imageInputToGrid,
  PALETTE_ENTRIES,
  spritePathFor,
} from "../../scripts/lib/pixel-grid.mjs";

const PORT = Number.parseInt(process.env.PORT ?? "5787", 10);
const PUBLIC_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "public");
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

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
  return readdirSync(ART_DIR)
    .filter((f) => f.endsWith(".json") && f !== "legend.json")
    .map((f) => {
      try {
        const data = JSON.parse(readFileSync(join(ART_DIR, f), "utf8"));
        if (!Array.isArray(data.rows)) return null;
        return { name: data.name, width: data.width, height: data.height };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
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
      const rowsValid =
        Array.isArray(rows) &&
        rows.length === height &&
        rows.every((r) => typeof r === "string" && r.length === width);
      if (width !== 64 || height !== 64 || !rowsValid) {
        sendJson(res, 400, { error: "grid must be 64x64" });
        return true;
      }
      const localPaletteValid =
        localPalette === undefined ||
        (typeof localPalette === "object" &&
          localPalette !== null &&
          !Array.isArray(localPalette) &&
          Object.values(localPalette).every((v) => typeof v === "string"));
      if (!localPaletteValid) {
        sendJson(res, 400, { error: "localPalette must be a char->hex object" });
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
      const grid = await imageInputToGrid(body, { size: 64, colorMode });
      sendJson(res, 200, {
        width: grid.width,
        height: grid.height,
        rows: grid.rows,
        localPalette: grid.localPalette,
        colorMode: grid.colorMode,
      });
    } catch (err) {
      sendJson(res, 400, { error: `couldn't decode image: ${err.message}` });
    }
    return true;
  }

  return false;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname.startsWith("/api/")) {
    const handled = await handleApi(req, res, url);
    if (!handled) sendJson(res, 404, { error: "not found" });
    return;
  }
  serveStatic(req, res);
});

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`Sprite editor running at ${url}`);
  const openCmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  exec(`${openCmd} ${url}`, () => {});
});
