import type { AgentPlanningSessionCollection } from '../agent/agentPlanningSessions.ts'
import type { AgentSessionBackup, StoredWorkspace } from '../dataBackup.ts'

export type AgentModelSelection = {
  profileId: string
  model: string
}

export type StoragePreferences = {
  activeProfileId: string | null
  agentModelSelection: AgentModelSelection | null
  redisSnapshotVersion: string | null
}

export type PersistentApplicationState = {
  workspace: StoredWorkspace | null
  agentPlanningSessions: AgentPlanningSessionCollection
  agentSessions: AgentSessionBackup[]
  preferences: StoragePreferences
}

export type StorageStateResponse = {
  state: PersistentApplicationState
  storage: {
    engine: 'sqlite'
    schemaVersion: number
    workspaceVersion: number
  }
}

export type BrowserStorageMigrationRequest = {
  state: PersistentApplicationState
}

export type WorkspaceSaveRequest = {
  workspace: StoredWorkspace
  expectedVersion: number
}

export type WorkspaceSaveResponse = {
  workspace: StoredWorkspace
  workspaceVersion: number
}

export type PlanningSessionsSaveRequest = {
  agentPlanningSessions: AgentPlanningSessionCollection
}

export type AgentRuntimeSaveRequest = {
  agentSessions: AgentSessionBackup[]
  agentModelSelection: AgentModelSelection | null
}

export type PreferencesSaveRequest = {
  activeProfileId?: string | null
  redisSnapshotVersion?: string | null
}
