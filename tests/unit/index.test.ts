import { afterEach, beforeAll, beforeEach, expect, mock, spyOn, test } from "bun:test"
import * as fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { PluginInput, ToolContext, ToolDefinition } from "@opencode-ai/plugin"
import { buildGenerationPrompt } from "../../src/codex"
import type { GenerateArgs } from "../../src/types"
import { PNG_BASE64, PNG_BUFFER, pngDataUrl } from "./fixtures"

let imageTool: ToolDefinition
let dir: string
const originalFetch = globalThis.fetch
const originalAuth = process.env.OPENCODE_AUTH_CONTENT

beforeAll(async () => {
  const plugin = (await import("../../src/index")).default
  const hooks = await plugin.server({} as PluginInput)
  if (!hooks.tool?.gpt_imagegen) throw new Error("missing image tool")
  expect(hooks.tool.gpt_blender).toBeDefined()
  imageTool = hooks.tool.gpt_imagegen
})

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "image-tool-"))
  process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ openai: { type: "oauth", access: "test-token" } })
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  if (originalAuth === undefined) delete process.env.OPENCODE_AUTH_CONTENT
  else process.env.OPENCODE_AUTH_CONTENT = originalAuth
  await fs.rm(dir, { recursive: true, force: true })
})

function context(ask: ToolContext["ask"], abort = new AbortController().signal): ToolContext {
  return {
    directory: dir,
    worktree: dir,
    sessionID: "test",
    messageID: "test",
    agent: "test",
    abort,
    ask,
    metadata() {},
  }
}

for (const denied of ["read", "edit", "gpt_imagegen"]) {
  test(`${denied} denial prevents reference reads, output creation, and fetch`, async () => {
    await fs.writeFile(path.join(dir, "ref.png"), PNG_BUFFER)
    const fetchMock = mock(async () => new Response())
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const openSpy = spyOn(fs, "open")
    const readSpy = spyOn(fs, "readFile")
    const ask = mock(async (request: Parameters<ToolContext["ask"]>[0]) => {
      if (request.permission === denied) throw new Error("permission denied")
    })
    try {
      await expect(
        imageTool.execute({ prompt: "cat", out: "new/cat.png", quality: "auto", images: ["ref.png"] }, context(ask)),
      ).rejects.toThrow("permission denied")
      expect(openSpy).not.toHaveBeenCalled()
      expect(readSpy).not.toHaveBeenCalled()
      expect(fetchMock).not.toHaveBeenCalled()
      expect(ask.mock.calls.map(([request]) => request.permission)).toEqual(
        ["read", "edit", "gpt_imagegen"].slice(0, ["read", "edit", "gpt_imagegen"].indexOf(denied) + 1),
      )
      await expect(fs.stat(path.join(dir, "new"))).rejects.toThrow()
    } finally {
      openSpy.mockRestore()
      readSpy.mockRestore()
    }
  })
}

test("approves canonical paths and the exact transmitted prompt before upload", async () => {
  await fs.mkdir(path.join(dir, "real"))
  await fs.symlink(path.join(dir, "real"), path.join(dir, "alias"))
  await fs.writeFile(path.join(dir, "real/ref.png"), PNG_BUFFER)
  const second = Buffer.concat([PNG_BUFFER, Buffer.from("second")])
  await fs.writeFile(path.join(dir, "second.png"), second)
  const args: GenerateArgs = {
    prompt: "restyle",
    out: "alias/new/result.png",
    quality: "auto",
    references: [
      { path: "alias/ref.png", role: "edit-target", preserve: "shape" },
      { path: "second.png", role: "style" },
    ],
  }
  const ask = mock(async (_request: Parameters<ToolContext["ask"]>[0]) => {})
  const fetchMock = mock(async (_url: string, init: RequestInit) => {
    expect(ask.mock.calls.map(([request]) => request.permission)).toEqual(["read", "edit", "gpt_imagegen"])
    const content = JSON.parse(init.body as string).input[0].content
    expect(content).toEqual([
      { type: "input_text", text: buildGenerationPrompt(args) },
      { type: "input_image", image_url: pngDataUrl(PNG_BUFFER) },
      { type: "input_image", image_url: pngDataUrl(second) },
    ])
    return new Response(
      `data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "image_generation_call", result: PNG_BASE64 } })}\n\n`,
    )
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch
  const result = await imageTool.execute(args, context(ask))
  const output = path.join(dir, "real/new/result.png")
  expect(ask.mock.calls[0][0].patterns).toEqual([path.join(dir, "real/ref.png"), path.join(dir, "second.png")])
  expect(ask.mock.calls[1][0].patterns).toEqual([output, path.dirname(output)])
  expect(ask.mock.calls[1][0].always).toEqual([])
  expect(ask.mock.calls[2][0].always).toEqual([])
  expect(ask.mock.calls[2][0].metadata).toEqual({
    prompt: buildGenerationPrompt(args),
    references: [
      { path: path.join(dir, "real/ref.png"), role: "edit-target", preserve: "shape" },
      { path: path.join(dir, "second.png"), role: "style" },
    ],
    output,
    billing: "subscription",
  })
  expect(result).toMatchObject({ metadata: { out: output, billing: "subscription", versioned: false } })
  expect(ask.mock.calls[3][0]).toEqual({
    permission: "edit",
    patterns: [output],
    always: [],
    metadata: { output },
  })
  expect(await fs.readFile(output)).toEqual(PNG_BUFFER)
})

test("file-specific edit denial stops generation before network or directory creation", async () => {
  const out = path.join(dir, "new/result.png")
  const fetchMock = mock(async () => new Response())
  globalThis.fetch = fetchMock as unknown as typeof fetch
  const ask = mock(async (request: Parameters<ToolContext["ask"]>[0]) => {
    if (request.permission === "edit" && request.patterns.includes(out)) throw new Error("file denied")
  })
  await expect(imageTool.execute({ prompt: "cat", out, quality: "auto" }, context(ask))).rejects.toThrow("file denied")
  expect(fetchMock).not.toHaveBeenCalled()
  expect(await fs.readdir(dir)).toEqual([])
})

for (const versioned of [false, true]) {
  test(`exact ${versioned ? "versioned" : "original"} candidate denial prevents its exclusive create`, async () => {
    const out = path.join(dir, "result.png")
    const denied = versioned ? path.join(dir, "result-v2.png") : out
    if (versioned) await fs.writeFile(out, "original")
    const fetchMock = mock(
      async () =>
        new Response(
          `data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "image_generation_call", result: PNG_BASE64 } })}\n\n`,
        ),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const candidates: string[] = []
    const ask = mock(async (request: Parameters<ToolContext["ask"]>[0]) => {
      if (request.permission === "edit" && request.patterns.length === 1) {
        expect(request.always).toEqual([])
        candidates.push(request.patterns[0])
        if (request.patterns[0] === denied) throw new Error("candidate denied")
      }
    })
    const openSpy = spyOn(fs, "open")
    try {
      await expect(imageTool.execute({ prompt: "cat", out, quality: "auto" }, context(ask))).rejects.toThrow(
        "candidate denied",
      )
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(candidates).toEqual(versioned ? [out, denied] : [out])
      expect(openSpy.mock.calls.map(([file]) => file)).toEqual(versioned ? [out] : [])
      expect(await fs.readdir(dir)).toEqual(versioned ? ["result.png"] : [])
      if (versioned) expect(await fs.readFile(out, "utf8")).toBe("original")
    } finally {
      openSpy.mockRestore()
    }
  })
}

for (const external of ["reference", "output"]) {
  test(`external ${external} denial uses canonical paths and prevents reads, writes, and network`, async () => {
    const project = path.join(dir, "project")
    const outside = path.join(dir, "project-other")
    await fs.mkdir(project)
    await fs.mkdir(outside)
    await fs.writeFile(path.join(outside, "ref.png"), PNG_BUFFER)
    await fs.symlink(outside, path.join(project, "escape"))
    const fetchMock = mock(async () => new Response())
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const ask = mock(async (request: Parameters<ToolContext["ask"]>[0]) => {
      if (request.permission === "external_directory") throw new Error("external denied")
    })
    const openSpy = spyOn(fs, "open")
    const readSpy = spyOn(fs, "readFile")
    const mkdirSpy = spyOn(fs, "mkdir")
    try {
      await expect(
        imageTool.execute(
          {
            prompt: "cat",
            quality: "auto",
            out: external === "output" ? "escape/new/result.png" : "new/result.png",
            images: external === "reference" ? ["escape/ref.png"] : [],
          },
          { ...context(ask), directory: project, worktree: project },
        ),
      ).rejects.toThrow("external denied")
      expect(ask.mock.calls.map(([request]) => request.permission)).toEqual(["external_directory"])
      expect(ask.mock.calls[0][0].patterns).toEqual([
        path.join(outside, external === "reference" ? "ref.png" : "new/result.png"),
      ])
      expect(openSpy).not.toHaveBeenCalled()
      expect(readSpy).not.toHaveBeenCalled()
      expect(mkdirSpy).not.toHaveBeenCalled()
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      openSpy.mockRestore()
      readSpy.mockRestore()
      mkdirSpy.mockRestore()
    }
  })
}

test("rejects mixed reference arguments before permissions or fetch", async () => {
  const ask = mock(async () => {})
  const fetchMock = mock(async () => new Response())
  globalThis.fetch = fetchMock as unknown as typeof fetch
  await expect(
    imageTool.execute({ prompt: "cat", out: "cat.png", quality: "auto", images: [], references: [] }, context(ask)),
  ).rejects.toThrow("mutually exclusive")
  expect(ask).not.toHaveBeenCalled()
  expect(fetchMock).not.toHaveBeenCalled()
})

test("cancellation during approval prevents upload", async () => {
  const abort = new AbortController()
  const ask = mock(async () => {
    abort.abort(new Error("cancelled"))
  })
  const fetchMock = mock(async () => new Response())
  globalThis.fetch = fetchMock as unknown as typeof fetch
  await expect(
    imageTool.execute({ prompt: "cat", out: "cat.png", quality: "auto" }, context(ask, abort.signal)),
  ).rejects.toThrow("cancelled")
  expect(fetchMock).not.toHaveBeenCalled()
  expect(ask).toHaveBeenCalledTimes(1)
})
