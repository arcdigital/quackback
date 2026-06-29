/**
 * Shared AWS Bedrock runtime client.
 *
 * Auth: when AI_BEDROCK_API_KEY is set we pass it as a bearer `token` and pin
 * the bearer auth scheme (the client lists SigV4 first, so without pinning a
 * resolvable instance role would win over the key). Otherwise we pass nothing
 * and let the client's default credential chain apply (env, shared config,
 * instance profile, EKS pod identity) via its baked-in
 * `credentialDefaultProvider` (=@aws-sdk/credential-provider-node).
 *
 * Embeddings call this client directly; the SigV4 chat fetch borrows its
 * resolved credential provider for signing. Reusing one client avoids a second
 * copy of the credential chain and keeps us off `@aws-sdk/credential-providers`
 * (whose pinned version drifts from the rest of the SDK tree).
 */

import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime'
import { config } from '@/lib/server/config'

let client: BedrockRuntimeClient | null = null

/** Lazily build (and cache) the shared Bedrock runtime client. */
export function getBedrockRuntime(): BedrockRuntimeClient {
  if (!client) {
    const apiKey = config.aiBedrockApiKey
    client = new BedrockRuntimeClient({
      region: config.aiBedrockRegion,
      ...(apiKey ? { token: { token: apiKey }, authSchemePreference: ['httpBearerAuth'] } : {}),
    })
  }
  return client
}

/**
 * The client's resolved credential provider (the default AWS chain). Used to
 * sign chat requests to bedrock-mantle with SigV4. Typed from the client's own
 * config so we don't depend on @smithy/types directly.
 */
export function getBedrockCredentials(): BedrockRuntimeClient['config']['credentials'] {
  return getBedrockRuntime().config.credentials
}
