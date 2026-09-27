# Security Review and Local Deployment

Historical upstream review: 2026-09-05, commit `6d87754110bcc810abda418d38e30ebed10eedd6`, published version 0.1.12 (`ab5d219d5088f18c5326e32fe5774648ddb0f04b`). The V2-only fork migration was merged to this fork's `main`; it is **not covered** by that upstream signature or byte match. Further changes on `OPENCODE` still require review before a new release.

No obvious malicious behavior was found in the reviewed source, scripts, or published plugin bundle. This is a point-in-time review, not a guarantee of safety, a full transitive dependency audit, or approval of future versions.

The upstream npm bundle matched a local build byte-for-byte (SHA-256 `37fc82bf739d0a87a8f6274ffe3b180d4d20c4d3381f5d7d89c0f5c483f32246`). Registry metadata advertised provenance and GitHub reported verified release commits; local signature verification was unavailable. Repository history and CI/release scripts were inspected. Dependencies were installed with lifecycle scripts disabled. Upstream typecheck, lint, build, 41 unit tests, and npm audit passed. These checks do not establish absence of malicious code in all dependencies.

## Trust Boundaries

- Image generation resolves the **active V2 OpenAI ChatGPT OAuth integration connection** and sends its access token, prompt, and selected image bytes to `https://chatgpt.com/backend-api/codex/responses`. It neither reads old credential files nor refreshes expired tokens. This is an unofficial subscription integration; backend availability and plan limits may change.
- Reference images can contain private content and metadata. Only select images the user authorizes for upload. The `gpt_imagegen` action has one V2 leaf permission assertion; custom tools do not request extra read/edit permission for every file. Approving the tool also consents to its selected local references being uploaded. `options.permission` alone filters catalog visibility and does **not** authorize execution.
- Plugins run in-process with OpenCode's OS privileges. Tool permission `ask` is not an OS sandbox; project/agent rules and auto-approval may alter decisions. Default canonical-path enforcement restricts all selected inputs and outputs to the executing session's location. The `allow_external_paths` option broadly relaxes this check; it is not a per-path prompt.
- Canonical path checks and exclusive file creation reduce symlink and overwrite hazards but do not defend against every hostile concurrent ancestor-directory replacement. PNG validation checks the signature, not complete decoding.
- Tool results carry generated output paths; the image tool does not automatically persist a sidecar. Session logs may contain sensitive prompts and paths.

## Fork Hardening

The local fork adds ordered role-based references, bounded image reads/responses, explicit V2 leaf permission assertions, per-session canonical path checks, cancellation, request timeout, rejected HTTP redirects, PNG signature checks, private file permissions, and exclusive non-overwriting output creation. An older host without `ctx.permission.assert` fails closed before OAuth or Blender execution.

The optional `gpt_blender` tool runs a bundled fixed Python script with Blender factory startup and auto-execution disabled. It accepts no arbitrary code, does not open supplied .blend files, and calls no paid API or MCP. It uses its own V2 `gpt_blender` permission before execution. It still executes the `blender` executable found on PATH, processes potentially untrusted image files, consumes CPU, and inherits the local process environment. It is not OS-sandboxed.

Blender must be installed separately after human approval. Only a UV plane, cube, or sphere with supplied material maps is supported. Mesh reconstruction, custom modeling, displacement, and baking need separately approved tooling. Paid services require separate operator approval and a budget; no MCP server is implicitly trusted.

## Deployment

Use a local build of this fork, not the upstream npm package or a moving remote branch. Install with `bun install --frozen-lockfile`, run typecheck/tests/build, then register the **package directory** under V2 `plugins` and the skill directory under V2 `skills`. The Python script must stay at `scripts/blender_asset.py` relative to the package root; it is included in the package allowlist.

Keep `gpt_imagegen` and `gpt_blender` set to `ask` unless the owner elects V2's saved **Allow always** for a trusted workflow. Recheck effective project/agent policy before use. Denying a request is final; do not route around it with another tool.

The package is private to prevent accidental publication under the upstream npm name. GitHub fork creation does not publish local modifications. Review changes and explicitly commit/push if remote publication is desired. Re-audit before updating dependencies or upstream code. Restart OpenCode after configuration changes.

## V2 Dogfood (2026-09-27)

The V2-only package passed 81 unit tests, typecheck, Biome CI, build, and a packed-install smoke on an isolated private fork build exposing leaf assertions. The smoke invoked both tools through Code Mode under `ask`; headless OpenCode rejected each request before execution, with no OAuth, output files, Blender process, or paid generation. A separate one-time image approval reached the expected OAuth-missing gate without making a network call. A prior owner-approved no-reference ChatGPT OAuth call saved a 600-permission PNG at `/tmp/opencode/image-v2-dogfood-20260927/image-v2-verify.png`; its inspected content matched the test prompt. That call **preceded** the discovery that catalog visibility is not execution authorization, so it does not prove the new permission path. The provider returned 1254×1254 despite a 1024×1024 request. The tool reports actual dimensions and warns on a mismatch; no local resizing or second paid generation was performed.

One separately owner-approved, texture-free local Blender 5.2.1 UV-cube operation wrote a `.blend`, `.glb`, preview PNG, and manifest under `/tmp/opencode/image-v2-dogfood-20260927/v2_smoke_cube-seYmWI/`. The GLB header, PNG signature, compressed Blender project, manifest, and visual preview were checked. No Blender MCP or paid mesh service was enabled. The image/Blender plugin and its skill are currently **disabled globally** until the updated host is installed and the leaf authorization gate is verified there. Reference-guided OAuth generation is still untested live.
