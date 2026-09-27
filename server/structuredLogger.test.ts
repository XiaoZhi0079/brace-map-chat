import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { StructuredJsonlLogger } from './structuredLogger.ts'

test('structured logger writes daily JSONL and redacts secrets and conversation content', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'brace-map-chat-logs-'))
  const stdout: string[] = []
  const stderr: string[] = []
  try {
    let currentTime = new Date('2026-08-26T03:04:05.000Z')
    const logger = new StructuredJsonlLogger(directory, {
      now: () => currentTime,
      dateKey: (date) => date.toISOString().slice(0, 10),
      stdout: { write: (value) => stdout.push(value) },
      stderr: { write: (value) => stderr.push(value) },
    })
    logger.write({
      level: 'error',
      event: 'provider_stream_failed',
      request_id: 'request-1',
      apiKey: 'must-not-leak',
      messages: [{ content: 'private learning conversation' }],
      error_code: 'PROVIDER_STREAM_INTERRUPTED',
    })

    const source = await readFile(join(directory, 'brace-map-chat-2026-08-26.jsonl'), 'utf8')
    const entry = JSON.parse(source.trim())
    assert.equal(entry.timestamp, '2026-08-26T03:04:05.000Z')
    assert.equal(entry.request_id, 'request-1')
    assert.equal(entry.apiKey, '[REDACTED]')
    assert.equal(entry.messages, '[REDACTED]')
    assert.doesNotMatch(source, /must-not-leak|private learning conversation/)
    assert.equal(stdout[0], source)

    currentTime = new Date('2026-08-27T00:00:01.000Z')
    logger.write({ level: 'info', event: 'next_day' })
    const nextDaySource = await readFile(join(directory, 'brace-map-chat-2026-08-27.jsonl'), 'utf8')
    assert.equal(JSON.parse(nextDaySource.trim()).event, 'next_day')
    assert.deepEqual(stderr, [])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
