import { execFileSync, spawn } from "node:child_process"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { createServer as createHTTPServer } from "node:http"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const sandbox = await mkdtemp(path.join(tmpdir(), "gpt-imagegen-v2-smoke-"))
let server
const requests = []
let phase = "discover"
let permissionCallSent = false
const model = createHTTPServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (req.url === "/health") {
    res.writeHead(200).end("ok")
    return
  }
  if (req.url === "/v1/models") {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(
      JSON.stringify({ object: "list", data: [{ id: "mock", object: "model", created: 0, owned_by: "fixture" }] }),
    )
    return
  }
  if (!req.url?.endsWith("/chat/completions")) {
    res.writeHead(404).end()
    return
  }
  requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")))
  const discovery = requests.length === 1
  const permissionCall = (phase.startsWith("deny") || phase === "approve") && !permissionCallSent
  if (permissionCall) permissionCallSent = true
  res.writeHead(200, { "content-type": "text/event-stream" })
  res.write(
    `data: ${JSON.stringify({
      id: "image-fixture",
      object: "chat.completion.chunk",
      created: 0,
      model: "mock",
      choices: [
        {
          index: 0,
          delta:
            discovery || permissionCall
              ? {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: "fixture-discover-image-tools",
                      type: "function",
                      function: {
                        name: "execute",
                        arguments: JSON.stringify({
                          code: permissionCall
                            ? phase === "deny-blender"
                              ? 'return await tools.gpt_blender({name:"denied",output_dir:".",primitive:"cube"})'
                              : 'return await tools.gpt_imagegen({prompt:"Offline permission-denial fixture",out:"denied.png",quality:"low"})'
                            : 'return search({ query: "gpt_" }).items.map((tool) => tool.path)',
                        }),
                      },
                    },
                  ],
                }
              : { role: "assistant", content: "Fixture tools discovered." },
          finish_reason: null,
        },
      ],
    })}\n\n`,
  )
  res.write(
    `data: ${JSON.stringify({
      id: "image-fixture",
      object: "chat.completion.chunk",
      created: 0,
      model: "mock",
      choices: [{ index: 0, delta: {}, finish_reason: discovery || permissionCall ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
    })}\n\n`,
  )
  res.end("data: [DONE]\n\n")
})

try {
  const modelPort = await new Promise((resolve) => model.listen(0, "127.0.0.1", () => resolve(model.address().port)))
  const info = JSON.parse(
    execFileSync("npm", ["pack", "--pack-destination", sandbox, "--json"], { cwd: root, encoding: "utf8" }),
  )
  const archive = Array.isArray(info) ? info[0]?.filename : Object.values(info)[0]?.filename
  if (!archive) throw new Error("Image plugin tarball not produced")
  execFileSync(
    "npm",
    [
      "install",
      "--prefix",
      sandbox,
      "--no-save",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      path.join(sandbox, archive),
    ],
    { cwd: sandbox, encoding: "utf8", timeout: 90_000 },
  )
  const installed = path.join(sandbox, "node_modules", "opencode-gpt-imagegen")
  const project = path.join(sandbox, "project")
  const configHome = path.join(sandbox, "config")
  await mkdir(project)
  await mkdir(path.join(project, ".opencode"))
  await mkdir(path.join(configHome, "opencode"), { recursive: true })
  await writeFile(
    path.join(project, "opencode.jsonc"),
    JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      plugins: [installed],
      model: "vllm/mock",
      compaction: { auto: false },
      permissions: [
        { action: "gpt_imagegen", resource: "*", effect: "ask" },
        { action: "gpt_blender", resource: "*", effect: "ask" },
      ],
      providers: {
        vllm: {
          package: "@opencode/ai/providers/openai-compatible",
          settings: { baseURL: `http://127.0.0.1:${modelPort}/v1` },
          models: {
            mock: {
              name: "Fixture",
              package: "@opencode/ai/providers/openai-compatible",
              capabilities: { tools: true, input: ["text"], output: ["text"] },
              limit: { context: 16000, output: 2048 },
            },
          },
        },
      },
    }),
  )
  const env = {
    PATH: process.env.PATH,
    HOME: path.join(sandbox, "home"),
    XDG_CONFIG_HOME: configHome,
    XDG_DATA_HOME: path.join(sandbox, "data"),
    XDG_CACHE_HOME: path.join(sandbox, "cache"),
    OPENCODE_DB: path.join(sandbox, "staging.db"),
    OPENCODE_PASSWORD: "imagegen-fixture-only",
  }
  await mkdir(env.HOME)
  const port = await new Promise((resolve) => {
    const socket = createServer()
    socket.listen(0, "127.0.0.1", () => {
      const value = socket.address().port
      socket.close(() => resolve(value))
    })
  })
  const executable = process.env.OPENCODE_BIN ?? "opencode"
  server = spawn(executable, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: project,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Private V2 server startup timed out")), 30_000)
    server.once("error", reject)
    server.once("exit", (code) => reject(new Error(`Private V2 server exited ${code}`)))
    server.stdout.on("data", (chunk) => {
      if (String(chunk).includes("server listening")) {
        clearTimeout(timer)
        resolve()
      }
    })
  })
  const address = `http://127.0.0.1:${port}`
  const session = JSON.parse(
    execFileSync(
      executable,
      ["api", "--server", address, "post", "/api/session", "--data", '{"title":"Imagegen V2 packaging smoke"}'],
      { cwd: project, env, encoding: "utf8", timeout: 30_000 },
    ),
  ).data?.id
  if (!session) throw new Error("V2 image fixture session creation failed")
  let plugin
  for (let attempt = 0; attempt < 12; attempt++) {
    const listing = JSON.parse(
      execFileSync(
        executable,
        ["api", "--server", address, "get", "/api/plugin", "--param", `location.directory=${project}`],
        { cwd: project, env, encoding: "utf8", timeout: 30_000 },
      ),
    )
    plugin = listing.data?.find((entry) => entry.id === "opencode-gpt-imagegen")
    if (plugin?.state?.status === "active" || plugin?.state?.status === "error") break
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  if (plugin?.state?.status !== "active" || plugin.source?.type !== "local") {
    const log = await readFile(path.join(sandbox, "data", "opencode", "log", "opencode.log"), "utf8").catch(() => "")
    throw new Error(
      `Packed image plugin not active: ${JSON.stringify(plugin)}\n${log
        .split("\n")
        .filter((line) => /plugin|error/i.test(line))
        .slice(-12)
        .join("\n")}`,
    )
  }
  const runSession = async (sessionID, prompt) => {
    const run = spawn(
      executable,
      ["run", "--server", address, "--session", sessionID, "--model", "vllm/mock", prompt],
      {
        cwd: project,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    )
    let output = ""
    let errors = ""
    run.stdout.on("data", (chunk) => {
      output = (output + String(chunk)).slice(-4000)
    })
    run.stderr.on("data", (chunk) => {
      errors = (errors + String(chunk)).slice(-1500)
    })
    const code = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        run.kill()
        reject(new Error("V2 image fixture run timed out"))
      }, 45_000)
      run.once("error", reject)
      run.once("exit", (status) => {
        clearTimeout(timeout)
        resolve(status)
      })
    })
    return { code, output, errors }
  }
  const discoveryRun = await runSession(session, "List the available image tools without calling either.")
  if (discoveryRun.code !== 0)
    throw new Error(`V2 image fixture run failed (${discoveryRun.code}): ${discoveryRun.errors}`)
  const tools = requests.flatMap((request) => request.tools?.map((item) => item.function?.name) ?? [])
  const discovered = JSON.stringify(requests.slice(1).flatMap((request) => request.messages ?? []))
  if (!tools.includes("execute") || !discovered.includes("gpt_imagegen") || !discovered.includes("gpt_blender"))
    throw new Error(
      `Packed V2 tools were not exposed via Code Mode search: ${JSON.stringify({
        tools,
        requests: requests.length,
        toolResults: requests
          .slice(1)
          .flatMap((request) => request.messages ?? [])
          .filter((message) => message.role === "tool").length,
      })}`,
    )
  phase = "deny"
  const deniedSession = JSON.parse(
    execFileSync(
      executable,
      ["api", "--server", address, "post", "/api/session", "--data", '{"title":"Imagegen permission-denial smoke"}'],
      {
        cwd: project,
        env,
        encoding: "utf8",
        timeout: 30_000,
      },
    ),
  ).data?.id
  if (!deniedSession) throw new Error("V2 image denial fixture session creation failed")
  const deniedRun = await runSession(deniedSession, "Attempt the image generation tool to verify permission denial.")
  const denial = deniedRun.output + deniedRun.errors
  if (
    !permissionCallSent ||
    deniedRun.code === 0 ||
    !denial.includes("permission requested: gpt_imagegen") ||
    !denial.includes("auto-rejecting")
  )
    throw new Error(
      `V2 image tool permission was not rejected: ${JSON.stringify({
        ...deniedRun,
        toolResults: requests
          .slice(2)
          .flatMap((request) => request.messages ?? [])
          .filter((message) => message.role === "tool")
          .map((message) => JSON.stringify(message.content).slice(0, 800)),
      })}`,
    )
  if (
    await readFile(path.join(project, "denied.png")).then(
      () => true,
      () => false,
    )
  )
    throw new Error("Permission-denied image tool unexpectedly wrote a file")
  phase = "deny-blender"
  permissionCallSent = false
  const blenderSession = JSON.parse(
    execFileSync(
      executable,
      ["api", "--server", address, "post", "/api/session", "--data", '{"title":"Blender permission-denial smoke"}'],
      { cwd: project, env, encoding: "utf8", timeout: 30_000 },
    ),
  ).data?.id
  if (!blenderSession) throw new Error("V2 Blender denial fixture session creation failed")
  const blenderRun = await runSession(blenderSession, "Attempt Blender only to verify permission denial.")
  const blenderDenial = blenderRun.output + blenderRun.errors
  if (
    !permissionCallSent ||
    blenderRun.code === 0 ||
    !blenderDenial.includes("permission requested: gpt_blender") ||
    !blenderDenial.includes("auto-rejecting")
  )
    throw new Error(`V2 Blender tool permission was not rejected: ${JSON.stringify(blenderRun)}`)
  if ((await readdir(project)).some((name) => name.startsWith("denied")))
    throw new Error("Permission-denied Blender tool unexpectedly created output")
  phase = "approve"
  permissionCallSent = false
  const approvalStart = requests.length
  const approvedSession = JSON.parse(
    execFileSync(
      executable,
      ["api", "--server", address, "post", "/api/session", "--data", '{"title":"Imagegen allow-once smoke"}'],
      { cwd: project, env, encoding: "utf8", timeout: 30_000 },
    ),
  ).data?.id
  if (!approvedSession) throw new Error("V2 image approval fixture session creation failed")
  execFileSync(
    executable,
    [
      "api",
      "--server",
      address,
      "post",
      `/api/session/${approvedSession}/prompt`,
      "--data",
      '{"text":"Try the image tool only to verify a one-time approval."}',
    ],
    { cwd: project, env, encoding: "utf8", timeout: 30_000 },
  )
  let approval
  for (let attempt = 0; attempt < 60; attempt++) {
    const pending = JSON.parse(
      execFileSync(executable, ["api", "--server", address, "get", `/api/session/${approvedSession}/permission`], {
        cwd: project,
        env,
        encoding: "utf8",
        timeout: 30_000,
      }),
    ).data
    approval = pending?.find((request) => request.action === "gpt_imagegen")
    if (approval) break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (approval?.source?.type !== "tool" || approval.resources?.[0] !== "*" || approval.save?.[0] !== "*")
    throw new Error(`V2 image permission was not offered for one-time approval: ${JSON.stringify(approval)}`)
  execFileSync(
    executable,
    [
      "api",
      "--server",
      address,
      "post",
      `/api/session/${approvedSession}/permission/${approval.id}/reply`,
      "--data",
      '{"decision":"once"}',
    ],
    { cwd: project, env, encoding: "utf8", timeout: 30_000 },
  )
  let approvedResults = ""
  for (let attempt = 0; attempt < 60; attempt++) {
    approvedResults = JSON.stringify(
      requests
        .slice(approvalStart)
        .flatMap((request) => request.messages ?? [])
        .filter((message) => message.role === "tool"),
    )
    if (approvedResults.includes("An active OpenAI ChatGPT OAuth connection is required.")) break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (!approvedResults.includes("An active OpenAI ChatGPT OAuth connection is required.")) {
    const pending = JSON.parse(
      execFileSync(executable, ["api", "--server", address, "get", `/api/session/${approvedSession}/permission`], {
        cwd: project,
        env,
        encoding: "utf8",
        timeout: 30_000,
      }),
    ).data
    throw new Error(
      `V2 image authorization did not reach OAuth gate: ${JSON.stringify({
        pending: pending?.map((request) => ({ id: request.id, action: request.action })),
        requests: requests.length - approvalStart,
        toolResults: approvedResults.slice(-800),
      })}`,
    )
  }
  if (
    await readFile(path.join(project, "denied.png")).then(
      () => true,
      () => false,
    )
  )
    throw new Error("Offline approval fixture unexpectedly generated an image")
  console.log(
    `Installed image/Blender V2 plugin ${plugin.id} is active; each tool's ask permission rejected execution, and a one-time image approval reached the OAuth gate without credentials, generated files, Blender execution, or paid calls.`,
  )
} finally {
  if (server && server.exitCode === null && server.signalCode === null) {
    const done = new Promise((resolve) => server.once("exit", resolve))
    server.kill()
    await done
  }
  await new Promise((resolve) => model.close(resolve))
  await rm(sandbox, { recursive: true, force: true })
}
