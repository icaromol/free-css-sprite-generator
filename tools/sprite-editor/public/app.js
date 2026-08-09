// Sprite editor client -- see README.md and docs/drawing-workflow.md. Plain vanilla JS, no
// build step, no framework: there's no reason to reach for more machinery than a 64x64 paint
// grid needs.

const SIZE = 64;
const BASE_DISPLAY_SIZE = 512; // canvas backing resolution, see index.html -- never changes
const CELL = BASE_DISPLAY_SIZE / SIZE; // backing-store px per grid cell, used for all drawing math
const BRUSH_MIN = 1;
const BRUSH_MAX = 8;
const VIEW_SCALE_MIN = 0.5;
const VIEW_SCALE_MAX = 4;
const VIEW_ZOOM_STEP = 1.15;
const COLOR_COUNT_MIN = 2;

const canvas = document.getElementById("grid-canvas");
const ctx = canvas.getContext("2d");
const paletteEl = document.getElementById("palette-swatches");
const localPaletteSection = document.getElementById("local-palette-section");
const localSwatchesEl = document.getElementById("local-swatches");
const cssPreviewEl = document.getElementById("css-preview");
const spriteSelect = document.getElementById("sprite-select");
const nameInput = document.getElementById("sprite-name");
const saveBtn = document.getElementById("save-btn");
const importInput = document.getElementById("import-input");
const importModeSelect = document.getElementById("import-mode");
const removeBgBtn = document.getElementById("remove-bg-btn");
const maximizeBtn = document.getElementById("maximize-btn");
const statusEl = document.getElementById("status");
const brushSizeInput = document.getElementById("brush-size");
const brushSizeValueEl = document.getElementById("brush-size-value");
const colorCountInput = document.getElementById("color-count");
const colorCountValueEl = document.getElementById("color-count-value");

let globalPalette = []; // [{ char, hex, cssVar, rgb }] -- the 20 shared tokens, from /api/palette
let globalHexByChar = new Map();
let globalCssVarByChar = new Map();
let globalRgbByChar = new Map();
let localPalette = {}; // char -> hex, this sprite's own colors beyond the shared 20 (see
// scripts/lib/pixel-grid.mjs's precise/conform import modes) -- changes per sprite, unlike the
// global palette above.
let localRgbByChar = new Map(); // derived from localPalette, rebuilt by setLocalPalette()
let selectedChar = null;
let eraserEl = null;
let grid = makeBlankGrid();
let sourceGrid = null; // highest-fidelity grid since last import/load, for the color-count slider
let colorCountMax = 20; // recomputed per-sprite by setColorCountMax() -- how many distinct colors
// sourceGrid actually has, so the slider's range always matches what's really there instead of a
// stale fixed ceiling (relevant now that precise/conform imports can bring in far more than 20).
let painting = false;
let lastPaintedCell = null;
let loadedExisting = false;
let brushSize = 1;
let viewScale = 1; // display-only scale -- never touches grid data, just how big pixels render
let tool = "paint"; // 'paint' | 'move'
let hoverCell = null; // [x, y] cell under the cursor, for the brush-size cursor ring
let moving = false;
let moveStart = null; // [clientX, clientY] where a move-tool drag started
let moveSourceGrid = null; // grid snapshot at drag start, so panning recomputes instead of drifting

function makeBlankGrid() {
  return Array.from({ length: SIZE }, () => Array(SIZE).fill("."));
}

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.style.color = isError ? "#ff8080" : "#8fd68f";
}

// ---- color lookup (global palette + this sprite's own local palette) ----

function hexFor(ch) {
  return globalHexByChar.get(ch) ?? localPalette[ch] ?? null;
}

// What to put in a box-shadow entry for this char: a CSS var for global/shared tokens (so a
// single edit point restyles every sprite using it), or the raw hex for local-only colors.
function cssRefFor(ch) {
  const cssVar = globalCssVarByChar.get(ch);
  if (cssVar) return `var(${cssVar})`;
  const hex = localPalette[ch];
  return hex ?? null;
}

function rgbFor(ch) {
  return globalRgbByChar.get(ch) ?? localRgbByChar.get(ch) ?? null;
}

// ---- rendering ----

function drawGrid() {
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const ch = grid[y][x];
      if (ch === ".") {
        const light = (x + y) % 2 === 0;
        ctx.fillStyle = light ? "#3a3a3a" : "#2f2f2f";
      } else {
        ctx.fillStyle = hexFor(ch) ?? "#ff00ff";
      }
      ctx.fillRect(x * CELL, y * CELL, CELL, CELL);
    }
  }
}

function updateCssPreview() {
  const entries = [];
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const ch = grid[y][x];
      const ref = cssRefFor(ch);
      if (ref) entries.push(`${x}px ${y}px ${ref}`);
    }
  }
  const body = entries.length > 0 ? entries.join(",\n    ") : "none";
  cssPreviewEl.textContent = `.sprite-${nameInput.value || "___"} {\n  box-shadow:\n    ${body};\n}`;
}

// Outline showing the brush/eraser's current size at the cursor -- black+white double stroke so
// it reads against both dark checkerboard cells and bright palette colors.
function drawBrushCursor() {
  if (tool !== "paint" || !hoverCell) return;
  const [cx, cy] = hoverCell;
  // Matches paintAt's painted region exactly (same `half` offset), so the ring never drifts
  // half a cell off-center for even brush sizes.
  const half = Math.floor((brushSize - 1) / 2);
  const px = (cx - half + brushSize / 2) * CELL;
  const py = (cy - half + brushSize / 2) * CELL;
  const radius = (brushSize * CELL) / 2;
  ctx.save();
  ctx.beginPath();
  ctx.arc(px, py, radius, 0, Math.PI * 2);
  ctx.strokeStyle = "#000";
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(px, py, radius, 0, Math.PI * 2);
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();
}

function render() {
  drawGrid();
  drawBrushCursor();
}

function refresh() {
  render();
  updateCssPreview();
}

// ---- palette ----

function hexToRgb(hex) {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

async function loadPalette() {
  const res = await fetch("/api/palette");
  globalPalette = await res.json();
  globalHexByChar = new Map(globalPalette.map((p) => [p.char, p.hex]));
  globalCssVarByChar = new Map(globalPalette.map((p) => [p.char, p.cssVar]));
  globalRgbByChar = new Map(globalPalette.map((p) => [p.char, hexToRgb(p.hex)]));

  paletteEl.innerHTML = "";

  const eraser = document.createElement("div");
  eraser.className = "swatch swatch--eraser is-selected";
  eraser.title = "Erase (transparent)";
  eraser.innerHTML = `
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
      <g transform="rotate(-25 12 12)">
        <rect x="4" y="9" width="16" height="10" rx="2" fill="#f2a8c4"></rect>
        <rect x="4" y="9" width="16" height="4.5" rx="2" fill="#fbd3e3"></rect>
        <rect x="4" y="9" width="16" height="10" rx="2" fill="none" stroke="#9c5570" stroke-width="1"></rect>
      </g>
    </svg>`;
  eraser.addEventListener("click", () => selectChar(".", eraser));
  paletteEl.appendChild(eraser);
  eraserEl = eraser;
  selectedChar = ".";

  for (const entry of globalPalette) {
    const el = document.createElement("div");
    el.className = "swatch";
    el.style.background = entry.hex;
    el.title = `${entry.cssVar} (${entry.hex})`;
    el.addEventListener("click", () => selectChar(entry.char, el));
    paletteEl.appendChild(el);
  }
}

// This sprite's own colors (beyond the shared 20), from the last import/load -- see
// scripts/lib/pixel-grid.mjs's precise/conform modes. Rebuilds the local swatch row and hides it
// entirely when there's nothing local to show (e.g. a blank "new" sprite).
function setLocalPalette(next) {
  localPalette = next ?? {};
  localRgbByChar = new Map(Object.entries(localPalette).map(([ch, hex]) => [ch, hexToRgb(hex)]));

  localSwatchesEl.innerHTML = "";
  const entries = Object.entries(localPalette);
  localPaletteSection.style.display = entries.length > 0 ? "" : "none";
  for (const [ch, hex] of entries) {
    const el = document.createElement("div");
    el.className = "swatch";
    el.style.background = hex;
    el.title = `${hex} (image color)`;
    el.addEventListener("click", () => selectChar(ch, el));
    localSwatchesEl.appendChild(el);
  }
}

function selectChar(char, el) {
  selectedChar = char;
  setTool("paint");
  for (const swatch of paletteEl.children) swatch.classList.remove("is-selected");
  for (const swatch of localSwatchesEl.children) swatch.classList.remove("is-selected");
  el.classList.add("is-selected");
}

// ---- sprite list / load ----

async function loadSpriteList() {
  const res = await fetch("/api/sprites");
  const sprites = await res.json();
  spriteSelect.innerHTML = '<option value="">— new —</option>';
  for (const s of sprites) {
    const opt = document.createElement("option");
    opt.value = s.name;
    opt.textContent = s.name;
    spriteSelect.appendChild(opt);
  }
}

spriteSelect.addEventListener("change", async () => {
  const name = spriteSelect.value;
  if (!name) {
    grid = makeBlankGrid();
    sourceGrid = null;
    setLocalPalette({});
    nameInput.value = "";
    loadedExisting = false;
    setColorCountMax(20);
    refresh();
    return;
  }
  const res = await fetch(`/api/sprites/${encodeURIComponent(name)}`);
  if (!res.ok) {
    setStatus("Could not load that sprite.", true);
    return;
  }
  const data = await res.json();
  grid = data.rows.map((row) => [...row]);
  sourceGrid = grid.map((row) => [...row]);
  setLocalPalette(data.localPalette ?? {});
  nameInput.value = data.name;
  loadedExisting = true;
  setColorCountMax(countDistinctColors(sourceGrid));
  setStatus(`Loaded: ${name}`);
  refresh();
});

// ---- import ----

function sanitizeName(raw) {
  return raw
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

importInput.addEventListener("change", async () => {
  const file = importInput.files[0];
  if (!file) return;
  const mode = importModeSelect.value === "conform" ? "conform" : "precise";
  setStatus("Importing...");
  try {
    const res = await fetch(`/api/import?mode=${encodeURIComponent(mode)}`, {
      method: "POST",
      body: file,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "import failed");
    grid = data.rows.map((row) => [...row]);
    sourceGrid = grid.map((row) => [...row]);
    setLocalPalette(data.localPalette);
    loadedExisting = false;
    spriteSelect.value = "";
    if (!nameInput.value) nameInput.value = sanitizeName(file.name);
    setColorCountMax(countDistinctColors(sourceGrid));
    const localCount = Object.keys(data.localPalette).length;
    const modeLabel = mode === "conform" ? "conform to palette" : "precise";
    setStatus(
      localCount > 0
        ? `Imported (${modeLabel}) — ${localCount} color(s) unique to this image.`
        : `Imported (${modeLabel}) — every pixel matched the shared palette.`,
    );
    refresh();
  } catch (err) {
    setStatus(`Import error: ${err.message}`, true);
  } finally {
    importInput.value = "";
  }
});

// ---- remove background (manual, on demand -- see the pipeline comments below) ----

function removeBackground() {
  const bgChars = new Set(
    [grid[0][0], grid[0][SIZE - 1], grid[SIZE - 1][0], grid[SIZE - 1][SIZE - 1]].filter(
      (c) => c !== ".",
    ),
  );
  if (bgChars.size === 0) {
    setStatus("All 4 corners are already transparent -- nothing to remove.");
    return;
  }
  let count = 0;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (bgChars.has(grid[y][x])) {
        grid[y][x] = ".";
        count++;
      }
    }
  }
  setStatus(`Background removed — ${count} pixel(s) cleared.`);
  refresh();
}

removeBgBtn.addEventListener("click", removeBackground);

// ---- maximize (scale content to fill the frame, proportions locked) ----

function contentBBox() {
  let minX = SIZE;
  let minY = SIZE;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (grid[y][x] === ".") continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return maxX < 0 ? null : { minX, minY, maxX, maxY };
}

function maximizeItem() {
  const bbox = contentBBox();
  if (!bbox) {
    setStatus("Nothing drawn to maximize.");
    return;
  }
  const { minX, minY, maxX, maxY } = bbox;
  const contentWidth = maxX - minX + 1;
  const contentHeight = maxY - minY + 1;
  if (contentWidth === SIZE && contentHeight === SIZE) {
    setStatus("The drawing already fills the whole frame.");
    return;
  }
  // Single uniform scale for both axes -- whichever dimension is proportionally larger caps the
  // scale, so the content grows as much as possible without stretching either axis differently
  // (locks proportions, per the ask). Inverse (destination -> source) mapping, same technique as
  // the sprite-scale/brush math elsewhere in this file, avoids sampling holes when scaling up.
  const scale = Math.min(SIZE / contentWidth, SIZE / contentHeight);
  const contentCenterX = (minX + maxX) / 2;
  const contentCenterY = (minY + maxY) / 2;
  const frameCenter = (SIZE - 1) / 2;
  const source = grid;
  const next = makeBlankGrid();
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const srcX = Math.round((x - frameCenter) / scale + contentCenterX);
      const srcY = Math.round((y - frameCenter) / scale + contentCenterY);
      if (srcX >= 0 && srcX < SIZE && srcY >= 0 && srcY < SIZE) {
        next[y][x] = source[srcY][srcX];
      }
    }
  }
  grid = next;
  setStatus(`Maximized — scale ${scale.toFixed(2)}x, proportions kept.`);
  refresh();
}

maximizeBtn.addEventListener("click", maximizeItem);

// ---- tools (paint vs move) ----

function setTool(next) {
  tool = next;
  canvas.style.cursor = tool === "move" ? "grab" : "crosshair";
  render();
}

// ---- painting ----

function cellFromEvent(evt) {
  const rect = canvas.getBoundingClientRect();
  const x = Math.floor(((evt.clientX - rect.left) / rect.width) * SIZE);
  const y = Math.floor(((evt.clientY - rect.top) / rect.height) * SIZE);
  if (x < 0 || x >= SIZE || y < 0 || y >= SIZE) return null;
  return [x, y];
}

function paintAt(evt) {
  const cell = cellFromEvent(evt);
  if (!cell) return;
  const [cx, cy] = cell;
  if (lastPaintedCell && lastPaintedCell[0] === cx && lastPaintedCell[1] === cy) return;
  lastPaintedCell = [cx, cy];

  const half = Math.floor((brushSize - 1) / 2);
  for (let dy = 0; dy < brushSize; dy++) {
    const y = cy - half + dy;
    if (y < 0 || y >= SIZE) continue;
    for (let dx = 0; dx < brushSize; dx++) {
      const x = cx - half + dx;
      if (x < 0 || x >= SIZE) continue;
      grid[y][x] = selectedChar;
    }
  }
  refresh();
}

// ---- move tool (pan the drawing within the fixed 64x64 frame) ----

function shiftGrid(source, dx, dy) {
  const next = makeBlankGrid();
  for (let y = 0; y < SIZE; y++) {
    const srcY = y - dy;
    if (srcY < 0 || srcY >= SIZE) continue;
    for (let x = 0; x < SIZE; x++) {
      const srcX = x - dx;
      if (srcX < 0 || srcX >= SIZE) continue;
      next[y][x] = source[srcY][srcX];
    }
  }
  return next;
}

canvas.addEventListener("mousedown", (evt) => {
  if (tool === "move") {
    moving = true;
    moveStart = [evt.clientX, evt.clientY];
    moveSourceGrid = grid.map((row) => [...row]);
    canvas.style.cursor = "grabbing";
    return;
  }
  painting = true;
  lastPaintedCell = null;
  paintAt(evt);
});
canvas.addEventListener("mousemove", (evt) => {
  hoverCell = cellFromEvent(evt);
  if (painting) {
    paintAt(evt);
    return;
  }
  render();
});
window.addEventListener("mousemove", (evt) => {
  if (!moving) return;
  const rect = canvas.getBoundingClientRect();
  const dx = Math.round(((evt.clientX - moveStart[0]) / rect.width) * SIZE);
  const dy = Math.round(((evt.clientY - moveStart[1]) / rect.height) * SIZE);
  grid = shiftGrid(moveSourceGrid, dx, dy);
  refresh();
});
window.addEventListener("mouseup", () => {
  painting = false;
  lastPaintedCell = null;
  if (moving) {
    moving = false;
    moveSourceGrid = null;
    if (tool === "move") canvas.style.cursor = "grab";
  }
});
canvas.addEventListener("mouseleave", () => {
  painting = false;
  lastPaintedCell = null;
  hoverCell = null;
  render();
});

// ---- view zoom via Shift + mouse wheel (Ctrl+/Ctrl- is intercepted by the browser's page zoom) ----
// Display-only: resizes how big the canvas renders on screen (CSS size, image-rendering:
// pixelated keeps edges crisp). Never touches `grid` -- the art and its pixel count are
// untouched, this only makes pixels easier to see/paint at different sizes.

canvas.addEventListener(
  "wheel",
  (evt) => {
    if (!evt.shiftKey) return;
    evt.preventDefault();
    // Shift+wheel is often remapped to horizontal scroll by the OS/browser before it reaches JS,
    // so deltaY can be ~0 with the motion showing up in deltaX instead -- check both.
    const delta = evt.deltaY !== 0 ? evt.deltaY : evt.deltaX;
    setViewScale(viewScale * (delta < 0 ? VIEW_ZOOM_STEP : 1 / VIEW_ZOOM_STEP));
  },
  { passive: false },
);

nameInput.addEventListener("input", updateCssPreview);

// ---- brush size ----

function setBrushSize(n) {
  brushSize = Math.min(BRUSH_MAX, Math.max(BRUSH_MIN, n));
  brushSizeInput.value = String(brushSize);
  brushSizeValueEl.textContent = `${brushSize}px`;
  render();
}

brushSizeInput.addEventListener("input", () =>
  setBrushSize(Number.parseInt(brushSizeInput.value, 10)),
);

// ---- view scale (how big pixels render, not what the art is) ----

function setViewScale(scale) {
  viewScale = Math.min(VIEW_SCALE_MAX, Math.max(VIEW_SCALE_MIN, scale));
  const displaySize = Math.round(BASE_DISPLAY_SIZE * viewScale);
  canvas.style.width = `${displaySize}px`;
  canvas.style.height = `${displaySize}px`;
  setStatus(`Zoom: ${Math.round(viewScale * 100)}%`);
}

// ---- color simplify (reduce the drawing to its N most-used colors) ----

function countDistinctColors(sourceGridToCount) {
  const seen = new Set();
  for (const row of sourceGridToCount) {
    for (const ch of row) {
      if (ch !== ".") seen.add(ch);
    }
  }
  return Math.max(COLOR_COUNT_MIN, seen.size);
}

// The slider's ceiling is however many distinct colors the current sprite actually has (global +
// local combined), not a fixed constant -- precise/conform imports can bring in far more than the
// 20 shared tokens, and a stale fixed cap would silently prevent "no reduction" from meaning
// "no reduction."
function setColorCountMax(max) {
  colorCountMax = Math.max(COLOR_COUNT_MIN, max);
  colorCountInput.max = String(colorCountMax);
  setColorCount(colorCountMax);
}

function setColorCount(n) {
  const clamped = Math.min(colorCountMax, Math.max(COLOR_COUNT_MIN, n));
  colorCountInput.value = String(clamped);
  colorCountValueEl.textContent = `${clamped} colors`;
}

function applyColorCount(n) {
  if (!sourceGrid) return;
  if (n >= colorCountMax) {
    grid = sourceGrid.map((row) => [...row]);
    refresh();
    return;
  }

  const counts = new Map();
  for (const row of sourceGrid) {
    for (const ch of row) {
      if (ch === ".") continue;
      counts.set(ch, (counts.get(ch) ?? 0) + 1);
    }
  }
  const kept = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([ch]) => ch);
  const keptSet = new Set(kept);

  const nearestKept = (ch) => {
    const [r, g, b] = rgbFor(ch);
    let best = ch;
    let bestDist = Number.POSITIVE_INFINITY;
    for (const candidate of kept) {
      const [cr, cg, cb] = rgbFor(candidate);
      const dist = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2;
      if (dist < bestDist) {
        bestDist = dist;
        best = candidate;
      }
    }
    return best;
  };
  const remap = new Map();

  grid = sourceGrid.map((row) =>
    row.map((ch) => {
      if (ch === "." || keptSet.has(ch)) return ch;
      if (!remap.has(ch)) remap.set(ch, nearestKept(ch));
      return remap.get(ch);
    }),
  );
  refresh();
}

colorCountInput.addEventListener("input", () => {
  const n = Number.parseInt(colorCountInput.value, 10);
  colorCountValueEl.textContent = `${n} colors`;
  applyColorCount(n);
});

// ---- keyboard shortcuts ----

function isTypingTarget(el) {
  return el && ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName);
}

window.addEventListener("keydown", (evt) => {
  if (isTypingTarget(document.activeElement)) return;

  if (evt.key === "[") {
    evt.preventDefault();
    setBrushSize(brushSize - 1);
    return;
  }
  if (evt.key === "]") {
    evt.preventDefault();
    setBrushSize(brushSize + 1);
    return;
  }
  if (evt.key === "e" || evt.key === "E") {
    evt.preventDefault();
    if (eraserEl) selectChar(".", eraserEl);
    return;
  }
  if (evt.key === "m" || evt.key === "M") {
    evt.preventDefault();
    if (tool === "move") {
      setTool("paint");
      setStatus("Mode: paint");
    } else {
      setTool("move");
      setStatus("Mode: move — drag to shift the drawing (M to exit)");
    }
  }
});

// ---- save ----

async function saveSprite(overwrite) {
  const name = nameInput.value.trim();
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
    setStatus("Invalid name — use lowercase letters, numbers, and hyphens.", true);
    return;
  }
  const rows = grid.map((row) => row.join(""));
  const res = await fetch(`/api/sprites/${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ width: SIZE, height: SIZE, rows, overwrite, localPalette }),
  });

  if (res.status === 409) {
    if (confirm(`"${name}" already exists. Overwrite?`)) await saveSprite(true);
    return;
  }
  const data = await res.json();
  if (!res.ok) {
    setStatus(`Save error: ${data.error || res.status}`, true);
    return;
  }
  loadedExisting = true;
  setStatus(`Saved: art/${name}.json`);
  await loadSpriteList();
  spriteSelect.value = name;
}

saveBtn.addEventListener("click", () => saveSprite(loadedExisting));

// ---- init ----

(async function init() {
  await loadPalette();
  await loadSpriteList();
  setBrushSize(brushSize);
  setColorCountMax(20);
  refresh();
})();
