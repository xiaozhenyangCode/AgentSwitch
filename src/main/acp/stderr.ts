import { userInfo } from 'node:os'
import { StringDecoder } from 'node:string_decoder'

const CHUNK_BYTES = 32 * 1024
const TAIL_BYTES = 4 * 1024
const realHome = userInfo().homedir

export function sanitize(text: string, home?: string): string {
  text = text.replace(/\0/g, '')
  for (const dir of [home, realHome].filter((dir): dir is string => Boolean(dir)).sort((a, b) => b.length - a.length)) {
    text = text.replaceAll(dir, '~')
  }
  return text
    .replace(/https?:\/\/accounts\.google\.com(?:(?!\\[nr])[^\s"'<>])*/gi, '[sign-in-url]')
    .replace(/(\bBearer\s+)[^\s"'<>\\]+/gi, '$1[redacted]')
    .replace(/(\bAuthorization"?\s*:\s*"?Basic\s+)[^\s"'<>\\]+/gi, '$1[redacted]')
    .replace(/(\bx-api-key"?\s*:\s*"?)[^\s"'<>\\]+/gi, '$1[redacted]')
    .replace(/\b(?:sk-[\w-]{8,}|ghp_[\w-]+|xox[a-z]?-[\w-]+|ya29\.[\w.-]+|AIza[\w-]+)/g, '[redacted]')
}

const tailBytes = (text: string, max: number): string => {
  const bytes = Buffer.from(text)
  if (bytes.length <= max) return text
  let start = bytes.length - max
  while ((bytes[start] & 0xc0) === 0x80) start++
  return bytes.toString('utf8', start)
}

// A clipped prefix may be the middle of a token whose identifying prefix is gone.
const clipLine = (text: string): string => Buffer.byteLength(text) > CHUNK_BYTES
  ? tailBytes(text, CHUNK_BYTES).replace(/^\S+/, '[truncated]')
  : text

export class StderrTail {
  private readonly decoder = new StringDecoder('utf8')
  private line = ''
  private kept = ''

  constructor(private readonly home: string | undefined, private readonly onLog: (text: string) => void) {}

  push(chunk: Buffer): void {
    if (chunk.length > CHUNK_BYTES) {
      this.decoder.end()
      this.line = ''
      const retained = chunk.subarray(-CHUNK_BYTES)
      this.consume(this.decoder.write(retained).replace(/^\S+/, '[truncated]'))
      return
    }
    this.consume(this.decoder.write(chunk))
  }

  end(): void {
    this.consume(this.decoder.end())
    if (this.line) this.record(this.line)
    this.line = ''
  }

  get tail(): string {
    return tailBytes(this.kept + sanitize(this.line, this.home), TAIL_BYTES)
  }

  private consume(text: string): void {
    const lines = (this.line + text).split('\n')
    this.line = clipLine(lines.pop()!)
    for (const line of lines) this.record(clipLine(line) + '\n')
  }

  private record(raw: string): void {
    const safe = sanitize(raw, this.home)
    this.kept = tailBytes(this.kept + safe, TAIL_BYTES)
    this.onLog(safe)
  }
}
