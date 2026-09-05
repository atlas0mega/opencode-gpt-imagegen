import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { MAX_INPUT_IMAGE_BYTES, readReferenceImages, resolveReferences } from "../../src/input-image"
import { pngDataUrl as dataUrl, PNG_BUFFER as PNG } from "./fixtures"

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "input-image-"))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("readReferenceImages", () => {
  test("returns an empty array when given undefined", async () => {
    expect(await readReferenceImages(undefined, dir)).toEqual([])
  })

  test("returns an empty array when given an empty list", async () => {
    expect(await readReferenceImages([], dir)).toEqual([])
  })

  test("encodes a PNG as a base64 data URL with the detected MIME type", async () => {
    await writeFile(path.join(dir, "ref.png"), PNG)
    expect(await readReferenceImages(["ref.png"], dir)).toEqual([dataUrl(PNG)])
  })

  // The MIME type comes from file-type's content sniffing, not the extension, so cover a
  // few non-PNG formats to confirm the detected type (not a hard-coded "image/png") is used.
  // Each case is a minimal header file-type recognizes from its magic bytes.
  const formats: Array<{ name: string; mime: string; bytes: Buffer }> = [
    { name: "JPEG", mime: "image/jpeg", bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0]) },
    { name: "GIF", mime: "image/gif", bytes: Buffer.from("GIF89a") },
    {
      name: "WebP",
      mime: "image/webp",
      bytes: Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")]),
    },
    { name: "BMP", mime: "image/bmp", bytes: Buffer.concat([Buffer.from("BM"), Buffer.alloc(16)]) },
  ]
  for (const { name, mime, bytes } of formats) {
    test(`detects a ${name} file and uses its MIME type in the data URL`, async () => {
      const file = `ref-${name.toLowerCase()}`
      await writeFile(path.join(dir, file), bytes)
      expect(await readReferenceImages([file], dir)).toEqual([`data:${mime};base64,${bytes.toString("base64")}`])
    })
  }

  test("resolves relative paths against the context directory", async () => {
    await writeFile(path.join(dir, "ref.png"), PNG)
    const abs = path.join(dir, "ref.png")
    const [viaRelative] = await readReferenceImages(["ref.png"], dir)
    const [viaAbsolute] = await readReferenceImages([abs], "/some/other/ctx")
    expect(viaRelative).toBe(viaAbsolute)
  })

  test("preserves the input order across multiple images", async () => {
    // A second PNG with extra trailing bytes: still detected as PNG, but distinct base64.
    const png2 = Buffer.concat([PNG, Buffer.from("trailer")])
    await writeFile(path.join(dir, "first.png"), PNG)
    await writeFile(path.join(dir, "second.png"), png2)
    expect(await readReferenceImages(["first.png", "second.png"], dir)).toEqual([dataUrl(PNG), dataUrl(png2)])
  })

  test("throws when a file is not a recognized image", async () => {
    const abs = path.join(dir, "notes.txt")
    await writeFile(abs, "this is plain text, not an image")
    expect(readReferenceImages(["notes.txt"], dir)).rejects.toThrow(`unsupported image file type: ${abs}`)
  })

  // A bad path must fail the whole call, not silently drop a reference.
  test("rejects the whole call when any path is missing", async () => {
    await writeFile(path.join(dir, "present.png"), PNG)
    expect(readReferenceImages(["present.png", "missing.png"], dir)).rejects.toThrow()
  })

  test("rejects more than eight images before resolving paths", async () => {
    await expect(readReferenceImages(Array(9).fill("missing.png"), dir)).rejects.toThrow("at most 8")
  })

  test("rejects directories and oversized regular files", async () => {
    await expect(readReferenceImages([dir], dir)).rejects.toThrow("regular file")
    const file = path.join(dir, "large.png")
    await writeFile(file, PNG)
    await truncate(file, MAX_INPUT_IMAGE_BYTES + 1)
    await expect(readReferenceImages([file], dir)).rejects.toThrow("20 MiB")
    await expect(resolveReferences({ images: [file] }, dir)).rejects.toThrow("20 MiB")
  })

  test("caps total input bytes including repeated references", async () => {
    const file = path.join(dir, "large.png")
    await writeFile(file, PNG)
    await truncate(file, MAX_INPUT_IMAGE_BYTES)
    await expect(resolveReferences({ images: [file, file, file] }, dir)).rejects.toThrow("50 MiB total")
    await expect(readReferenceImages([file, file, file], dir)).rejects.toThrow("50 MiB total")
  })

  test("rejects an aborted read", async () => {
    await expect(readReferenceImages(["missing.png"], dir, AbortSignal.abort())).rejects.toThrow()
  })
})

describe("resolveReferences", () => {
  test("canonicalizes symlinks and preserves structured order and guidance", async () => {
    await writeFile(path.join(dir, "first.png"), PNG)
    await writeFile(path.join(dir, "second.png"), PNG)
    await symlink(path.join(dir, "second.png"), path.join(dir, "alias.png"))
    const references = [
      { path: "alias.png", role: "style" as const, preserve: "palette" },
      { path: "first.png", role: "edit-target" as const },
    ]
    expect(await resolveReferences({ references }, dir)).toEqual([
      { path: path.join(dir, "second.png"), role: "style", preserve: "palette" },
      { path: path.join(dir, "first.png"), role: "edit-target" },
    ])
  })

  test("rejects mixing even when one argument is empty", async () => {
    await expect(resolveReferences({ images: [], references: [] }, dir)).rejects.toThrow("mutually exclusive")
    await expect(resolveReferences({ images: ["missing.png"], references: [] }, dir)).rejects.toThrow(
      "mutually exclusive",
    )
  })

  test("rejects a canonical reference replaced by a symlink after approval", async () => {
    const approved = path.join(dir, "approved.png")
    const other = path.join(dir, "other.png")
    await writeFile(approved, PNG)
    await writeFile(other, PNG)
    const references = await resolveReferences({ images: [approved] }, dir)
    await rm(approved)
    await symlink(other, approved)
    await expect(
      readReferenceImages(
        references.map((r) => r.path),
        dir,
      ),
    ).rejects.toThrow("not canonical")
  })
})
