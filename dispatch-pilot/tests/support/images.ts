// Image files and programs for the world (tests/support/world.ts, #57): the files the mod reads as bytes (`$.fs.read(path,
// { as: 'bytes' })`) and the programs it runs (`$.process.run`: sips, and later ffmpeg and the rest), on a disk of the test's own.
//
// A file is described, not drawn: its format, its pixels' width and height, and a `label`, the story of how it came to be (the
// derived files a program writes carry the source and what was done: `/shots/a.png > resize 522x1568`). `fileBase64` makes the
// bytes of one: a real PNG or JPEG header, so that what the mod reads of the size out of them is the size the description gives,
// and the label in a text chunk (PNG) or a comment (JPEG), so that a test can tell, from the bytes in a request, which file and
// which steps they came from (`readFake`).
//
// Not a test file (no `.test.ts`).

/** A file the world's disk holds: an image, or any bytes the test gives as base64. `size` is the size on disk when it is not the bytes' own. */
export type FakeFile = FakeImage | { base64: string; size?: number; mtimeMs?: number }

export type FakeImage = {
  /** The name sips gives the format: png, jpeg, tiff, gif, heic, bmp, ... */
  format: string
  width: number
  height: number
  /** The size on disk in bytes (a fake image is a few dozen bytes); `fs.read` refuses what is over 4 MiB. */
  size?: number
  /** Where it came from and what was done to it. */
  label?: string
  /** The EXIF orientation of a JPEG (1 to 8); left out for none. */
  orientation?: number
  /** When it was last modified (`$.fs.stat`'s `mtimeMs`, in mock clock ms); 0 when left out, a file from before anything began. `w.save` stamps the time now. */
  mtimeMs?: number
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export function toBase64(bytes: ArrayLike<number>): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0
    const b = bytes[i + 1] ?? 0
    const c = bytes[i + 2] ?? 0
    const group = (a << 16) | (b << 8) | c
    out += ALPHABET.charAt((group >> 18) & 63) + ALPHABET.charAt((group >> 12) & 63) + (i + 1 < bytes.length ? ALPHABET.charAt((group >> 6) & 63) : '=') + (i + 2 < bytes.length ? ALPHABET.charAt(group & 63) : '=')
  }
  return out
}

export function fromBase64(text: string): number[] {
  const bytes: number[] = []
  const clean = text.replace(/=+$/, '')
  let bits = 0
  let held = 0
  for (const char of clean) {
    held = (held << 6) | ALPHABET.indexOf(char)
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes.push((held >> bits) & 255)
    }
  }
  return bytes
}

const ascii = (text: string): number[] => [...text].map((char) => char.charCodeAt(0) & 255)
const be16 = (n: number): number[] => [(n >> 8) & 255, n & 255]
const be32 = (n: number): number[] => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]

/** The bytes of a fake image: a PNG's signature, IHDR and a text chunk with the label; a JPEG's SOI, comment, SOF0 and EOI; any other format, a line of text. */
function imageBytes(image: FakeImage): number[] {
  const label = image.label ?? ''
  if (image.format === 'png') {
    const chunk = (type: string, body: number[]) => [...be32(body.length), ...ascii(type), ...body, 0, 0, 0, 0]
    return [137, 80, 78, 71, 13, 10, 26, 10, ...chunk('IHDR', [...be32(image.width), ...be32(image.height), 8, 2, 0, 0, 0]), ...chunk('tEXt', [...ascii('label'), 0, ...ascii(label)]), ...chunk('IEND', [])]
  }
  if (image.format === 'jpeg') {
    const comment = ascii(label)
    // The EXIF block of a camera's photo: a big-endian TIFF with one entry, the orientation.
    const tiff = [0x4d, 0x4d, 0, 42, ...be32(8), ...be16(1), ...be16(0x0112), ...be16(3), ...be32(1), ...be16(image.orientation ?? 1), 0, 0, ...be32(0)]
    const exif = image.orientation === undefined ? [] : [0xff, 0xe1, ...be16(tiff.length + 8), ...ascii('Exif'), 0, 0, ...tiff]
    return [0xff, 0xd8, ...exif, 0xff, 0xfe, ...be16(comment.length + 2), ...comment, 0xff, 0xc0, ...be16(17), 8, ...be16(image.height), ...be16(image.width), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]
  }
  return ascii(`FAKE ${image.format} ${image.width}x${image.height} ${label}`)
}

export function fileBase64(file: FakeFile): string {
  return 'base64' in file ? file.base64 : toBase64(imageBytes(file))
}

/** The size of a file on disk: as the test says, else the length of its bytes. */
export function fileSize(file: FakeFile): number {
  return file.size ?? fromBase64(fileBase64(file)).length
}

/** What a request's image bytes say of the file they came from, read the way a decoder would (the PNG's IHDR, the JPEG's SOF); null for bytes that are neither. */
export function readFake(base64: string): { format: 'png' | 'jpeg'; width: number; height: number; label: string } | null {
  const bytes = fromBase64(base64)
  const text = (from: number, to: number) => String.fromCharCode(...bytes.slice(from, to))
  const u32 = (at: number) => ((bytes[at] ?? 0) * 2 ** 24) + (((bytes[at + 1] ?? 0) << 16) | ((bytes[at + 2] ?? 0) << 8) | (bytes[at + 3] ?? 0))
  const u16 = (at: number) => ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0)
  if (text(1, 4) === 'PNG') {
    let label = ''
    for (let at = 8; at + 8 <= bytes.length; at += 12 + u32(at)) {
      if (text(at + 4, at + 8) === 'tEXt') label = text(at + 8 + 'label'.length + 1, at + 8 + u32(at))
    }
    return { format: 'png', width: u32(16), height: u32(20), label }
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let label = ''
    let size: { width: number; height: number } | null = null
    for (let at = 2; at + 4 <= bytes.length && bytes[at] === 0xff; at += 2 + u16(at + 2)) {
      if (bytes[at + 1] === 0xfe) label = text(at + 4, at + 2 + u16(at + 2))
      if (bytes[at + 1] === 0xc0) size = { height: u16(at + 5), width: u16(at + 7) }
    }
    return size === null ? null : { format: 'jpeg', ...size, label }
  }
  return null
}

// ---- What the engine hands the mod of an image (#62) -----------------------------------------------------------------------

/** The media type of a fake image, as the engine names it; null for a format the engine does not show as an image. */
export function mediaTypeOf(file: FakeFile): 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | null {
  if (!('format' in file)) return null
  return file.format === 'png' || file.format === 'jpeg' || file.format === 'gif' || file.format === 'webp' ? `image/${file.format}` : null
}

/**
 * What `tool.call` gets of a Read of an image file, as the engine gives it (spec #55 「实测得到的形状」, Claude Code 2.1.300): the
 * image as a structured result (the engine scales it to 2000 on the long side for the model, and says so in `dimensions`), the
 * `[Image: ...]` text it adds, and the reference (a number) the core would use for the model's message.
 */
export function readImageResult(path: string, file: FakeImage) {
  const long = Math.max(file.width, file.height)
  const scale = long > 2000 ? 2000 / long : 1
  return {
    result: {
      type: 'image' as const,
      file: {
        base64: fileBase64(file),
        type: mediaTypeOf(file) ?? 'image/png',
        originalSize: fileSize(file),
        dimensions: { originalWidth: file.width, originalHeight: file.height, displayWidth: Math.round(file.width * scale), displayHeight: Math.round(file.height * scale) },
      },
    },
    ref: 7,
    text: `[Image: source: ${path} (${file.width}x${file.height})]`,
  }
}

/**
 * The content of an MCP screenshot tool's result: a line of text and the image. `mcp` is MCP's own shape for an image block
 * (`data`, `mimeType`); `api` the Messages API's (`source.data`, `source.media_type`). Which of them the engine hands a
 * `tool.call` hook was never measured (the user decided on no more probes), so the mod reads both.
 */
export function screenshotContent(file: FakeImage, shape: 'mcp' | 'api' = 'mcp') {
  const mediaType = mediaTypeOf(file) ?? 'image/png'
  const image = shape === 'mcp' ? { type: 'image', data: fileBase64(file), mimeType: mediaType } : { type: 'image', source: { type: 'base64', media_type: mediaType, data: fileBase64(file) } }
  return [{ type: 'text', text: 'Took a screenshot of the page.' }, image]
}

// ---- Programs ---------------------------------------------------------------------------------------------------------

/** What a program prints and how it ends. */
export type ProgramResult = { exitCode: number; stdout: string; stderr: string }

/** The disk a program works on: the files by absolute path, and the directories that exist. */
export type Disk = { files: Map<string, FakeFile>; dirs: Set<string> }

/** What `$.process.run` was given besides the arguments (`init`). */
export type RunInit = { cwd?: string; env?: Record<string, string>; stdin?: string; timeoutMs?: number }

/** A program of the world: given its arguments (not its name), the disk and the `init` of the run, what it prints. */
export type Program = (args: readonly string[], disk: Disk, init?: RunInit) => ProgramResult | Promise<ProgramResult>

export const ok = (stdout = ''): ProgramResult => ({ exitCode: 0, stdout, stderr: '' })

/** Where the world's session works: relative paths are under it. */
export const WORK_DIR = '/work'

export function absolute(path: string): string {
  const parts: string[] = []
  for (const part of (path.startsWith('/') ? path : `${WORK_DIR}/${path}`).split('/')) {
    if (part === '..') parts.pop()
    else if (part !== '' && part !== '.') parts.push(part)
  }
  return `/${parts.join('/')}`
}

/** The directories a world's disk starts with. */
export const BASE_DIRS = ['/', WORK_DIR, '/tmp', '/private/tmp']

const parentOf = (path: string): string => path.replace(/\/[^/]*$/, '') || '/'

/** `mkdir -p` (the only form the mod uses). */
export const mkdir: Program = (args, disk) => {
  for (const dir of args.filter((arg) => !arg.startsWith('-'))) {
    for (let at = absolute(dir); at !== '/' && !disk.dirs.has(at); at = parentOf(at)) disk.dirs.add(at)
  }
  return ok()
}

/**
 * `base64 -D -o <file>` (macOS's; the only form the mod uses, #62): decodes the text on stdin into the file. A fake image's
 * bytes come back as the image they describe (`readFake`), so that the files the mod saves from an MCP tool's result can be read
 * by the world's sips and `fs.read` like any other; bytes of any other kind are kept as they are. The output goes in a directory
 * that exists; stdin that is no base64 text is an error with exit code 1.
 */
export const base64: Program = (args, disk, init) => {
  const out = args[args.indexOf('-o') + 1]
  if (!args.some((arg) => arg === '-D' || arg === '-d' || arg === '--decode') || args.indexOf('-o') < 0 || out === undefined) return { exitCode: 1, stdout: '', stderr: 'usage: base64 [-Ddh] [-b num] [-i in_file] [-o out_file]' }
  const text = (init?.stdin ?? '').replace(/\s+/g, '')
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return { exitCode: 1, stdout: '', stderr: 'base64: invalid input' }
  const target = absolute(out)
  if (!disk.dirs.has(parentOf(target))) return { exitCode: 1, stdout: '', stderr: `base64: ${out}: No such file or directory` }
  const image = readFake(text)
  disk.files.set(target, image === null ? { base64: text } : { format: image.format, width: image.width, height: image.height, label: image.label })
  return ok()
}

/** A recording the world's ffmpeg knows (#60): it is not a file of the disk (`files`), the program has it by path. */
export type FakeVideo = {
  seconds: number
  width: number
  height: number
  /** Frames a second; the last frame lies one frame before the end. 30 when left out. */
  fps?: number
  /** The last frame lies this many seconds before the end (a screen recording whose picture stood still at the end); one frame when left out. */
  gapAtEnd?: number
}

const clock = (seconds: number): string => {
  const whole = Math.floor(seconds)
  const hundredths = Math.round((seconds - whole) * 100)
  const two = (n: number) => String(n).padStart(2, '0')
  return `${two(Math.floor(whole / 3600))}:${two(Math.floor(whole / 60) % 60)}:${two(whole % 60)}.${two(hundredths)}`
}

/**
 * ffmpeg, as far as the mod uses it, and as it answers (measured with ffmpeg 8.1.2): `ffmpeg -hide_banner -i file` alone prints
 * the file's `Duration: HH:MM:SS.cc` among its notes on stderr and ends with exit code 1 ("At least one output file must be
 * specified"); a file that is not there ends with 254 and "No such file or directory"; `-ss T -i file -frames:v 1 out.jpg` writes
 * the first frame at or after T as a JPEG, and when there is none (T past the last frame) ends with 234 and writes nothing. The
 * recordings are `videos`, by absolute path; the frames land on the disk, labelled `<recording> @<T>s`.
 */
export function ffmpeg(videos: Record<string, FakeVideo>): Program {
  return (args, disk) => {
    let input: string | undefined
    let from = 0
    const outputs: string[] = []
    for (let i = 0; i < args.length; i++) {
      const arg = args[i] as string
      if (arg === '-i') input = args[++i]
      else if (arg === '-ss') from = Number(args[++i])
      else if (['-loglevel', '-frames:v', '-q:v', '-t', '-vf'].includes(arg)) i++
      else if (!arg.startsWith('-')) outputs.push(arg)
    }
    if (input === undefined) return { exitCode: 1, stdout: '', stderr: 'Error: no input' }
    const video = videos[absolute(input)]
    if (video === undefined) return { exitCode: 254, stdout: '', stderr: `[in#0] Error opening input: No such file or directory\nError opening input file ${input}.\nError opening input files: No such file or directory\n` }
    const out = outputs[0]
    if (out === undefined) {
      return { exitCode: 1, stdout: '', stderr: `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from '${input}':\n  Duration: ${clock(video.seconds)}, start: 0.000000, bitrate: 81 kb/s\n  Stream #0:0: Video: h264, ${video.width}x${video.height}, ${video.fps ?? 30} fps\nAt least one output file must be specified\n` }
    }
    const lastFrame = video.seconds - (video.gapAtEnd ?? 1 / (video.fps ?? 30))
    if (from > lastFrame) return { exitCode: 234, stdout: '', stderr: 'Nothing was written into output file, because at least one of its streams received no packets.\n' }
    const target = absolute(out)
    if (!disk.dirs.has(parentOf(target))) return { exitCode: 254, stdout: '', stderr: `${out}: No such file or directory\n` }
    disk.files.set(target, { format: 'jpeg', width: video.width, height: video.height, label: `${absolute(input)} @${from.toFixed(3)}s` })
    return ok()
  }
}

/**
 * macOS's sips, as far as the mod uses it, and as it answers (measured on macOS 26): `-g key` prints the file's path and then
 * `  key: value` (`<nil>` for what it cannot read); a file that is not an image is a warning on stderr and exit code 0; `-Z n`
 * makes the longer side n pixels, larger or smaller; `-z h w` the height and width; `-c h w --cropOffset y x` crops; `-s format
 * png|jpeg` converts; `-r deg` rotates clockwise; `-f horizontal|vertical` flips; `--out` names the output, which must be in a
 * directory that exists (else it is the file in place).
 */
export const sips: Program = (args, disk) => {
  const gets: string[] = []
  const steps: { name: string; args: string[] }[] = []
  const inputs: string[] = []
  let out: string | undefined
  let offset: { y: number; x: number } | undefined
  const take = (i: number, count: number): string[] => args.slice(i + 1, i + 1 + count)
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (arg === '-g' || arg === '--getProperty') gets.push(...take(i++, 1))
    else if (arg === '-1' || arg === '--oneLine') continue
    else if (arg === '-Z' || arg === '--resampleHeightWidthMax') steps.push({ name: 'fit', args: take(i, 1) }), (i += 1)
    else if (arg === '-z' || arg === '--resampleHeightWidth') steps.push({ name: 'resize', args: take(i, 2) }), (i += 2)
    else if (arg === '-c' || arg === '--cropToHeightWidth') steps.push({ name: 'crop', args: take(i, 2) }), (i += 2)
    else if (arg === '--cropOffset') (offset = { y: Number(args[i + 1]), x: Number(args[i + 2]) }), (i += 2)
    else if (arg === '-s' || arg === '--setProperty') steps.push({ name: 'set', args: take(i, 2) }), (i += 2)
    else if (arg === '-r' || arg === '--rotate') steps.push({ name: 'rotate', args: take(i, 1) }), (i += 1)
    else if (arg === '-f' || arg === '--flip') steps.push({ name: 'flip', args: take(i, 1) }), (i += 1)
    else if (arg === '-o' || arg === '--out') (out = args[i + 1]), (i += 1)
    else if (arg.startsWith('-')) return { exitCode: 1, stdout: '', stderr: `Error 3: unknown option ${arg}` }
    else inputs.push(arg)
  }
  let stdout = ''
  let stderr = ''
  for (const input of inputs) {
    const source = disk.files.get(absolute(input))
    // A path that is no file: a warning only. A file that is no image: its properties are `<nil>`.
    if (source === undefined) {
      stderr += `Warning: ${input} not a valid file - skipping\n`
      continue
    }
    if ('base64' in source) {
      stderr += `Warning: ${input} not a valid file - skipping\n`
      if (gets.length > 0) stdout += `${absolute(input)}\n${gets.map((key) => `  ${key}: <nil>\n`).join('')}`
      continue
    }
    if (gets.length > 0) {
      const value = (key: string): string => (key === 'pixelWidth' ? String(source.width) : key === 'pixelHeight' ? String(source.height) : key === 'format' ? source.format : key === 'hasAlpha' ? 'no' : '<nil>')
      stdout += `${absolute(input)}\n${gets.map((key) => `  ${key}: ${value(key)}\n`).join('')}`
    }
    if (steps.length === 0) continue
    const next: FakeImage = { ...source }
    const story: string[] = []
    for (const step of steps) {
      const [a = '', b = ''] = step.args
      if (step.name === 'fit') {
        const longest = Math.max(next.width, next.height)
        next.width = Math.max(1, Math.round((next.width * Number(a)) / longest))
        next.height = Math.max(1, Math.round((next.height * Number(a)) / longest))
        story.push(`fit ${next.width}x${next.height}`)
      } else if (step.name === 'resize') {
        next.height = Number(a)
        next.width = Number(b)
        story.push(`resize ${next.width}x${next.height}`)
      } else if (step.name === 'crop') {
        const at = offset ?? { y: 0, x: 0 }
        next.height = Math.min(Number(a), next.height)
        next.width = Math.min(Number(b), next.width)
        story.push(`crop ${next.width}x${next.height}+${at.x}+${at.y}`)
      } else if (step.name === 'set' && a === 'format') {
        next.format = b
        story.push(`format ${b}`)
      } else if (step.name === 'set') {
        story.push(`${a} ${b}`)
      } else if (step.name === 'rotate') {
        if (Number(a) % 180 !== 0) [next.width, next.height] = [next.height, next.width]
        story.push(`rotate ${a}`)
      } else {
        story.push(`flip ${a}`)
      }
    }
    next.label = [source.label ?? absolute(input), ...story].join(' > ')
    next.size = undefined
    const target = out === undefined ? absolute(input) : absolute(out)
    if (!disk.dirs.has(parentOf(target))) return { exitCode: 1, stdout, stderr: `Error 4: cannot write ${target}: no such directory` }
    disk.files.set(target, next)
    stdout += `${absolute(input)}\n  ${target}\n`
  }
  return { exitCode: 0, stdout, stderr }
}
