import { appendFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

type TextSink = {
  write: (chunk: string) => unknown
}

type StructuredLoggerOptions = {
  now?: () => Date
  dateKey?: (date: Date) => string
  stdout?: TextSink
  stderr?: TextSink
}

const SENSITIVE_KEYS = new Set([
  'authorization',
  'apikey',
  'xapikey',
  'token',
  'secret',
  'password',
  'messages',
  'content',
  'prompt',
  'body',
  'input',
  'sourcequote',
  'selectedsource',
])

function normalizedKey(key: string) {
  return key.replace(/[^a-z0-9]/gi, '').toLowerCase()
}

function sanitizeValue(value: unknown, key = '', depth = 0): unknown {
  if (SENSITIVE_KEYS.has(normalizedKey(key))) return '[REDACTED]'
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') return value.length > 8_000 ? `${value.slice(0, 8_000)}…` : value
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'undefined') return undefined
  if (depth >= 6) return '[MAX_DEPTH]'
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, '', depth + 1))
  if (value instanceof Error) {
    return {
      name: value.name,
      message: sanitizeValue(value.message, 'error_message', depth + 1),
      stack: sanitizeValue(value.stack, 'stack', depth + 1),
    }
  }
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).flatMap(([childKey, childValue]) => {
      const sanitized = sanitizeValue(childValue, childKey, depth + 1)
      return typeof sanitized === 'undefined' ? [] : [[childKey, sanitized]]
    }))
  }
  return String(value)
}

export class StructuredJsonlLogger {
  readonly directory: string
  private readonly now: () => Date
  private readonly dateKey: (date: Date) => string
  private readonly stdout: TextSink
  private readonly stderr: TextSink

  constructor(directory: string, options: StructuredLoggerOptions = {}) {
    this.directory = resolve(directory)
    this.now = options.now ?? (() => new Date())
    this.dateKey = options.dateKey ?? ((date) => [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0'),
    ].join('-'))
    this.stdout = options.stdout ?? process.stdout
    this.stderr = options.stderr ?? process.stderr
    mkdirSync(this.directory, { recursive: true })
  }

  write(entry: Record<string, unknown>) {
    const now = this.now()
    const timestamp = now.toISOString()
    const sanitized = sanitizeValue(entry) as Record<string, unknown>
    const line = `${JSON.stringify({ ...sanitized, timestamp })}\n`
    this.stdout.write(line)
    try {
      mkdirSync(this.directory, { recursive: true })
      appendFileSync(join(this.directory, `brace-map-chat-${this.dateKey(now)}.jsonl`), line, 'utf8')
    } catch (error) {
      this.stderr.write(`${JSON.stringify({
        level: 'error',
        event: 'persistent_log_write_failed',
        error_name: error instanceof Error ? error.name : typeof error,
        timestamp,
      })}\n`)
    }
  }
}
