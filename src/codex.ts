import { EventSourceParserStream } from "eventsource-parser/stream"
import { getReferences } from "./input-image"
import { MAX_OUTPUT_BASE64_LENGTH } from "./output-image"
import type { GenerateArgs, OpenAIAuth } from "./types"

// Codex OAuth responses endpoint URL.
// https://github.com/openai/codex/blob/fca81eeb5bab4cad997622a359d446e6489c445b/codex-rs/model-provider-info/src/lib.rs#L37
// https://github.com/openai/codex/blob/fca81eeb5bab4cad997622a359d446e6489c445b/codex-rs/core/src/client.rs#L146
const CODEX_RESPONSES_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses"

// Codex model slug used for the hosted image_generation turn.
// https://github.com/openai/codex/blob/fca81eeb5bab4cad997622a359d446e6489c445b/codex-rs/models-manager/models.json#L24
const SUBSCRIPTION_MODEL = "gpt-5.5"
export const REQUEST_TIMEOUT_MS = 5 * 60 * 1000
const MAX_RESPONSE_BYTES = MAX_OUTPUT_BASE64_LENGTH * 2 + 1024 * 1024

export function buildGenerationPrompt(args: GenerateArgs): string {
  const references = getReferences(args)
  if (!references.length) return args.prompt
  return [
    args.prompt,
    "Reference images (in attachment order; roles and preservation requests are guidance, not exact edits or masks):",
    ...references.map(
      (reference, i) =>
        `Image ${i + 1}: ${reference.role ?? "reference image"}.${reference.preserve ? ` Preserve: ${reference.preserve}` : ""}`,
    ),
  ].join("\n")
}

type CodexSSEEvent = {
  type?: string
  item?: { type?: string; result?: string }
}

export async function parseImageGenerationResultFromSSE(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): Promise<string> {
  let received = 0
  const bounded = stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        received += chunk.byteLength
        if (received > MAX_RESPONSE_BYTES) throw new Error("codex response exceeds size limit")
        controller.enqueue(chunk)
      },
    }),
    { signal },
  )
  const events = (bounded as unknown as ReadableStream<BufferSource>)
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventSourceParserStream({ maxBufferSize: MAX_RESPONSE_BYTES }))
  for await (const event of events) {
    if (event.data === "[DONE]") continue
    let json: CodexSSEEvent
    try {
      json = JSON.parse(event.data) as CodexSSEEvent
    } catch {
      // SSE keepalive or non-JSON heartbeat
      continue
    }
    if (
      json &&
      json.type === "response.output_item.done" &&
      json.item?.type === "image_generation_call" &&
      typeof json.item.result === "string" &&
      // Reject an empty result: decoding it would write a 0-byte file and report success.
      json.item.result.length > 0
    ) {
      if (json.item.result.length > MAX_OUTPUT_BASE64_LENGTH) throw new Error("generated image exceeds 50 MiB")
      return json.item.result
    }
  }
  throw new Error("no image_generation result returned by codex backend")
}

export async function callViaCodexResponses(
  auth: OpenAIAuth,
  args: GenerateArgs,
  inputImageDataUrls: string[],
  abort?: AbortSignal,
): Promise<string> {
  const signal = AbortSignal.any([...(abort ? [abort] : []), AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
  signal.throwIfAborted()
  const userContent: Array<Record<string, unknown>> = [{ type: "input_text", text: buildGenerationPrompt(args) }]
  for (const dataUrl of inputImageDataUrls) {
    userContent.push({ type: "input_image", image_url: dataUrl })
  }

  // https://github.com/openai/codex/blob/fca81eeb5bab4cad997622a359d446e6489c445b/codex-rs/core/src/client.rs#L745-L763
  const body: Record<string, unknown> = {
    model: SUBSCRIPTION_MODEL,
    instructions:
      "You are an image generation assistant running inside the Codex backend. " +
      "Always satisfy the request by invoking the image_generation tool exactly once. " +
      "Do not respond with text only.",
    input: [{ role: "user", content: userContent }],
    tools: [
      {
        type: "image_generation",
        output_format: "png",
        quality: args.quality,
        ...(args.size ? { size: args.size } : {}),
      },
    ],
    tool_choice: { type: "image_generation" },
    stream: true,
    store: false,
  }

  const res = await fetch(CODEX_RESPONSES_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${auth.access}`,
      ...(auth.accountId ? { "ChatGPT-Account-Id": auth.accountId } : {}),
      originator: "opencode",
      Accept: "text/event-stream",
    },
    body: JSON.stringify(body),
    signal,
    redirect: "error",
  })
  if (!res.ok || !res.body) {
    let detail = ""
    if (res.body) {
      const text = (res.body as unknown as ReadableStream<BufferSource>).pipeThrough(new TextDecoderStream(), {
        signal,
      })
      for await (const chunk of text) {
        detail += chunk.slice(0, 500 - detail.length)
        if (detail.length >= 500) break
      }
    }
    throw new Error(`codex responses request failed: ${res.status} ${detail}`)
  }
  return parseImageGenerationResultFromSSE(res.body, signal)
}
