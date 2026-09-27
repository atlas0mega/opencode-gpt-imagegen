import type { Context } from "@opencode/plugin/promise/plugin"
import type { ToolContext } from "@opencode/plugin/promise/tool"

type Assertion = (
  input: {
    sessionID: ToolContext["sessionID"]
    agent: ToolContext["agent"]
    action: "gpt_imagegen" | "gpt_blender"
    resources: string[]
    save: string[]
    source: { type: "tool"; messageID: ToolContext["messageID"]; id: ToolContext["id"] }
  },
  options?: { signal?: AbortSignal },
) => Promise<void>

// V2 tool options filter catalog visibility; only a leaf assertion authorizes execution.
export async function assertToolPermission(
  permission: Context["permission"],
  context: ToolContext,
  action: "gpt_imagegen" | "gpt_blender",
  signal: AbortSignal,
) {
  const authorization = permission as Context["permission"] & { assert?: Assertion }
  if (typeof authorization.assert !== "function") {
    throw new Error("This OpenCode V2 host does not support tool permission assertions; image tools cannot run.")
  }
  signal.throwIfAborted()
  await authorization.assert(
    {
      sessionID: context.sessionID,
      agent: context.agent,
      action,
      resources: ["*"],
      save: ["*"],
      source: { type: "tool", messageID: context.messageID, id: context.id },
    },
    { signal },
  )
  signal.throwIfAborted()
}
