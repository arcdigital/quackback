/**
 * Provider-neutral chat completion helper.
 *
 * All chat features call `createChatCompletion()` instead of the OpenAI client
 * directly. It hides two backends behind one `{ text, usage }` shape:
 *   - openai:  Chat Completions API (`chat.completions.create`).
 *   - bedrock: Responses API (`responses.create`) on bedrock-mantle.
 *
 * It also owns the retry + usage-logging wrapping so callers only deal with the
 * resolved model, prompts, and parsing. Returns `null` when AI is unconfigured,
 * preserving each caller's existing early-return shape.
 */

import type OpenAI from 'openai'
import { getOpenAI, getAiProvider } from './config'
import { withRetry, type RetryOptions } from './retry'
import { withUsageLogging, type LogAiUsageParams } from './usage-log'

export interface ChatCompletionUsage {
  inputTokens: number
  outputTokens?: number
  totalTokens: number
}

export interface ChatCompletionResult {
  text: string
  usage: ChatCompletionUsage
}

/** Usage-logging context, minus the fields this helper fills in itself. */
type ChatLogContext = Omit<
  LogAiUsageParams,
  | 'callType'
  | 'model'
  | 'durationMs'
  | 'inputTokens'
  | 'outputTokens'
  | 'totalTokens'
  | 'status'
  | 'error'
  | 'retryCount'
>

export interface CreateChatCompletionParams {
  /** Resolved model id (caller uses getChatModel(feature)). */
  model: string
  /** Optional system/instructions prompt. */
  system?: string
  /** User prompt. */
  user: string
  /** Request strict JSON output. Defaults to true (every current caller wants JSON). */
  jsonResponse?: boolean
  temperature?: number
  /** Max tokens to generate. */
  maxOutputTokens: number
  /** Retry overrides (e.g. quality gate uses fewer retries). */
  retry?: RetryOptions
  /** When provided, the call is recorded to ai_usage_log. */
  log?: ChatLogContext
}

/**
 * Run a chat completion against the active provider.
 * Returns `null` when no AI client is configured.
 */
export async function createChatCompletion(
  params: CreateChatCompletionParams
): Promise<ChatCompletionResult | null> {
  const client = getOpenAI()
  if (!client) return null

  const callOnce = () =>
    getAiProvider() === 'bedrock'
      ? callResponses(client, params)
      : callChatCompletions(client, params)

  const run = () => withRetry(callOnce, params.retry)

  if (params.log) {
    return withUsageLogging(
      { ...params.log, model: params.model, callType: 'chat_completion' },
      run,
      (r) => r.usage
    )
  }

  const { result } = await run()
  return result
}

/** OpenAI Chat Completions backend. */
async function callChatCompletions(
  client: OpenAI,
  params: CreateChatCompletionParams
): Promise<ChatCompletionResult> {
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = []
  if (params.system) messages.push({ role: 'system', content: params.system })
  messages.push({ role: 'user', content: params.user })

  const completion = await client.chat.completions.create({
    model: params.model,
    messages,
    ...(params.jsonResponse !== false ? { response_format: { type: 'json_object' } } : {}),
    ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
    max_completion_tokens: params.maxOutputTokens,
  })

  return {
    text: completion.choices[0]?.message?.content ?? '',
    usage: {
      inputTokens: completion.usage?.prompt_tokens ?? 0,
      outputTokens: completion.usage?.completion_tokens,
      totalTokens: completion.usage?.total_tokens ?? 0,
    },
  }
}

/** Bedrock Responses API backend. */
async function callResponses(
  client: OpenAI,
  params: CreateChatCompletionParams
): Promise<ChatCompletionResult> {
  // gpt-5.5 on the Responses API rejects `temperature` (only the default is
  // supported), so we never forward it on this path. Our callers use low
  // temperatures purely for determinism; the loss is acceptable.
  const response = await client.responses.create({
    model: params.model,
    ...(params.system ? { instructions: params.system } : {}),
    input: params.user,
    max_output_tokens: params.maxOutputTokens,
    ...(params.jsonResponse !== false ? { text: { format: { type: 'json_object' } } } : {}),
  })

  return {
    text: response.output_text ?? '',
    usage: {
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens,
      totalTokens: response.usage?.total_tokens ?? 0,
    },
  }
}
