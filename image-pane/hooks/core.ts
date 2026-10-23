// 纯函数：从任意工具结果或 API 消息里找出图片，判断来源，算显示尺寸。
// 不碰 `$`，测试直接调用。

export type FoundImage = { mediaType: string; base64: string }

const MEDIA = /^image\/(png|jpeg|jpg|gif|webp)$/

// 认得的几种形状：
// Read 的 `{ type: 'image', file: { base64, type } }`；
// MCP 的 `{ type: 'image', data, mimeType }`；
// Messages API 的 `{ type: 'image', source: { type: 'base64', media_type, data } }`；
// 其他工具的 `{ media_type, data }`。
export function findImages(value: unknown, depth = 0, out: FoundImage[] = []): FoundImage[] {
  if (depth > 8 || value === null || typeof value !== 'object') return out
  if (Array.isArray(value)) {
    for (const one of value) findImages(one, depth + 1, out)
    return out
  }
  const o = value as Record<string, unknown>
  const mediaType = [o.mimeType, o.media_type, o.mediaType, o.type].find(
    (t): t is string => typeof t === 'string' && MEDIA.test(t),
  )
  const base64 = [o.base64, o.data].find((d): d is string => typeof d === 'string' && d.length > 32)
  if (mediaType && base64) {
    out.push({ mediaType, base64 })
    return out
  }
  for (const key of Object.keys(o)) findImages(o[key], depth + 1, out)
  return out
}

export type Origin = 'user' | 'read' | 'screenshot' | 'tool'

export function classify(tool: string): Origin {
  if (tool === 'Read') return 'read'
  if (/screenshot|zoom|snapshot|capture|computer/i.test(tool)) return 'screenshot'
  return 'tool'
}

export const ORIGIN_LABEL: Record<Origin, string> = {
  user: '用户发的',
  read: '读取',
  screenshot: '截图',
  tool: '工具结果',
}

// 去重用的指纹：长度加首尾片段，不必为了它整段做哈希。
export function fingerprint(base64: string): string {
  return `${base64.length}:${base64.slice(0, 48)}:${base64.slice(-48)}`
}

// PNG 的宽高在 IHDR 里（第 16 到 23 字节），解开前 32 个 base64 字符就够。
export function pngSize(base64: string): { width: number; height: number } | null {
  try {
    const head = decode(base64.slice(0, 32))
    if (head[1] !== 0x50 || head[2] !== 0x4e || head[3] !== 0x47) return null
    const b = (i: number) => head[i] ?? 0
    const at = (i: number) => ((b(i) << 24) | (b(i + 1) << 16) | (b(i + 2) << 8) | b(i + 3)) >>> 0
    return { width: at(16), height: at(20) }
  } catch {
    return null
  }
}

// 终端一格大约宽 1、高 2，所以行数是列数乘高宽比再除以 2。
export function fitCells(
  width: number | undefined,
  height: number | undefined,
  columns: number,
  rows: number,
): { columns: number; rows: number } {
  const cols = Math.max(1, Math.min(255, columns))
  const maxRows = Math.max(1, Math.min(255, rows))
  if (!width || !height) return { columns: cols, rows: Math.min(maxRows, Math.round(cols / 3)) || 1 }
  const want = Math.round((cols * height) / width / 2)
  if (want <= maxRows) return { columns: cols, rows: Math.max(1, want) }
  return { columns: Math.max(1, Math.min(cols, Math.round((maxRows * 2 * width) / height))), rows: maxRows }
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

// 只为解开 PNG 文件头的几十个字符，沙箱里没有 atob。
function decode(text: string): number[] {
  const out: number[] = []
  for (let i = 0; i + 3 < text.length; i += 4) {
    const v = [0, 1, 2, 3].map(k => ALPHABET.indexOf(text[i + k] ?? 'A'))
    if (v.some(x => x < 0)) throw new Error('not base64')
    const [a = 0, b = 0, c = 0, d = 0] = v
    out.push((a << 2) | (b >> 4), ((b & 15) << 4) | (c >> 2), ((c & 3) << 6) | d)
  }
  return out
}

// 消息里 `[Image: source: /path/1.png …]` 的路径，贴图时引擎存下的原文件。
export function imageSources(text: string): string[] {
  // 路径里可能有空格（macOS 截屏的文件名），所以一直取到 `]`。
  return [...text.matchAll(/\[Image: source: ([^\]]+?)\s*\]/g)].map(m => m[1] ?? '').filter(Boolean)
}
