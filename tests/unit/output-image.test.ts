import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { existsSync } from "node:fs"
import * as fs from "node:fs/promises"
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  buildSavedMessage,
  MAX_OUTPUT_BASE64_LENGTH,
  pickNonOverwritePath,
  resolveOutputPath,
  saveGeneratedImage,
} from "../../src/output-image"
import { PNG_BASE64, PNG_BUFFER } from "./fixtures"

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "out-image-"))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

// Place a real PNG at the path so it is occupied; pickNonOverwritePath only checks existence.
function occupy(p: string): Promise<void> {
  return writeFile(p, PNG_BUFFER)
}

describe("pickNonOverwritePath", () => {
  test("returns the requested path when nothing exists", async () => {
    const requested = path.join(dir, "image.png")
    expect(await pickNonOverwritePath(requested)).toBe(requested)
  })

  test("appends -v2 when the requested path exists", async () => {
    const requested = path.join(dir, "image.png")
    await occupy(requested)
    expect(await pickNonOverwritePath(requested)).toBe(path.join(dir, "image-v2.png"))
  })

  test("skips to the first free suffix when earlier versions exist", async () => {
    const requested = path.join(dir, "image.png")
    await occupy(requested)
    await occupy(path.join(dir, "image-v2.png"))
    expect(await pickNonOverwritePath(requested)).toBe(path.join(dir, "image-v3.png"))
  })

  test("preserves the extension and stem in the versioned name", async () => {
    const requested = path.join(dir, "my.photo.jpeg")
    await occupy(requested)
    expect(await pickNonOverwritePath(requested)).toBe(path.join(dir, "my.photo-v2.jpeg"))
  })

  test("throws once every version up to the limit is taken", async () => {
    // maxVersion is lowered to 2 so we can fill the suffix space without writing 999 files.
    const requested = path.join(dir, "image.png")
    await occupy(requested)
    await occupy(path.join(dir, "image-v2.png"))
    expect(pickNonOverwritePath(requested, 2)).rejects.toThrow(
      `could not find a non-conflicting filename under ${dir}/image-vN.png (tried up to v2)`,
    )
  })
})

describe("buildSavedMessage", () => {
  test("omits the version note when the path was not changed", () => {
    const p = "/tmp/image.png"
    expect(buildSavedMessage(p, p)).toBe(`Generated image saved to ${p}.`)
  })

  test("explains the versioning when the saved path differs from the requested one", () => {
    const saved = "/tmp/image-v2.png"
    const requested = "/tmp/image.png"
    expect(buildSavedMessage(saved, requested)).toBe(
      `Generated image saved to ${saved} (the requested path ${requested} already existed; ` +
        "the new image was versioned to avoid overwriting it).",
    )
  })
})

describe("saveGeneratedImage", () => {
  for (const versioned of [false, true]) {
    test(`awaits approval before the ${versioned ? "versioned" : "original"} wx create and propagates denial`, async () => {
      const out = path.join(dir, "image.png")
      const denied = versioned ? path.join(dir, "image-v2.png") : out
      if (versioned) await writeFile(out, "original")
      const candidates: string[] = []
      const openSpy = spyOn(fs, "open")
      try {
        await expect(
          saveGeneratedImage(out, dir, PNG_BASE64, async (candidate) => {
            await Promise.resolve()
            expect(openSpy.mock.calls.some(([file]) => file === candidate)).toBe(false)
            candidates.push(candidate)
            // Even an EEXIST-shaped permission failure must not be treated as a collision.
            if (candidate === denied) throw Object.assign(new Error("denied"), { code: "EEXIST" })
          }),
        ).rejects.toThrow("denied")
        expect(candidates).toEqual(versioned ? [out, denied] : [out])
        expect(openSpy.mock.calls.map(([file, flags]) => [file, flags])).toEqual(versioned ? [[out, "wx"]] : [])
        expect(existsSync(denied)).toBe(false)
        expect(existsSync(path.join(dir, "image-v3.png"))).toBe(false)
        if (versioned) expect(await readFile(out, "utf8")).toBe("original")
      } finally {
        openSpy.mockRestore()
      }
    })
  }

  test("rechecks the parent after asynchronous write approval", async () => {
    await mkdir(path.join(dir, "parent"))
    await mkdir(path.join(dir, "other"))
    await expect(
      saveGeneratedImage("parent/image.png", dir, PNG_BASE64, async () => {
        await rm(path.join(dir, "parent"), { recursive: true })
        await symlink(path.join(dir, "other"), path.join(dir, "parent"))
      }),
    ).rejects.toThrow("not canonical")
    expect(existsSync(path.join(dir, "other/image.png"))).toBe(false)
  })

  test("concurrent saves claim distinct files without overwriting", async () => {
    const images = Array.from({ length: 12 }, (_, i) => Buffer.concat([PNG_BUFFER, Buffer.from(`${i}`)]))
    const results = await Promise.all(
      images.map((image) => saveGeneratedImage("image.png", dir, image.toString("base64"))),
    )
    expect(new Set(results.map((result) => result.savedPath)).size).toBe(images.length)
    for (const [i, result] of results.entries()) {
      expect(await readFile(result.savedPath)).toEqual(images[i])
    }
  })

  test("does not follow or replace dangling symlink leaves, including versioned ones", async () => {
    const target = path.join(dir, "missing.png")
    const requested = path.join(dir, "image.png")
    await symlink(target, requested)
    await symlink(target, path.join(dir, "image-v2.png"))
    expect(await pickNonOverwritePath(requested)).toBe(path.join(dir, "image-v3.png"))
    const result = await saveGeneratedImage(requested, dir, PNG_BASE64)
    expect(result.savedPath).toBe(path.join(dir, "image-v3.png"))
    expect(await readlink(requested)).toBe(target)
    expect((await lstat(requested)).isSymbolicLink()).toBe(true)
    expect(existsSync(target)).toBe(false)
  })

  test("rejects invalid PNG and oversized output before creating directories", async () => {
    await expect(saveGeneratedImage("new/image.png", dir, Buffer.from("not PNG").toString("base64"))).rejects.toThrow(
      "invalid signature",
    )
    await expect(saveGeneratedImage("new/image.png", dir, "A".repeat(MAX_OUTPUT_BASE64_LENGTH + 1))).rejects.toThrow(
      "50 MiB",
    )
    expect(existsSync(path.join(dir, "new"))).toBe(false)
  })

  test("canonicalizes existing ancestors without creating missing output parents", async () => {
    await mkdir(path.join(dir, "real"))
    await symlink(path.join(dir, "real"), path.join(dir, "alias"))
    const out = await resolveOutputPath("alias/new/image.png", dir)
    expect(out).toBe(path.join(dir, "real/new/image.png"))
    expect(existsSync(path.dirname(out))).toBe(false)
    expect((await saveGeneratedImage(out, dir, PNG_BASE64)).savedPath).toBe(out)
  })

  test("rejects a parent replaced by a symlink after approval", async () => {
    await mkdir(path.join(dir, "parent"))
    await mkdir(path.join(dir, "other"))
    const out = await resolveOutputPath("parent/image.png", dir)
    await rm(path.dirname(out), { recursive: true })
    await symlink(path.join(dir, "other"), path.dirname(out))
    await expect(saveGeneratedImage(out, dir, PNG_BASE64)).rejects.toThrow("not canonical")
    expect(existsSync(path.join(dir, "other/image.png"))).toBe(false)
  })

  test("rejects dangling symlink output parents", async () => {
    await symlink(path.join(dir, "missing"), path.join(dir, "parent"))
    await expect(resolveOutputPath("parent/image.png", dir)).rejects.toThrow()
  })

  test("writes the decoded image to the requested path", async () => {
    const out = "image.png"
    const result = await saveGeneratedImage(out, dir, PNG_BASE64)
    expect(result.savedPath).toBe(path.join(dir, "image.png"))
    expect(result.versioned).toBe(false)
    const written = await readFile(result.savedPath)
    expect(written.equals(PNG_BUFFER)).toBe(true)
  })

  test("resolves a relative path against the context directory", async () => {
    const result = await saveGeneratedImage("nested/image.png", dir, PNG_BASE64)
    expect(result.savedPath).toBe(path.join(dir, "nested", "image.png"))
    expect(existsSync(result.savedPath)).toBe(true)
  })

  test("honors an absolute output path verbatim", async () => {
    const abs = path.join(dir, "absolute.png")
    const result = await saveGeneratedImage(abs, "/some/other/ctx", PNG_BASE64)
    expect(result.savedPath).toBe(abs)
  })

  test("creates missing parent directories", async () => {
    const result = await saveGeneratedImage("a/b/c/image.png", dir, PNG_BASE64)
    expect(existsSync(result.savedPath)).toBe(true)
  })

  test("versions the output instead of overwriting an existing file", async () => {
    const first = await saveGeneratedImage("image.png", dir, PNG_BASE64)
    const second = await saveGeneratedImage("image.png", dir, PNG_BASE64)
    expect(second.savedPath).toBe(path.join(dir, "image-v2.png"))
    expect(second.versioned).toBe(true)
    expect(second.message).toBe(
      `Generated image saved to ${second.savedPath} (the requested path ${first.savedPath} already existed; ` +
        "the new image was versioned to avoid overwriting it).",
    )
    // The original file is left untouched.
    expect(existsSync(first.savedPath)).toBe(true)
  })
})
