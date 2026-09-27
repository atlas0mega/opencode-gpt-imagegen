import { realpath } from "node:fs/promises"
import * as path from "node:path"

// V2 custom tools use one permission action for the invocation, which a human
// may save with "Allow always". They cannot create extra per-path permission
// prompts in the plugin context. Fail closed on paths outside this Location
// unless the owner explicitly enables them in plugin options.
export async function requireLocalPaths(
  location: string,
  candidates: readonly string[],
  allowExternalPaths = false,
): Promise<void> {
  if (allowExternalPaths) return
  const root = await realpath(location)
  for (const candidate of candidates) {
    const relative = path.relative(root, candidate)
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`Path is outside the OpenCode location: ${candidate}. Use a path within ${root}.`)
    }
  }
}
