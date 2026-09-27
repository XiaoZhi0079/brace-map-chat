import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import {
  emptyAgentPlanningSessionCollection,
  normalizeAgentPlanningSessionCollection,
  type AgentPlanningSessionCollection,
} from '../src/agent/agentPlanningSessions.ts'
import {
  LEARNING_DATA_BACKUP_FORMAT,
  LEARNING_DATA_BACKUP_VERSION,
  LearningDataBackupError,
  normalizeLearningDataBackup,
  normalizeStoredAgentSessions,
  normalizeStoredWorkspace,
  type AgentSessionBackup,
  type LearningDataBackup,
  type StoredWorkspace,
} from '../src/dataBackup.ts'
import type {
  AgentModelSelection,
  PersistentApplicationState,
  StoragePreferences,
} from '../src/shared/persistence.ts'
import { GatewayError } from './gatewayError.ts'
import { DATABASE_MIGRATIONS, DATABASE_SCHEMA_VERSION } from './databaseMigrations.ts'

type Row = Record<string, unknown>

const EMPTY_PREFERENCES: StoragePreferences = {
  activeProfileId: null,
  agentModelSelection: null,
  redisSnapshotVersion: null,
}

function rowText(value: unknown) {
  return typeof value === 'string' ? value : null
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function booleanValue(value: unknown) {
  return value === 1
}

function storageError(error: unknown): never {
  if (error instanceof GatewayError) throw error
  if (error instanceof LearningDataBackupError) {
    throw new GatewayError(422, 'INVALID_STORED_DATA', error.message)
  }
  throw error
}

function validateModelSelection(value: unknown): AgentModelSelection | null {
  if (value === null || typeof value === 'undefined') return null
  if (!value || typeof value !== 'object') {
    throw new GatewayError(422, 'INVALID_AGENT_MODEL', 'Agent 模型选择无效。')
  }
  const selection = value as Partial<AgentModelSelection>
  if (
    typeof selection.profileId !== 'string'
    || !selection.profileId.trim()
    || selection.profileId.length > 120
    || typeof selection.model !== 'string'
    || !selection.model.trim()
    || selection.model.length > 240
  ) {
    throw new GatewayError(422, 'INVALID_AGENT_MODEL', 'Agent 模型选择无效。')
  }
  return { profileId: selection.profileId.trim(), model: selection.model.trim() }
}

function optionalPreferenceText(value: unknown, field: string) {
  if (value === null || typeof value === 'undefined') return null
  if (typeof value !== 'string' || !value.trim() || value.length > 240) {
    throw new GatewayError(422, 'INVALID_PREFERENCE', `${field}无效。`)
  }
  return value.trim()
}

export function validateStoragePreferences(value: unknown): StoragePreferences {
  if (!value || typeof value !== 'object') {
    throw new GatewayError(422, 'INVALID_PREFERENCES', '存储偏好必须是对象。')
  }
  const preferences = value as Partial<StoragePreferences>
  return {
    activeProfileId: optionalPreferenceText(preferences.activeProfileId, '当前模型配置'),
    agentModelSelection: validateModelSelection(preferences.agentModelSelection),
    redisSnapshotVersion: optionalPreferenceText(preferences.redisSnapshotVersion, '示例快照版本'),
  }
}

function transaction(database: DatabaseSync, operation: () => void) {
  database.exec('BEGIN IMMEDIATE')
  try {
    operation()
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

function run(statement: StatementSync, values: unknown[]) {
  statement.run(...values as never[])
}

export class LearningDatabase {
  readonly filePath: string
  readonly schemaVersion = DATABASE_SCHEMA_VERSION
  private readonly database: DatabaseSync

  constructor(filePath: string) {
    this.filePath = filePath
    mkdirSync(dirname(filePath), { recursive: true })
    this.database = new DatabaseSync(filePath)
    this.database.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;')
    this.applyMigrations()
  }

  private applyMigrations() {
    const row = this.database.prepare('PRAGMA user_version').get() as Row
    let currentVersion = Number(row.user_version ?? 0)
    for (const migration of DATABASE_MIGRATIONS) {
      if (migration.version <= currentVersion) continue
      transaction(this.database, () => {
        this.database.exec(migration.sql)
        this.database.exec(`PRAGMA user_version = ${migration.version}`)
      })
      currentVersion = migration.version
    }
    if (currentVersion !== DATABASE_SCHEMA_VERSION) {
      throw new Error(`Unsupported database schema version: ${currentVersion}`)
    }
  }

  close() {
    this.database.close()
  }

  check() {
    const row = this.database.prepare('PRAGMA quick_check').get() as Row
    return row.quick_check === 'ok'
  }

  private readSettings() {
    return this.database.prepare('SELECT * FROM app_settings WHERE singleton_id = 1').get() as Row
  }

  readWorkspaceVersion() {
    return Number(this.readSettings().workspace_version ?? 0)
  }

  readWorkspace(): StoredWorkspace | null {
    const canvasRows = this.database.prepare('SELECT * FROM canvases ORDER BY sort_order').all() as Row[]
    if (!canvasRows.length) return null
    const nodeRows = this.database.prepare('SELECT * FROM nodes ORDER BY canvas_id, sort_order').all() as Row[]
    const messageRows = this.database.prepare('SELECT * FROM node_messages ORDER BY canvas_id, node_id, sort_order').all() as Row[]
    const edgeRows = this.database.prepare('SELECT * FROM edges ORDER BY canvas_id, sort_order').all() as Row[]
    const messagesByNode = new Map<string, Row[]>()
    for (const message of messageRows) {
      const key = `${String(message.canvas_id)}\u0000${String(message.node_id)}`
      const messages = messagesByNode.get(key) ?? []
      messages.push(message)
      messagesByNode.set(key, messages)
    }
    const nodesByCanvas = new Map<string, Row[]>()
    for (const node of nodeRows) {
      const canvasId = String(node.canvas_id)
      const nodes = nodesByCanvas.get(canvasId) ?? []
      nodes.push(node)
      nodesByCanvas.set(canvasId, nodes)
    }
    const edgesByCanvas = new Map<string, Row[]>()
    for (const edge of edgeRows) {
      const canvasId = String(edge.canvas_id)
      const edges = edgesByCanvas.get(canvasId) ?? []
      edges.push(edge)
      edgesByCanvas.set(canvasId, edges)
    }
    const canvases = canvasRows.map((canvas) => {
      const canvasId = String(canvas.id)
      const nodes = (nodesByCanvas.get(canvasId) ?? []).map((node) => ({
        id: String(node.id),
        type: 'conversation' as const,
        position: { x: Number(node.position_x), y: Number(node.position_y) },
        data: {
          title: String(node.title),
          ...(rowText(node.brief) ? { brief: rowText(node.brief)! } : {}),
          ...(rowText(node.parent_id) ? { parentId: rowText(node.parent_id)! } : {}),
          expanded: booleanValue(node.expanded),
          messages: (messagesByNode.get(`${canvasId}\u0000${String(node.id)}`) ?? []).map((message) => {
            const generationStatus: 'stopped' | 'incomplete' | 'error' | undefined = message.generation_status === 'stopped'
              || message.generation_status === 'incomplete'
              || message.generation_status === 'error'
              ? message.generation_status
              : undefined
            return {
              id: String(message.message_id),
              role: message.role === 'assistant' ? 'assistant' as const : 'user' as const,
              content: String(message.content),
              ...(generationStatus ? { generationStatus } : {}),
            }
          }),
          note: String(node.note ?? ''),
          ...(rowText(node.source_quote) ? { sourceQuote: rowText(node.source_quote)! } : {}),
          ...(rowText(node.branch_context) ? { branchContext: rowText(node.branch_context)! } : {}),
          ...(rowText(node.agent_opening_prompt) ? { agentOpeningPrompt: rowText(node.agent_opening_prompt)! } : {}),
          ...(rowText(node.learning_status) ? { status: rowText(node.learning_status)! as never } : {}),
          ...(rowText(node.knowledge_json) ? { knowledge: parseJson(node.knowledge_json, undefined) } : {}),
        },
      }))
      const edges = (edgesByCanvas.get(canvasId) ?? []).map((edge) => ({
        id: String(edge.edge_id),
        source: String(edge.source_id),
        target: String(edge.target_id),
      }))
      return {
        id: canvasId,
        revision: Number(canvas.revision),
        title: String(canvas.title),
        ...(rowText(canvas.learning_goal) ? { learningGoal: rowText(canvas.learning_goal)! } : {}),
        ...(rowText(canvas.target_outcome) ? { targetOutcome: rowText(canvas.target_outcome)! } : {}),
        ...(rowText(canvas.path_mode) ? { pathMode: rowText(canvas.path_mode)! as never } : {}),
        nodes,
        edges,
      }
    })
    const requestedActiveId = rowText(this.readSettings().active_canvas_id)
    return {
      canvases,
      activeCanvasId: requestedActiveId && canvases.some((canvas) => canvas.id === requestedActiveId)
        ? requestedActiveId
        : canvases[0].id,
    }
  }

  private writeWorkspace(workspace: StoredWorkspace, force = false) {
    const existingCanvases = this.database.prepare('SELECT id, revision FROM canvases').all() as Row[]
    const incomingCanvasIds = new Set(workspace.canvases.map((canvas) => canvas.id))
    const deleteCanvas = this.database.prepare('DELETE FROM canvases WHERE id = ?')
    for (const canvas of existingCanvases) {
      if (!incomingCanvasIds.has(String(canvas.id))) deleteCanvas.run(String(canvas.id))
    }

    const upsertCanvas = this.database.prepare(`
      INSERT INTO canvases (id, title, learning_goal, target_outcome, path_mode, revision, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        learning_goal = excluded.learning_goal,
        target_outcome = excluded.target_outcome,
        path_mode = excluded.path_mode,
        revision = excluded.revision,
        sort_order = excluded.sort_order
    `)
    const upsertNode = this.database.prepare(`
      INSERT INTO nodes (
        canvas_id, id, parent_id, node_type, position_x, position_y, title, brief, expanded, note,
        source_quote, branch_context, agent_opening_prompt, learning_status, knowledge_json, sort_order
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(canvas_id, id) DO UPDATE SET
        parent_id = excluded.parent_id,
        node_type = excluded.node_type,
        position_x = excluded.position_x,
        position_y = excluded.position_y,
        title = excluded.title,
        brief = excluded.brief,
        expanded = excluded.expanded,
        note = excluded.note,
        source_quote = excluded.source_quote,
        branch_context = excluded.branch_context,
        agent_opening_prompt = excluded.agent_opening_prompt,
        learning_status = excluded.learning_status,
        knowledge_json = excluded.knowledge_json,
        sort_order = excluded.sort_order
    `)
    const upsertMessage = this.database.prepare(`
      INSERT INTO node_messages (canvas_id, node_id, message_id, role, content, generation_status, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(canvas_id, node_id, message_id) DO UPDATE SET
        role = excluded.role,
        content = excluded.content,
        generation_status = excluded.generation_status,
        sort_order = excluded.sort_order
    `)
    const upsertEdge = this.database.prepare(`
      INSERT INTO edges (canvas_id, edge_id, source_id, target_id, sort_order)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(canvas_id, edge_id) DO UPDATE SET
        source_id = excluded.source_id,
        target_id = excluded.target_id,
        sort_order = excluded.sort_order
    `)
    const deleteNode = this.database.prepare('DELETE FROM nodes WHERE canvas_id = ? AND id = ?')
    const deleteMessage = this.database.prepare('DELETE FROM node_messages WHERE canvas_id = ? AND node_id = ? AND message_id = ?')
    const deleteEdge = this.database.prepare('DELETE FROM edges WHERE canvas_id = ? AND edge_id = ?')
    const revisionByCanvas = new Map(existingCanvases.map((canvas) => [String(canvas.id), Number(canvas.revision)]))

    workspace.canvases.forEach((canvas, canvasIndex) => {
      run(upsertCanvas, [canvas.id, canvas.title, canvas.learningGoal ?? null, canvas.targetOutcome ?? null, canvas.pathMode ?? null, canvas.revision ?? 0, canvasIndex])
      if (!force && revisionByCanvas.get(canvas.id) === (canvas.revision ?? 0)) return

      const desiredNodeIds = new Set(canvas.nodes.map((node) => node.id))
      const storedNodes = this.database.prepare('SELECT id FROM nodes WHERE canvas_id = ?').all(canvas.id) as Row[]
      for (const storedNode of storedNodes) {
        const nodeId = String(storedNode.id)
        if (!desiredNodeIds.has(nodeId)) deleteNode.run(canvas.id, nodeId)
      }

      const storedMessages = this.database.prepare(
        'SELECT node_id, message_id FROM node_messages WHERE canvas_id = ?',
      ).all(canvas.id) as Row[]
      const storedMessageIds = new Map<string, Set<string>>()
      for (const message of storedMessages) {
        const nodeId = String(message.node_id)
        const ids = storedMessageIds.get(nodeId) ?? new Set<string>()
        ids.add(String(message.message_id))
        storedMessageIds.set(nodeId, ids)
      }

      canvas.nodes.forEach((node, nodeIndex) => {
        run(upsertNode, [
          canvas.id,
          node.id,
          node.data.parentId ?? null,
          node.type,
          node.position.x,
          node.position.y,
          node.data.title,
          node.data.brief ?? null,
          node.data.expanded ? 1 : 0,
          node.data.note,
          node.data.sourceQuote ?? null,
          node.data.branchContext ?? null,
          node.data.agentOpeningPrompt ?? null,
          node.data.status ?? null,
          node.data.knowledge ? JSON.stringify(node.data.knowledge) : null,
          nodeIndex,
        ])
        const desiredMessageIds = new Set(node.data.messages.map((message) => message.id))
        for (const messageId of storedMessageIds.get(node.id) ?? []) {
          if (!desiredMessageIds.has(messageId)) deleteMessage.run(canvas.id, node.id, messageId)
        }
        node.data.messages.forEach((message, messageIndex) => run(upsertMessage, [
          canvas.id,
          node.id,
          message.id,
          message.role,
          message.content,
          message.generationStatus ?? null,
          messageIndex,
        ]))
      })

      const desiredEdgeIds = new Set(canvas.edges.map((edge) => edge.id))
      const storedEdges = this.database.prepare('SELECT edge_id FROM edges WHERE canvas_id = ?').all(canvas.id) as Row[]
      for (const storedEdge of storedEdges) {
        const edgeId = String(storedEdge.edge_id)
        if (!desiredEdgeIds.has(edgeId)) deleteEdge.run(canvas.id, edgeId)
      }
      canvas.edges.forEach((edge, edgeIndex) => run(upsertEdge, [canvas.id, edge.id, edge.source, edge.target, edgeIndex]))
    })
    this.database.prepare(`
      UPDATE app_settings SET active_canvas_id = ?, updated_at = ? WHERE singleton_id = 1
    `).run(workspace.activeCanvasId, new Date().toISOString())
  }

  saveWorkspace(value: unknown, expectedVersion: unknown) {
    try {
      const workspace = normalizeStoredWorkspace(value)
      if (!Number.isInteger(expectedVersion) || (expectedVersion as number) < 0) {
        throw new GatewayError(422, 'INVALID_WORKSPACE_VERSION', '工作区版本无效。')
      }
      let workspaceVersion = 0
      transaction(this.database, () => {
        const currentVersion = this.readWorkspaceVersion()
        if (currentVersion !== expectedVersion) {
          throw new GatewayError(409, 'WORKSPACE_CONFLICT', '学习数据已在另一个页面中更新。请刷新后再继续编辑。')
        }
        this.writeWorkspace(workspace)
        workspaceVersion = currentVersion + 1
        this.database.prepare(`
          UPDATE app_settings SET workspace_version = ?, updated_at = ? WHERE singleton_id = 1
        `).run(workspaceVersion, new Date().toISOString())
      })
      return { workspace, workspaceVersion }
    } catch (error) {
      storageError(error)
    }
  }

  readPlanningSessions(): AgentPlanningSessionCollection {
    const sessionRows = this.database.prepare('SELECT * FROM agent_planning_sessions ORDER BY sort_order').all() as Row[]
    const messageRows = this.database.prepare(
      'SELECT * FROM agent_planning_messages ORDER BY session_id, sort_order',
    ).all() as Row[]
    const messagesBySession = new Map<string, Row[]>()
    for (const message of messageRows) {
      const sessionId = String(message.session_id)
      const messages = messagesBySession.get(sessionId) ?? []
      messages.push(message)
      messagesBySession.set(sessionId, messages)
    }
    const sessions = sessionRows.map((session) => ({
      id: String(session.id),
      title: String(session.title),
      messages: (messagesBySession.get(String(session.id)) ?? []).map((message) => ({
        role: message.role === 'assistant' ? 'assistant' as const : 'user' as const,
        content: String(message.content),
      })),
      input: String(session.input),
      plan: parseJson(session.plan_json, null),
      pendingPlan: parseJson(session.pending_plan_json, null),
      pendingPlanKind: rowText(session.pending_plan_kind) as 'agent-proposal' | 'manual-edit' | null,
      readyToInitialize: booleanValue(session.ready_to_initialize),
      missingInformation: parseJson(session.missing_information_json, []),
      readyToAdopt: booleanValue(session.ready_to_adopt),
      createdAt: String(session.created_at),
      updatedAt: String(session.updated_at),
      ...(rowText(session.adopted_canvas_id) ? { adoptedCanvasId: rowText(session.adopted_canvas_id)! } : {}),
    }))
    const normalized = normalizeAgentPlanningSessionCollection({
      version: 1,
      sessions,
      activeSessionId: rowText(this.readSettings().active_planning_session_id),
    })
    return normalized ?? emptyAgentPlanningSessionCollection()
  }

  private writePlanningSessions(collection: AgentPlanningSessionCollection) {
    const incomingIds = new Set(collection.sessions.map((session) => session.id))
    const storedSessions = this.database.prepare('SELECT id FROM agent_planning_sessions').all() as Row[]
    const deleteSession = this.database.prepare('DELETE FROM agent_planning_sessions WHERE id = ?')
    for (const stored of storedSessions) {
      const id = String(stored.id)
      if (!incomingIds.has(id)) deleteSession.run(id)
    }
    const insertSession = this.database.prepare(`
      INSERT INTO agent_planning_sessions (
        id, title, input, plan_json, pending_plan_json, pending_plan_kind, ready_to_initialize,
        missing_information_json, ready_to_adopt, created_at, updated_at, adopted_canvas_id, sort_order
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        input = excluded.input,
        plan_json = excluded.plan_json,
        pending_plan_json = excluded.pending_plan_json,
        pending_plan_kind = excluded.pending_plan_kind,
        ready_to_initialize = excluded.ready_to_initialize,
        missing_information_json = excluded.missing_information_json,
        ready_to_adopt = excluded.ready_to_adopt,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        adopted_canvas_id = excluded.adopted_canvas_id,
        sort_order = excluded.sort_order
    `)
    const deleteMessages = this.database.prepare('DELETE FROM agent_planning_messages WHERE session_id = ?')
    const insertMessage = this.database.prepare(`
      INSERT INTO agent_planning_messages (session_id, role, content, sort_order) VALUES (?, ?, ?, ?)
    `)
    collection.sessions.forEach((session, sessionIndex) => {
      run(insertSession, [
        session.id,
        session.title,
        session.input,
        session.plan ? JSON.stringify(session.plan) : null,
        session.pendingPlan ? JSON.stringify(session.pendingPlan) : null,
        session.pendingPlanKind,
        session.readyToInitialize ? 1 : 0,
        JSON.stringify(session.missingInformation),
        session.readyToAdopt ? 1 : 0,
        session.createdAt,
        session.updatedAt,
        session.adoptedCanvasId ?? null,
        sessionIndex,
      ])
      deleteMessages.run(session.id)
      session.messages.forEach((message, messageIndex) => run(insertMessage, [session.id, message.role, message.content, messageIndex]))
    })
    this.database.prepare(`
      UPDATE app_settings SET active_planning_session_id = ?, updated_at = ? WHERE singleton_id = 1
    `).run(collection.activeSessionId, new Date().toISOString())
  }

  savePlanningSessions(value: unknown) {
    const collection = normalizeAgentPlanningSessionCollection(value)
    if (!collection) throw new GatewayError(422, 'INVALID_PLANNING_SESSIONS', 'Agent 规划会话数据无效。')
    const canvasIds = new Set(this.readWorkspace()?.canvases.map((canvas) => canvas.id) ?? [])
    const sanitized = {
      ...collection,
      sessions: collection.sessions.map((session) => (
        session.adoptedCanvasId && !canvasIds.has(session.adoptedCanvasId)
          ? (() => {
              const remaining = { ...session }
              delete remaining.adoptedCanvasId
              return remaining
            })()
          : session
      )),
    }
    const current = this.readPlanningSessions()
    const mergedById = new Map(current.sessions.map((session) => [session.id, session]))
    for (const session of sanitized.sessions) {
      const existing = mergedById.get(session.id)
      if (!existing || session.updatedAt >= existing.updatedAt) mergedById.set(session.id, session)
    }
    const mergedSessions = [
      ...current.sessions.map((session) => mergedById.get(session.id)!),
      ...sanitized.sessions.filter((session) => !current.sessions.some((currentSession) => currentSession.id === session.id)),
    ]
    const requestedActiveId = sanitized.activeSessionId
    const merged = {
      version: 1 as const,
      sessions: mergedSessions,
      activeSessionId: requestedActiveId && mergedById.has(requestedActiveId)
        ? requestedActiveId
        : current.activeSessionId,
    }
    transaction(this.database, () => this.writePlanningSessions(merged))
    return this.readPlanningSessions()
  }

  deletePlanningSession(sessionId: string) {
    if (!sessionId.trim() || sessionId.length > 240) {
      throw new GatewayError(422, 'INVALID_PLANNING_SESSION_ID', 'Agent 规划会话 ID 无效。')
    }
    transaction(this.database, () => {
      this.database.prepare('DELETE FROM agent_planning_sessions WHERE id = ?').run(sessionId)
      this.database.prepare(`
        UPDATE app_settings
        SET active_planning_session_id = CASE WHEN active_planning_session_id = ? THEN NULL ELSE active_planning_session_id END,
            updated_at = ?
        WHERE singleton_id = 1
      `).run(sessionId, new Date().toISOString())
    })
    return this.readPlanningSessions()
  }

  readAgentSessions(): AgentSessionBackup[] {
    const sessionRows = this.database.prepare('SELECT * FROM agent_sessions ORDER BY sort_order').all() as Row[]
    const messageRows = this.database.prepare(
      'SELECT * FROM agent_session_messages ORDER BY session_id, sort_order',
    ).all() as Row[]
    const operationRows = this.database.prepare(
      'SELECT * FROM agent_reviewed_operations ORDER BY session_id, sort_order',
    ).all() as Row[]
    const messagesBySession = new Map<string, Row[]>()
    for (const message of messageRows) {
      const sessionId = String(message.session_id)
      const messages = messagesBySession.get(sessionId) ?? []
      messages.push(message)
      messagesBySession.set(sessionId, messages)
    }
    const operationsBySession = new Map<string, Row[]>()
    for (const operation of operationRows) {
      const sessionId = String(operation.session_id)
      const operations = operationsBySession.get(sessionId) ?? []
      operations.push(operation)
      operationsBySession.set(sessionId, operations)
    }
    return sessionRows.map((session) => ({
      id: String(session.id),
      canvasId: String(session.canvas_id),
      canvasTitle: String(session.canvas_title),
      title: String(session.title),
      messages: (messagesBySession.get(String(session.id)) ?? []).map((message) => ({
        role: message.role === 'assistant' ? 'assistant' as const : 'user' as const,
        content: String(message.content),
      })),
      operations: (operationsBySession.get(String(session.id)) ?? []).map((operation) => ({
        reviewId: String(operation.review_id),
        operation: parseJson(operation.operation_json, null) as never,
        expectedRevision: Number(operation.expected_revision),
        status: String(operation.review_status) as AgentSessionBackup['operations'][number]['status'],
        ...(rowText(operation.result) ? { result: rowText(operation.result)! } : {}),
      })),
      createdAt: String(session.created_at),
      updatedAt: String(session.updated_at),
    }))
  }

  private writeAgentSessions(sessions: AgentSessionBackup[]) {
    const incomingIds = new Set(sessions.map((session) => session.id))
    const storedSessions = this.database.prepare('SELECT id FROM agent_sessions').all() as Row[]
    const deleteSession = this.database.prepare('DELETE FROM agent_sessions WHERE id = ?')
    for (const stored of storedSessions) {
      const id = String(stored.id)
      if (!incomingIds.has(id)) deleteSession.run(id)
    }
    const insertSession = this.database.prepare(`
      INSERT INTO agent_sessions (id, canvas_id, canvas_title, title, created_at, updated_at, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        canvas_id = excluded.canvas_id,
        canvas_title = excluded.canvas_title,
        title = excluded.title,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        sort_order = excluded.sort_order
    `)
    const deleteMessages = this.database.prepare('DELETE FROM agent_session_messages WHERE session_id = ?')
    const deleteOperations = this.database.prepare('DELETE FROM agent_reviewed_operations WHERE session_id = ?')
    const insertMessage = this.database.prepare(`
      INSERT INTO agent_session_messages (session_id, role, content, sort_order) VALUES (?, ?, ?, ?)
    `)
    const insertOperation = this.database.prepare(`
      INSERT INTO agent_reviewed_operations (
        session_id, review_id, operation_json, expected_revision, review_status, result, sort_order
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    sessions.forEach((session, sessionIndex) => {
      run(insertSession, [session.id, session.canvasId, session.canvasTitle, session.title, session.createdAt, session.updatedAt, sessionIndex])
      deleteMessages.run(session.id)
      deleteOperations.run(session.id)
      session.messages.forEach((message, messageIndex) => run(insertMessage, [session.id, message.role, message.content, messageIndex]))
      session.operations.forEach((operation, operationIndex) => run(insertOperation, [
        session.id,
        operation.reviewId,
        JSON.stringify(operation.operation),
        operation.expectedRevision,
        operation.status,
        operation.result ?? null,
        operationIndex,
      ]))
    })
  }

  saveAgentSessions(value: unknown) {
    try {
      const sessions = normalizeStoredAgentSessions(value)
      this.validateAgentSessionCanvases(sessions, this.readWorkspace())
      transaction(this.database, () => this.writeAgentSessions(sessions))
      return sessions
    } catch (error) {
      storageError(error)
    }
  }

  readPreferences(): StoragePreferences {
    const settings = this.readSettings()
    const agentProfileId = rowText(settings.agent_profile_id)
    const agentModel = rowText(settings.agent_model)
    return {
      activeProfileId: rowText(settings.active_profile_id),
      agentModelSelection: agentProfileId && agentModel ? { profileId: agentProfileId, model: agentModel } : null,
      redisSnapshotVersion: rowText(settings.redis_snapshot_version),
    }
  }

  savePreferences(value: unknown) {
    const preferences = validateStoragePreferences(value)
    this.writePreferences(preferences)
    return preferences
  }

  private writePreferences(preferences: StoragePreferences) {
    this.database.prepare(`
      UPDATE app_settings
      SET active_profile_id = ?, agent_profile_id = ?, agent_model = ?, redis_snapshot_version = ?, updated_at = ?
      WHERE singleton_id = 1
    `).run(
      preferences.activeProfileId,
      preferences.agentModelSelection?.profileId ?? null,
      preferences.agentModelSelection?.model ?? null,
      preferences.redisSnapshotVersion,
      new Date().toISOString(),
    )
  }

  saveAgentRuntime(sessionsValue: unknown, modelSelectionValue: unknown) {
    const sessions = normalizeStoredAgentSessions(sessionsValue)
    this.validateAgentSessionCanvases(sessions, this.readWorkspace())
    const preferences = {
      ...this.readPreferences(),
      agentModelSelection: validateModelSelection(modelSelectionValue),
    }
    transaction(this.database, () => {
      this.writeAgentSessions(sessions)
      this.writePreferences(preferences)
    })
    return { agentSessions: sessions, agentModelSelection: preferences.agentModelSelection }
  }

  readState(): PersistentApplicationState {
    return {
      workspace: this.readWorkspace(),
      agentPlanningSessions: this.readPlanningSessions(),
      agentSessions: this.readAgentSessions(),
      preferences: this.readPreferences(),
    }
  }

  private validateAgentSessionCanvases(sessions: AgentSessionBackup[], workspace: StoredWorkspace | null) {
    const canvasIds = new Set(workspace?.canvases.map((canvas) => canvas.id) ?? [])
    if (sessions.some((session) => !canvasIds.has(session.canvasId))) {
      throw new GatewayError(422, 'INVALID_AGENT_SESSION_CANVAS', 'Agent 会话引用了不存在的画布。')
    }
  }

  replaceState(state: PersistentApplicationState) {
    const workspace = state.workspace ? normalizeStoredWorkspace(state.workspace) : null
    const planning = normalizeAgentPlanningSessionCollection(state.agentPlanningSessions)
    if (!planning) throw new GatewayError(422, 'INVALID_PLANNING_SESSIONS', 'Agent 规划会话数据无效。')
    const sessions = normalizeStoredAgentSessions(state.agentSessions)
    const preferences = validateStoragePreferences(state.preferences)
    this.validateAgentSessionCanvases(sessions, workspace)
    const canvasIds = new Set(workspace?.canvases.map((canvas) => canvas.id) ?? [])
    const sanitizedPlanning = {
      ...planning,
      sessions: planning.sessions.map((session) => (
          session.adoptedCanvasId && !canvasIds.has(session.adoptedCanvasId)
          ? (() => {
              const remaining = { ...session }
              delete remaining.adoptedCanvasId
              return remaining
            })()
          : session
      )),
    }
    transaction(this.database, () => {
      const nextWorkspaceVersion = this.readWorkspaceVersion() + 1
      if (workspace) this.writeWorkspace(workspace, true)
      else this.database.exec('DELETE FROM canvases')
      this.writePlanningSessions(sanitizedPlanning)
      this.writeAgentSessions(sessions)
      this.writePreferences(preferences)
      this.database.prepare(`
        UPDATE app_settings SET workspace_version = ?, updated_at = ? WHERE singleton_id = 1
      `).run(nextWorkspaceVersion, new Date().toISOString())
    })
    return this.readState()
  }

  mergeBrowserState(value: PersistentApplicationState) {
    const incoming = {
      workspace: value.workspace ? normalizeStoredWorkspace(value.workspace) : null,
      agentPlanningSessions: normalizeAgentPlanningSessionCollection(value.agentPlanningSessions),
      agentSessions: normalizeStoredAgentSessions(value.agentSessions),
      preferences: validateStoragePreferences(value.preferences),
    }
    if (!incoming.agentPlanningSessions) {
      throw new GatewayError(422, 'INVALID_PLANNING_SESSIONS', 'Agent 规划会话数据无效。')
    }
    const current = this.readState()
    const canvasById = new Map((current.workspace?.canvases ?? []).map((canvas) => [canvas.id, canvas]))
    for (const canvas of incoming.workspace?.canvases ?? []) {
      const existing = canvasById.get(canvas.id)
      if (!existing || (canvas.revision ?? 0) >= (existing.revision ?? 0)) canvasById.set(canvas.id, canvas)
    }
    const mergedCanvases = [...canvasById.values()]
    const requestedActiveId = incoming.workspace?.activeCanvasId
    const workspace = mergedCanvases.length ? {
      canvases: mergedCanvases,
      activeCanvasId: requestedActiveId && canvasById.has(requestedActiveId)
        ? requestedActiveId
        : current.workspace?.activeCanvasId ?? mergedCanvases[0].id,
    } : null

    const planningById = new Map(current.agentPlanningSessions.sessions.map((session) => [session.id, session]))
    for (const session of incoming.agentPlanningSessions.sessions) {
      const existing = planningById.get(session.id)
      if (!existing || session.updatedAt > existing.updatedAt) planningById.set(session.id, session)
    }
    const activePlanningId = incoming.agentPlanningSessions.activeSessionId
    const planning = {
      version: 1 as const,
      sessions: [...planningById.values()],
      activeSessionId: activePlanningId && planningById.has(activePlanningId)
        ? activePlanningId
        : current.agentPlanningSessions.activeSessionId,
    }

    const agentSessionById = new Map(current.agentSessions.map((session) => [session.id, session]))
    for (const session of incoming.agentSessions) {
      const existing = agentSessionById.get(session.id)
      if (!existing || session.updatedAt > existing.updatedAt) agentSessionById.set(session.id, session)
    }
    return this.replaceState({
      workspace,
      agentPlanningSessions: planning,
      agentSessions: [...agentSessionById.values()],
      preferences: {
        activeProfileId: incoming.preferences.activeProfileId ?? current.preferences.activeProfileId,
        agentModelSelection: incoming.preferences.agentModelSelection ?? current.preferences.agentModelSelection,
        redisSnapshotVersion: incoming.preferences.redisSnapshotVersion ?? current.preferences.redisSnapshotVersion,
      },
    })
  }

  exportLearningData(now = new Date()): LearningDataBackup {
    const state = this.readState()
    if (!state.workspace) throw new GatewayError(404, 'NO_LEARNING_DATA', '尚未找到可导出的学习画布。')
    return normalizeLearningDataBackup({
      format: LEARNING_DATA_BACKUP_FORMAT,
      version: LEARNING_DATA_BACKUP_VERSION,
      exportedAt: now.toISOString(),
      data: {
        workspace: state.workspace,
        agentSessions: state.agentSessions,
        agentPlanningSessions: state.agentPlanningSessions,
      },
    })
  }

  importLearningData(value: unknown) {
    try {
      const backup = normalizeLearningDataBackup(value)
      const current = this.readState()
      this.replaceState({
        workspace: backup.data.workspace,
        agentSessions: backup.data.agentSessions,
        agentPlanningSessions: backup.data.agentPlanningSessions,
        preferences: current.preferences,
      })
      return backup
    } catch (error) {
      storageError(error)
    }
  }
}

export { EMPTY_PREFERENCES }
