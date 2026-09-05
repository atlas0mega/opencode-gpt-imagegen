import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import type { ChildProcess, spawn } from "node:child_process"
import { EventEmitter } from "node:events"
import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { PassThrough } from "node:stream"
import type { ToolContext } from "@opencode-ai/plugin"
import { blenderTool, executeBlender } from "../../src/blender"

let dir: string
let controller: AbortController
let requests: Parameters<ToolContext["ask"]>[0][]
let ctx: ToolContext

beforeEach(async () => {
  dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "blender-test-")))
  controller = new AbortController()
  requests = []
  ctx = {
    directory: dir,
    worktree: dir,
    sessionID: "test",
    messageID: "test",
    agent: "test",
    abort: controller.signal,
    metadata() {},
    async ask(request) {
      requests.push(request)
    },
  }
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const args = { name: "sample", primitive: "cube" as const, output_dir: "." }

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

describe("blender tool", () => {
  test("exports a minimal fixed schema without code or blend-file inputs", () => {
    expect(Object.keys(blenderTool.args)).toEqual([
      "name",
      "output_dir",
      "primitive",
      "albedo",
      "roughness",
      "metallic",
      "normal",
    ])
    expect(blenderTool.args.primitive.safeParse("sphere").success).toBe(true)
    expect(blenderTool.args.primitive.safeParse("script").success).toBe(false)
  })

  test("rejects unsafe names, URL textures and arbitrary code before approval", async () => {
    const fake = fakeSpawn(() => {})
    for (const invalid of [
      { ...args, name: "../escape" },
      { ...args, name: "a;touch x" },
      { ...args, albedo: "https://example.com/image.png" },
      { ...args, output_dir: "bad\0path" },
      { ...args, python: "print('no')" },
    ]) {
      await expect(executeBlender(invalid, ctx, fake)).rejects.toThrow()
    }
    expect(requests).toEqual([])
    expect(fake.calls).toEqual([])
    expect(await readdir(dir)).toEqual([])
  })

  test("denied execution or edit permission causes no writes or spawn", async () => {
    for (const denied of ["blender_execute", "edit"]) {
      const fake = fakeSpawn(() => {})
      ctx.ask = async (request) => {
        requests.push(request)
        expect(await readdir(dir)).toEqual([])
        if (request.permission === denied) throw new Error("denied")
      }
      await expect(executeBlender(args, ctx, fake)).rejects.toThrow("denied")
      expect(fake.calls).toEqual([])
      expect(await readdir(dir)).toEqual([])
    }
  })

  test("requests canonical texture read approval before any output creation", async () => {
    await writeFile(path.join(dir, "actual.png"), "fake image")
    await symlink(path.join(dir, "actual.png"), path.join(dir, "alias.png"))
    const fake = fakeSpawn(() => {})
    ctx.ask = async (request) => {
      requests.push(request)
      if (request.permission === "read") throw new Error("read denied")
    }
    await expect(executeBlender({ ...args, albedo: "alias.png" }, ctx, fake)).rejects.toThrow("read denied")
    expect(requests.map((request) => request.permission)).toEqual(["blender_execute", "read"])
    expect(requests[1].patterns).toEqual([path.join(dir, "actual.png")])
    expect(requests[0].metadata).toMatchObject({ local: true, billing: "free", external_paid_services: false })
    expect(fake.calls).toEqual([])
    expect((await readdir(dir)).sort()).toEqual(["actual.png", "alias.png"])
  })

  for (const external of ["texture", "output"]) {
    test(`external ${external} denial prevents writes and spawn`, async () => {
      const project = path.join(dir, "project")
      const outside = path.join(dir, "project-other")
      await mkdir(project)
      await mkdir(outside)
      await writeFile(path.join(outside, "actual.png"), "not read")
      await symlink(outside, path.join(project, "escape"))
      ctx.directory = project
      ctx.worktree = project
      const fake = fakeSpawn(() => {})
      ctx.ask = async (request) => {
        requests.push(request)
        if (request.permission === "external_directory") throw new Error("external denied")
      }
      await expect(
        executeBlender(
          {
            ...args,
            output_dir: external === "output" ? "escape" : ".",
            albedo: external === "texture" ? "escape/actual.png" : undefined,
          },
          ctx,
          fake,
        ),
      ).rejects.toThrow("external denied")
      expect(requests.map((request) => request.permission)).toEqual(["external_directory"])
      expect(requests[0].patterns).toEqual(
        external === "texture" ? [path.join(outside, "actual.png")] : [outside, path.join(outside, "**")],
      )
      expect(fake.calls).toEqual([])
      expect(await readdir(project)).toEqual(["escape"])
      expect(await readdir(outside)).toEqual(["actual.png"])
    })
  }

  test("rejects user blend files and directory textures", async () => {
    await writeFile(path.join(dir, "input.blend"), "not opened")
    await mkdir(path.join(dir, "directory.png"))
    const fake = fakeSpawn(() => {})
    await expect(executeBlender({ ...args, albedo: "input.blend" }, ctx, fake)).rejects.toThrow("raster image")
    await expect(executeBlender({ ...args, albedo: "directory.png" }, ctx, fake)).rejects.toThrow("not a regular file")
    expect(fake.calls).toEqual([])
    expect((await readdir(dir)).sort()).toEqual(["directory.png", "input.blend"])
  })

  test("requires an existing output directory and never replaces a file", async () => {
    await writeFile(path.join(dir, "existing"), "keep")
    const fake = fakeSpawn(() => {})
    await expect(executeBlender({ ...args, output_dir: "missing" }, ctx, fake)).rejects.toThrow()
    await expect(executeBlender({ ...args, output_dir: "existing" }, ctx, fake)).rejects.toThrow("not a directory")
    expect(fake.calls).toEqual([])
    expect(await readdir(dir)).toEqual(["existing"])
  })

  test("spawns only after approvals with fixed argv and unique non-overwriting outputs", async () => {
    const fake = fakeSpawn((child, argv) => {
      void (async () => {
        try {
          const payload = JSON.parse(argv[argv.length - 1])
          for (const file of ["sample.blend", "sample.glb", "preview.png", "manifest.json"]) {
            await writeFile(path.join(payload.output_dir, file), "fake output", { flag: "wx" })
          }
          child.emit("close", 0, null)
        } catch (error) {
          child.emit("error", error)
          child.emit("close", 1, null)
        }
      })()
    })
    ctx.ask = async (request) => {
      requests.push(request)
      expect(fake.calls.length).toBe(Math.floor((requests.length - 1) / 2))
    }
    const first = await executeBlender(args, ctx, fake)
    const second = await executeBlender(args, ctx, fake)
    expect(requests.map((request) => request.permission)).toEqual([
      "blender_execute",
      "edit",
      "blender_execute",
      "edit",
    ])
    expect(first.metadata.output_dir).not.toBe(second.metadata.output_dir)
    expect(first.output).toContain("not a production mesh")
    expect(first.metadata.outputs.blend).toBe(path.join(first.metadata.output_dir, "sample.blend"))
    expect((await readdir(first.metadata.output_dir)).sort()).toEqual([
      "manifest.json",
      "preview.png",
      "sample.blend",
      "sample.glb",
    ])
    const call = fake.calls[0]
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
    expect(call.argv[7]).toBe("--")
    expect(JSON.parse(call.argv[8])).toEqual({
      name: "sample",
      primitive: "cube",
      output_dir: first.metadata.output_dir,
      textures: {},
    })
  })

  test("reports a missing executable without trying to install it", async () => {
    const fake = fakeSpawn((child) => {
      child.emit("error", Object.assign(new Error("missing"), { code: "ENOENT" }))
      child.emit("close", -2, null)
    })
    await expect(executeBlender(args, ctx, fake)).rejects.toThrow(
      "Blender was not found on PATH. No installation was attempted.",
    )
    expect(fake.calls).toHaveLength(1)
  })

  test("bounds combined stdout/stderr on failure", async () => {
    const fake = fakeSpawn((child) => {
      child.stdout?.emit("data", Buffer.alloc(100_000, "x"))
      child.stderr?.emit("data", Buffer.alloc(100_000, "y"))
      child.emit("close", 1, null)
    })
    let message = ""
    try {
      await executeBlender(args, ctx, fake)
    } catch (error) {
      message = String(error)
    }
    expect(message).toContain("Blender failed (1)")
    expect(message.length).toBeLessThan(66_000)
    expect(message).not.toContain("yyyy")
  })

  test("rejects successful exits with missing artifacts", async () => {
    const fake = fakeSpawn((child) => child.emit("close", 0, null))
    await expect(executeBlender(args, ctx, fake)).rejects.toThrow("Partial files may remain")
  })

  test("already cancelled calls neither ask, write nor spawn", async () => {
    const fake = fakeSpawn(() => {})
    controller.abort()
    await expect(executeBlender(args, ctx, fake)).rejects.toThrow()
    expect(requests).toEqual([])
    expect(fake.calls).toEqual([])
    expect(await readdir(dir)).toEqual([])
  })

  test("cancellation during approval prevents writes and spawn", async () => {
    const fake = fakeSpawn(() => {})
    ctx.ask = async () => controller.abort()
    await expect(executeBlender(args, ctx, fake)).rejects.toThrow()
    expect(fake.calls).toEqual([])
    expect(await readdir(dir)).toEqual([])
  })

  test("cancellation kills the child and waits for close", async () => {
    const fake = fakeSpawn(() => controller.abort())
    let closed = false
    fake.child.on("close", () => {
      closed = true
    })
    await expect(executeBlender(args, ctx, fake)).rejects.toThrow("cancelled")
    expect(fake.signals).toEqual(["SIGKILL"])
    expect(closed).toBe(true)
  })

  test("timeout kills the child and waits for close", async () => {
    const fake = fakeSpawn(() => {})
    let closed = false
    fake.child.on("close", () => {
      closed = true
    })
    await expect(executeBlender(args, ctx, { ...fake, timeoutMs: 5 })).rejects.toThrow("120-second timeout")
    expect(fake.signals).toEqual(["SIGKILL"])
    expect(closed).toBe(true)
  })

  test.skipIf(process.platform === "win32")(
    "cancellation kills the POSIX process group, not just Blender",
    async () => {
      const fake = fakeSpawn((child) => {
        controller.abort()
        child.emit("close", null, "SIGKILL")
      })
      Object.defineProperty(fake.child, "pid", { value: 12345 })
      const kill = spyOn(process, "kill").mockImplementation(() => true)
      try {
        await expect(executeBlender(args, ctx, fake)).rejects.toThrow("cancelled")
        expect(kill).toHaveBeenCalledWith(-12345, "SIGKILL")
        expect(fake.signals).toEqual([])
        expect(fake.calls[0].options).toMatchObject({ detached: true })
      } finally {
        kill.mockRestore()
      }
    },
  )
})
