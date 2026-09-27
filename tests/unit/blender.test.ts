import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import type { ChildProcess, spawn } from "node:child_process"
import { EventEmitter } from "node:events"
import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { PassThrough } from "node:stream"
import type { Context } from "@opencode/plugin/promise/plugin"
import type { ToolContext } from "@opencode/plugin/promise/tool"
import { blenderTool, executeBlender } from "../../src/blender"

let dir: string
let controller: AbortController
beforeEach(async () => {
  dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "blender-v2-test-")))
  controller = new AbortController()
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const args = { name: "sample", primitive: "cube" as const, output_dir: "." }
const run = (input: unknown, dependencies: { spawn?: typeof spawn; timeoutMs?: number } = {}, allowExternal = false) =>
  executeBlender(input, dir, controller.signal, allowExternal, dependencies)

function fakeSpawn(action: (child: ChildProcess, argv: string[]) => void) {
  const child = new EventEmitter() as ChildProcess
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  const signals: string[] = []
  child.kill = (signal) => {
    signals.push(String(signal))
    setTimeout(() => child.emit("close", null, signal), 0)
    return true
  }
  const calls: { command: string; argv: string[]; options: unknown }[] = []
  const launch = ((command: string, argv: string[], options: unknown) => {
    calls.push({ command, argv, options })
    setTimeout(() => action(child, argv), 0)
    return child
  }) as typeof spawn
  return { spawn: launch, calls, signals, child }
}

describe("V2 Blender tool", () => {
  test("registers only fixed primitives/textures and uses a reusable host permission", () => {
    const tool = blenderTool(
      async () => dir,
      false,
      (context) => (context as unknown as { signal: AbortSignal }).signal,
      { assert: async () => {} } as unknown as Context["permission"],
    )
    expect(tool.name).toBe("gpt_blender")
    expect(tool.options?.permission).toBe("gpt_blender")
    expect(Object.keys((tool.input as { properties: Record<string, unknown> }).properties)).toEqual([
      "name",
      "output_dir",
      "primitive",
      "albedo",
      "roughness",
      "metallic",
      "normal",
    ])
    expect(JSON.stringify(tool.input)).not.toContain("python")
  })

  test("a denied tool permission prevents path inspection, output creation and Blender execution", async () => {
    let lookedUpSession = false
    const tool = blenderTool(
      async () => {
        lookedUpSession = true
        return dir
      },
      false,
      (context) => (context as unknown as { signal: AbortSignal }).signal,
      {
        assert: async () => {
          throw new Error("fixture permission denied")
        },
      } as unknown as Context["permission"],
    )
    await expect(
      tool.execute(args, {
        sessionID: "ses_denied",
        agent: "build",
        messageID: "msg_denied",
        id: "call_denied",
        signal: controller.signal,
        progress: async () => {},
      } as unknown as ToolContext),
    ).rejects.toThrow("fixture permission denied")
    expect(lookedUpSession).toBe(false)
    expect(await readdir(dir)).toEqual([])
  })

  test("rejects unsafe names, URLs, arbitrary code, and output controls before spawning", async () => {
    const fake = fakeSpawn(() => {})
    for (const invalid of [
      { ...args, name: "../escape" },
      { ...args, name: "a;touch x" },
      { ...args, albedo: "https://example.com/image.png" },
      { ...args, output_dir: "bad\0path" },
      { ...args, python: "print('no')" },
    ])
      await expect(run(invalid, fake)).rejects.toThrow()
    expect(fake.calls).toEqual([])
    expect(await readdir(dir)).toEqual([])
  })

  for (const external of ["texture", "output"]) {
    test(`denies external ${external} symlink before writing or spawning`, async () => {
      const project = path.join(dir, "project")
      const outside = path.join(dir, "project-other")
      await mkdir(project)
      await mkdir(outside)
      await writeFile(path.join(outside, "actual.png"), "not read")
      await symlink(outside, path.join(project, "escape"))
      const fake = fakeSpawn(() => {})
      await expect(
        executeBlender(
          {
            ...args,
            output_dir: external === "output" ? "escape" : ".",
            albedo: external === "texture" ? "escape/actual.png" : undefined,
          },
          project,
          controller.signal,
          false,
          fake,
        ),
      ).rejects.toThrow("outside")
      expect(fake.calls).toEqual([])
      expect(await readdir(outside)).toEqual(["actual.png"])
    })
  }

  test("rejects .blend inputs, directories named .png, missing output roots and existing files", async () => {
    await writeFile(path.join(dir, "input.blend"), "not opened")
    await mkdir(path.join(dir, "directory.png"))
    await writeFile(path.join(dir, "existing"), "keep")
    const fake = fakeSpawn(() => {})
    await expect(run({ ...args, albedo: "input.blend" }, fake)).rejects.toThrow("raster image")
    await expect(run({ ...args, albedo: "directory.png" }, fake)).rejects.toThrow("not a regular file")
    await expect(run({ ...args, output_dir: "missing" }, fake)).rejects.toThrow()
    await expect(run({ ...args, output_dir: "existing" }, fake)).rejects.toThrow("not a directory")
    expect(fake.calls).toEqual([])
  })

  test("spawns fixed Blender argv and creates unique non-overwriting outputs", async () => {
    const fake = fakeSpawn((child, argv) => {
      void (async () => {
        try {
          const payload = JSON.parse(argv.at(-1) ?? "{}")
          for (const file of ["sample.blend", "sample.glb", "preview.png", "manifest.json"])
            await writeFile(path.join(payload.output_dir, file), "fake output", { flag: "wx" })
          child.emit("close", 0, null)
        } catch (error) {
          child.emit("error", error)
          child.emit("close", 1, null)
        }
      })()
    })
    const first = await run(args, fake)
    const second = await run(args, fake)
    expect(first.metadata.output_dir).not.toBe(second.metadata.output_dir)
    expect(first.output).toContain("not a production mesh")
    expect((await readdir(first.metadata.output_dir)).sort()).toEqual([
      "manifest.json",
      "preview.png",
      "sample.blend",
      "sample.glb",
    ])
    const call = fake.calls[0]
    if (!call) throw new Error("Blender did not spawn")
    expect(call.command).toBe("blender")
    expect(call.options).toMatchObject({
      shell: false,
      cwd: first.metadata.output_dir,
      stdio: ["ignore", "pipe", "pipe"],
    })
    expect(call.argv.slice(0, 6)).toEqual([
      "--background",
      "--factory-startup",
      "--disable-autoexec",
      "--python-exit-code",
      "1",
      "--python",
    ])
    expect(call.argv[6]).toBe(path.resolve(import.meta.dir, "../../scripts/blender_asset.py"))
    expect(JSON.parse(call.argv[8] ?? "{}")).toEqual({
      name: "sample",
      primitive: "cube",
      output_dir: first.metadata.output_dir,
      textures: {},
    })
  })

  test("missing executable, bounded stderr, and missing artifacts fail without installation", async () => {
    const missing = fakeSpawn((child) => {
      child.emit("error", Object.assign(new Error("missing"), { code: "ENOENT" }))
      child.emit("close", -2, null)
    })
    await expect(run(args, missing)).rejects.toThrow("No installation was attempted")
    const noisy = fakeSpawn((child) => {
      child.stdout?.emit("data", Buffer.alloc(100_000, "x"))
      child.stderr?.emit("data", Buffer.alloc(100_000, "y"))
      child.emit("close", 1, null)
    })
    let error = ""
    try {
      await run(args, noisy)
    } catch (failure) {
      error = String(failure)
    }
    expect(error.length).toBeLessThan(66_000)
    expect(error).not.toContain("yyyy")
    const empty = fakeSpawn((child) => child.emit("close", 0, null))
    await expect(run(args, empty)).rejects.toThrow("Partial files may remain")
  })

  test("already-cancelled calls neither write nor spawn", async () => {
    const fake = fakeSpawn(() => {})
    controller.abort(new Error("cancelled"))
    await expect(run(args, fake)).rejects.toThrow("cancelled")
    expect(fake.calls).toEqual([])
    expect(await readdir(dir)).toEqual([])
  })

  test("cancellation and timeout kill the child, waiting for close", async () => {
    const cancelled = fakeSpawn(() => controller.abort())
    await expect(run(args, cancelled)).rejects.toThrow("cancelled")
    expect(cancelled.signals).toEqual(["SIGKILL"])
    const timed = fakeSpawn(() => {})
    controller = new AbortController()
    await expect(run(args, { ...timed, timeoutMs: 5 })).rejects.toThrow("120-second timeout")
    expect(timed.signals).toEqual(["SIGKILL"])
  })

  test.skipIf(process.platform === "win32")("cancellation terminates the POSIX process group", async () => {
    const fake = fakeSpawn((child) => {
      controller.abort()
      child.emit("close", null, "SIGKILL")
    })
    Object.defineProperty(fake.child, "pid", { value: 12345 })
    const kill = spyOn(process, "kill").mockImplementation(() => true)
    try {
      await expect(run(args, fake)).rejects.toThrow("cancelled")
      expect(kill).toHaveBeenCalledWith(-12345, "SIGKILL")
      expect(fake.signals).toEqual([])
    } finally {
      kill.mockRestore()
    }
  })
})
