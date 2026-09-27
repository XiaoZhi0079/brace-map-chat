import {
  createLearningDataBackup,
  normalizeStoredAgentSessions,
  normalizeStoredWorkspace,
  type StoredWorkspace,
} from './dataBackup.ts'
import {
  readStoredAgentPlanningSessions,
} from './agent/agentPlanningSessions.ts'
import type {
  AgentModelSelection,
  PersistentApplicationState,
  StoragePreferences,
} from './shared/persistence.ts'
import {
  ACTIVE_PROFILE_STORAGE_KEY,
  AGENT_MODEL_STORAGE_KEY,
  AGENT_PLANNING_SESSIONS_STORAGE_KEY,
  AGENT_SESSIONS_STORAGE_KEY,
  AGENT_SETUP_DRAFT_STORAGE_KEY,
  LEGACY_WORKSPACE_STORAGE_KEY,
  REDIS_SNAPSHOT_VERSION_KEY,
  WORKSPACE_STORAGE_KEY,
} from './storageKeys.ts'

const LEGACY_KEYS = [
  WORKSPACE_STORAGE_KEY,
  LEGACY_WORKSPACE_STORAGE_KEY,
  ACTIVE_PROFILE_STORAGE_KEY,
  REDIS_SNAPSHOT_VERSION_KEY,
  AGENT_SESSIONS_STORAGE_KEY,
  AGENT_MODEL_STORAGE_KEY,
  AGENT_SETUP_DRAFT_STORAGE_KEY,
  AGENT_PLANNING_SESSIONS_STORAGE_KEY,
]

function parseJson(value: string | null) {
  if (value === null) return null
  try {
    return JSON.parse(value) as unknown
  } catch {
    return null
  }
}

function readPreferences(storage: Storage): StoragePreferences {
  const modelValue = parseJson(storage.getItem(AGENT_MODEL_STORAGE_KEY)) as Partial<AgentModelSelection> | null
  const agentModelSelection = modelValue
    && typeof modelValue.profileId === 'string'
    && typeof modelValue.model === 'string'
    && modelValue.profileId.trim()
    && modelValue.model.trim()
    ? { profileId: modelValue.profileId.trim(), model: modelValue.model.trim() }
    : null
  return {
    activeProfileId: storage.getItem(ACTIVE_PROFILE_STORAGE_KEY)?.trim() || null,
    agentModelSelection,
    redisSnapshotVersion: storage.getItem(REDIS_SNAPSHOT_VERSION_KEY)?.trim() || null,
  }
}

function readVersionTwoWorkspace(storage: Storage): StoredWorkspace | null {
  const value = parseJson(storage.getItem(LEGACY_WORKSPACE_STORAGE_KEY))
  if (!value || typeof value !== 'object') return null
  const legacy = value as { nodes?: unknown; edges?: unknown }
  if (!Array.isArray(legacy.nodes) || !Array.isArray(legacy.edges)) return null
  const root = legacy.nodes.find((node) => {
    if (!node || typeof node !== 'object') return false
    const data = (node as { data?: { parentId?: unknown } }).data
    return data && !data.parentId
  }) as { data?: { title?: unknown } } | undefined
  const title = typeof root?.data?.title === 'string' && root.data.title.trim()
    ? root.data.title.trim()
    : '迁移的学习主题'
  const id = crypto.randomUUID()
  return normalizeStoredWorkspace({
    canvases: [{ id, revision: 0, title, nodes: legacy.nodes, edges: legacy.edges }],
    activeCanvasId: id,
  })
}

export function hasLegacyBrowserData(storage: Storage = localStorage) {
  return LEGACY_KEYS.some((key) => storage.getItem(key) !== null)
}

export function readLegacyBrowserState(storage: Storage = localStorage): PersistentApplicationState | null {
  if (!hasLegacyBrowserData(storage)) return null
  let workspace: StoredWorkspace | null = null
  let agentSessions = normalizeStoredAgentSessions(parseJson(storage.getItem(AGENT_SESSIONS_STORAGE_KEY)) ?? [])
  let agentPlanningSessions = readStoredAgentPlanningSessions(storage, true)
  if (storage.getItem(WORKSPACE_STORAGE_KEY)) {
    const backup = createLearningDataBackup(storage)
    workspace = backup.data.workspace
    agentSessions = backup.data.agentSessions
    agentPlanningSessions = backup.data.agentPlanningSessions
  } else {
    workspace = readVersionTwoWorkspace(storage)
  }
  return {
    workspace,
    agentSessions,
    agentPlanningSessions,
    preferences: readPreferences(storage),
  }
}

export function clearLegacyBrowserData(storage: Storage = localStorage) {
  for (const key of LEGACY_KEYS) storage.removeItem(key)
}
