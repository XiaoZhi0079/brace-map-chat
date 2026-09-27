import type { ProtocolId } from '../src/shared/chat.ts'

export type ProviderStreamEvent =
  | { type: 'delta'; delta: string }
  | { type: 'done'; implicit?: boolean }
  | { type: 'error'; message: string }

type JsonRecord = Record<string, unknown>

function record(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' ? value as JsonRecord : null
}

function textParts(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value.map((part) => {
    const item = record(part)
    if (!item) return ''
    if (typeof item.text === 'string') return item.text
    return typeof item.content === 'string' ? item.content : ''
  }).join('')
}

function providerErrorMessage(payload: JsonRecord, fallback: string) {
  const error = record(payload.error)
  if (typeof error?.message === 'string' && error.message.trim()) return error.message.trim()
  if (typeof payload.message === 'string' && payload.message.trim()) return payload.message.trim()
  const response = record(payload.response)
  const responseError = record(response?.error)
  if (typeof responseError?.message === 'string' && responseError.message.trim()) {
    return responseError.message.trim()
  }
  const details = record(response?.incomplete_details)
  if (typeof details?.reason === 'string' && details.reason.trim()) {
    return `模型未完整生成回答：${details.reason.trim()}`
  }
  return fallback
}

function compatibleDelta(payload: JsonRecord) {
  if (!Array.isArray(payload.choices)) return ''
  return payload.choices.map((value) => {
    const choice = record(value)
    const delta = record(choice?.delta)
    return textParts(delta?.content)
  }).join('')
}

function completeResponseText(protocol: ProtocolId, payload: JsonRecord) {
  if (typeof payload.output_text === 'string') return payload.output_text

  if (protocol === 'openai-responses' && Array.isArray(payload.output)) {
    return payload.output.flatMap((value) => {
      const output = record(value)
      if (output?.type !== 'message' || !Array.isArray(output.content)) return []
      return output.content.map((part) => {
        const content = record(part)
        return content?.type === 'output_text' && typeof content.text === 'string' ? content.text : ''
      })
    }).join('\n')
  }

  if (protocol === 'anthropic-messages' && Array.isArray(payload.content)) {
    return payload.content.map((value) => {
      const content = record(value)
      return content?.type === 'text' && typeof content.text === 'string' ? content.text : ''
    }).join('\n')
  }

  if (Array.isArray(payload.choices)) {
    return payload.choices.map((value) => {
      const choice = record(value)
      const message = record(choice?.message)
      if (typeof message?.content === 'string') return message.content
      return typeof choice?.text === 'string' ? choice.text : ''
    }).join('\n')
  }
  return ''
}

export function parseProviderStreamPayload(
  protocol: ProtocolId,
  payload: unknown,
  eventName = '',
): ProviderStreamEvent[] {
  const value = record(payload)
  if (!value) return [{ type: 'error', message: '模型流返回了无法识别的事件。' }]
  const eventType = typeof value.type === 'string' ? value.type : eventName

  if (eventName === 'error' || eventType === 'error') {
    return [{ type: 'error', message: providerErrorMessage(value, '模型流返回了错误事件。') }]
  }
  if (eventType === 'response.failed') {
    return [{ type: 'error', message: providerErrorMessage(value, '模型生成失败。') }]
  }
  if (eventType === 'response.incomplete') {
    return [{ type: 'error', message: providerErrorMessage(value, '模型未完整生成回答。') }]
  }
  if (eventType === 'response.completed' || eventType === 'message_stop') {
    return [{ type: 'done' }]
  }
  if (eventType === 'response.output_text.delta' || eventType === 'response.refusal.delta') {
    return typeof value.delta === 'string' && value.delta
      ? [{ type: 'delta', delta: value.delta }]
      : []
  }
  if (eventType === 'content_block_delta') {
    const delta = record(value.delta)
    return delta?.type === 'text_delta' && typeof delta.text === 'string' && delta.text
      ? [{ type: 'delta', delta: delta.text }]
      : []
  }

  const chatDelta = compatibleDelta(value)
  if (chatDelta) return [{ type: 'delta', delta: chatDelta }]

  const fullText = completeResponseText(protocol, value)
  if (fullText) return [{ type: 'delta', delta: fullText }]
  return []
}

export class ProviderSseDecoder {
  private buffer = ''
  private eventName = ''
  private dataLines: string[] = []
  private receivedText = false
  private terminal = false
  private readonly protocol: ProtocolId

  constructor(protocol: ProtocolId) {
    this.protocol = protocol
  }

  push(chunk: string): ProviderStreamEvent[] {
    this.buffer += chunk
    const events: ProviderStreamEvent[] = []
    while (true) {
      const newline = this.buffer.indexOf('\n')
      if (newline < 0) break
      let line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      events.push(...this.consumeLine(line))
    }
    return this.remember(events)
  }

  finish(): ProviderStreamEvent[] {
    const events: ProviderStreamEvent[] = []
    if (this.buffer) {
      let line = this.buffer
      if (line.endsWith('\r')) line = line.slice(0, -1)
      events.push(...this.consumeLine(line))
      this.buffer = ''
    }
    events.push(...this.flushEvent())
    this.remember(events)
    if (!this.terminal && this.receivedText) {
      this.terminal = true
      events.push({ type: 'done', implicit: true })
    }
    return events
  }

  private remember(events: ProviderStreamEvent[]) {
    for (const event of events) {
      if (event.type === 'delta' && event.delta) this.receivedText = true
      if (event.type === 'done' || event.type === 'error') this.terminal = true
    }
    return events
  }

  private consumeLine(line: string): ProviderStreamEvent[] {
    if (!line) return this.flushEvent()
    if (line.startsWith(':')) return []
    const separator = line.indexOf(':')
    const field = separator < 0 ? line : line.slice(0, separator)
    let value = separator < 0 ? '' : line.slice(separator + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') this.eventName = value
    if (field === 'data') this.dataLines.push(value)
    return []
  }

  private flushEvent(): ProviderStreamEvent[] {
    if (!this.dataLines.length) {
      this.eventName = ''
      return []
    }
    const data = this.dataLines.join('\n')
    const eventName = this.eventName
    this.dataLines = []
    this.eventName = ''
    if (data.trim() === '[DONE]') return [{ type: 'done' }]
    try {
      return parseProviderStreamPayload(this.protocol, JSON.parse(data) as unknown, eventName)
    } catch {
      return [{ type: 'error', message: '模型流返回了无效的 JSON 事件。' }]
    }
  }
}
