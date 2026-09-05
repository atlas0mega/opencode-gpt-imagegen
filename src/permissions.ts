import { realpath } from "node:fs/promises"
import * as path from "node:path"
import type { ToolContext } from "@opencode-ai/plugin"

// Callers resolve paths without reading contents or creating outputs first.
export async function askExternalDirectory(ctx: ToolContext, paths: string[]): Promise<void> {
  const roots = await Promise.all([ctx.directory, ctx.worktree].map((root) => realpath(root)))
  const external = [...new Set(paths)].filter(
    (candidate) =>
      !roots.some((root) => {
        const relative = path.relative(root, candidate)
        return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
      }),
  )
  ctx.abort.throwIfAborted()
  if (external.length) {
    await ctx.ask({ permission: "external_directory", patterns: external, always: [], metadata: { paths: external } })
    ctx.abort.throwIfAborted()
  }
}
