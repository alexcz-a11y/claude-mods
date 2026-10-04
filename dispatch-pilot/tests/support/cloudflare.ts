// Cloudflare Workers AI beneath the mod, for the tests that choose Clef: the
// twin of `jev()` in world.ts. Its replies have the shape of the real REST API
// (the envelope and the error body were captured from it on 2026-10-04), and
// it refuses what Workers AI would refuse, so a request that is wrong fails
// the test the way it fails live: a wrong token (HTTP 401), a wrong address
// (404), a body that breaks Clef's input rules (400).
//
// Not a test file. Use it as `world($, on, { backend: clef([...]) })`.

import { jev, type Reply, type Sent } from './world.ts'

/** A made-up account ID and token: nothing here is a real credential. */
export const ACCOUNT = '0123456789abcdef0123456789abcdef'
export const TOKEN = 'cf-test-token-7f3a9c'

/** Where Clef lives for ACCOUNT (Cloudflare's model page: the curl example). */
export const CLEF_URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run/@cf/cloudflare/clef`

/** The options that choose Clef with the credentials above. */
export const CLEF_OPTIONS = { decisionModel: 'clef', cloudflareAccountId: ACCOUNT, cloudflareApiToken: TOKEN }

/** A failed call as the REST API answers it: `result` null, the error in `errors` (guide §3.2). */
export function cloudflareError(status: number, code: number, message: string): Reply {
  return { status, body: { result: null, success: false, errors: [{ code, message }], messages: [] } }
}

/**
 * What a request breaks of Clef's input rules (schema-input.json on Cloudflare's
 * model page); empty when it keeps them all. Written from that schema, not
 * from the code under test.
 */
export function clefInputProblems(body: any): string[] {
  const problems: string[] = []
  if (typeof body?.model !== 'string' || !/^\s*(clef|clef-flash)\s*$/.test(body.model)) problems.push(`model must be "clef" or "clef-flash", got ${JSON.stringify(body?.model)}`)
  if (body?.state === undefined || body.state === null) problems.push('state is required')
  const questions = body?.questions
  if (typeof questions !== 'object' || questions === null || Array.isArray(questions)) return [...problems, 'questions must be an object']
  const ids = Object.keys(questions)
  if (ids.length < 1 || ids.length > 64) problems.push(`${ids.length} questions: 1 to 64 allowed`)
  for (const id of ids) {
    const question = questions[id]
    if (!/^[A-Za-z0-9_.-]{1,100}$/.test(id)) problems.push(`question id "${id}": letters, digits, "_", ".", "-" only, at most 100`)
    const instructions = question?.instructions
    const blank = instructions === undefined || instructions === null || (typeof instructions === 'string' ? instructions.trim() === '' : typeof instructions === 'object' ? Object.keys(instructions).length === 0 : true)
    if (blank) problems.push(`question "${id}": instructions must be a non-empty string, object or array`)
    const criteria = question?.criteria
    switch (question?.type) {
      case 'noul':
        break
      case 'choice': {
        const options = typeof criteria === 'object' && criteria !== null && !Array.isArray(criteria) ? Object.keys(criteria) : null
        if (options === null || options.length < 2 || options.length > 255) problems.push(`question "${id}": a choice needs an object of 2 to 255 options`)
        break
      }
      case 'score':
        if (!Array.isArray(criteria) || criteria.length < 2 || criteria.length > 10) problems.push(`question "${id}": a score needs an array of 2 to 10 levels`)
        break
      default:
        problems.push(`question "${id}": type must be noul, choice or score`)
    }
  }
  return problems
}

/**
 * Clef as Workers AI serves it for ACCOUNT and TOKEN. A request that is not
 * for CLEF_URL with `Bearer TOKEN`, or that breaks Clef's input rules, is
 * refused with the error Cloudflare gives. Otherwise every question is
 * answered as `jev(levels)` answers it (`choice` picks the option a Choice
 * answers), in Cloudflare's envelope, with the model "clef" (no version number).
 */
export function clef(levels: readonly number[], extra: { choice?: string } = {}) {
  return (request: Sent): Reply => {
    if (request.headers.authorization !== `Bearer ${TOKEN}`) return cloudflareError(401, 10000, 'Authentication error')
    if (request.url !== CLEF_URL) return cloudflareError(404, 7003, 'No route for the URI')
    const problems = clefInputProblems(request.body)
    if (problems.length > 0) return cloudflareError(400, 5006, `AiError: ${problems.join('; ')}`)
    const { body } = jev(levels, extra)(request) as { body: { answers: unknown } }
    return { status: 200, body: { result: { model: 'clef', answers: body.answers, usage: { input_tokens: 151, output_tokens: 0 } }, success: true, errors: [], messages: [] } }
  }
}
