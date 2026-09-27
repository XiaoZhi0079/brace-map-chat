export type ProtocolId = 'openai-responses' | 'anthropic-messages'

export type ApiChatMessage = {
  role: 'user' | 'assistant'
  content: string
}

export type ModelProfileSummary = {
  id: string
  name: string
  protocol: ProtocolId
  model: string
  requestUrl: string
  modelsUrl?: string
  hasApiKey: boolean
}

export type ModelProfileInput = {
  id?: string
  name: string
  protocol: ProtocolId
  model: string
  requestUrl: string
  modelsUrl?: string
  apiKey?: string
}

export type ModelListItem = {
  id: string
  ownedBy?: string
}

export type ModelListResponse = {
  profileId?: string
  models: ModelListItem[]
}

export type ModelDiscoveryInput = {
  profileId?: string
  protocol: ProtocolId
  requestUrl: string
  modelsUrl?: string
  apiKey?: string
}

export type ProfileListResponse = {
  profiles: ModelProfileSummary[]
}

export type ProfileSaveResponse = {
  profile: ModelProfileSummary
}

export type ChatRequest = {
  profileId: string
  messages: ApiChatMessage[]
  sourceQuote?: string
}

export type ChatResponse = {
  message: ApiChatMessage & { role: 'assistant' }
  model: string
  protocol: ProtocolId
  profileId: string
}

export type ChatStreamEvent =
  | {
      type: 'start'
      model: string
      protocol: ProtocolId
      profileId: string
    }
  | { type: 'delta'; delta: string }
  | { type: 'done' }
  | {
      type: 'error'
      error: {
        status: number
        code: string
        message: string
        requestId: string
      }
    }

export type HealthResponse = {
  status: 'ok'
}

export type ErrorResponse = {
  error: {
    code: string
    message: string
    requestId: string
  }
}
