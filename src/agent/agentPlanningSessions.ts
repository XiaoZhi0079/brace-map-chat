import type { AgentTreePlan } from '../shared/agent.ts'
import type { ApiChatMessage } from '../shared/chat.ts'
import {
  AGENT_PLANNING_SESSIONS_STORAGE_KEY,
  AGENT_SETUP_DRAFT_STORAGE_KEY,
} from '../storageKeys.ts'
import {
  normalizeAgentTreePlan,
  normalizeStoredAgentSetupDraft,
  type StoredAgentSetupDraft,
} from './agentSetupDraft.ts'

export const DEFAULT_AGENT_PLANNING_TITLE = '未命名学习主题'

export type PendingAgentPlanKind = 'agent-proposal' | 'manual-edit'

export type AgentPlanningSession = {
  id: string
  title: string
  messages: ApiChatMessage[]
  input: string
  plan: AgentTreePlan | null
  pendingPlan: AgentTreePlan | null
  pendingPlanKind: PendingAgentPlanKind | null
  readyToInitialize: boolean
  missingInformation: string[]
  readyToAdopt: boolean
  createdAt: string
  updatedAt: string
  adoptedCanvasId?: string
}

export type AgentPlanningSessionCollection = {
  version: 1
  sessions: AgentPlanningSession[]
  activeSessionId: string | null
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export function emptyAgentPlanningSessionCollection(): AgentPlanningSessionCollection {
  return { version: 1, sessions: [], activeSessionId: null }
}

function compactText(value: string, maxLength: number) {
  const compact = value.replace(/\s+/g, ' ').trim()
  return compact.length > maxLength ? `${compact.slice(0, maxLength)}…` : compact
}

export function suggestedAgentPlanningTitle(messages: ApiChatMessage[], input = '', plan?: AgentTreePlan | null) {
  if (plan?.canvasTitle.trim()) return compactText(plan.canvasTitle, 80)
  const firstUserMessage = messages.find((message) => message.role === 'user')?.content ?? input
  return compactText(firstUserMessage, 42) || DEFAULT_AGENT_PLANNING_TITLE
}

export function createAgentPlanningSession(now = new Date()): AgentPlanningSession {
  const timestamp = now.toISOString()
  return {
    id: crypto.randomUUID(),
    title: DEFAULT_AGENT_PLANNING_TITLE,
    messages: [],
    input: '',
    plan: null,
    pendingPlan: null,
    pendingPlanKind: null,
    readyToInitialize: false,
    missingInformation: [],
    readyToAdopt: false,
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

function legacySessionId(updatedAt: string) {
  const stamp = updatedAt.replace(/[^0-9a-z]/gi, '').slice(0, 40) || 'unknown'
  return `migrated-agent-planning-${stamp}`
}

export function migrateAgentSetupDraft(draft: StoredAgentSetupDraft): AgentPlanningSessionCollection {
  return {
    version: 1,
    activeSessionId: legacySessionId(draft.updatedAt),
    sessions: [{
      id: legacySessionId(draft.updatedAt),
      title: suggestedAgentPlanningTitle(draft.messages, draft.input, draft.plan),
      messages: draft.messages,
      input: draft.input,
      plan: draft.plan,
      pendingPlan: null,
      pendingPlanKind: null,
      readyToInitialize: draft.readyToInitialize,
      missingInformation: draft.missingInformation,
      readyToAdopt: Boolean(draft.plan),
      createdAt: draft.updatedAt,
      updatedAt: draft.updatedAt,
    }],
  }
}

function normalizeSession(value: unknown): AgentPlanningSession | null {
  if (!value || typeof value !== 'object') return null
  const session = value as Partial<AgentPlanningSession>
  if (typeof session.id !== 'string' || !session.id.trim() || session.id.length > 120) return null
  if (!Array.isArray(session.messages)) return null
  const normalizeSentinel = '__brace_map_empty_planning_session__'
  const rawMessages = session.messages
  const normalizedDraft = normalizeStoredAgentSetupDraft({
    version: 1,
    messages: [{ role: 'user', content: normalizeSentinel }, ...rawMessages],
    input: session.input,
    plan: session.plan,
    readyToInitialize: session.readyToInitialize,
    missingInformation: session.missingInformation,
    readyToAdopt: session.readyToAdopt,
    updatedAt: session.updatedAt,
  })
  if (!normalizedDraft) return null
  const messages = normalizedDraft.messages.filter((message) => message.content !== normalizeSentinel)
  const input = normalizedDraft.input
  const plan = normalizedDraft.plan
  const pendingPlan = plan ? normalizeAgentTreePlan(session.pendingPlan) : null
  const pendingPlanKind = pendingPlan && (session.pendingPlanKind === 'agent-proposal' || session.pendingPlanKind === 'manual-edit')
    ? session.pendingPlanKind
    : pendingPlan
      ? 'agent-proposal'
      : null
  const createdAt = typeof session.createdAt === 'string' ? session.createdAt : normalizedDraft.updatedAt
  return {
    id: session.id,
    title: typeof session.title === 'string' && session.title.trim()
      ? session.title.trim().slice(0, 80)
      : suggestedAgentPlanningTitle(messages, input, plan),
    messages,
    input,
    plan,
    pendingPlan,
    pendingPlanKind,
    readyToInitialize: normalizedDraft.readyToInitialize,
    missingInformation: normalizedDraft.missingInformation,
    readyToAdopt: Boolean(plan && !pendingPlan),
    createdAt,
    updatedAt: normalizedDraft.updatedAt,
    ...(typeof session.adoptedCanvasId === 'string' && session.adoptedCanvasId.trim()
      ? { adoptedCanvasId: session.adoptedCanvasId.slice(0, 120) }
      : {}),
  }
}

export function normalizeAgentPlanningSessionCollection(value: unknown): AgentPlanningSessionCollection | null {
  if (!value || typeof value !== 'object') return null
  const collection = value as Partial<AgentPlanningSessionCollection>
  if (collection.version !== 1 || !Array.isArray(collection.sessions) || collection.sessions.length > 100) return null
  const sessions = collection.sessions.map(normalizeSession)
  if (sessions.some((session) => !session)) return null
  const validSessions = sessions as AgentPlanningSession[]
  if (new Set(validSessions.map((session) => session.id)).size !== validSessions.length) return null
  const activeSessionId = typeof collection.activeSessionId === 'string'
    && validSessions.some((session) => session.id === collection.activeSessionId)
    ? collection.activeSessionId
    : null
  return { version: 1, sessions: validSessions, activeSessionId }
}

export function sortAgentPlanningSessions(sessions: AgentPlanningSession[]) {
  return [...sessions].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
}

export function writeStoredAgentPlanningSessions(
  collection: AgentPlanningSessionCollection,
  storage: StorageLike = localStorage,
) {
  storage.setItem(AGENT_PLANNING_SESSIONS_STORAGE_KEY, JSON.stringify(collection))
}

export function readStoredAgentPlanningSessions(
  storage: StorageLike = localStorage,
  strict = false,
): AgentPlanningSessionCollection {
  try {
    const currentRaw = storage.getItem(AGENT_PLANNING_SESSIONS_STORAGE_KEY)
    const legacyDraft = normalizeStoredAgentSetupDraft(JSON.parse(storage.getItem(AGENT_SETUP_DRAFT_STORAGE_KEY) ?? 'null'))
    if (currentRaw !== null) {
      const normalized = normalizeAgentPlanningSessionCollection(JSON.parse(currentRaw))
      if (normalized) {
        if (legacyDraft) {
          const migrated = migrateAgentSetupDraft(legacyDraft)
          const migratedSession = migrated.sessions[0]
          if (!normalized.sessions.some((session) => session.id === migratedSession.id)) {
            normalized.sessions.push(migratedSession)
            normalized.activeSessionId ??= migratedSession.id
            writeStoredAgentPlanningSessions(normalized, storage)
          }
        }
        writeStoredAgentPlanningSessions(normalized, storage)
        storage.removeItem(AGENT_SETUP_DRAFT_STORAGE_KEY)
        return normalized
      }
    }
    if (!legacyDraft) return emptyAgentPlanningSessionCollection()
    const migrated = migrateAgentSetupDraft(legacyDraft)
    writeStoredAgentPlanningSessions(migrated, storage)
    storage.removeItem(AGENT_SETUP_DRAFT_STORAGE_KEY)
    return migrated
  } catch (error) {
    if (strict) throw error
    return emptyAgentPlanningSessionCollection()
  }
}
