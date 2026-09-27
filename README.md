# OpenCode V2 GPT Image Generation

This fork provides two V2 tools: `gpt_imagegen` for reference-guided raster
image generation through an **active ChatGPT OAuth connection**, and optional
`gpt_blender` for a local starter primitive with supplied texture maps. It has
no V1 entrypoint, legacy credential-file reader, Blender MCP, or paid mesh API.

## Install locally

Build with Bun (the two-day release-age policy in `bunfig.toml` stays enabled):

```sh
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run build
```

Add the checkout **directory** to OpenCode V2's global `opencode.jsonc`, merging
with any existing plugins and settings:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/absolute/path/to/opencode-gpt-imagegen"],
  "permissions": [
    { "action": "gpt_imagegen", "resource": "*", "effect": "ask" },
    { "action": "gpt_blender", "resource": "*", "effect": "ask" }
  ],
  "skills": ["/absolute/path/to/opencode-gpt-imagegen/skills"]
}
```

Use the V2 permission prompt's **Allow once** or **Allow always** choice for
each tool. The latter avoids repeated prompts; it does not disable this
plugin's canonical path checks. This repo is private to prevent accidental
publication under the upstream npm name. Do not enable the package globally
until you have verified V2 OAuth, tool permission, cancellation and the
installed artifact in your environment.

### Paths and external override

By default, output and input paths must remain within the **executing
session's** OpenCode location, not the plugin's load directory. Symlink escapes
and sibling paths are rejected before image upload or Blender execution. If
the owner knowingly needs files outside the session location, use the V2
plugin options object:

```jsonc
{
  "plugins": [{
    "package": "/absolute/path/to/opencode-gpt-imagegen",
    "options": { "allow_external_paths": true }
  }]
}
```

This override is broad for that plugin instance; it is **not** a per-path
approval. Keep the tool permission at `ask` if a human must approve each
invocation, or disable the override. Do not use global auto-approval when
human authorization is required.

## `gpt_imagegen`

The tool takes `prompt`, `out`, `quality` (`low`, `medium`, `high`, or `auto`),
optional `size`, and up to eight ordered references. Use `images` for simple
legacy path lists **or** `references` with a `path`, a role (`edit-target`,
`style`, `subject`, `material`, or `composition`), and optional `preserve`
guidance; never both. References are uploaded to OpenAI's hosted Codex image
generation endpoint. The tool writes one PNG per call using exclusive
creation and versions existing names (`-v2` through `-v999`) rather than
overwriting. Requests are cancellable and bounded; subscription usage and
provider behavior depend on your account and OpenAI policy.

## `gpt_blender`

Requires Blender already on `PATH` and the separate `gpt_blender` tool
permission. The tool accepts a safe name, an existing output directory, a UV
`plane`, `cube`, or `sphere`, and optional local albedo, roughness, metallic,
and OpenGL/+Y normal textures. It launches Blender with factory startup,
automatic script execution disabled, a fixed bundled script and a 120-second
limit. A unique subdirectory receives `.blend`, `.glb`, a preview PNG, and a
manifest. It neither reconstructs meshes nor creates coherent PBR maps.

See [the current security review](SECURITY-REVIEW.md). This is an unofficial
third-party integration; follow OpenAI's Terms of Use and Usage Policies.
