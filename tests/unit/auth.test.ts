import { describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import { loadOpenAIAuth } from "../../src/auth"

function context(connection: unknown, credential: unknown) {
  return {
    integration: {
      connection: {
        active: async (id: string) => (id === "openai" ? connection : undefined),
        resolve: async () => credential,
      },
    },
  } as unknown as Pick<Plugin.Context, "integration">
}

describe("V2 active OpenAI connection", () => {
  test("resolves an active browser OAuth token and account ID without reading credential files", async () => {
    expect(
      await loadOpenAIAuth(
        context(
          { id: "active" },
          { type: "oauth", methodID: "chatgpt-browser", access: "test-token", metadata: { accountId: "acct-1" } },
        ),
      ),
    ).toEqual({
      type: "oauth",
      access: "test-token",
      accountId: "acct-1",
    })
  })

  test("accepts a headless ChatGPT OAuth connection and snake-case account metadata", async () => {
    expect(
      await loadOpenAIAuth(
        context(
          { id: "active" },
          { type: "oauth", methodID: "chatgpt-headless", access: "test-token", metadata: { account_id: "acct-2" } },
        ),
      ),
    ).toEqual({
      type: "oauth",
      access: "test-token",
      accountId: "acct-2",
    })
  })

  test("rejects inactive, API-key, unrelated OAuth, and missing-access credentials", async () => {
    expect(await loadOpenAIAuth(context(undefined, { type: "oauth", access: "token" }))).toBeUndefined()
    for (const credential of [
      { type: "api", access: "token" },
      { type: "oauth", methodID: "other", access: "token" },
      { type: "oauth", methodID: "chatgpt-browser" },
    ]) {
      expect(await loadOpenAIAuth(context({ id: "active" }, credential))).toBeUndefined()
    }
  })

  test("fails closed when the V2 connection resolver fails", async () => {
    const ctx = {
      integration: {
        connection: {
          active: async () => {
            throw new Error("unavailable")
          },
        },
      },
    }
    expect(await loadOpenAIAuth(ctx as unknown as Pick<Plugin.Context, "integration">)).toBeUndefined()
  })
})
