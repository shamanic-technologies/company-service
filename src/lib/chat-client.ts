/**
 * HTTP client for chat-service (LLM completions).
 *
 * Mirrors the caller-side endpoint convention:
 * - OrgCaller (mode: 'org')      → POST /complete                   (x-org-id, x-user-id, x-run-id + tracking)
 * - PlatformCaller (mode: 'platform') → POST /internal/platform-complete (x-api-key only, no billing, no run tracking)
 *
 * The single public entry point `chat()` dispatches on `caller.mode`.
 */

import { fetchWithRetry } from './fetch-with-retry';

const CHAT_SERVICE_URL =
  process.env.CHAT_SERVICE_URL || 'https://chat.distribute.you';
const CHAT_SERVICE_API_KEY = process.env.CHAT_SERVICE_API_KEY || '';

export interface ChatParams {
  message: string;
  systemPrompt: string;
  /** LLM provider — 'google' (Gemini) or 'anthropic' (Claude). */
  provider: 'google' | 'anthropic';
  /** Model tier — chat-service resolves the versioned model internally. */
  model: 'flash' | 'flash-lite' | 'flash-pro' | 'pro' | 'sonnet' | 'haiku' | 'opus';
  responseFormat?: 'json';
  /**
   * Optional JSON Schema describing the exact shape of the expected response.
   * When set, chat-service passes it to the provider's structured-output API
   * (Gemini: `generationConfig.responseSchema`) and the provider enforces the
   * shape server-side — the model can no longer emit malformed/truncated JSON
   * mid-output on large multi-field outputs. Implies `responseFormat: 'json'`.
   *
   * Gemini constraint: do NOT set `additionalProperties: false` — that is the
   * Anthropic strict-schema dialect and Gemini rejects it with HTTP 400.
   */
  responseSchema?: Record<string, unknown>;
  temperature?: number;
  maxTokens?: number;
  /** URL of an image for vision analysis. Requires a vision-capable model. Only supported on /complete (org mode). */
  imageUrl?: string;
  /** HTML metadata for the image — alt text, title, source URL. Only supported on /complete (org mode). */
  imageContext?: { alt?: string; title?: string; sourceUrl?: string };
  /** Token budget for model thinking/reasoning. 0 = disabled (default). */
  thinkingBudget?: number;
  /**
   * Minimize the model's internal reasoning so the whole output budget goes to
   * the answer (faster, cheaper). Provider-floored: Gemini 2.5 → thinking fully
   * OFF; Gemini 3 (incl. flash-pro) has no full-off → drops to its lowest level
   * (`minimal` for Flash). Use for short structured-JSON / scoring tasks that
   * don't need funnel-of-thought.
   */
  disableThinking?: boolean;
}

export interface ChatResult {
  content: string;
  json?: Record<string, unknown>;
  tokensInput: number;
  tokensOutput: number;
  model: string;
}

export interface GeneratedImageResult {
  imageBase64: string;
  mimeType: string;
  model: string;
  tokensInput: number;
  tokensOutput: number;
  text?: string;
}

export class ChatServiceImageGenerationError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(`chat-service POST /orgs/images/generate returned ${status}`);
    this.name = 'ChatServiceImageGenerationError';
  }
}

/**
 * Caller invoked on a brand-service `/orgs/*` route. Maps to chat-service `POST /complete`.
 * `runId` is forwarded as `x-run-id` — typically brand-service's own run id (so the chat
 * call is registered as a child of brand-service's run).
 */
export interface OrgCaller {
  mode: 'org';
  orgId: string;
  userId: string;
  runId: string;
  campaignId?: string;
  featureSlug?: string;
  brandIdHeader?: string;
  workflowSlug?: string;
  audienceId?: string;
}

/**
 * Caller invoked on a brand-service `/internal/*` route. Maps to chat-service
 * `POST /internal/platform-complete` — no org/user/run tracking, platform-billed.
 */
export interface PlatformCaller {
  mode: 'platform';
}

export type Caller = OrgCaller | PlatformCaller;

/**
 * Synchronous LLM completion. Dispatches to chat-service's org-scoped or
 * platform endpoint based on `caller.mode`.
 */
export async function chat(params: ChatParams, caller: Caller): Promise<ChatResult> {
  if (caller.mode === 'org') {
    return chatOrg(params, caller);
  }
  return chatPlatform(params);
}

export async function generateImage(prompt: string, caller: OrgCaller): Promise<GeneratedImageResult> {
  const response = await fetchWithRetry(`${CHAT_SERVICE_URL}/orgs/images/generate`, {
    method: 'POST',
    headers: buildOrgHeaders(caller),
    body: JSON.stringify({ prompt }),
    label: 'chat-service POST /orgs/images/generate',
    returnClientError: true,
  });

  if (!response.ok) {
    throw new ChatServiceImageGenerationError(response.status, await parseErrorBody(response));
  }

  const body = await response.json() as Partial<GeneratedImageResult>;
  if (
    typeof body.imageBase64 !== 'string'
    || typeof body.mimeType !== 'string'
    || typeof body.model !== 'string'
    || typeof body.tokensInput !== 'number'
    || typeof body.tokensOutput !== 'number'
  ) {
    throw new Error('chat-service image generation response was missing required fields');
  }
  if (!body.mimeType.startsWith('image/')) {
    throw new Error(`chat-service image generation returned non-image MIME type: ${body.mimeType}`);
  }

  return {
    imageBase64: body.imageBase64,
    mimeType: body.mimeType,
    model: body.model,
    tokensInput: body.tokensInput,
    tokensOutput: body.tokensOutput,
    ...(typeof body.text === 'string' ? { text: body.text } : {}),
  };
}

async function chatOrg(params: ChatParams, caller: OrgCaller): Promise<ChatResult> {
  const response = await fetchWithRetry(`${CHAT_SERVICE_URL}/complete`, {
    method: 'POST',
    headers: buildOrgHeaders(caller),
    body: JSON.stringify(buildBody(params)),
    label: `chat-service POST /complete (${params.model})`,
  });

  return response.json() as Promise<ChatResult>;
}

function buildOrgHeaders(caller: OrgCaller): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-API-Key': CHAT_SERVICE_API_KEY,
    'x-org-id': caller.orgId,
    'x-user-id': caller.userId,
    'x-run-id': caller.runId,
  };
  if (caller.campaignId) headers['x-campaign-id'] = caller.campaignId;
  if (caller.featureSlug) headers['x-feature-slug'] = caller.featureSlug;
  if (caller.brandIdHeader) headers['x-brand-id'] = caller.brandIdHeader;
  if (caller.workflowSlug) headers['x-workflow-slug'] = caller.workflowSlug;
  if (caller.audienceId) headers['x-audience-id'] = caller.audienceId;
  return headers;
}

async function chatPlatform(params: ChatParams): Promise<ChatResult> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-API-Key': CHAT_SERVICE_API_KEY,
  };

  const response = await fetchWithRetry(`${CHAT_SERVICE_URL}/internal/platform-complete`, {
    method: 'POST',
    headers,
    body: JSON.stringify(buildBody(params)),
    label: `chat-service POST /internal/platform-complete (${params.model})`,
  });

  return response.json() as Promise<ChatResult>;
}

function buildBody(params: ChatParams): Record<string, unknown> {
  return {
    message: params.message,
    systemPrompt: params.systemPrompt,
    provider: params.provider,
    model: params.model,
    ...(params.responseFormat && { responseFormat: params.responseFormat }),
    ...(params.responseSchema && { responseSchema: params.responseSchema }),
    ...(params.temperature !== undefined && { temperature: params.temperature }),
    ...(params.maxTokens !== undefined && { maxTokens: params.maxTokens }),
    ...(params.imageUrl && { imageUrl: params.imageUrl }),
    ...(params.imageContext && { imageContext: params.imageContext }),
    ...(params.thinkingBudget !== undefined && { thinkingBudget: params.thinkingBudget }),
    ...(params.disableThinking !== undefined && { disableThinking: params.disableThinking }),
  };
}

async function parseErrorBody(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => '');
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
