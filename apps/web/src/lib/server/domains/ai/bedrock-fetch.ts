/**
 * Custom `fetch` for the OpenAI SDK when talking to AWS Bedrock (bedrock-mantle).
 *
 * Bedrock's data plane needs one of two auth schemes, neither of which the
 * OpenAI SDK speaks natively:
 *   - Bedrock API key  → a bearer token in the Authorization header.
 *   - Default AWS chain → SigV4 request signing (instance profile, EKS pod
 *     identity / web-identity, env creds, shared config, …).
 *
 * The SDK invokes its `fetch` option as `fetch(url, init)` where `url` is a
 * string, `init.headers` is a `Headers`, and `init.body` is a string. We wrap
 * that call: the bearer path just sets the header; the SigV4 path rebuilds the
 * request as an smithy `HttpRequest`, signs it, and forwards the signed headers.
 */

import { Sha256 } from '@aws-crypto/sha256-js'
import { HttpRequest } from '@smithy/protocol-http'
import { SignatureV4 } from '@smithy/signature-v4'
import { config } from '@/lib/server/config'
import { getBedrockCredentials } from './bedrock-runtime'

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

// Bedrock's data-plane signing name.
const SIGNING_SERVICE = 'bedrock'

/**
 * Build a `fetch` implementation for the configured Bedrock auth mode.
 *
 * Prefers an explicit Bedrock API key (bearer) when set; otherwise signs with
 * SigV4 using the default AWS credential provider chain. Region must be set
 * (guaranteed by `isBedrockConfigured`).
 */
export function createBedrockFetch(): Fetch {
  const apiKey = config.aiBedrockApiKey
  const region = config.aiBedrockRegion

  if (apiKey) {
    return async (input, init) => {
      const headers = new Headers(init?.headers)
      headers.set('Authorization', `Bearer ${apiKey}`)
      return fetch(input, { ...init, headers })
    }
  }

  if (!region) {
    // Should be unreachable: getOpenAI only builds the Bedrock client when
    // isBedrockConfigured (region + base url) is true. Guard defensively so a
    // misconfiguration surfaces clearly instead of a cryptic signer error.
    throw new Error('Bedrock SigV4 signing requires AI_BEDROCK_REGION (or AWS_REGION)')
  }

  const signer = new SignatureV4({
    service: SIGNING_SERVICE,
    region,
    credentials: getBedrockCredentials(),
    sha256: Sha256,
  })

  return async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.toString())

    // The SDK always passes a string body for these calls; normalize anything
    // else defensively so signing matches the bytes actually sent.
    let body: string | undefined
    if (typeof init?.body === 'string') {
      body = init.body
    } else if (init?.body != null) {
      body = await new Response(init.body as BodyInit).text()
    }

    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value
    })
    // SigV4 must sign the Host header; set it explicitly since fetch would
    // otherwise add it after signing.
    headers['host'] = url.host

    const signed = await signer.sign(
      new HttpRequest({
        method: init?.method?.toUpperCase() ?? 'POST',
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port ? Number(url.port) : undefined,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers,
        body,
      })
    )

    return fetch(url, { method: signed.method, headers: signed.headers, body })
  }
}
