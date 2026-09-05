# Security Review and Local Deployment

Review date: 2026-09-05. Upstream inspected: `6d87754110bcc810abda418d38e30ebed10eedd6`; published version: 0.1.12 (`ab5d219d5088f18c5326e32fe5774648ddb0f04b`).

No obvious malicious behavior was found in the reviewed source, scripts, or published plugin bundle. This is a point-in-time review, not a guarantee of safety, a full transitive dependency audit, or approval of future versions.

The upstream npm bundle matched a local build byte-for-byte (SHA-256 `37fc82bf739d0a87a8f6274ffe3b180d4d20c4d3381f5d7d89c0f5c483f32246`). Registry metadata advertised provenance and GitHub reported verified release commits; local signature verification was unavailable. Repository history and CI/release scripts were inspected. Dependencies were installed with lifecycle scripts disabled. Upstream typecheck, lint, build, 41 unit tests, and npm audit passed. These checks do not establish absence of malicious code in all dependencies.

## Trust Boundaries

- Image generation reads OpenCode's OAuth credentials and sends the access token, prompt, and selected image bytes to `https://chatgpt.com/backend-api/codex/responses`. It does not refresh expired tokens. This is an unofficial subscription integration; backend availability and plan limits may change.
- Reference images can contain private content and metadata. Only select images the user authorizes for upload. Read permission alone is not upload consent; the tool requests `gpt_imagegen` permission separately.
- Plugins run in-process with OpenCode's OS privileges. Permission requests honor OpenCode policy; `ask` is not a sandbox and can be overridden by project/agent policy or auto-approval modes. Do not use auto-approve when human approval is required.
- Canonical path checks and exclusive file creation reduce symlink and overwrite hazards but do not defend against every hostile concurrent ancestor-directory replacement. PNG validation checks the signature, not complete decoding.
- Generated prompt/reference metadata stays in permission/session context; the image tool does not automatically persist a sidecar. Session logs may contain sensitive prompts and paths.

## Fork Hardening

The local fork adds ordered role-based references, bounded image reads/responses, read/edit/upload permission requests, cancellation, request timeout, rejected HTTP redirects, PNG signature checks, private file permissions, and exclusive non-overwriting output creation.

The optional `gpt_blender` tool runs a bundled fixed Python script with Blender factory startup and auto-execution disabled. It accepts no arbitrary code, does not open supplied .blend files, and calls no paid API or MCP. It requests `blender_execute` approval before writing or spawning. It still executes the `blender` executable found on PATH, processes potentially untrusted image files, consumes CPU, and inherits the local process environment. It is not OS-sandboxed.

Blender must be installed separately after human approval. Only a UV plane, cube, or sphere with supplied material maps is supported. Mesh reconstruction, custom modeling, displacement, and baking need separately approved tooling. Paid services require separate operator approval and a budget; no MCP server is implicitly trusted.

## Deployment

Use a local build of this fork, not the upstream npm package or a moving remote branch. Install with `bun install --frozen-lockfile --ignore-scripts`, then `bun run build`. Register its absolute `dist/index.js` file URL in global OpenCode config and its `skills` directory under `skills.paths`. The Python script must stay at `scripts/blender_asset.py` relative to the package root; it is included in the package allowlist.

Keep `gpt_imagegen`, `gpt_blender`, `blender_execute`, and Blender MCP tool names set to `ask`. Recheck effective project/agent policy before use. Denying a request is final; do not route around it with another tool.

The package is private to prevent accidental publication under the upstream npm name. GitHub fork creation does not publish local modifications. Review changes and explicitly commit/push if remote publication is desired. Re-audit before updating dependencies or upstream code. Restart OpenCode after configuration changes.
