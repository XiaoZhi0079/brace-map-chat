import type {
  ChatRequest,
  ChatResponse,
  ChatStreamEvent,
  ErrorResponse,
  HealthResponse,
  ModelProfileInput,
  ModelDiscoveryInput,
  ModelListResponse,
  ProfileListResponse,
  ProfileSaveResponse,
} from './shared/chat.ts'
import type { AgentRequest, AgentResponse } from './shared/agent.ts'
import type { LearningDataBackup, StoredWorkspace } from './dataBackup.ts'
import type {
  AgentModelSelection,
  BrowserStorageMigrationRequest,
  PersistentApplicationState,
  PreferencesSaveRequest,
  StorageStateResponse,
  WorkspaceSaveResponse,
} from './shared/persistence.ts'
import type { AgentPlanningSessionCollection } from './agent/agentPlanningSessions.ts'
import type { AgentSessionBackup } from './dataBackup.ts'
import type {
  CanvasSnapshotCanvas,
  PublishedCanvasSnapshot,
  PublishCanvasSnapshotRequest,
} from './shared/canvasSnapshot.ts'
import type { EditorLeaseAcquiredEvent, EditorLeaseEvent } from './shared/instance.ts'

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '')
let activeEditorLeaseToken: string | null = null

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly requestId?: string

  constructor(status: number, code: string, message: string, requestId?: string) {
    super(requestId ? `${message}\n请求 ID：${requestId}` : message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.requestId = requestId
  }
}

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(activeEditorLeaseToken ? { 'X-Brace-Editor-Lease': activeEditorLeaseToken } : {}),
        ...options?.headers,
      },
    })
  } catch (error) {
    if (options?.signal?.aborted) throw error
    throw new ApiError(0, 'NETWORK_ERROR', '无法连接本地服务，请确认开发服务器正在运行。')
  }

  if (!response.ok) {
    const body = await response.json().catch(() => null) as ErrorResponse | null
    throw new ApiError(
      response.status,
      body?.error.code ?? 'API_ERROR',
      body?.error.message ?? '请求失败，请稍后重试。',
      body?.error.requestId,
    )
  }

  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

export function getHealth() {
  return api<HealthResponse>('/api/health')
}

export type EditorLeaseSession = {
  acquired: EditorLeaseAcquiredEvent
  closed: Promise<void>
}

export async function acquireEditorLease(clientId: string, signal: AbortSignal): Promise<EditorLeaseSession> {
  let response: Response
  try {
    response = await fetch(`${API_BASE_URL}/api/editor-lease?clientId=${encodeURIComponent(clientId)}`, {
      signal,
      cache: 'no-store',
    })
  } catch (error) {
    if (signal.aborted) throw error
    throw new ApiError(0, 'NETWORK_ERROR', '无法连接本地服务，请确认开发服务器正在运行。')
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null) as ErrorResponse | null
    throw new ApiError(
      response.status,
      body?.error.code ?? 'API_ERROR',
      body?.error.message ?? '无法取得项目编辑权。',
    )
  }
  if (!response.body) {
    throw new ApiError(502, 'EMPTY_EDITOR_LEASE', '本地服务没有返回编辑租约连接。')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let ended = false
  const readEvent = async (): Promise<EditorLeaseEvent | null> => {
    while (true) {
      const newline = buffer.indexOf('\n')
      if (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '')
        buffer = buffer.slice(newline + 1)
        if (!line.trim()) continue
        try {
          return JSON.parse(line) as EditorLeaseEvent
        } catch {
          throw new ApiError(502, 'INVALID_EDITOR_LEASE', '本地服务返回了无效的编辑租约事件。')
        }
      }
      if (ended) return null
      const chunk = await reader.read()
      if (chunk.done) {
        buffer += decoder.decode()
        ended = true
      } else {
        buffer += decoder.decode(chunk.value, { stream: true })
      }
    }
  }

  const acquired = await readEvent()
  if (acquired?.type !== 'acquired' || acquired.clientId !== clientId) {
    await reader.cancel().catch(() => undefined)
    throw new ApiError(502, 'INVALID_EDITOR_LEASE', '本地服务没有确认当前页面的编辑权。')
  }
  activeEditorLeaseToken = acquired.leaseToken
  const closed = (async () => {
    try {
      while (await readEvent()) {
        // Heartbeats keep the single-editor connection alive.
      }
      if (!signal.aborted) {
        throw new ApiError(0, 'EDITOR_LEASE_LOST', '当前页面已失去项目编辑权，正在重新连接。')
      }
    } catch (error) {
      if (signal.aborted) return
      if (error instanceof ApiError) throw error
      throw new ApiError(0, 'EDITOR_LEASE_LOST', '当前页面已失去项目编辑权，正在重新连接。')
    } finally {
      if (activeEditorLeaseToken === acquired.leaseToken) activeEditorLeaseToken = null
    }
  })()
  return { acquired, closed }
}

export function getStorageState() {
  return api<StorageStateResponse>('/api/storage/state')
}

export function migrateBrowserStorage(request: BrowserStorageMigrationRequest) {
  return api<StorageStateResponse>('/api/storage/migrate-browser', {
    method: 'POST',
    body: JSON.stringify(request),
  })
}

export function saveWorkspace(workspace: StoredWorkspace, expectedVersion: number, keepalive = false) {
  const body = JSON.stringify({ workspace, expectedVersion })
  const canKeepalive = keepalive && new TextEncoder().encode(body).byteLength <= 60_000
  return api<WorkspaceSaveResponse>('/api/storage/workspace', {
    method: 'PUT',
    body,
    keepalive: canKeepalive,
  })
}

export function savePlanningSessions(agentPlanningSessions: AgentPlanningSessionCollection) {
  return api<{ agentPlanningSessions: AgentPlanningSessionCollection }>('/api/storage/planning-sessions', {
    method: 'PUT',
    body: JSON.stringify({ agentPlanningSessions }),
  })
}

export function deletePlanningSession(sessionId: string) {
  return api<{ agentPlanningSessions: AgentPlanningSessionCollection }>(
    `/api/storage/planning-sessions/${encodeURIComponent(sessionId)}`,
    { method: 'DELETE' },
  )
}

export function saveAgentRuntime(agentSessions: AgentSessionBackup[], agentModelSelection: AgentModelSelection | null) {
  return api<{ agentSessions: AgentSessionBackup[]; agentModelSelection: AgentModelSelection | null }>('/api/storage/agent-runtime', {
    method: 'PUT',
    body: JSON.stringify({ agentSessions, agentModelSelection }),
  })
}

export function saveStoragePreferences(preferences: PreferencesSaveRequest) {
  return api<{ preferences: PersistentApplicationState['preferences'] }>('/api/storage/preferences', {
    method: 'PUT',
    body: JSON.stringify(preferences),
  })
}

export function exportLearningData() {
  return api<LearningDataBackup>('/api/storage/export')
}

export function importLearningData(backup: LearningDataBackup) {
  return api<{
    backup: LearningDataBackup
    state: PersistentApplicationState
    storage: StorageStateResponse['storage']
  }>('/api/storage/import', {
    method: 'PUT',
    body: JSON.stringify(backup),
  })
}

export function listModelProfiles() {
  return api<ProfileListResponse>('/api/profiles')
}

export function saveModelProfile(input: ModelProfileInput) {
  return api<ProfileSaveResponse>('/api/profiles', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function deleteModelProfile(profileId: string) {
  return api<void>(`/api/profiles/${encodeURIComponent(profileId)}`, { method: 'DELETE' })
}

export function listProfileModels(profileId: string) {
  return api<ModelListResponse>(`/api/profiles/${encodeURIComponent(profileId)}/models`)
}

export function discoverProfileModels(input: ModelDiscoveryInput) {
  return api<ModelListResponse>('/api/models/discover', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function createModelResponse(request: ChatRequest, signal?: AbortSignal) {
  return api<ChatResponse>('/api/chat', {
    method: 'POST',
    body: JSON.stringify(request),
    signal,
  })
}

export type StreamModelResponseOptions = {
  signal?: AbortSignal
  onDelta: (delta: string) => void
}

export async function streamModelResponse(
  request: ChatRequest,
  options: StreamModelResponseOptions,
) {
  let response: Response
  try {
    response = await fetch(`${API_BASE_URL}/api/chat/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(activeEditorLeaseToken ? { 'X-Brace-Editor-Lease': activeEditorLeaseToken } : {}),
      },
      body: JSON.stringify(request),
      signal: options.signal,
    })
  } catch (error) {
    if (options.signal?.aborted) throw error
    throw new ApiError(0, 'NETWORK_ERROR', '无法连接本地服务，请确认开发服务器正在运行。')
  }

  if (!response.ok) {
    const body = await response.json().catch(() => null) as ErrorResponse | null
    throw new ApiError(
      response.status,
      body?.error.code ?? 'API_ERROR',
      body?.error.message ?? '请求失败，请稍后重试。',
    )
  }
  if (!response.body) {
    throw new ApiError(502, 'EMPTY_STREAM', '本地服务没有返回可读取的响应流。')
  }

  let buffer = ''
  let completed = false
  let metadata: Extract<ChatStreamEvent, { type: 'start' }> | null = null
  const handleLine = (line: string) => {
    if (!line.trim()) return
    let event: ChatStreamEvent
    try {
      event = JSON.parse(line) as ChatStreamEvent
    } catch {
      throw new ApiError(502, 'INVALID_STREAM_EVENT', '本地服务返回了无效的流事件。')
    }
    if (event.type === 'start') {
      metadata = event
      return
    }
    if (event.type === 'delta') {
      if (typeof event.delta !== 'string') {
        throw new ApiError(502, 'INVALID_STREAM_EVENT', '本地服务返回了无效的文本增量。')
      }
      options.onDelta(event.delta)
      return
    }
    if (event.type === 'done') {
      completed = true
      return
    }
    if (event.type === 'error') {
      throw new ApiError(event.error.status, event.error.code, event.error.message, event.error.requestId)
    }
    throw new ApiError(502, 'INVALID_STREAM_EVENT', '本地服务返回了未知的流事件。')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '')
        buffer = buffer.slice(newline + 1)
        handleLine(line)
        newline = buffer.indexOf('\n')
      }
    }
    buffer += decoder.decode()
    if (buffer.trim()) handleLine(buffer.replace(/\r$/, ''))
  } catch (error) {
    if (options.signal?.aborted) throw error
    if (error instanceof ApiError) throw error
    throw new ApiError(0, 'STREAM_INTERRUPTED', '模型回复连接意外中断，请重试。')
  }

  if (!completed) {
    throw new ApiError(502, 'STREAM_INTERRUPTED', '模型回复在完成前中断。')
  }
  return metadata
}

export function createAgentResponse(request: AgentRequest, signal?: AbortSignal) {
  return api<AgentResponse>('/api/agent', {
    method: 'POST',
    body: JSON.stringify(request),
    signal,
  })
}

export function getPublishedRedisCanvas() {
  return api<PublishedCanvasSnapshot | undefined>('/api/canvas-snapshots/redis-core')
}

export function publishRedisCanvas(canvas: CanvasSnapshotCanvas) {
  const request: PublishCanvasSnapshotRequest = { canvas }
  return api<PublishedCanvasSnapshot>('/api/canvas-snapshots/redis-core', {
    method: 'PUT',
    body: JSON.stringify(request),
  })
}
