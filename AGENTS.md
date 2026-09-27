# AGENTS.md

## Project Shape

- Bun is the package manager/runtime; use `bun install --frozen-lockfile` with the committed `bun.lock`.
- The plugin entry is `src/index.ts` (plugin wiring + tool schema); helpers live in role-based modules — `src/types.ts` (shared types), `src/auth.ts` (auth resolution), `src/input-image.ts` (reference image reading), `src/output-image.ts` (non-overwriting save + message), `src/codex.ts` (Codex backend call + SSE parsing).
- `bun run build` bundles `src` into `dist/index.js` with external runtime packages. The V2-only entrypoint uses `@opencode/plugin` 2.0.10 (the newest version allowed by the two-day install policy at migration time) and requires an OpenCode host at least 2.0.18 for tool cancellation. No V1 plugin API is retained.
- `dist/` is ignored locally but is the publish artifact (just `index.js`). Run `bun run build` before inspecting package output.
- `bunfig.toml` enforces `install.minimumReleaseAge = 172800` (2 days): newer versions are filtered out by `bun install` / `bun add` / `bun outdated`. Read the file before assuming a different delay.

## Commands

- Tests are split by kind: `tests/unit/` (helper-module unit tests) and `tests/e2e/` (one file per auth path, e.g. `subscription.test.ts`).
- `bun run typecheck` runs `tsc --noEmit` over `src` and `tests`.
- `bunx biome ci .` is the CI formatter/linter check.
- `bun run check` runs `biome check --write .`; it may modify files.
- `bun run test` runs `bun test tests/unit` — unit tests only, and is what CI uses. (A bare `bun test` would also discover the e2e files under `tests/e2e/` and try to run them for real, so prefer the script.)
- `bun run test:e2e_subscription` sets `OPENCODE_MODEL=openai/gpt-5.5` and runs `tests/e2e/subscription.test.ts` (ChatGPT subscription / OAuth path). It can take minutes because it calls `opencode run` and generates real images. The future API-key path gets its own `test:e2e_apikey` script + `tests/e2e/apikey.test.ts`.
- Each e2e path is its own script (its own `bun test` process), which also avoids the unit-test `process.env` leak into the single-process e2e `opencode` spawn.
- CI runs `bun run typecheck`, `bunx biome ci .`, and `bun run test`. The e2e suites are not run in CI's default checks (they need real auth + generations); they are invoked separately via their `test:e2e_*` scripts.

## E2E Requirements

- E2E suites run in a temporary workdir and require an active V2 OpenAI ChatGPT OAuth integration connection. Do not inspect or import legacy credential files.
- The e2e tests assert that produced files are valid PNGs and cover the plugin's output auto-versioning behavior.

## Implementation Notes

- The exposed tool is `gpt_imagegen`; it calls the ChatGPT Codex responses endpoint with the hosted `image_generation` tool.
- Output paths are resolved relative to the OpenCode context directory unless absolute, and existing files are never overwritten; suffixes `-v2` through `-v999` are tried.
- Reference images are read from paths relative to the OpenCode context directory and are embedded as data URLs after MIME detection.

## Publishing

- `package.json` `files` intentionally allowlists `index.js`, `dist`, the fixed `scripts/blender_asset.py`, the image-material skill, the security review, `README.md`, and `LICENSE`.
- `prepublishOnly` runs `bun run build`, so `npm publish` always rebuilds `dist/` first.
- Agent-authored changes stay on `OPENCODE` and are handed off through an unmerged PR to `main`. The human release owner decides when to merge, tag and publish; never run the release scripts during migration.
- The tag push triggers `.github/workflows/release.yml`, which runs `npm publish --provenance --access public` via npm OIDC trusted publisher (no `NPM_TOKEN` secret) and creates a GitHub release with auto-generated notes. The npm package must have GitHub Actions registered as a trusted publisher on npmjs.com for OIDC to work.
