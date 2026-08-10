# Changelog

All notable changes to this project are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/); entries are derived from this repo's
[Conventional Commits](https://www.conventionalcommits.org/) history (`git log`). This project
hasn't cut a tagged release yet — everything so far is `1.0.0` per `package.json`.

## [Unreleased]

### Added
- `art/legend.example.json` and `art/palette.example.hex` — tracked starter palette templates
  (zero colors).

### Fixed
- `npm run sprite-editor` and `npm run build:sprites` no longer crash with `ENOENT` on a fresh
  `git clone`. `art/legend.json` and `art/palette.hex` are gitignored (they're per-project data),
  but nothing previously seeded them, so a clean checkout had no palette to load. They're now
  auto-created from the tracked example templates the first time either is missing
  (`scripts/lib/pixel-grid.mjs`'s `ensurePaletteFilesExist`).

### Documentation
- Added `CONTRIBUTING.md`, `docs/ARCHITECTURE.md`, and this changelog.
- Expanded `README.md` with badges, an explicit Installation section, requirements, and a project
  structure overview.

## [1.0.0] — 2026-08-09 to 2026-08-10

### Added
- Initial pixel-art sprite editor and CSS `box-shadow` code generator: draw or import a sprite,
  save it as a JSON pixel grid, generate `.sprite-<name>` CSS from it. (`8b68446`)
- Configurable sprite dimensions, full-resolution image import, and a personalizable shared
  palette. (`479cc43`)
- Square size slider, export as PNG/WebP/SCSS, "fit to art," and unsaved-changes guards in the
  editor. (`d65efc2`)
- Sprite size slider extended up to 2048px. (`c97400d`)

### Changed
- Import/export controls redesigned. (`d54dc6e`)
- Generated `styles/sprites/` output is now gitignored rather than committed. (`ae03b8a`)

### Fixed
- Resize now preserves aspect ratio instead of distorting the sprite. (`d54dc6e`)
- Palette reduction preserves perceptually distinct colors instead of merging them away. (`6317b20`)
- Color reduction always merges the most similar colors first, so a distinct color is only
  sacrificed once nothing more similar remains to merge — fixes cases where the previous fix
  (`6317b20`) could still lose a rare, distinct color if the merge order was unlucky. (`fcd1270`)
