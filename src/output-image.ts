import * as fs from "node:fs/promises"
import * as path from "node:path"

const MAX_OUTPUT_VERSION_SUFFIX = 999
export const MAX_OUTPUT_IMAGE_BYTES = 50 * 1024 * 1024
export const MAX_OUTPUT_BASE64_LENGTH = 4 * Math.ceil(MAX_OUTPUT_IMAGE_BYTES / 3)
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}

// Canonicalize the existing ancestor without creating unapproved directories.
export async function resolveOutputPath(out: string, ctxDir: string): Promise<string> {
  const requested = path.resolve(ctxDir, out)
  let parent = path.dirname(requested)
  const missing: string[] = []
  while (!(await pathExists(parent))) {
    missing.unshift(path.basename(parent))
    parent = path.dirname(parent)
  }
  const canonical = await fs.realpath(parent)
  if (!(await fs.stat(canonical)).isDirectory()) throw new Error(`output parent must be a directory: ${parent}`)
  return path.join(canonical, ...missing, path.basename(requested))
}

// maxVersion is injectable only so tests can reach the exhaustion branch cheaply; production callers use the default.
export async function pickNonOverwritePath(requested: string, maxVersion = MAX_OUTPUT_VERSION_SUFFIX): Promise<string> {
  if (!(await pathExists(requested))) return requested
  const dir = path.dirname(requested)
  const ext = path.extname(requested)
  const stem = path.basename(requested, ext)
  for (let n = 2; n <= maxVersion; n++) {
    const candidate = path.join(dir, `${stem}-v${n}${ext}`)
    if (!(await pathExists(candidate))) return candidate
  }
  throw new Error(
    `could not find a non-conflicting filename under ${dir}/${stem}-vN${ext} (tried up to v${maxVersion})`,
  )
}

export function buildSavedMessage(savedPath: string, requestedPath: string): string {
  const versionNote =
    savedPath !== requestedPath
      ? ` (the requested path ${requestedPath} already existed; the new image was versioned to avoid overwriting it)`
      : ""
  return `Generated image saved to ${savedPath}${versionNote}.`
}

type SaveResult = { savedPath: string; versioned: boolean; message: string; width: number; height: number }

// The tool passes an approved canonical path. Exclusive creation also treats dangling
// symlinks as occupied, so neither concurrent saves nor symlink leaves are overwritten.
export async function saveGeneratedImage(
  out: string,
  ctxDir: string,
  base64: string,
  beforeWrite?: (path: string) => void | Promise<void>,
): Promise<SaveResult> {
  if (base64.length > MAX_OUTPUT_BASE64_LENGTH) throw new Error("generated image exceeds 50 MiB")
  const png = Buffer.from(base64, "base64")
  if (png.length > MAX_OUTPUT_IMAGE_BYTES) throw new Error("generated image exceeds 50 MiB")
  if (!png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error("generated image is not a PNG (invalid signature)")
  }
  if (png.length < 24 || png.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error("generated image has no PNG dimensions")
  }
  const width = png.readUInt32BE(16)
  const height = png.readUInt32BE(20)
  if (!width || !height) throw new Error("generated image has invalid PNG dimensions")
  const requestedPath = path.resolve(ctxDir, out)
  const dir = path.dirname(requestedPath)
  if ((await resolveOutputPath(requestedPath, ctxDir)) !== requestedPath) {
    throw new Error("output parent changed or is not canonical")
  }
  await fs.mkdir(dir, { recursive: true })
  if ((await fs.realpath(dir)) !== dir) throw new Error("output parent changed or is not canonical")
  const ext = path.extname(requestedPath)
  const stem = path.basename(requestedPath, ext)
  for (let n = 1; n <= MAX_OUTPUT_VERSION_SUFFIX; n++) {
    const savedPath = n === 1 ? requestedPath : path.join(dir, `${stem}-v${n}${ext}`)
    await beforeWrite?.(savedPath)
    if ((await fs.realpath(dir)) !== dir) throw new Error("output parent changed or is not canonical")
    let file: fs.FileHandle
    try {
      file = await fs.open(savedPath, "wx", 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue
      throw error
    }
    try {
      await file.writeFile(png)
    } catch (error) {
      await fs.unlink(savedPath)
      throw error
    } finally {
      await file.close()
    }
    return {
      savedPath,
      versioned: savedPath !== requestedPath,
      message: buildSavedMessage(savedPath, requestedPath),
      width,
      height,
    }
  }
  throw new Error(`could not find a non-conflicting filename (tried up to v${MAX_OUTPUT_VERSION_SUFFIX})`)
}
