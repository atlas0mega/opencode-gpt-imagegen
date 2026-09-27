import { spawn } from "node:child_process"
import { mkdtemp, realpath, stat } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { ToolContext, Info as ToolInfo } from "@opencode/plugin/promise/tool"
import { z } from "zod"
import { requireLocalPaths } from "./permissions"

const localPath = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) => ![...value].some((character) => character.charCodeAt(0) < 32) && !/^[a-z][a-z\d+.-]*:\/\//i.test(value),
    "Use a local filesystem path without control characters, not a URL.",
  )
const blenderArgs = z
  .object({
    name: z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/)
      .describe("Safe asset name, 1-64 characters."),
    output_dir: localPath.describe("Existing output directory, relative to the project unless absolute."),
    primitive: z.enum(["plane", "cube", "sphere"]),
    albedo: localPath.optional().describe("Local albedo texture (sRGB)."),
    roughness: localPath.optional().describe("Local roughness texture (Non-Color)."),
    metallic: localPath.optional().describe("Local metallic texture (Non-Color)."),
    normal: localPath.optional().describe("Local tangent-space OpenGL/+Y normal texture (Non-Color)."),
  })
  .strict()

const textureSlots = ["albedo", "roughness", "metallic", "normal"] as const
const scriptPath = fileURLToPath(new URL("../scripts/blender_asset.py", import.meta.url))
const outputLimit = 64 * 1024

// Dependencies are injectable only in code, never through tool arguments.
export async function executeBlender(
  input: unknown,
  directory: string,
  signal: AbortSignal,
  allowExternalPaths = false,
  dependencies: { spawn?: typeof spawn; timeoutMs?: number } = {},
) {
  const args = blenderArgs.parse(input)
  signal.throwIfAborted()
  const outputParent = await realpath(path.resolve(directory, args.output_dir))
  const textures: Partial<Record<(typeof textureSlots)[number], string>> = {}
  for (const slot of textureSlots) {
    const value = args[slot]
    if (value) {
      const canonical = await realpath(path.resolve(directory, value))
      if (!/\.(png|jpe?g|webp|tiff?|exr|hdr|bmp)$/i.test(canonical)) {
        throw new Error(`Unsupported ${slot} texture: use a local raster image, not a .blend or script.`)
      }
      textures[slot] = canonical
    }
  }

  const texturePaths = [...new Set(Object.values(textures))]
  await requireLocalPaths(directory, [...texturePaths, outputParent], allowExternalPaths)
  const metadata = {
    local: true,
    billing: "free",
    external_paid_services: false,
    executable: "blender (PATH)",
    script: scriptPath,
    name: args.name,
    primitive: args.primitive,
    path: outputParent,
    output_dir: outputParent,
    textures,
    timeout_ms: 120_000,
    outputs: [".blend", ".glb", "preview.png", "manifest.json"],
  }
  signal.throwIfAborted()

  if ((await realpath(outputParent)) !== outputParent || !(await stat(outputParent)).isDirectory()) {
    throw new Error("Output directory changed or is not a directory.")
  }
  for (const texture of texturePaths) {
    const info = await stat(texture)
    if ((await realpath(texture)) !== texture || !info.isFile() || info.size > 64 * 1024 * 1024) {
      throw new Error(`Texture changed, is not a regular file, or exceeds 64 MiB: ${texture}`)
    }
  }
  if (!(await stat(scriptPath)).isFile()) throw new Error(`Bundled Blender script missing: ${scriptPath}`)
  signal.throwIfAborted()
  const outputDir = await mkdtemp(path.join(outputParent, `${args.name}-`))
  const payload = { name: args.name, primitive: args.primitive, output_dir: outputDir, textures }
  const argv = [
    "--background",
    "--factory-startup",
    "--disable-autoexec",
    "--python-exit-code",
    "1",
    "--python",
    scriptPath,
    "--",
    JSON.stringify(payload),
  ]

  try {
    signal.throwIfAborted()
    await new Promise<void>((resolve, reject) => {
      const child = (dependencies.spawn ?? spawn)("blender", argv, {
        shell: false,
        cwd: outputDir,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      })
      let captured = Buffer.alloc(0)
      let failure: Error | undefined
      const capture = (chunk: Buffer) => {
        const remaining = outputLimit - captured.length
        if (remaining > 0) captured = Buffer.concat([captured, chunk.subarray(0, remaining)])
      }
      child.stdout?.on("data", capture)
      child.stderr?.on("data", capture)
      const kill = (includeChild = true) => {
        // A separate POSIX process group also terminates any Blender descendants.
        if (process.platform !== "win32" && child.pid) {
          try {
            process.kill(-child.pid, "SIGKILL")
            return
          } catch {
            // The process may already have exited; still try the direct child.
          }
        }
        if (includeChild) child.kill("SIGKILL")
      }
      const cancel = () => {
        failure ??= new Error("Blender execution cancelled.")
        kill()
      }
      const timer = setTimeout(() => {
        failure ??= new Error("Blender exceeded the 120-second timeout.")
        kill()
      }, dependencies.timeoutMs ?? 120_000)
      signal.addEventListener("abort", cancel, { once: true })
      child.once("error", (error: NodeJS.ErrnoException) => {
        failure ??= new Error(
          error.code === "ENOENT"
            ? "Blender was not found on PATH. No installation was attempted."
            : `Could not execute Blender: ${error.message}`,
        )
      })
      // Wait for close, not just exit, so cancellation never returns with the child still running.
      child.once("close", (code, exitSignal) => {
        clearTimeout(timer)
        signal.removeEventListener("abort", cancel)
        kill(false)
        if (failure || code !== 0) {
          reject(
            new Error(`${failure?.message ?? `Blender failed (${exitSignal ?? code}).`}\n${captured.toString("utf8")}`),
          )
        } else {
          resolve()
        }
      })
      if (signal.aborted) cancel()
    })
    signal.throwIfAborted()
    const outputs = {
      blend: path.join(outputDir, `${args.name}.blend`),
      glb: path.join(outputDir, `${args.name}.glb`),
      preview: path.join(outputDir, "preview.png"),
      manifest: path.join(outputDir, "manifest.json"),
    }
    for (const file of Object.values(outputs)) {
      const info = await stat(file)
      if (!info.isFile() || info.size === 0 || (await realpath(file)) !== file) {
        throw new Error(`Blender did not produce a valid output file: ${file}`)
      }
    }
    return {
      output: [
        `Local Blender primitive saved in ${outputDir}`,
        ...Object.entries(outputs).map(([kind, file]) => `${kind}: ${file}`),
        "Supplied textures are assigned as-is. This is not a production mesh or a guarantee of coherent PBR maps.",
      ].join("\n"),
      metadata: { ...metadata, output_dir: outputDir, outputs },
    }
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nPartial files may remain in ${outputDir}`,
    )
  }
}

export function blenderTool(
  sessionDirectory: (sessionID: string) => Promise<string>,
  allowExternalPaths: boolean,
  toolSignal: (context: ToolContext) => AbortSignal,
): ToolInfo {
  return {
    name: "gpt_blender",
    description: [
      "Optional human-approved local Blender workflow; free, no MCP, authentication, network API, or paid provider.",
      "Requires Blender on PATH; never installs it. Creates a UV primitive with optional local textures, .blend, .glb, preview PNG, and manifest.",
      "Uses a unique subdirectory of an existing output_dir, never opens user .blend files or accepts Python code.",
      "Requires V2 gpt_blender tool permission (save Allow always if desired). Canonical paths must remain inside this location unless allow_external_paths is enabled. Hard timeout: 120 seconds.",
      "Textures are used as supplied, not generated coherent PBR maps; output is a starting asset, not a production mesh.",
    ].join(" "),
    input: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$" },
        output_dir: { type: "string", minLength: 1, maxLength: 4096 },
        primitive: { type: "string", enum: ["plane", "cube", "sphere"] },
        albedo: { type: "string" },
        roughness: { type: "string" },
        metallic: { type: "string" },
        normal: { type: "string" },
      },
      required: ["name", "output_dir", "primitive"],
    },
    options: { permission: "gpt_blender" },
    async execute(raw, context) {
      const signal = toolSignal(context)
      signal.throwIfAborted()
      const result = await executeBlender(raw, await sessionDirectory(context.sessionID), signal, allowExternalPaths)
      return { content: result.output, metadata: result.metadata }
    },
  }
}
