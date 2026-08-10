# Free CSS Sprite Generator

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js >= 20.9](https://img.shields.io/badge/node-%3E%3D20.9-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Code style: Biome](https://img.shields.io/badge/code%20style-biome-60a5fa)](https://biomejs.dev)
[![No build step](https://img.shields.io/badge/build%20step-none-brightgreen)]()

A local pixel-art sprite editor and CLI that turns images into pure-CSS `box-shadow` sprites — no
raster images ship, no `<canvas>`, no SVG. Draw or import a sprite, get back a `.sprite-<name>`
CSS class you can drop straight into a stylesheet.

## Why box-shadow pixel art

A single 1×1px `div`, scaled up with `transform: scale()`, becomes one pixel block. Stack one
`box-shadow` entry per colored pixel on that same div and you get a full sprite — hundreds or
thousands of entries, but generated, never hand-written. It's a real, load-bearing CSS technique:
zero image requests, trivially recolorable via CSS custom properties, and every sprite is plain
text you can diff in git.

```css
.sprite-example {
  width: 1px;
  height: 1px;
  transform: scale(var(--sprite-scale, 8));
  transform-origin: top left;
  box-shadow:
    0px 0px var(--color-ink),
    1px 0px var(--color-ink),
    /* ...one entry per pixel... */;
}
```

## Requirements

- **Node.js 20.9+** (required by the `sharp` image-processing dependency)
- **npm** (the repo ships a `package-lock.json`; no yarn/pnpm lockfile)

No database, no network access, no account — everything runs and stores data on your machine.

## Installation

```bash
git clone https://github.com/icaromol/free-css-sprite-generator.git
cd free-css-sprite-generator
npm install
```

`npm install` also runs `husky` (via the `prepare` script) to set up local git hooks — safe to
ignore if you don't plan on committing to this repo directly.

## Quick start

```bash
npm install
npm run sprite-editor
# open the URL it prints, draw or import something, hit Save
npm run build:sprites
# styles/sprites/_<name>.scss now exists -- compile/consume it however your own project does CSS
```

Or skip the UI entirely:
```bash
npm run grid:from-png -- path/to/image.png my-sprite --debug
npm run build:sprites
```

Both commands work right out of a fresh clone: `art/legend.json` and `art/palette.hex` (your
color palette) don't ship in git — they're generated from
[`art/legend.example.json`](art/legend.example.json) and
[`art/palette.example.hex`](art/palette.example.hex) automatically the first time you run either
command. The starter palette has **zero colors** by design; add your own from the sprite editor's
"add new global color" form, or hand-edit the two files directly (see
[docs/drawing-workflow.md](docs/drawing-workflow.md#using-your-own-palette-instead-of-the-shipped-example)).

Full walkthrough, both color-import modes, and how to bring your own palette:
[docs/drawing-workflow.md](docs/drawing-workflow.md).

## What's in here

- **`tools/sprite-editor/`** — the actual editor. `npm run sprite-editor` opens a local page:
  import an image (auto-converted through the same pipeline as the CLI), paint/erase pixels by
  hand against a locked palette, save straight to `art/<name>.json`.
- **`scripts/png-to-grid.mjs`** — CLI equivalent of the editor's import: `image → art/<name>.json`.
- **`scripts/build-sprites.mjs`** — `art/*.json → styles/sprites/_<name>.scss`, one SCSS partial
  per sprite plus a generated `_index.scss` and the palette's `:root` custom properties.
- **`scripts/lib/pixel-grid.mjs`** — the shared pipeline underneath both (palette loading, image →
  grid conversion, grid → `box-shadow` generation). Not meant to be used directly, but readable if
  you want to understand or extend the pipeline.
- **`shared/color-reduce.mjs`** — perceptual color clustering/palette-reduction (used when a
  source image has more distinct colors than a sprite's local-palette slots can hold). Lives
  outside `scripts/lib/` specifically because it's shared with the *browser*, not just between
  Node scripts: the sprite editor's color-simplify slider imports it directly (served by
  `tools/sprite-editor/server.mjs` at `/shared/color-reduce.mjs`), so it has zero Node-only
  imports by design.
- **`art/legend.example.json` + `art/palette.example.hex`** — tracked starter templates (zero
  colors) that get copied to `art/legend.json` + `art/palette.hex` on first run. Those two real
  files, plus every `art/*.json` sprite, are gitignored — they're your project's data, not this
  repo's. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for why.

## Project structure

```
free-css-sprite-generator/
├── art/                        Your sprite data (gitignored except the two *.example.* files)
│   ├── legend.example.json     Tracked starter palette template (zero colors)
│   ├── palette.example.hex     Tracked starter palette template (zero colors)
│   ├── legend.json             Generated on first run -- your real palette (char -> CSS var)
│   ├── palette.hex             Generated on first run -- your real palette (hex values)
│   └── <name>.json             Your sprites, one JSON pixel-grid per sprite
├── docs/
│   ├── drawing-workflow.md     End-to-end guide: image -> JSON -> CSS, all three import paths
│   └── ARCHITECTURE.md         How the pipeline fits together and why
├── exports/                    Gitignored. Standalone PNG/WebP/SCSS exports from the editor
├── scripts/
│   ├── build-sprites.mjs       CLI: art/*.json -> styles/sprites/_<name>.scss
│   ├── png-to-grid.mjs         CLI: image -> art/<name>.json
│   └── lib/pixel-grid.mjs      Shared pipeline (palette I/O, image->grid, grid->CSS/PNG/WebP)
├── shared/
│   └── color-reduce.mjs        Perceptual color clustering, shared by Node and the browser
├── styles/
│   ├── abstracts/_palette-tokens.scss   Generated :root CSS custom properties (tracked)
│   └── sprites/                Gitignored. Generated per-sprite SCSS partials + _index.scss
├── tools/sprite-editor/
│   ├── server.mjs              Local HTTP server + REST API for the editor
│   └── public/                 Vanilla JS/CSS/HTML editor front end (no framework, no bundler)
├── biome.json                  Lint/format config (Biome -- replaces ESLint + Prettier)
├── CONTRIBUTING.md
├── CHANGELOG.md
└── package.json
```

## The JSON pixel-grid format

```json
{
  "name": "my-sprite",
  "width": 64,
  "height": 64,
  "rows": ["................", "....uu....uu....", "..."],
  "localPalette": { "x": "#ff00aa" }
}
```
Each character in `rows` is either `.` (transparent) or a char from `art/legend.json` (a shared
palette color) or `localPalette` (a color unique to this sprite, stored as raw hex). This is the
one format the pipeline treats as the canonical, editable source — PNG and SCSS are input/output
formats around it, never the stored source (see
[docs/drawing-workflow.md](docs/drawing-workflow.md#why-json-as-the-source-format-not-png-or-scss-directly)
for why).

## Contributing

Bug reports, palette ideas, and pipeline improvements are welcome — see
[CONTRIBUTING.md](CONTRIBUTING.md) for how to run the project locally, code style, and how to open
a PR.

## License
MIT — see [LICENSE](LICENSE).
