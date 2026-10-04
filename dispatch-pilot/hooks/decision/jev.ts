// Jev, TypeSafe's System One model: POST /v1/systemone with a Bearer key.
//
// Pure (see system-one.ts).

import { postJson, type Backend } from './backend.ts'
import { readResponse } from './system-one.ts'

export const JEV_URL = 'https://api.typesafe.ai/v1/systemone'
/** The alias of the current Jev; pin a version id (`jev-1.13.0`) to keep calibrated thresholds stable. */
export const JEV_MODEL = 'jev-latest'

export function jevBackend(apiKey: string, options: { url?: string; model?: string } = {}): Backend {
  const url = options.url ?? JEV_URL
  const model = options.model ?? JEV_MODEL
  return {
    name: 'jev',
    async ask(io, request, timeoutMs) {
      if (!apiKey) return { ok: false, failure: { kind: 'config', detail: 'no TypeSafe API key: set typesafeApiKey' } }
      const posted = await postJson(io, url, { authorization: `Bearer ${apiKey}` }, { model, state: request.state, questions: request.questions }, timeoutMs)
      if (!posted.ok) return posted
      let body: unknown
      try {
        body = JSON.parse(posted.response.text)
      } catch {
        return { ok: false, failure: { kind: 'parse', detail: `not JSON: ${posted.response.text.slice(0, 200)}` } }
      }
      const response = readResponse(body)
      if (response === null) return { ok: false, failure: { kind: 'parse', detail: `no answers: ${posted.response.text.slice(0, 200)}` } }
      return { ok: true, ...response }
    },
  }
}
