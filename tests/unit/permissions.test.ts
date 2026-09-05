import { afterEach, beforeEach, expect, mock, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { ToolContext } from "@opencode-ai/plugin"
import { askExternalDirectory } from "../../src/permissions"

let dir: string

beforeEach(async () => {
  dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "permissions-")))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

test("accepts either canonical root, but not sibling prefixes or paths outside both", async () => {
  const directory = path.join(dir, "project")
  const worktree = path.join(dir, "worktree")
  await mkdir(directory)
  await mkdir(worktree)
  await symlink(directory, path.join(dir, "project-alias"))
  await symlink(worktree, path.join(dir, "worktree-alias"))
  const ask = mock(async (_request: Parameters<ToolContext["ask"]>[0]) => {})
  const ctx: ToolContext = {
    directory: path.join(dir, "project-alias"),
    worktree: path.join(dir, "worktree-alias"),
    abort: new AbortController().signal,
    ask,
    sessionID: "test",
    messageID: "test",
    agent: "test",
    metadata() {},
  }
  await askExternalDirectory(ctx, [
    directory,
    path.join(directory, "new/image.png"),
    worktree,
    path.join(worktree, "ref.png"),
  ])
  expect(ask).not.toHaveBeenCalled()
  const external = [path.join(dir, "project-other/image.png"), path.join(dir, "worktree-other/ref.png")]
  await askExternalDirectory(ctx, [...external, external[0], path.join(directory, "image.png")])
  expect(ask).toHaveBeenCalledTimes(1)
  expect(ask.mock.calls[0][0]).toEqual({
    permission: "external_directory",
    patterns: external,
    always: [],
    metadata: { paths: external },
  })
})
