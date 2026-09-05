import { constants } from "node:fs"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { fileTypeFromBuffer } from "file-type"
import type { GenerateArgs, ResolvedReference } from "./types"

export const MAX_REFERENCE_IMAGES = 8
export const MAX_INPUT_IMAGE_BYTES = 20 * 1024 * 1024
export const MAX_INPUT_TOTAL_BYTES = 50 * 1024 * 1024

export function getReferences(args: Pick<GenerateArgs, "images" | "references">): ResolvedReference[] {
  if (args.images !== undefined && args.references !== undefined) {
    throw new Error("images and references are mutually exclusive")
  }
  const references = args.references ?? (args.images ?? []).map((p) => ({ path: p }))
  if (references.length > MAX_REFERENCE_IMAGES) throw new Error("at most 8 reference images are allowed")
  return references
}

// Resolve and inspect metadata only; the caller must approve these paths before reading bytes.
export async function resolveReferences(
  args: Pick<GenerateArgs, "images" | "references">,
  ctxDir: string,
): Promise<ResolvedReference[]> {
  const resolved: ResolvedReference[] = []
  let total = 0
  for (const reference of getReferences(args)) {
    const canonical = await fs.realpath(path.resolve(ctxDir, reference.path))
    const stat = await fs.stat(canonical)
    if (!stat.isFile()) throw new Error(`reference must be a regular file: ${canonical}`)
    if (stat.size > MAX_INPUT_IMAGE_BYTES) throw new Error(`reference exceeds 20 MiB: ${canonical}`)
    total += stat.size
    if (total > MAX_INPUT_TOTAL_BYTES) throw new Error("references exceed 50 MiB total")
    resolved.push({ ...reference, path: canonical })
  }
  return resolved
}

export async function readReferenceImages(
  paths: string[] | undefined,
  ctxDir: string,
  signal?: AbortSignal,
): Promise<string[]> {
  getReferences({ images: paths })
  const urls: string[] = []
  let total = 0
  for (const p of paths ?? []) {
    signal?.throwIfAborted()
    const abs = path.resolve(ctxDir, p)
    if ((await fs.realpath(abs)) !== abs) throw new Error(`reference path changed or is not canonical: ${abs}`)
    // NONBLOCK avoids hanging on a FIFO substituted after the metadata check.
    const file = await fs.open(abs, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const stat = await file.stat()
      if (!stat.isFile()) throw new Error(`reference must be a regular file: ${abs}`)
      if (stat.size > MAX_INPUT_IMAGE_BYTES) throw new Error(`reference exceeds 20 MiB: ${abs}`)
      if (total + stat.size > MAX_INPUT_TOTAL_BYTES) throw new Error("references exceed 50 MiB total")
      const limit = Math.min(MAX_INPUT_IMAGE_BYTES, MAX_INPUT_TOTAL_BYTES - total)
      const chunks: Buffer[] = []
      let size = 0
      while (true) {
        signal?.throwIfAborted()
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, limit - size + 1))
        const { bytesRead } = await file.read(chunk)
        if (!bytesRead) break
        size += bytesRead
        if (size > limit) throw new Error("reference exceeds 20 MiB or references exceed 50 MiB total")
        chunks.push(chunk.subarray(0, bytesRead))
      }
      total += size
      const buf = Buffer.concat(chunks, size)
      const detected = await fileTypeFromBuffer(buf)
      if (!detected?.mime.startsWith("image/")) throw new Error(`unsupported image file type: ${abs}`)
      urls.push(`data:${detected.mime};base64,${buf.toString("base64")}`)
    } finally {
      await file.close()
    }
  }
  return urls
}
