# Free CSS Sprite Generator

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
- **`art/legend.json` + `art/palette.hex`** — the shipped example palette (20 colors). Swap these
  two files for your own to use different colors — see
  [docs/drawing-workflow.md](docs/drawing-workflow.md#using-your-own-palette-instead-of-the-shipped-example).

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

Full walkthrough, both color-import modes, and how to bring your own palette:
[docs/drawing-workflow.md](docs/drawing-workflow.md).

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

## License
MIT — see [LICENSE](LICENSE).
