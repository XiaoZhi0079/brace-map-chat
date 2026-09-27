import {
  emptyAgentPlanningSessionCollection,
  migrateAgentSetupDraft,
  normalizeAgentPlanningSessionCollection,
  type AgentPlanningSessionCollection,
} from './agent/agentPlanningSessions.ts'
import { normalizeStoredAgentSetupDraft } from './agent/agentSetupDraft.ts'
import type { AgentOperation, LearningNodeStatus, NodeKnowledgeSummary } from './shared/agent.ts'
import type {
  CanvasSnapshotCanvas,
  CanvasSnapshotEdge,
  CanvasSnapshotMessage,
  CanvasSnapshotNode,
} from './shared/canvasSnapshot.ts'
import type { ApiChatMessage } from './shared/chat.ts'
import {
  AGENT_SESSIONS_STORAGE_KEY,
  AGENT_PLANNING_SESSIONS_STORAGE_KEY,
  AGENT_SETUP_DRAFT_STORAGE_KEY,
  WORKSPACE_STORAGE_KEY,
} from './storageKeys.ts'

export const LEARNING_DATA_BACKUP_FORMAT = 'brace-map-chat-learning-data'
export const LEARNING_DATA_BACKUP_VERSION = 1
export const MAX_LEARNING_DATA_BACKUP_BYTES = 100_000_000

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export type StoredWorkspace = {
  canvases: CanvasSnapshotCanvas[]
  activeCanvasId: string
}

export type ReviewedOperationBackup = {
  reviewId: string
  operation: AgentOperation
  expectedRevision: number
  status: 'pending' | 'applied' | 'rejected' | 'error'
  result?: string
}

export type AgentSessionBackup = {
  id: string
  canvasId: string
  canvasTitle: string
  title: string
  messages: ApiChatMessage[]
  operations: ReviewedOperationBackup[]
  createdAt: string
  updatedAt: string
}

export type LearningDataBackup = {
  format: typeof LEARNING_DATA_BACKUP_FORMAT
  version: typeof LEARNING_DATA_BACKUP_VERSION
  exportedAt: string
  data: {
    workspace: StoredWorkspace
    agentSessions: AgentSessionBackup[]
    agentPlanningSessions: AgentPlanningSessionCollection
  }
}

export type LearningDataBackupSummary = {
  canvasCount: number
  nodeCount: number
  messageCount: number
  agentSessionCount: number
  planningSessionCount: number
}

export class LearningDataBackupError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LearningDataBackupError'
  }
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LearningDataBackupError(`${field}格式无效。`)
  }
  return value as Record<string, unknown>
}

function text(value: unknown, field: string, maxLength: number, allowEmpty = false) {
  if (typeof value !== 'string' || value.length > maxLength || (!allowEmpty && !value.trim())) {
    throw new LearningDataBackupError(`${field}无效。`)
  }
  return value
}

function optionalText(value: unknown, field: string, maxLength: number) {
  return typeof value === 'undefined' ? undefined : text(value, field, maxLength, true)
}

function stringList(value: unknown, field: string, maxItems: number, maxLength = 1000) {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new LearningDataBackupError(`${field}无效。`)
  }
  return value.map((item) => text(item, field, maxLength, true))
}

function normalizeMessage(value: unknown, field: string, totalCharacters: { value: number }): CanvasSnapshotMessage {
  const message = record(value, field)
  const role = message.role
  if (role !== 'user' && role !== 'assistant') {
    throw new LearningDataBackupError(`${field}角色无效。`)
  }
  if (
    typeof message.generationStatus !== 'undefined'
    && message.generationStatus !== 'stopped'
    && message.generationStatus !== 'incomplete'
    && message.generationStatus !== 'error'
  ) {
    throw new LearningDataBackupError(`${field}生成状态无效。`)
  }
  const content = text(message.content, `${field}内容`, 1_000_000)
  totalCharacters.value += content.length
  if (totalCharacters.value > 20_000_000) {
    throw new LearningDataBackupError('备份中的会话正文超过 2000 万字符。')
  }
  return {
    id: text(message.id, `${field} ID`, 120),
    role,
    content,
    generationStatus: message.generationStatus,
  }
}

function normalizeApiMessage(value: unknown, field: string, totalCharacters: { value: number }): ApiChatMessage {
  const message = record(value, field)
  const role = message.role
  if (role !== 'user' && role !== 'assistant') {
    throw new LearningDataBackupError(`${field}角色无效。`)
  }
  const content = text(message.content, `${field}内容`, 1_000_000)
  totalCharacters.value += content.length
  if (totalCharacters.value > 20_000_000) {
    throw new LearningDataBackupError('备份中的会话正文超过 2000 万字符。')
  }
  return { role, content }
}

function normalizeKnowledge(value: unknown): NodeKnowledgeSummary {
  const knowledge = record(value, '节点学习摘要')
  const updatedBy = knowledge.updatedBy
  if (typeof updatedBy !== 'undefined' && updatedBy !== 'user' && updatedBy !== 'agent') {
    throw new LearningDataBackupError('节点学习摘要的更新来源无效。')
  }
  return {
    topic: text(knowledge.topic, '节点学习摘要主题', 10_000),
    mastered: stringList(knowledge.mastered ?? [], '已掌握内容', 500),
    keyPoints: stringList(knowledge.keyPoints ?? [], '关键知识点', 500),
    unresolvedQuestions: stringList(knowledge.unresolvedQuestions ?? [], '未解决问题', 500),
    nextRecommendations: stringList(knowledge.nextRecommendations ?? [], '后续建议', 500),
    sourceMessageIds: stringList(knowledge.sourceMessageIds ?? [], '摘要来源消息', 2000, 120),
    updatedAt: optionalText(knowledge.updatedAt, '摘要更新时间', 100),
    updatedBy,
    stale: knowledge.stale === true,
  }
}

function normalizeNode(value: unknown, totalCharacters: { value: number }): CanvasSnapshotNode {
  const node = record(value, '画布节点')
  const position = record(node.position, '节点位置')
  const data = record(node.data, '节点数据')
  if (node.type !== 'conversation' || !Number.isFinite(position.x) || !Number.isFinite(position.y)) {
    throw new LearningDataBackupError('画布节点类型或位置无效。')
  }
  if (!Array.isArray(data.messages) || data.messages.length > 1000) {
    throw new LearningDataBackupError('单个节点最多包含 1000 条消息。')
  }
  const status = data.status
  const validStatuses = new Set<LearningNodeStatus>(['not-started', 'learning', 'review', 'completed'])
  if (typeof status !== 'undefined' && !validStatuses.has(status as LearningNodeStatus)) {
    throw new LearningDataBackupError('节点学习状态无效。')
  }
  const messages = data.messages.map((message, index) => normalizeMessage(message, `节点消息 ${index + 1}`, totalCharacters))
  if (new Set(messages.map((message) => message.id)).size !== messages.length) {
    throw new LearningDataBackupError('同一节点中存在重复消息 ID。')
  }
  return {
    id: text(node.id, '节点 ID', 120),
    type: 'conversation',
    position: { x: position.x as number, y: position.y as number },
    data: {
      title: text(data.title, '节点标题', 500),
      brief: optionalText(data.brief, '节点简介', 20_000),
      parentId: optionalText(data.parentId, '父节点 ID', 120),
      expanded: data.expanded === true,
      messages,
      note: typeof data.note === 'string' ? text(data.note, '节点笔记', 1_000_000, true) : '',
      status: status as LearningNodeStatus | undefined,
      knowledge: typeof data.knowledge === 'undefined' ? undefined : normalizeKnowledge(data.knowledge),
      sourceQuote: optionalText(data.sourceQuote, '节点引用', 1_000_000),
      branchContext: optionalText(data.branchContext, '分支上下文', 2_000_000),
      agentOpeningPrompt: optionalText(data.agentOpeningPrompt, '节点开场提示', 100_000),
    },
  }
}

function normalizeEdge(value: unknown): CanvasSnapshotEdge {
  const edge = record(value, '画布连线')
  return {
    id: text(edge.id, '连线 ID', 240),
    source: text(edge.source, '连线起点', 120),
    target: text(edge.target, '连线终点', 120),
  }
}

function ensureAcyclicTree(nodes: CanvasSnapshotNode[]) {
  const parentById = new Map(nodes.map((node) => [node.id, node.data.parentId]))
  for (const node of nodes) {
    const visited = new Set<string>()
    let current: string | undefined = node.id
    while (current) {
      if (visited.has(current)) throw new LearningDataBackupError('画布节点关系中存在循环。')
      visited.add(current)
      current = parentById.get(current)
    }
  }
}

function normalizeCanvas(value: unknown, totalCharacters: { value: number }): CanvasSnapshotCanvas {
  const canvas = record(value, '画布')
  if (!Array.isArray(canvas.nodes) || canvas.nodes.length > 1000) {
    throw new LearningDataBackupError('单个画布最多包含 1000 个节点。')
  }
  if (!Array.isArray(canvas.edges) || canvas.edges.length > 2000) {
    throw new LearningDataBackupError('单个画布最多包含 2000 条连线。')
  }
  const nodes = canvas.nodes.map((node) => normalizeNode(node, totalCharacters))
  const edges = canvas.edges.map(normalizeEdge)
  const ids = new Set(nodes.map((node) => node.id))
  const edgeIds = new Set(edges.map((edge) => edge.id))
  if (ids.size !== nodes.length) throw new LearningDataBackupError('同一画布中存在重复节点 ID。')
  if (edgeIds.size !== edges.length) throw new LearningDataBackupError('同一画布中存在重复连线 ID。')
  if (nodes.length && nodes.filter((node) => !node.data.parentId).length !== 1) {
    throw new LearningDataBackupError('非空画布必须只有一个总目标节点。')
  }
  if (nodes.some((node) => node.data.parentId && !ids.has(node.data.parentId))) {
    throw new LearningDataBackupError('画布中存在找不到父节点的节点。')
  }
  if (edges.some((edge) => !ids.has(edge.source) || !ids.has(edge.target))) {
    throw new LearningDataBackupError('画布中存在指向无效节点的连线。')
  }
  const expectedRelationships = new Set(nodes.flatMap((node) => (
    node.data.parentId ? [`${node.data.parentId}\u0000${node.id}`] : []
  )))
  const actualRelationships = new Set(edges.map((edge) => `${edge.source}\u0000${edge.target}`))
  if (
    actualRelationships.size !== expectedRelationships.size
    || [...actualRelationships].some((relationship) => !expectedRelationships.has(relationship))
  ) {
    throw new LearningDataBackupError('画布连线必须与节点父子关系完全一致。')
  }
  ensureAcyclicTree(nodes)
  const pathMode = canvas.pathMode
  if (typeof pathMode !== 'undefined' && pathMode !== 'course' && pathMode !== 'exam' && pathMode !== 'project' && pathMode !== 'exploration') {
    throw new LearningDataBackupError('画布学习方式无效。')
  }
  return {
    id: text(canvas.id, '画布 ID', 120),
    revision: Number.isInteger(canvas.revision) && (canvas.revision as number) >= 0 ? canvas.revision as number : 0,
    title: text(canvas.title, '画布标题', 500),
    learningGoal: optionalText(canvas.learningGoal, '学习目标', 20_000),
    targetOutcome: optionalText(canvas.targetOutcome, '目标结果', 20_000),
    pathMode,
    nodes,
    edges,
  }
}

function normalizeWorkspace(value: unknown, totalCharacters: { value: number }): StoredWorkspace {
  const workspace = record(value, '学习画布数据')
  if (!Array.isArray(workspace.canvases) || !workspace.canvases.length || workspace.canvases.length > 100) {
    throw new LearningDataBackupError('备份必须包含 1 到 100 个画布。')
  }
  const canvases = workspace.canvases.map((canvas) => normalizeCanvas(canvas, totalCharacters))
  const canvasIds = new Set(canvases.map((canvas) => canvas.id))
  if (canvasIds.size !== canvases.length) throw new LearningDataBackupError('备份中存在重复画布 ID。')
  const activeCanvasId = text(workspace.activeCanvasId, '当前画布 ID', 120)
  if (!canvasIds.has(activeCanvasId)) throw new LearningDataBackupError('备份中的当前画布不存在。')
  return { canvases, activeCanvasId }
}

export function normalizeStoredWorkspace(value: unknown): StoredWorkspace {
  return normalizeWorkspace(value, { value: 0 })
}

function normalizeOperation(value: unknown): AgentOperation {
  const operation = record(value, 'Agent 操作')
  const base = {
    id: text(operation.id, 'Agent 操作 ID', 120),
    reason: text(operation.reason, 'Agent 操作原因', 10_000),
  }
  if (operation.type === 'create-child') {
    let seedContext: Extract<AgentOperation, { type: 'create-child' }>['seedContext']
    if (typeof operation.seedContext !== 'undefined') {
      const seed = record(operation.seedContext, '分支依据')
      seedContext = {
        summary: text(seed.summary, '分支背景', 100_000),
        sourceMessageIds: stringList(seed.sourceMessageIds, '分支来源消息', 100, 120),
        question: text(seed.question, '分支问题', 100_000),
      }
    }
    return {
      ...base,
      type: 'create-child',
      parentId: text(operation.parentId, '父节点 ID', 120),
      title: text(operation.title, '节点标题', 500),
      brief: text(operation.brief, '节点简介', 20_000),
      openingPrompt: text(operation.openingPrompt, '节点开场', 100_000),
      ...(seedContext ? { seedContext } : {}),
    }
  }
  if (operation.type === 'update-brief') {
    return {
      ...base,
      type: 'update-brief',
      nodeId: text(operation.nodeId, '节点 ID', 120),
      brief: text(operation.brief, '节点简介', 20_000),
    }
  }
  if (operation.type === 'set-status') {
    if (operation.status !== 'not-started' && operation.status !== 'learning' && operation.status !== 'review' && operation.status !== 'completed') {
      throw new LearningDataBackupError('Agent 操作中的学习状态无效。')
    }
    return {
      ...base,
      type: 'set-status',
      nodeId: text(operation.nodeId, '节点 ID', 120),
      status: operation.status,
    }
  }
  if (operation.type === 'rename-node') {
    return {
      ...base,
      type: 'rename-node',
      nodeId: text(operation.nodeId, '节点 ID', 120),
      title: text(operation.title, '节点标题', 500),
    }
  }
  throw new LearningDataBackupError('备份包含不支持的 Agent 操作。')
}

function normalizeAgentSessions(value: unknown, totalCharacters: { value: number }): AgentSessionBackup[] {
  if (!Array.isArray(value) || value.length > 100) {
    throw new LearningDataBackupError('Agent 会话数量无效。')
  }
  return value.map((item, sessionIndex) => {
    const session = record(item, `Agent 会话 ${sessionIndex + 1}`)
    if (!Array.isArray(session.messages) || session.messages.length > 500 || !Array.isArray(session.operations) || session.operations.length > 100) {
      throw new LearningDataBackupError(`Agent 会话 ${sessionIndex + 1}的内容数量无效。`)
    }
    const operations = session.operations.map((itemValue) => {
      const reviewed = record(itemValue, 'Agent 审核操作')
      if (reviewed.status !== 'pending' && reviewed.status !== 'applied' && reviewed.status !== 'rejected' && reviewed.status !== 'error') {
        throw new LearningDataBackupError('Agent 审核状态无效。')
      }
      if (!Number.isInteger(reviewed.expectedRevision) || (reviewed.expectedRevision as number) < 0) {
        throw new LearningDataBackupError('Agent 操作的画布版本无效。')
      }
      return {
        reviewId: text(reviewed.reviewId, 'Agent 审核 ID', 120),
        operation: normalizeOperation(reviewed.operation),
        expectedRevision: reviewed.expectedRevision as number,
        status: reviewed.status,
        result: optionalText(reviewed.result, 'Agent 审核结果', 10_000),
      } satisfies ReviewedOperationBackup
    })
    return {
      id: text(session.id, 'Agent 会话 ID', 120),
      canvasId: text(session.canvasId, 'Agent 会话画布 ID', 120),
      canvasTitle: text(session.canvasTitle, 'Agent 会话画布标题', 500),
      title: text(session.title, 'Agent 会话标题', 500),
      messages: session.messages.map((message, index) => normalizeApiMessage(message, `Agent 消息 ${index + 1}`, totalCharacters)),
      operations,
      createdAt: text(session.createdAt, 'Agent 会话创建时间', 100),
      updatedAt: text(session.updatedAt, 'Agent 会话更新时间', 100),
    }
  })
}

export function normalizeStoredAgentSessions(value: unknown): AgentSessionBackup[] {
  return normalizeAgentSessions(value, { value: 0 })
}

export function normalizeLearningDataBackup(value: unknown): LearningDataBackup {
  const backup = record(value, '备份文件')
  if (backup.format !== LEARNING_DATA_BACKUP_FORMAT || backup.version !== LEARNING_DATA_BACKUP_VERSION) {
    throw new LearningDataBackupError('这不是受支持的 Brace Map Chat 学习数据备份。')
  }
  const data = record(backup.data, '备份数据')
  const totalCharacters = { value: 0 }
  const workspace = normalizeWorkspace(data.workspace, totalCharacters)
  const agentSessions = normalizeAgentSessions(data.agentSessions ?? [], totalCharacters)
  const canvasIds = new Set(workspace.canvases.map((canvas) => canvas.id))
  if (agentSessions.some((session) => !canvasIds.has(session.canvasId))) {
    throw new LearningDataBackupError('Agent 会话引用了备份中不存在的画布。')
  }
  let agentPlanningSessions: AgentPlanningSessionCollection
  if (typeof data.agentPlanningSessions !== 'undefined') {
    const normalized = normalizeAgentPlanningSessionCollection(data.agentPlanningSessions)
    if (!normalized) throw new LearningDataBackupError('Agent 规划会话数据无效。')
    agentPlanningSessions = normalized
  } else if (data.agentSetupDraft !== null && typeof data.agentSetupDraft !== 'undefined') {
    const legacyDraft = normalizeStoredAgentSetupDraft(data.agentSetupDraft)
    if (!legacyDraft) throw new LearningDataBackupError('Agent 初始化草稿无效。')
    agentPlanningSessions = migrateAgentSetupDraft(legacyDraft)
  } else {
    agentPlanningSessions = emptyAgentPlanningSessionCollection()
  }
  return {
    format: LEARNING_DATA_BACKUP_FORMAT,
    version: LEARNING_DATA_BACKUP_VERSION,
    exportedAt: text(backup.exportedAt, '导出时间', 100),
    data: { workspace, agentSessions, agentPlanningSessions },
  }
}

function parseStoredJson(storage: StorageLike, key: string, fallback: unknown) {
  const raw = storage.getItem(key)
  if (raw === null) return fallback
  try {
    return JSON.parse(raw) as unknown
  } catch {
    throw new LearningDataBackupError('浏览器中的现有学习数据已经损坏，暂时无法导出。')
  }
}

export function createLearningDataBackup(storage: StorageLike = localStorage, now = new Date()): LearningDataBackup {
  const workspace = parseStoredJson(storage, WORKSPACE_STORAGE_KEY, null)
  if (!workspace) throw new LearningDataBackupError('尚未找到可导出的学习画布。')
  return normalizeLearningDataBackup({
    format: LEARNING_DATA_BACKUP_FORMAT,
    version: LEARNING_DATA_BACKUP_VERSION,
    exportedAt: now.toISOString(),
    data: {
      workspace,
      agentSessions: parseStoredJson(storage, AGENT_SESSIONS_STORAGE_KEY, []),
      agentPlanningSessions: parseStoredJson(storage, AGENT_PLANNING_SESSIONS_STORAGE_KEY, undefined),
      agentSetupDraft: parseStoredJson(storage, AGENT_SETUP_DRAFT_STORAGE_KEY, null),
    },
  })
}

export function parseLearningDataBackup(source: string): LearningDataBackup {
  if (new TextEncoder().encode(source).byteLength > MAX_LEARNING_DATA_BACKUP_BYTES) {
    throw new LearningDataBackupError('备份文件不能超过 100 MB。')
  }
  try {
    return normalizeLearningDataBackup(JSON.parse(source) as unknown)
  } catch (error) {
    if (error instanceof LearningDataBackupError) throw error
    throw new LearningDataBackupError('备份文件不是有效的 JSON。')
  }
}

export function applyLearningDataBackup(backup: LearningDataBackup, storage: StorageLike = localStorage) {
  const normalized = normalizeLearningDataBackup(backup)
  const keys = [
    WORKSPACE_STORAGE_KEY,
    AGENT_SESSIONS_STORAGE_KEY,
    AGENT_PLANNING_SESSIONS_STORAGE_KEY,
    AGENT_SETUP_DRAFT_STORAGE_KEY,
  ]
  const previous = new Map(keys.map((key) => [key, storage.getItem(key)]))
  try {
    storage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(normalized.data.workspace))
    storage.setItem(AGENT_SESSIONS_STORAGE_KEY, JSON.stringify(normalized.data.agentSessions))
    storage.setItem(AGENT_PLANNING_SESSIONS_STORAGE_KEY, JSON.stringify(normalized.data.agentPlanningSessions))
    storage.removeItem(AGENT_SETUP_DRAFT_STORAGE_KEY)
  } catch {
    for (const [key, value] of previous) {
      if (value === null) storage.removeItem(key)
      else storage.setItem(key, value)
    }
    throw new LearningDataBackupError('浏览器存储空间不足，导入没有生效。')
  }
  return normalized
}

export function summarizeLearningDataBackup(backup: LearningDataBackup): LearningDataBackupSummary {
  return {
    canvasCount: backup.data.workspace.canvases.length,
    nodeCount: backup.data.workspace.canvases.reduce((total, canvas) => total + canvas.nodes.length, 0),
    messageCount: backup.data.workspace.canvases.reduce((canvasTotal, canvas) => (
      canvasTotal + canvas.nodes.reduce((nodeTotal, node) => nodeTotal + node.data.messages.length, 0)
    ), 0),
    agentSessionCount: backup.data.agentSessions.length,
    planningSessionCount: backup.data.agentPlanningSessions.sessions.length,
  }
}

export function learningDataBackupFilename(date = new Date()) {
  const stamp = date.toISOString().slice(0, 19).replaceAll(':', '-').replace('T', '_')
  return `brace-map-chat-backup_${stamp}.json`
}
