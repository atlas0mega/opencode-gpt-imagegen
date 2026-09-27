import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { requireLocalPaths } from "../../src/permissions"

let dir: string
beforeEach(async () => {
  dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "permissions-v2-")))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

test("canonical project paths stay local; sibling prefixes and symlink escapes fail closed", async () => {
  const project = path.join(dir, "project")
  const outside = path.join(dir, "project-other")
  await mkdir(project)
  await mkdir(outside)
  await symlink(project, path.join(dir, "project-alias"))
  await symlink(outside, path.join(project, "escape"))
  await requireLocalPaths(path.join(dir, "project-alias"), [project, path.join(project, "new/image.png")])
  await expect(requireLocalPaths(project, [path.join(outside, "image.png")])).rejects.toThrow("outside")
  await expect(requireLocalPaths(project, [outside])).rejects.toThrow("outside")
  await expect(requireLocalPaths(project, [await realpath(path.join(project, "escape"))])).rejects.toThrow("outside")
  await expect(requireLocalPaths(project, [project, outside])).rejects.toThrow("outside")
})

test("explicit owner option can allow external paths; default never prompts itself", async () => {
  const project = path.join(dir, "project")
  await mkdir(project)
  await requireLocalPaths(project, [path.join(dir, "external", "image.png")], true)
  await expect(requireLocalPaths(project, [path.join(dir, "external", "image.png")])).rejects.toThrow("outside")
})
