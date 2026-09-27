import { Plugin } from "@opencode/plugin"
import type { ToolContext } from "@opencode/plugin/promise/tool"
import { z } from "zod"
import { loadOpenAIAuth } from "./auth"
import { blenderTool } from "./blender"
import { callViaCodexResponses } from "./codex"
import { readReferenceImages, resolveReferences } from "./input-image"
import { resolveOutputPath, saveGeneratedImage } from "./output-image"
import { requireLocalPaths } from "./permissions"
import { assertToolPermission } from "./tool-permission"

const argsSchema = z
  .object({
    prompt: z.string().min(1),
    out: z.string().min(1),
    quality: z.enum(["low", "medium", "high", "auto"]),
    size: z.string().optional(),
    references: z
      .array(
        z
          .object({
            path: z.string(),
            role: z.enum(["edit-target", "style", "subject", "material", "composition"]),
            preserve: z.string().optional(),
          })
          .strict(),
      )
      .max(8)
      .optional(),
  })
  .strict()

// The published package targets a V2 host with cancellable Promise tool
// executors and leaf permission assertions. @opencode/plugin 2.0.10 is pinned
// for Bun's two-day release-age policy; its types predate those host capabilities.
export function toolSignal(context: ToolContext): AbortSignal {
  const signal = (context as ToolContext & { signal?: AbortSignal }).signal
  if (!signal) throw new Error("OpenCode V2.0.18 or newer is required for cancellable image tools.")
  return signal
}

export default Plugin.define({
  id: "opencode-gpt-imagegen",
  async setup(ctx) {
    const allowExternalPaths = ctx.options.allow_external_paths === true
    const sessionDirectory = async (sessionID: string) => (await ctx.session.get({ sessionID })).location.directory

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "gpt_imagegen",
        description: [
          "Generate raster images using OpenAI's hosted image_generation tool.",
          "Use for AI-created bitmap visuals such as photos, illustrations, textures, sprites, and mockups.",
          "Do not use for SVG/vector/code-native graphics or when the image-material-development skill is not applicable.",
          "Attach up to 8 ordered reference images, each with a role and optional preservation guidance.",
          "One V2 tool-level permission can be approved once or saved with Allow always; paths must stay inside this OpenCode location unless the owner enables allow_external_paths.",
          "Requires an active OpenAI ChatGPT OAuth connection. Returns the saved PNG path; never overwrites an existing file.",
        ].join(" "),
        input: {
          type: "object",
          properties: {
            prompt: { type: "string", minLength: 1, description: "Description of the image to generate." },
            out: {
              type: "string",
              minLength: 1,
              description: "PNG output path, relative to this location unless absolute.",
            },
            quality: { type: "string", enum: ["low", "medium", "high", "auto"] },
            size: { type: "string", description: "Optional auto or WIDTHxHEIGHT image size." },
            references: {
              type: "array",
              maxItems: 8,
              items: {
                type: "object",
                properties: {
                  path: { type: "string" },
                  role: { type: "string", enum: ["edit-target", "style", "subject", "material", "composition"] },
                  preserve: { type: "string" },
                },
                required: ["path", "role"],
                additionalProperties: false,
              },
              description: "Ordered reference paths with roles and optional preservation guidance.",
            },
          },
          required: ["prompt", "out", "quality"],
          additionalProperties: false,
        },
        options: { permission: "gpt_imagegen" },
        async execute(input, context) {
          const args = argsSchema.parse(input)
          const signal = toolSignal(context)
          signal.throwIfAborted()
          const directory = await sessionDirectory(context.sessionID)
          const references = await resolveReferences(args, directory)
          const out = await resolveOutputPath(args.out, directory)
          await requireLocalPaths(
            directory,
            [...references.map((reference) => reference.path), out],
            allowExternalPaths,
          )
          await assertToolPermission(ctx.permission, context, "gpt_imagegen", signal)
          signal.throwIfAborted()
          const auth = await loadOpenAIAuth(ctx)
          if (!auth) throw new Error("An active OpenAI ChatGPT OAuth connection is required.")

          const images = await readReferenceImages(
            references.map((reference) => reference.path),
            directory,
            signal,
          )
          const base64 = await callViaCodexResponses(auth, args, images, signal)
          signal.throwIfAborted()
          const { savedPath, versioned, message, width, height } = await saveGeneratedImage(
            out,
            directory,
            base64,
            async (candidate) => {
              signal.throwIfAborted()
              await requireLocalPaths(directory, [candidate], allowExternalPaths)
            },
          )
          const requested = args.size?.match(/^(\d+)x(\d+)$/)
          const mismatch = requested && (Number(requested[1]) !== width || Number(requested[2]) !== height)
          return {
            content: mismatch
              ? `${message} Requested ${args.size}, but the provider returned ${width}x${height}; no resizing was performed.`
              : message,
            metadata: { out: savedPath, versioned, billing: "subscription", width, height, requestedSize: args.size },
          }
        },
      })
      editor.add(blenderTool(sessionDirectory, allowExternalPaths, toolSignal, ctx.permission))
    })
  },
})
