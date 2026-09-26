import { createOpencodeClient, type OpencodeClientConfig } from "@opencode-ai/sdk/v2"

/** Preserve the injected client's in-process fetch, authentication and URL. */
export function attentionClient(injected: unknown) {
  const transport = (injected as { _client?: { getConfig(): OpencodeClientConfig } })._client
  if (!transport?.getConfig) throw new Error("OpenCode client transport unavailable")
  return createOpencodeClient(transport.getConfig())
}
