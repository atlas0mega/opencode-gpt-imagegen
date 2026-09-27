import type { Plugin } from "@opencode/plugin"
import type { OpenAIAuth } from "./types"

// Resolve the active V2 OpenAI integration for each call; never copy credentials to project files.
export async function loadOpenAIAuth(context: Pick<Plugin.Context, "integration">): Promise<OpenAIAuth | undefined> {
  try {
    const connection = await context.integration.connection.active("openai")
    if (!connection) return undefined
    const credential = await context.integration.connection.resolve(connection)
    if (
      credential?.type !== "oauth" ||
      !["chatgpt-browser", "chatgpt-headless"].includes(credential.methodID) ||
      !credential.access
    ) {
      return undefined
    }
    const metadata = credential.metadata ?? {}
    const accountId = metadata.accountID ?? metadata.accountId ?? metadata.account_id
    return {
      type: "oauth",
      access: credential.access,
      ...(typeof accountId === "string" && accountId ? { accountId } : {}),
    }
  } catch {
    // A broken connection is not a reason to try legacy credential files.
    return undefined
  }
}
