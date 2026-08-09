# Drawing Workflow — Image → JSON Pixel Grid → CSS

How to get a sprite from "an idea" to a working `box-shadow` CSS class. Three paths, pick whichever
fits what you're starting from.

## Path A — palette-locked pixel editor (cleanest result)
**Tool: [Lospec Pixel Editor](https://pixeleditor.lospec.com)** — free, browser-based, no install.
Use it because it can lock the canvas to an exact palette, so it's physically impossible to draw an
off-palette color. For multi-frame animation, **[Piskel](https://www.piskelapp.com)** has the same
palette-lock idea plus real frame/timeline support.

1. **New canvas: 64×64 px** (the default this tool ships tuned for — see `--size=N` below if you
   want a different grid size).
2. **Load the palette: drag `art/palette.hex` onto the palette button.** It's a plain-text file, one
   6-digit hex code per line, no `#` — Lospec's own `.hex` export format. Lock the canvas to it.
3. **Draw.** Leave anything outside the sprite **fully transparent**, not white/background-colored.
4. **Export → PNG**, 1x scale, no smoothing.
5. **Convert:**
   ```
   npm run grid:from-png -- path/to/file.png sprite-name
   ```
   Default `--mode=precise` keeps your exact colors, even if a couple of stray anti-aliased pixels
   drift slightly off the locked palette — they just land in the sprite's own `localPalette`
   instead of forcing a snap (see "Precise vs. conform" below).

## Path B — any image (AI-generated, screenshots, anything not pre-sized/pre-palette-locked)
The converter fits whatever you give it into the grid — it does **not** auto-crop and does **not**
auto-remove a background color. **Trim UI chrome, palette swatch bars, and decorative borders out
of the source image yourself first**; the pipeline assumes what you hand it is already reasonably
framed with a real alpha channel (an earlier auto-crop/auto-background-removal design was removed —
the crop heuristic could clip real artwork, and the background-color guess could be wrong in ways
that were hard to predict). If a source still has an opaque background baked in, use the sprite
editor's **"Remove background"** button after importing (Path C) instead — a one-click, on-demand
action rather than an automatic guess. Once the source is framed:

```
npm run grid:from-png -- path/to/file.png sprite-name --mode=precise --debug
```

What it does automatically:
1. **Fits the whole image into 64×64** (or `--size=N`) with nearest-neighbor sampling, preserving
   the original aspect ratio and padding with transparency rather than cropping or stretching — the
   whole drawing always ends up inside the frame, never clipped or distorted.
2. **Colors each pixel per `--mode`** (see below) — only the alpha channel counts as transparency,
   no background-color guessing.
3. **`--debug` writes `art/<name>.debug.png`** — the exact JSON rendered back out at a larger size,
   so you can look at the result before trusting it. Do this every time on Path B.

## Precise vs. "conform to palette" — the two color modes

Neither mode forces every pixel onto only the palette's shared tokens — colors outside that set
land in the sprite's own `localPalette` (stored alongside `rows` in `art/<name>.json`, rendered as
raw hex in the generated CSS instead of a `var(--color-x)`). Pick with `--mode=`:

- **`precise`** (default) — keeps each pixel's exact sampled color. Best when the source is already
  well-composed (a real photo reference, clean AI-generated art) and you want the actual
  shading/gradient detail preserved, not flattened.
- **`conform`** — recolors every pixel to the nearest palette family's hue/saturation while keeping
  that pixel's own lightness, generating tones/subtones that read as "your palette" without
  flattening every pixel to one fixed shade. Use this when the source's colors don't relate to your
  palette at all and you want it pulled toward your palette's families instead.

Both are also available live in the sprite editor (Path C) as a dropdown at import time, so you can
try one, see the result, and re-import with the other if it doesn't look right — no CLI round-trip
needed.

## Path C — the sprite editor (pixel-level touch-up, and the way to actually fix a bad import)
**`npm run sprite-editor`** opens a local page. Import via the same button (runs the exact Path B
pipeline server-side; pick **precise** or **conform to palette** from the dropdown next to it),
then:
- **Click individual pixels to repaint them** from either the shared palette panel or the sprite's
  own "Image colors" panel (its `localPalette`, populated automatically by import), or erase to
  transparent (`E`).
- **"Remove background"** clears any pixels matching one of the drawing's 4 corner colors — the
  manual replacement for auto-background-removal (see Path B above for why that's opt-in).
- **"Maximize item"** scales the drawing up to fill as much of the frame as possible in one step,
  without distorting its proportions — useful after an import that landed with a lot of empty
  letterboxed space.
- Brush size (`[`/`]`), move tool (`M`), zoom (Shift+wheel), and a color-count slider (reduces to
  the N most-used colors, recomputed from the last import/load so it never compounds quality loss)
  round out the toolset.

Type a name, hit Save, and it writes `art/<name>.json` directly. The same page can also **open any
existing `art/*.json` sprite** from a dropdown to keep refining it later. A live preview panel shows
the resulting `box-shadow` as you paint, so you can see it becoming real CSS — but what's actually
persisted/reloadable is the JSON, not that preview.

## Using your own palette instead of the shipped example
`art/legend.json` (char → CSS custom property name) and `art/palette.hex` (matching hex values, one
per line, same order) are the two files that define the palette — nothing else in the pipeline
hardcodes colors. To use your own:
1. Edit both files (keep their line/key order in sync — the loader throws if the counts don't
   match).
2. Restart the sprite editor / re-run the CLI — the palette is loaded fresh from these two files
   every time.
3. If you use `--mode=conform`, check `CONFORM_EXCLUDE`/`CONFORM_ACHROMATIC_VARS` near the top of
   `scripts/lib/pixel-grid.mjs` — add any of your own palette's UI-only/reserved tokens there if you
   don't want sprite content ever recoloring onto them.

## Why JSON as the source format, not PNG or SCSS directly
Kept JSON as the canonical, versioned, *editable* source: it's what `build-sprites.mjs` already
targets, a `box-shadow` list is generated from it directly, it's plain text (reviewable, and simple
shapes can be hand/AI-generated as coordinate math without any image tooling), and — critically for
the editor — it's the only one of the three formats that reloads cleanly into an editable pixel
grid. SCSS text would have to be parsed back apart to recover per-pixel data; JSON already *is* that
data. PNG/SCSS stay as *input*/*output* formats around JSON, never the stored source.
