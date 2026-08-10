# Contributing

Thanks for considering a contribution. This is a small, dependency-light tool, so the workflow is
intentionally lightweight.

## Getting set up

```bash
git clone https://github.com/icaromol/free-css-sprite-generator.git
cd free-css-sprite-generator
npm install
```

Requires **Node.js 20.9+** (the `sharp` dependency's minimum). `npm install` also runs `husky` via
the `prepare` script.

## Running things locally

There's no `dev`/`build`/`start` script — the project's three entry points are run directly:

| Command | What it does |
|---|---|
| `npm run sprite-editor` | Starts the local editor at `http://localhost:5787` (override with `PORT=<n>`). Auto-opens your browser. |
| `npm run grid:from-png -- <image> <name> [--size=64] [--mode=precise\|conform] [--debug]` | Headless CLI equivalent of the editor's import. |
| `npm run build:sprites` | Compiles every `art/*.json` sprite into `styles/sprites/_<name>.scss` + `styles/abstracts/_palette-tokens.scss` + `styles/sprites/_index.scss`. |

The first time you run either `npm run sprite-editor` or `npm run build:sprites`,
`art/legend.json` and `art/palette.hex` (your palette) are auto-created from the tracked
`*.example.*` templates — you don't need to do anything manually. See
[docs/drawing-workflow.md](docs/drawing-workflow.md) for the full editing workflow and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the pieces fit together.

## Code style

Formatting and linting are enforced by [Biome](https://biomejs.dev) (`biome.json`), not
ESLint/Prettier:

```bash
npm run check       # lint + format check, read-only
npm run check:fix   # same, but writes fixes
npm run lint         # lint only
npm run format        # format only, writes fixes
```

Run `npm run check` before opening a PR. Conventions to follow (already used throughout the
codebase):
- Plain JavaScript ES modules (`.mjs`), not TypeScript — no build/transpile step, and runtime files
  never change extension. Type-checking is opt-in via JSDoc + `tsconfig.json`'s `checkJs` (see
  below), not a full TS migration -- deliberately, since the build-free design is load-bearing (see
  [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)'s "Design principles").
- `camelCase` for functions/variables, `SCREAMING_SNAKE_CASE` for module-level constants.
- Functional/procedural style — no classes anywhere in the codebase.
- Comments explain *why*, not *what* (rationale, tradeoffs, footguns avoided), and often
  cross-reference the file/section that must stay in sync (e.g. "see `MIN_DIMENSION` in
  `pixel-grid.mjs`").
- Exported functions in `scripts/lib/pixel-grid.mjs` and `shared/color-reduce.mjs` carry JSDoc
  `@param`/`@returns` types, checked by `npm run typecheck` (`tsc --noEmit`, no emit, no effect on
  how anything runs). Add JSDoc types to new exports there; internal helpers and the rest of the
  codebase aren't required to be typed.
- Shared logic goes in `scripts/lib/pixel-grid.mjs` (Node-only) or `shared/` (needs to run in the
  browser too) rather than being duplicated between the CLI scripts and the editor server — see
  [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

**Windows note:** if `git config core.autocrlf` is `true`, `npm run check` may report line-ending
diffs on files you haven't touched. That's a checkout artifact (Biome expects LF), not a real
issue — don't "fix" it by committing CRLF changes to unrelated files.

## Tests

There is currently no automated test suite (no test framework or test files in the repo). Verify
changes manually:
1. Run `npm run check` — catches syntax/lint/format issues.
2. Run `npm run typecheck` — catches type/shape mismatches in the JSDoc-annotated exports.
3. Run `npm run sprite-editor` and exercise the feature you changed in the browser (import, paint,
   resize, color-reduce, save, export, as relevant).
4. Run `npm run build:sprites` and confirm the generated `styles/sprites/_*.scss` looks right.

If you're changing `scripts/lib/pixel-grid.mjs` or `shared/color-reduce.mjs`, test through **all
three** surfaces that depend on them (editor import, `grid:from-png`, `build:sprites`) — that
shared-pipeline design only pays off if nothing reimplements its own copy.

Mention what you tested and how in your PR description, since there's no CI to fall back on.

## Commit messages

This repo follows [Conventional Commits](https://www.conventionalcommits.org/): a lowercase type
prefix, colon, space, imperative-mood summary, no trailing period. No scopes. Examples from the
actual history:

```
feat: extend sprite size slider up to 2048px
fix: preserve aspect ratio on resize; redesign import/export controls
chore: gitignore generated styles/sprites/ output
```

Use `fix:`, `feat:`, `chore:` (seen so far), or other conventional-commit types (`docs:`,
`refactor:`) as appropriate.

## Opening a PR

There's no GitHub Actions CI and no PR template configured yet, so:
1. Fork/branch from `main`.
2. Keep the change focused — this is a small codebase, and unrelated cleanup makes review harder.
3. Run `npm run check` and do the manual verification above.
4. Open the PR with a description of *what* changed, *why*, and what you tested (see above).
5. If you're changing the palette format, the JSON pixel-grid schema, or anything documented in
   [docs/drawing-workflow.md](docs/drawing-workflow.md), update that doc in the same PR.

## Reporting bugs / suggesting features

Open a GitHub issue. Include Node.js version, OS, and exact steps to reproduce for bugs — since
there's no CI matrix, environment details are the main way to narrow down a platform-specific
issue.
