# Architecture

How the pieces of this repo fit together, and why they're shaped the way they are. For the
end-user workflow (how to actually draw/import a sprite), see
[docs/drawing-workflow.md](drawing-workflow.md) instead — this document is about the code, not the
UI.

## Design principles

- **No framework, no bundler, no build step for the app itself.** The editor is vanilla
  JS/CSS/HTML served by a hand-rolled `node:http` server — no Vite/Webpack config, nothing to
  compile before the code runs. `tsconfig.json` exists, but only for opt-in `checkJs` type-checking
  (`npm run typecheck`) via JSDoc comments — it has `noEmit: true` and never transforms a file that
  actually runs. The only real "build" in this repo is `scripts/build-sprites.mjs`, and what it
  builds is the *output* (SCSS), not the app.
- **One implementation, not several drifting copies.** Three different entry points
  (`scripts/png-to-grid.mjs`, `scripts/build-sprites.mjs`, `tools/sprite-editor/server.mjs`) all
  need to convert images to pixel grids and grids to CSS. Instead of each reimplementing that,
  they all import the same functions from `scripts/lib/pixel-grid.mjs`. This is stated explicitly
  in that file's header comment and is the single most load-bearing structural decision in the
  codebase — most bugs in the git history (see [CHANGELOG.md](../CHANGELOG.md)) were fixed once,
  in that shared module, rather than three times.
- **JSON is the only canonical source format.** PNG and SCSS are input/output formats around it,
  never storage. See [docs/drawing-workflow.md](drawing-workflow.md#why-json-as-the-source-format-not-png-or-scss-directly)
  for the full rationale — the short version is that JSON is the only one of the three formats
  that reloads cleanly into an editable pixel grid.

## The three surfaces, one pipeline

```
┌─────────────────────┐   ┌──────────────────────┐   ┌───────────────────────────┐
│ tools/sprite-editor/ │   │ scripts/png-to-grid   │   │ scripts/build-sprites.mjs │
│ (interactive editor) │   │ .mjs (headless CLI)   │   │ (CSS "compile" step)      │
└──────────┬───────────┘   └───────────┬───────────┘   └─────────────┬─────────────┘
           │                           │                             │
           └───────────────┬───────────┘                             │
                            ▼                                        │
              scripts/lib/pixel-grid.mjs                             │
        (palette I/O, image→grid, grid→box-shadow/PNG/WebP/SCSS)     │
                            │                                        │
                            ▼                                        │
              shared/color-reduce.mjs  ◄── also imported directly ───┘
        (Lab-space color clustering,        by the browser (app.js), via
         used when an image exceeds         server.mjs's explicit static
         the local-palette pool)             route for /shared/color-reduce.mjs
```

`shared/color-reduce.mjs` lives outside `scripts/lib/` specifically because it has a third
consumer that isn't Node at all: the editor's "Simplify colors" slider runs the *exact same*
clustering code in the browser, so the live slider and the server-side import path can never
diverge into two different color-reduction algorithms. `tools/sprite-editor/server.mjs` serves it
at `/shared/color-reduce.mjs` as an explicit static route (rather than, say, letting a bundler
inline it) — there is no bundler.

## Core modules

### `scripts/lib/pixel-grid.mjs` — the shared pipeline
- **Palette I/O** (`loadPaletteEntries`, `computeDerivedPaletteState`, `reloadPaletteFromDisk`) —
  loads `art/legend.json` (char → CSS custom-property name) and `art/palette.hex` (matching hex
  values, same order) into a single in-memory palette. `reloadPaletteFromDisk` exists because
  `server.mjs` is long-lived: when the editor's add/delete-color endpoints rewrite the two files on
  disk, the running server needs to pick that up without a restart.
- **Palette bootstrap** (`ensurePaletteFilesExist`) — `art/` is gitignored, so a fresh clone has no
  `legend.json`/`palette.hex` for `loadPaletteEntries` to read. This function copies them from the
  tracked `art/legend.example.json` / `art/palette.example.hex` templates (both empty — zero
  colors) the first time either file is missing, so the app boots instead of crashing with `ENOENT`
  on a clean checkout. It runs once, at module load, before the first `loadPaletteEntries()` call.
  See [Generated vs. tracked files](#generated-vs-tracked-files) below.
- **Image → grid** (`imageInputToGrid`) — uses `sharp` to nearest-neighbor–fit an image into a
  `size×size` square (transparent letterbox, never crop/distort), then colors each pixel per
  `colorMode` (`precise` keeps the exact sampled color; `conform` recolors toward the nearest
  palette hue via `conformPixel`'s HSL math, keeping the pixel's own lightness). If an image has
  more distinct colors than the local-palette char pool (42 slots) can hold, it falls back to
  `reduceToFit`, which delegates to `shared/color-reduce.mjs`.
- **Grid → CSS** (`gridToBoxShadow`, `gridToScss`) — walks the grid and emits one
  `"Xpx Ypx <color>"` `box-shadow` entry per non-transparent pixel. Shared-palette colors become
  `var(--color-x)` references (or raw hex if `hexOnly`); local-only colors are always raw hex.
  Standalone SCSS exports always use `hexOnly: true`, since an export can't depend on this repo's
  `:root` custom properties.
- **Grid → raster** (`gridToRgba`, `writeGridImage`) — renders a grid to a flat RGBA buffer and
  encodes it via `sharp` as PNG/WebP, for the editor's debug renders and "Export as" feature.

### `shared/color-reduce.mjs` — perceptual color reduction
Deliberately dependency-free (no imports from Node builtins or npm packages) so the exact same code
can run in the browser and in Node. Converts sRGB to CIE Lab (`rgbToLab`) and uses CIE76 Delta-E
(`deltaE76`) instead of raw RGB distance, so hue/saturation differences aren't confused with
lightness differences. `reduceCandidates` does agglomerative merging that always merges the two
*most similar* colors first — so a rare, visually distinct color is only sacrificed once nothing
more similar remains to merge instead. This exact function backs both the editor's live
"Simplify colors" slider and the server-side import-time reduction (`reduceToFit`).

### `tools/sprite-editor/server.mjs` — the local server
A plain `node:http` server (no Express/Fastify). Serves static files from
`tools/sprite-editor/public/`, exposes a small REST-style API under `/api/*` (import, save, list,
export, palette add/delete), and routes `/shared/color-reduce.mjs` to the top-level `shared/`
module. Listens on `PORT` (default `5787`) and auto-opens a browser on start.

### `tools/sprite-editor/public/app.js` — the editor client
No framework, no state library — plain module-scope mutable variables (`grid`, `sourceGrid`,
`globalPalette`, `localPalette`, `selectedChar`, etc.) hold client state, and DOM event listeners
drive everything (paint, pan, zoom, keyboard shortcuts). The one deliberate internal architecture
choice: `sourceGrid` always holds the highest-fidelity data since the last import/load, and both
the size slider and the color-count slider recompute from it via `rebuildGridFromSource()` rather
than compounding changes on top of each other — so resizing down and back up, or simplifying
colors twice, doesn't lose more information than necessary. Persistence is entirely server-side
(`art/<name>.json` via the REST API); nothing is kept in browser storage.

### `scripts/build-sprites.mjs` — the CSS "compile" step
Reads every `art/*.json`, calls `gridToBoxShadow` for each, and writes one
`styles/sprites/_<name>.scss` per sprite, a generated `:root` custom-properties partial
(`styles/abstracts/_palette-tokens.scss`), and a generated `styles/sprites/_index.scss`
(`@forward` list + a `$available-sprites` map). Also prunes orphaned partials for sprites that were
deleted from `art/`.

## Data model

| Shape | Where | Structure |
|---|---|---|
| Sprite record | `art/<name>.json` | `{ name, width, height, rows: string[], localPalette: { [char]: "#hex" } }` |
| Palette entry | derived from `legend.json` + `palette.hex` | `{ char, hex, cssVar, rgb }` |
| Grid (working form) | in-memory, client + server | `string[][]` — `rows` split into char arrays for editing |
| Cluster/candidate | `shared/color-reduce.mjs` internals | `{ rgb, count, lab, members }`, reduced to a `representativeOf` map from original candidate → surviving medoid |

`rows` characters are either `.` (transparent), a char resolved via the shared palette
(`legend.json`), or a key in that sprite's own `localPalette` (a color that doesn't need to be
shared across sprites, stored as raw hex alongside the grid).

## Data flow

**Interactive (editor) path:**
1. Browser POSTs an image to `/api/import?mode=precise|conform`.
2. `server.mjs` calls `imageInputToGrid()`, which fits/colors the image and falls back to
   `shared/color-reduce.mjs` if there are too many distinct colors for the local-palette pool.
3. The response becomes both `grid` (live working copy) and `sourceGrid` (fidelity baseline) in
   `app.js`.
4. Edits (paint, resize, color-simplify) all funnel through `rebuildGridFromSource()`.
5. **Save** → `POST /api/sprites/:name` → server writes `art/<name>.json` verbatim — the canonical
   source.
6. **Export** → `POST /api/export/:format` → `gridToScss` (SCSS) or `writeGridImage` (PNG/WebP) →
   written to `exports/`.

**Headless/build path:**
1. `npm run grid:from-png -- image.png name` → `scripts/png-to-grid.mjs` → same
   `imageInputToGrid()` → writes `art/<name>.json`.
2. `npm run build:sprites` → `scripts/build-sprites.mjs` reads every `art/*.json`, calls
   `gridToBoxShadow()` (CSS-var form, not hex) for each, and writes the `styles/sprites/` output
   your own project consumes.

Both paths converge on the same `pixel-grid.mjs` functions — that convergence is the point.

## Generated vs. tracked files

Only a subset of what's on disk in a working copy is actually part of this repo. `art/`,
`exports/`, and `styles/sprites/` are gitignored (with `art/legend.example.json` and
`art/palette.example.hex` explicitly un-ignored — see `.gitignore`):

| Path | Tracked? | What it is |
|---|---|---|
| `art/legend.example.json`, `art/palette.example.hex` | ✅ tracked | Starter palette templates (zero colors) |
| `art/legend.json`, `art/palette.hex` | ❌ gitignored | Your real palette — bootstrapped from the templates above on first run |
| `art/*.json` | ❌ gitignored | Your sprites — project-specific data, not this repo's |
| `exports/` | ❌ gitignored | Standalone PNG/WebP/SCSS exports |
| `styles/sprites/` | ❌ gitignored | Generated SCSS output of `build-sprites.mjs` |
| `styles/abstracts/_palette-tokens.scss` | ✅ tracked | The example palette's generated `:root` tokens (checked in so the repo has *something* to show/consume before you generate your own) |

This split matters when reading the codebase: don't assume a sprite you see locally under `art/`
is part of the shipped repo, and don't be surprised that `art/legend.json` doesn't show up in
`git status` even after you edit it through the editor.

## Tooling

- **Linting/formatting**: [Biome](https://biomejs.dev) (`biome.json`) — replaces ESLint + Prettier
  in a single tool. 2-space indent, double quotes, 100-char line width.
- **Git hooks**: `husky` is a devDependency and `package.json`'s `prepare` script installs it, but
  `.husky/` itself is gitignored — no hook scripts are version-controlled or enforced today.
- **No CI**: there's no `.github/workflows/` — verification is manual (`npm run check` + running
  the app). See [CONTRIBUTING.md](../CONTRIBUTING.md).
