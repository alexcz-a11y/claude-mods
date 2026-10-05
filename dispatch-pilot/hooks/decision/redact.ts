// Masks common secret formats before any text leaves for the decision model
// (spec: "发送前对 secret 脱敏"). Best effort: known token prefixes, credential
// assignments, URL passwords, private keys. Pure (see system-one.ts).

const MASK = '[REDACTED]'

/** Names whose `name = value` / `name: value` value is a secret. */
const NAME = String.raw`[A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credential)[A-Za-z0-9_.-]*`

const PATTERNS: readonly (readonly [RegExp, string])[] = [
  // A PEM private key, whole.
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]'],
  // Provider keys by their prefixes.
  [/\b(?:sk|rk|pk)-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g, MASK], // Anthropic, OpenAI and alike
  [/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g, MASK], // Stripe
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/g, MASK], // GitHub
  [/\bgithub_pat_[A-Za-z0-9_]{40,}/g, MASK],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, MASK], // GitLab
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, MASK], // Slack
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, MASK], // AWS access key id
  [/\bAIza[0-9A-Za-z_-]{35}/g, MASK], // Google API key
  [/\bnpm_[A-Za-z0-9]{36}\b/g, MASK], // npm
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, MASK], // JWT
  // Bearer and Basic credentials.
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/g, `$1 ${MASK}`],
  // The password of a URL: scheme://user:password@host.
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, `$1${MASK}@`],
  // name = "value" and name = value.
  [new RegExp(String.raw`\b(${NAME})(\s*[:=]\s*)(["'])[^"'\n]{4,}\3`, 'gi'), `$1$2$3${MASK}$3`],
  [new RegExp(String.raw`\b(${NAME})(\s*[:=]\s*)(?!\[REDACTED)[^\s"',;]{6,}`, 'gi'), `$1$2${MASK}`],
  // 密码是 xxx, 密钥：xxx
  [/(密码|口令|密钥|秘钥|令牌)(\s*(?:[:：=]|是|为)\s*)[^\s，。,;；]{4,}/g, `$1$2${MASK}`],
]

export function redactSecrets(text: string): string {
  let out = text
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement)
  return out
}

/** The start of a text as the decision log quotes it: secrets masked, whitespace collapsed, cut at 40 characters, in quotes. */
export function quoteStart(text: string): string {
  const flat = redactSecrets(text).replace(/\s+/g, ' ').trim()
  return JSON.stringify(flat.length > 40 ? `${flat.slice(0, 40)}...` : flat)
}
