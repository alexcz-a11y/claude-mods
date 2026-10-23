import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ImageEntry } from '../types'
import { classify, findImages, imageSources, fingerprint, fitCells, ORIGIN_LABEL, pngSize } from './core'
import type { FoundImage, Origin } from './core'

const PANE = 'image-pane'
const TITLE = 'Images'
const KEEP = 200

const images = atom({ plugin: 'image-pane', key: 'images' } as const, [])
const selected = atom({ plugin: 'image-pane', key: 'selected' } as const, null)
const seen = atom({ plugin: 'image-pane', key: 'seen' } as const, [])

// 解码 stdin 的 base64，非 PNG 用 sips 转成 PNG（macOS 才有 sips，别处只收 PNG），
// 未缩小的原件留作 <n>.orig.<ext>，「打开原图」找不到真实来源时打开它。
// 报原图宽高，再把超过 2 MiB 的缩小：iTerm2 只画 `{ png }` 字节，字节最多 2 MiB。
const SAVE = `dir=$1; name=$2; mt=$3
mkdir -p "$dir" || exit 1
ext=\${mt#image/}; orig="$dir/$name.orig.$ext"; png="$dir/$name.png"
base64 -d > "$orig" || exit 1
if [ "$mt" = image/png ]; then cp "$orig" "$png"; else
  sips -s format png "$orig" --out "$png" >/dev/null 2>&1 || exit 2
fi
sips -g pixelWidth -g pixelHeight "$png" 2>/dev/null | awk '/pixelWidth/{w=$2}/pixelHeight/{h=$2}END{print w" "h}'
for side in 1600 1200 800 500; do
  [ "$(wc -c < "$png")" -le 2000000 ] && break
  sips -Z $side "$png" >/dev/null 2>&1 || break
done`

// 画图用的 base64，按序号缓存，免得每次重绘都读 2 MiB 文件。
// 热重载后清空，代价只是下一次重绘再读一次文件。
const bytes = new Map<number, string>()

async function pngOf($: EngineInterface, one: ImageEntry): Promise<string | null> {
  if (!one.file) return null
  const hit = bytes.get(one.n)
  if (hit) return hit
  try {
    const { base64 } = await $.fs.read(one.file, { as: 'bytes' })
    bytes.set(one.n, base64)
    return base64
  } catch {
    return null
  }
}

// 只在终端里工作：session.start 时没有终端（Claude Desktop、-p、SDK）就整个 mod 不动。
// 热重载会重跑 session.start，所以放模块变量即可，丢了会在下一次 session.start 补回。
let isTerminal = false

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const surfaces = await $.session.surfaces()
    isTerminal = e.surface === 'terminal' || surfaces.includes('terminal')
    if (!isTerminal) return next(e)

    await $.command.register({
      name: 'images',
      description: '打开本会话的图片栏（你发的图和 agent 读到、截到的图）',
    })
    if ((await read($, images)).length > 0) void $.ui.open({ id: PANE, title: TITLE })

    return next(e)
  })

  on('command.run', { command: 'images' }, async $ => {
    if (!isTerminal) return { text: 'image-pane 只在终端里显示图片。' }
    const opened = await $.ui.open({ id: PANE, title: TITLE })
    const count = (await read($, images)).length

    return { text: opened.isPlaced ? `图片栏已打开，共 ${count} 张。` : '图片栏已打开，终端放不下时会等到有空间再显示。' }
  })

  // 用户发的图：这一轮开始时，最后一条用户消息里直接带的 image 块。
  on('turn.start', async ($, e, next) => {
    const r = await next(e)
    if (!isTerminal || e.agentId !== undefined) return r
    const messages = await $.session.messages({ as: 'api' })
    const last = [...messages].reverse().find(m => m.role === 'user')
    const blocks = last?.content ?? []
    const found = blocks.filter(b => b.type === 'image').flatMap(b => findImages(b))
    // 引擎把贴的图缩小后放进消息，原文件路径在紧跟的 `[Image: source: …]` 文本里；只有一张时才对得上。
    const sources = blocks.flatMap(b => (b.type === 'text' && typeof b.text === 'string' ? imageSources(b.text) : []))
    const sourcePath = found.length === 1 && sources.length === 1 ? sources[0] : undefined
    await collect($, found, { origin: 'user', sourcePath }).catch(() => {})

    return r
  })

  // agent 的图：任何工具结果里带的图片，主循环和子 agent 都算。
  on('tool.call', async ($, e, next) => {
    const r = await next(e)
    if (!isTerminal || r.deny !== undefined || r.isError) return r
    const found = findImages(r.result)
    if (found.length === 0) return r
    const input = e as unknown as { file_path?: unknown }
    await collect($, found, {
      origin: classify(e.tool),
      tool: e.tool,
      agentId: e.agentId,
      sourcePath: e.tool === 'Read' && typeof input.file_path === 'string' ? input.file_path : undefined,
    }).catch(() => {})

    return r
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    const { Box, Text, Button, Image } = $.ui.resolve(e)
    const list = await read($, images)
    const pick = await read($, selected)
    const { bodyColumns, scroll } = e.props

    if (list.length === 0) return <Text dimColor>还没有图片。你发的图和 agent 读到、截到的图会出现在这里。</Text>

    const at = pick === null ? list.length - 1 : Math.max(0, list.findIndex(one => one.n === pick))
    const one = list[at]
    if (!one) return next(e)
    const go = (to: number) => update($, selected, () => (to >= list.length - 1 ? null : list[Math.max(0, to)]?.n ?? null))
    const size = fitCells(one.width, one.height, bodyColumns, scroll.bodyRows - 4)
    const alt = `${ORIGIN_LABEL[one.origin]} ${one.sourcePath ?? one.file ?? ''}`.trim()
    const time = new Date(one.at).toTimeString().slice(0, 5)
    const png = await pngOf($, one)
    // Image 不接受点击，叠按钮又会盖掉像素，所以只能用按钮或热键打开。
    const target = one.sourcePath ?? one.original
    const open = () => void openOriginal($, one)

    return (
      <Box flexDirection="column">
        <Text>
          {at + 1}/{list.length} · {ORIGIN_LABEL[one.origin]}
          {one.tool ? ` · ${one.tool}` : ''}
          {one.agentId ? ` · 子 agent ${one.agentId.slice(0, 8)}` : ''}
          <Text dimColor> {time}{one.width ? ` · ${one.width}×${one.height}` : ''}</Text>
        </Text>
        {png ? (
          <Image key="shown" source={{ png }} columns={size.columns} rows={size.rows} alt={alt} />
        ) : (
          <Text dimColor>（这张图没能转成 PNG，无法显示：{one.mediaType}）</Text>
        )}
        {one.sourcePath && <Text dimColor>{one.sourcePath}</Text>}
        <Box flexDirection="row" gap={1}>
          <Button key="prev" label="上一张" hotkey="h" onPress={() => go(at - 1)} />
          <Button key="next" label="下一张" hotkey="l" onPress={() => go(at + 1)} />
          {target && <Button key="open" label="打开原图" hotkey="o" onPress={open} />}
          <Button key="latest" label={pick === null ? '跟随最新 ✓' : '跟随最新'} hotkey="f" onPress={() => go(list.length - 1)} />
        </Box>
      </Box>
    )
  })
}

// 「打开原图」：先开真实来源（Read 的文件、贴图时引擎存的原文件），开不了再开保存时留下的原件。
async function openOriginal($: EngineInterface, one: ImageEntry) {
  for (const path of [one.sourcePath, one.original]) {
    if (!path) continue
    const run = await $.process.run(['open', path]).catch(() => null)
    if (run?.exitCode === 0) return
  }
  await $.ui.toast('打不开这张图的原图：文件可能已被移走。')
}

type Meta = { origin: Origin; tool?: string; agentId?: string; sourcePath?: string }

async function collect($: EngineInterface, found: FoundImage[], meta: Meta) {
  if (found.length === 0) return
  const known = new Set(await read($, seen))
  const fresh = found.filter(f => !known.has(fingerprint(f.base64)))
  if (fresh.length === 0) return

  const dir = `/tmp/image-pane/${await $.session.id()}`
  let n = ((await read($, images)).at(-1)?.n ?? 0) + 1
  const added: ImageEntry[] = []
  for (const f of fresh) {
    const entry: ImageEntry = { n, ...meta, mediaType: f.mediaType, at: Date.now() }
    try {
      const run = await $.process.run(['/bin/sh', '-c', SAVE, 'sh', dir, String(n), f.mediaType], {
        stdin: f.base64,
        timeoutMs: 8000,
      })
      if (run.exitCode === 0) {
        entry.file = `${dir}/${n}.png`
        entry.original = `${dir}/${n}.orig.${f.mediaType.slice('image/'.length)}`
        const [w, h] = run.stdout.trim().split(' ').map(Number)
        const dims = w && h ? { width: w, height: h } : f.mediaType === 'image/png' ? pngSize(f.base64) : null
        if (dims) Object.assign(entry, dims)
      }
    } catch {
      // 写不出文件就只留文字条目
    }
    added.push(entry)
    n++
  }

  await update($, seen, list => [...list, ...fresh.map(f => fingerprint(f.base64))].slice(-KEEP))
  await update($, images, list => [...list, ...added].slice(-KEEP))
  void $.ui.open({ id: PANE, title: TITLE })
}
