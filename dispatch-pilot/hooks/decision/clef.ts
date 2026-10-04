// Clef, Cloudflare's decision model on Workers AI: POST to the account's
// /ai/run/@cf/cloudflare/clef with a Bearer token. The request is Jev's (the
// same state and questions); the answer comes inside Cloudflare's envelope,
// `{ result: { model, answers, usage }, success, errors, messages }`, and a
// failure inside the same envelope: `{ result: null, success: false, errors:
// [{ code, message }], messages }` (guide §3.2, captured from the real API).
//
// Pure (see system-one.ts).

import type { HttpResponse } from 'claude-code'
import { httpFailure, postJson, type Asked, type Backend, type BackendIo, type Failure } from './backend.ts'
import { readResponse, type DecisionRequest } from './system-one.ts'

/** The `model` of the request body, which Clef requires even though the address names the model. */
export const CLEF_MODEL = 'clef'

export type CloudflareCredentials = { accountId: string; apiToken: string }

/** Where Clef answers for an account (Cloudflare's model page). */
export function clefUrl(accountId: string): string {
  return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/@cf/cloudflare/clef`
}

export function clefBackend(credentials: CloudflareCredentials): Backend {
  return {
    name: 'clef',
    async ask(io, request, timeoutMs) {
      const asked = await askClef(io, credentials, request, timeoutMs)
      // A failure's detail goes to the debug log: what it echoes of the address or the header stays out.
      return asked.ok ? asked : { ok: false, failure: { ...asked.failure, detail: withoutSecrets(asked.failure.detail, credentials) } }
    },
  }
}

async function askClef(io: BackendIo, credentials: CloudflareCredentials, request: DecisionRequest, timeoutMs: number): Promise<Asked> {
  const missing = missingCredentials(credentials)
  if (missing !== null) return { ok: false, failure: { kind: 'config', detail: missing } }
  const url = clefUrl(credentials.accountId)
  const headers = { authorization: `Bearer ${credentials.apiToken}` }
  const posted = await postJson(io, url, headers, { model: CLEF_MODEL, state: request.state, questions: request.questions }, timeoutMs, cloudflareFailure)
  if (!posted.ok) return posted
  return readEnvelope(posted.response.text)
}

/** `text` with the credentials, wherever they appear in it, replaced. */
function withoutSecrets(text: string, { accountId, apiToken }: CloudflareCredentials): string {
  return [apiToken, accountId].reduce((out, secret) => (secret ? out.split(secret).join('[REDACTED]') : out), text)
}

/** What to set when a credential is missing (the status line shows it as it is); null when both are there. */
function missingCredentials({ accountId, apiToken }: CloudflareCredentials): string | null {
  if (!accountId && !apiToken) return 'no Cloudflare account ID or API token: set cloudflareAccountId and cloudflareApiToken'
  if (!accountId) return 'no Cloudflare account ID: set cloudflareAccountId'
  if (!apiToken) return 'no Cloudflare API token: set cloudflareApiToken'
  return null
}

/**
 * A non-2xx response as a failure. Cloudflare's error code says more than the
 * HTTP status where the same status means two things: 3036 (the free daily
 * allowance is spent, so not before tomorrow) and 3040 (capacity, try again)
 * are both 429; 3007 and 3008 are timeouts on its side (408).
 */
function cloudflareFailure(response: HttpResponse): Failure {
  const base = httpFailure(response)
  const error = firstError(response.text)
  if (error === null) return base
  const status = response.status
  const detail = `HTTP ${status}: ${error.code} ${error.message}`
  switch (error.code) {
    case 3036:
      return { kind: 'quota', status, detail }
    case 3040:
    case 3007:
    case 3008:
      return { kind: 'busy', status, detail }
    default:
      return { ...base, detail }
  }
}

/** The first of the envelope's `errors`, when the body is one. */
function firstError(text: string): { code: number; message: string } | null {
  const errors = record(parse(text))?.errors
  const first = Array.isArray(errors) ? record(errors[0]) : null
  return first !== null && typeof first.code === 'number' ? { code: first.code, message: String(first.message ?? '') } : null
}

/** The answers out of a 2xx envelope; a failure when it is not one or says `success: false`. */
function readEnvelope(text: string): Asked {
  const body = parse(text)
  if (body === undefined) return { ok: false, failure: { kind: 'parse', detail: `not JSON: ${text.slice(0, 200)}` } }
  const envelope = record(body)
  const response = envelope !== null && envelope.success !== false ? readResponse(envelope.result) : null
  if (response === null) return { ok: false, failure: { kind: 'parse', detail: `no answers: ${text.slice(0, 200)}` } }
  return { ok: true, ...response }
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}
