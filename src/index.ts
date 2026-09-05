import * as path from "node:path"
import type { Hooks, Plugin, PluginInput, PluginModule } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { loadOpenAIAuth } from "./auth"
import { blenderTool } from "./blender"
import { buildGenerationPrompt, callViaCodexResponses } from "./codex"
import { readReferenceImages, resolveReferences } from "./input-image"
import { resolveOutputPath, saveGeneratedImage } from "./output-image"
import { askExternalDirectory } from "./permissions"

const GptImagePlugin: Plugin = async (_input: PluginInput): Promise<Hooks> => {
  return {
    tool: {
      gpt_blender: blenderTool,
      gpt_imagegen: tool({
        description: [
          "Generate raster images using OpenAI's hosted image_generation tool.",
          "Use for AI-created bitmap visuals such as photos, illustrations, textures, sprites, and mockups.",
          "Do not use when the task is better handled by editing existing SVG/vector/code-native assets, extending an established icon or logo system, or building the visual directly in HTML/CSS/canvas.",
          "Attach up to 8 reference images using `references` with ordered roles and optional preservation guidance, or the legacy `images` paths, never both. Limit: 20 MiB each and 50 MiB total.",
          "Reference roles guide generation; this is not a native exact-edit or mask interface and does not guarantee unchanged pixels.",
          "For many distinct assets, invoke gpt_imagegen once per requested asset rather than relying on multi-image output; gpt_imagegen returns one image per call.",
          "Requires OpenCode to be authenticated with ChatGPT OAuth. Returns the absolute path of the saved PNG.",
        ].join(" "),
        // https://developers.openai.com/api/docs/guides/image-generation
        args: {
          prompt: tool.schema.string().describe("Description of the image to generate."),
          out: tool.schema
            .string()
            .describe("Output file path, relative to the project directory unless absolute. The plugin writes a PNG."),
          quality: tool.schema
            .enum(["low", "medium", "high", "auto"])
            .describe("Generation quality passed to the hosted image_generation tool."),
          size: tool.schema
            .string()
            .optional()
            .describe(
              "Optional image size passed to the hosted image_generation tool. Use `auto` or `WIDTHxHEIGHT`; width and height must be multiples of 16px, max edge <= 3840px, long-to-short ratio <= 3:1, and total pixels between 655,360 and 8,294,400.",
            ),
          images: tool.schema
            .array(tool.schema.string())
            .max(8)
            .optional()
            .describe(
              "Legacy reference image paths, relative to the project directory unless absolute. Cannot mix with references.",
            ),
          references: tool.schema
            .array(
              tool.schema.object({
                path: tool.schema
                  .string()
                  .describe("Reference image path, relative to the project directory unless absolute."),
                role: tool.schema.enum(["edit-target", "style", "subject", "material", "composition"]),
                preserve: tool.schema
                  .string()
                  .optional()
                  .describe("Optional preservation guidance, not an exact-edit guarantee."),
              }),
            )
            .max(8)
            .optional()
            .describe("Ordered reference images with roles. Cannot mix with images."),
        },
        async execute(args, ctx) {
          ctx.abort.throwIfAborted()
          const references = await resolveReferences(args, ctx.directory)
          const out = await resolveOutputPath(args.out, ctx.directory)
          const prompt = buildGenerationPrompt(args)
          await askExternalDirectory(ctx, [...references.map((reference) => reference.path), out])
          if (references.length) {
            await ctx.ask({
              permission: "read",
              patterns: references.map((reference) => reference.path),
              always: references.map((reference) => reference.path),
              metadata: { references },
            })
          }
          ctx.abort.throwIfAborted()
          await ctx.ask({
            permission: "edit",
            patterns: [out, path.dirname(out)],
            always: [],
            metadata: { output: out },
          })
          ctx.abort.throwIfAborted()
          await ctx.ask({
            permission: "gpt_imagegen",
            patterns: [out],
            always: [],
            metadata: { prompt, references, output: out, billing: "subscription" },
          })
          ctx.abort.throwIfAborted()
          const auth = await loadOpenAIAuth()
          if (!auth) {
            throw new Error("OpenAI ChatGPT OAuth credentials not configured.")
          }

          const inputImageDataUrls = await readReferenceImages(
            references.map((reference) => reference.path),
            ctx.directory,
            ctx.abort,
          )
          const base64 = await callViaCodexResponses(auth, args, inputImageDataUrls, ctx.abort)

          ctx.abort.throwIfAborted()
          const { savedPath, versioned, message } = await saveGeneratedImage(
            out,
            ctx.directory,
            base64,
            async (candidate) => {
              ctx.abort.throwIfAborted()
              await askExternalDirectory(ctx, [candidate])
              await ctx.ask({ permission: "edit", patterns: [candidate], always: [], metadata: { output: candidate } })
              ctx.abort.throwIfAborted()
            },
          )

          return {
            output: message,
            metadata: {
              out: savedPath,
              versioned,
              billing: "subscription",
            },
          }
        },
      }),
    },
  }
}

export default {
  id: "opencode-gpt-imagegen",
  server: GptImagePlugin,
} satisfies PluginModule
