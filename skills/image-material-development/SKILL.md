---
name: image-material-development
description: Use for raster image generation, reference-guided edits, seamless textures, material maps, and optional human-approved Blender starter meshes, material previews, and GLB exports. Not for ordinary SVG, CSS, or code-native graphics.
---

# Image and Material Development

This workflow uses the fork's `gpt_imagegen` tool, not OpenAI's native `image_gen` tool. It borrows the native skill's inspect, specify, generate, inspect, and iterate workflow without assuming native edit or mask capabilities.

## Choose the Workflow

1. Inspect the project's existing assets and the supplied images using an available image viewer. If visual inspection is unavailable, say so rather than claiming to have inspected them.
2. Distinguish a new image, a reference-guided edit, a tileable texture, a material set, or a geometry task. Keep code-native vectors in their native format when that better fits the request.
3. Establish deliverable paths, intended engine/use, reference roles, preservation requirements, and the number of variants. Use one generation per requested asset, not an open-ended retry loop.
4. Use `gpt_imagegen` for raster assets. Reference-guided edits are probabilistic: exact pixel preservation, identity, transparency, dimensions, and seamless tiling must be checked, not promised. There is no binary-mask inpainting parameter.
5. Use Blender only when the human explicitly approves the described operation. An image or texture request does not imply permission to run Blender, MCP, or paid mesh services.

## References and Iteration

Use `references`, an ordered array of `{path, role, preserve?}`. Roles are `edit-target`, `style`, `subject`, `material`, and `composition`. There is no legacy `images` argument. Maximum 8 images, 20 MiB per image, 50 MiB total.

```json
{
  "prompt": "Change only the jacket material to woven linen. Keep the subject, silhouette, pose, background, and lighting unchanged. Image 2 guides the weave, not the composition.",
  "out": "assets/jacket-linen.png",
  "quality": "medium",
  "references": [
    {"path": "assets/jacket.png", "role": "edit-target", "preserve": "face, silhouette, pose, framing, background"},
    {"path": "refs/linen.png", "role": "material", "preserve": "weave scale and fiber color"}
  ]
}
```

The tool appends numbered labels in attachment order. Describe each reference's intended role and resolve conflicting references explicitly. Files are uploaded to ChatGPT only after the configured permissions allow the call. Never read, print, or copy OAuth credentials yourself.

For an iteration, use the returned absolute output path as the next `edit-target`; repeat the invariants and change one thing at a time. Do not assume there is an implicit image-history store or asset-ID lookup. Preserve versioned siblings; never rename a versioned result over the original without approval.

Use a compact prompt specification when useful:

```text
Purpose and deliverable:
Primary request:
Reference roles (Image 1, Image 2, ...):
Composition / projection:
Material / scale / lighting:
Change only:
Preserve:
Avoid:
```

Inspect every selected output before accepting it. Record the final prompt, ordered reference paths/roles, output path, requested settings, and validation results in the delivery summary. If a reproducibility sidecar is wanted, ask before saving prompts or private reference paths; fixed seeds and reproducible pixels are not supported.

## Textures and Materials

For a tileable base-color texture, specify top-down/orthographic projection, surface scale, flat neutral illumination, edge continuity, and no baked shadows, specular highlights, perspective, text, borders, or isolated focal objects. Inspect a 2x2 or 3x3 repeated preview before claiming it is seamless. If no tiling-preview tool is available, report tiling as unverified.

For material sets, agree resolution, UV alignment, physical scale, channel layout, target engine, and normal convention first. Preserve the albedo as the appearance reference. Independently generated maps are proposals, not a coherent physically based material.

- Albedo/base color: sRGB, without illumination baked into the texture.
- Roughness: linear/Non-Color, white rough and black smooth.
- Metallic: linear/Non-Color, generally 0 for dielectrics and 1 for exposed metals, not a brightness map.
- Normal: linear/Non-Color, explicitly tangent-space OpenGL/+Y for this Blender tool. Do not feed DirectX/-Y maps without a deliberate conversion.
- Height/displacement: linear scalar data with agreed scale and midlevel. The bundled Blender starter workflow does not support displacement.
- AO: optional separate map; do not multiply it into albedo by default. The bundled tool does not accept an AO slot.

Do not relabel an albedo image as a normal/roughness/height map. Prefer deterministic derivation or geometry baking where appropriate, with human approval for additional tooling. Inspect seams, UV distortion, color spaces, highlights, and map alignment under more than one light direction before describing a material as validated.

## Optional Blender

Explain the proposed geometry, texture inputs, output location, expected files, and cost before requesting approval. Blender itself and the bundled local script do not charge per call; local CPU time/electricity and the agent's model usage still have costs. MCP is a transport, not a pricing plan. Third-party mesh generators, cloud renderers, asset subscriptions, and their API calls may charge independently.

`gpt_blender` creates only a plane, cube, or sphere with UVs and optional supplied textures. It does not reconstruct arbitrary geometry from images. It uses a fixed script, factory startup, disabled auto-execution, and no user Python or existing .blend files. It requires Blender on PATH; do not install it automatically.

```json
{
  "name": "linen_preview",
  "output_dir": "assets",
  "primitive": "sphere",
  "albedo": "assets/linen-albedo.png",
  "roughness": "assets/linen-roughness.png",
  "normal": "assets/linen-normal-opengl.png"
}
```

`output_dir` must already exist. The V2 tool requests one `gpt_blender` invocation permission; it cannot request separate texture `read` or output `edit` permissions. Approving the tool also consents to reading its listed local textures and writing its output. Keep `gpt_blender` at `ask`; choose Allow once for an individual operation, or Allow always only after explicit human approval of a trusted ongoing workflow. Canonical path checks still apply. It creates a unique subdirectory containing a .blend scene, a selected-mesh .glb, preview.png, and manifest.json. Timeout is 120 seconds; partial files may remain after failure. Inspect results before claiming successful rendering or mesh usability.

For advanced geometry, UV editing, baking, or an external Blender MCP:

1. Present the proposed server/tool, operations, files it can access, local versus remote processing, and any third-party services. Unknown price means unknown, not free.
2. Obtain explicit human approval for setup and execution scope. A prior local Blender approval does not authorize MCP or paid API use.
3. Audit the server/add-on before installing or connecting. Keep tool permissions at `ask`; do not use auto-approve, change permissions, or bypass denial through bash/Python/another tool.
4. Obtain a separate budget and confirmation before any paid job or expanded scope. Stop rather than automatically retrying paid operations.

This skill never installs or enables MCP or paid services automatically. If the approved capability is unavailable, report the blocker. Do not substitute an unapproved service.

On this workstation, the official Blender Lab MCP has been separately installed as `blender_official` but is disabled in OpenCode. Blender 5.2.1 and the MCP add-on are installed with bridge auto-start off. Local setup and risk notes are in `/home/atlas/.local/share/opencode/blender-mcp-install/README.md`. Obtain explicit approval before activation; this server executes unrestricted Python, unlike the limited `gpt_blender` primitive workflow. Never enable it or bypass its tool approvals merely because it is installed.

## Delivery

Report actual saved paths, references used, final prompts, iteration count, and what was visually or mechanically checked. Distinguish generated concept art, starter meshes, and production assets. Do not claim Blender render/export validation when Blender was unavailable, or claim native OpenAI skill parity.
