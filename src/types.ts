// Minimal subset of the active V2 OpenAI OAuth credential required by Codex.
export type OpenAIAuth = { type: "oauth"; access: string; accountId?: string }

export type ImageReference = {
  path: string
  role: "edit-target" | "style" | "subject" | "material" | "composition"
  preserve?: string
}

export type ResolvedReference = { path: string; role?: ImageReference["role"]; preserve?: string }

export type GenerateArgs = {
  prompt: string
  out: string
  quality: "low" | "medium" | "high" | "auto"
  size?: string
  images?: string[]
  references?: ImageReference[]
}
