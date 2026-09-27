import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test"
import * as fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Plugin } from "@opencode/plugin"
import { buildGenerationPrompt } from "../../src/codex"
import plugin from "../../src/index"
import type { GenerateArgs } from "../../src/types"
import { PNG_BASE64, PNG_BUFFER, pngDataUrl } from "./fixtures"

let dir: string
let project: string
type ToolFixture = {
  name: string
  options: { permission?: string }
  execute(
    input: unknown,
    context: unknown,
  ): Promise<{
    content: unknown
    metadata?: Record<string, unknown>
  }>
}
let tools: Map<string, ToolFixture>
let resolvedSessionIDs: string[]
const originalFetch = globalThis.fetch

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "image-v2-tool-"))
  project = path.join(dir, "active-session")
  await fs.mkdir(project)
  tools = new Map()
  resolvedSessionIDs = []
  const ctx = {
    location: { directory: path.join(dir, "plugin-instance-not-session") },
    options: {},
    session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        resolvedSessionIDs.push(sessionID)
        return { location: { directory: project } }
      },
    },
    integration: {
      connection: {
        active: async () => ({ id: "openai" }),
        resolve: async () => ({ type: "oauth", methodID: "chatgpt-browser", access: "local-test-token" }),
      },
    },
    tool: {
      transform: async (register: (editor: { add(tool: ToolFixture): void }) => void) => {
        register({ add: (tool) => tools.set(tool.name, tool) })
      },
    },
  }
  await plugin.setup(ctx as unknown as Plugin.Context)
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  await fs.rm(dir, { recursive: true, force: true })
})

function context(signal = new AbortController().signal) {
  return { sessionID: "ses_active", agent: "build", messageID: "msg_1", id: "call_1", signal, progress: async () => {} }
}

function imageTool() {
  const tool = tools.get("gpt_imagegen")
  if (!tool) throw new Error("V2 image tool missing")
  return tool
}

test("publishes V2-only tool definitions with reusable host permissions and per-session roots", () => {
  expect(plugin.id).toBe("opencode-gpt-imagegen")
  expect("server" in plugin).toBe(false)
  expect([...tools.keys()]).toEqual(["gpt_imagegen", "gpt_blender"])
  expect(imageTool().options.permission).toBe("gpt_imagegen")
  expect(tools.get("gpt_blender")?.options.permission).toBe("gpt_blender")
})

for (const external of ["reference", "output"]) {
  test(`external ${external} via symlink is denied before reading, writing, or uploading`, async () => {
    const outside = path.join(dir, "active-session-other")
    await fs.mkdir(outside)
    await fs.writeFile(path.join(outside, "ref.png"), PNG_BUFFER)
    await fs.symlink(outside, path.join(project, "escape"))
    const fetchMock = mock(async () => new Response())
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const open = spyOn(fs, "open")
    const read = spyOn(fs, "readFile")
    try {
      await expect(
        imageTool().execute(
          {
            prompt: "cat",
            quality: "auto",
            out: external === "output" ? "escape/new/result.png" : "new/result.png",
            images: external === "reference" ? ["escape/ref.png"] : [],
          },
          context(),
        ),
      ).rejects.toThrow("outside")
      expect(open).not.toHaveBeenCalled()
      expect(read).not.toHaveBeenCalled()
      expect(fetchMock).not.toHaveBeenCalled()
      expect(await fs.readdir(outside)).toEqual(["ref.png"])
    } finally {
      open.mockRestore()
      read.mockRestore()
    }
  })
}

test("V2 tool preserves ordered references, exact prompt and non-overwriting output", async () => {
  await fs.mkdir(path.join(project, "real"))
  await fs.symlink(path.join(project, "real"), path.join(project, "alias"))
  await fs.writeFile(path.join(project, "real", "ref.png"), PNG_BUFFER)
  const second = Buffer.concat([PNG_BUFFER, Buffer.from("second")])
  await fs.writeFile(path.join(project, "second.png"), second)
  const args: GenerateArgs = {
    prompt: "restyle",
    out: "alias/new/result.png",
    quality: "auto",
    references: [
      { path: "alias/ref.png", role: "edit-target", preserve: "shape" },
      { path: "second.png", role: "style" },
    ],
  }
  const fetchMock = mock(async (_url: string, init: RequestInit) => {
    const content = JSON.parse(init.body as string).input[0].content
    expect(content).toEqual([
      { type: "input_text", text: buildGenerationPrompt(args) },
      { type: "input_image", image_url: pngDataUrl(PNG_BUFFER) },
      { type: "input_image", image_url: pngDataUrl(second) },
    ])
    return new Response(
      `data: ${JSON.stringify({
        type: "response.output_item.done",
        item: {
          type: "image_generation_call",
          result: PNG_BASE64,
        },
      })}\n\n`,
    )
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch
  const result = await imageTool().execute(args, context())
  const output = path.join(project, "real", "new", "result.png")
  expect(resolvedSessionIDs).toEqual(["ses_active"])
  expect(result).toMatchObject({ metadata: { out: output, billing: "subscription", versioned: false } })
  expect(await fs.readFile(output)).toEqual(PNG_BUFFER)
  expect(fetchMock).toHaveBeenCalledTimes(1)
  const versioned = await imageTool().execute(args, context())
  expect(versioned.metadata).toMatchObject({ out: path.join(project, "real", "new", "result-v2.png"), versioned: true })
  expect(await fs.readFile(output)).toEqual(PNG_BUFFER)
})

test("mixed references and pre-aborted calls fail before network or filesystem writes", async () => {
  const fetchMock = mock(async () => new Response())
  globalThis.fetch = fetchMock as unknown as typeof fetch
  await expect(
    imageTool().execute({ prompt: "cat", out: "cat.png", quality: "auto", images: [], references: [] }, context()),
  ).rejects.toThrow("mutually exclusive")
  const aborted = new AbortController()
  aborted.abort(new Error("cancelled"))
  await expect(
    imageTool().execute({ prompt: "cat", out: "cat.png", quality: "auto" }, context(aborted.signal)),
  ).rejects.toThrow("cancelled")
  expect(fetchMock).not.toHaveBeenCalled()
  expect(await fs.readdir(project)).toEqual([])
})

test("missing V2 abort signal fails closed instead of running an uncancellable image request", async () => {
  const fetchMock = mock(async () => new Response())
  globalThis.fetch = fetchMock as unknown as typeof fetch
  await expect(
    imageTool().execute({ prompt: "cat", out: "cat.png", quality: "auto" }, { sessionID: "ses_active" }),
  ).rejects.toThrow("V2.0.18")
  expect(fetchMock).not.toHaveBeenCalled()
})
