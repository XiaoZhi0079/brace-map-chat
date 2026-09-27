import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type {
  CanvasSnapshotCanvas,
  CanvasSnapshotEdge,
  CanvasSnapshotNode,
  PublishedCanvasSnapshot,
} from '../src/shared/canvasSnapshot.ts'
import { LearningDataBackupError, normalizeStoredWorkspace } from '../src/dataBackup.ts'
import { GatewayError } from './gatewayError.ts'

function text(value: unknown, field: string, maxLength: number) {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new GatewayError(422, 'INVALID_CANVAS_SNAPSHOT', `${field}无效。`)
  }
  return value.trim()
}

function optionalText(value: unknown, field: string, maxLength: number) {
  if (typeof value === 'undefined') return undefined
  return text(value, field, maxLength)
}

function validateNode(value: unknown, totalCharacters: { value: number }): CanvasSnapshotNode {
  if (!value || typeof value !== 'object') {
    throw new GatewayError(422, 'INVALID_CANVAS_NODE', '快照包含无效节点。')
  }
  const node = value as CanvasSnapshotNode
  if (
    node.type !== 'conversation'
    || !node.position
    || !Number.isFinite(node.position.x)
    || !Number.isFinite(node.position.y)
    || !node.data
    || typeof node.data.expanded !== 'boolean'
    || !Array.isArray(node.data.messages)
    || node.data.messages.length > 200
  ) {
    throw new GatewayError(422, 'INVALID_CANVAS_NODE', '快照节点结构无效。')
  }
  const messages = node.data.messages.map((message) => {
    if (
      !message
      || (message.role !== 'user' && message.role !== 'assistant')
      || typeof message.content !== 'string'
      || !message.content.trim()
    ) {
      throw new GatewayError(422, 'INVALID_CANVAS_MESSAGE', '快照中包含无效消息。')
    }
    totalCharacters.value += message.content.length
    return {
      id: text(message.id, '消息 ID', 120),
      role: message.role,
      content: message.content,
    }
  })
  if (totalCharacters.value > 500_000) {
    throw new GatewayError(413, 'CANVAS_SNAPSHOT_TOO_LARGE', '画布快照内容过长。')
  }
  return {
    id: text(node.id, '节点 ID', 120),
    type: 'conversation',
    position: { x: node.position.x, y: node.position.y },
    data: {
      title: text(node.data.title, '节点标题', 160),
      brief: optionalText(node.data.brief, '节点简介', 1000),
      parentId: optionalText(node.data.parentId, '父节点 ID', 120),
      expanded: node.data.expanded,
      messages,
      note: typeof node.data.note === 'string' ? node.data.note.slice(0, 100_000) : '',
      status: node.data.status,
      knowledge: node.data.knowledge,
      sourceQuote: optionalText(node.data.sourceQuote, '节点引用', 100_000),
      branchContext: optionalText(node.data.branchContext, '分支上下文', 200_000),
      agentOpeningPrompt: optionalText(node.data.agentOpeningPrompt, 'Agent 开场上下文', 10_000),
    },
  }
}

function validateEdge(value: unknown): CanvasSnapshotEdge {
  if (!value || typeof value !== 'object') {
    throw new GatewayError(422, 'INVALID_CANVAS_EDGE', '快照包含无效连线。')
  }
  const edge = value as CanvasSnapshotEdge
  return {
    id: text(edge.id, '连线 ID', 240),
    source: text(edge.source, '连线起点', 120),
    target: text(edge.target, '连线终点', 120),
  }
}

export function validateCanvasSnapshot(value: unknown): CanvasSnapshotCanvas {
  if (!value || typeof value !== 'object') {
    throw new GatewayError(422, 'INVALID_CANVAS_SNAPSHOT', '缺少画布快照。')
  }
  const canvas = value as CanvasSnapshotCanvas
  if (!Array.isArray(canvas.nodes) || canvas.nodes.length < 1 || canvas.nodes.length > 50) {
    throw new GatewayError(422, 'INVALID_CANVAS_NODES', '画布快照必须包含 1 到 50 个节点。')
  }
  if (!Array.isArray(canvas.edges) || canvas.edges.length > 100) {
    throw new GatewayError(422, 'INVALID_CANVAS_EDGES', '画布快照连线数量无效。')
  }
  const totalCharacters = { value: 0 }
  const nodes = canvas.nodes.map((node) => validateNode(node, totalCharacters))
  const edges = canvas.edges.map(validateEdge)
  const ids = new Set(nodes.map((node) => node.id))
  const roots = nodes.filter((node) => !node.data.parentId)
  if (ids.size !== nodes.length || roots.length !== 1) {
    throw new GatewayError(422, 'INVALID_CANVAS_TREE', '画布快照必须是单根且节点 ID 唯一的树。')
  }
  if (nodes.some((node) => node.data.parentId && !ids.has(node.data.parentId))) {
    throw new GatewayError(422, 'INVALID_CANVAS_TREE', '画布快照包含不存在的父节点。')
  }
  if (edges.some((edge) => !ids.has(edge.source) || !ids.has(edge.target))) {
    throw new GatewayError(422, 'INVALID_CANVAS_EDGES', '画布快照包含无效连线。')
  }
  const candidate = {
    id: text(canvas.id, '画布 ID', 120),
    revision: Number.isInteger(canvas.revision) && canvas.revision! >= 0 ? canvas.revision : 0,
    title: text(canvas.title, '画布标题', 120),
    learningGoal: optionalText(canvas.learningGoal, '学习目标', 2000),
    targetOutcome: optionalText(canvas.targetOutcome, '目标结果', 2000),
    pathMode: canvas.pathMode,
    nodes,
    edges,
  }
  try {
    return normalizeStoredWorkspace({ canvases: [candidate], activeCanvasId: candidate.id }).canvases[0]
  } catch (error) {
    if (error instanceof LearningDataBackupError) {
      throw new GatewayError(422, 'INVALID_CANVAS_TREE', error.message)
    }
    throw error
  }
}

export class CanvasSnapshotStore {
  private writeQueue: Promise<void> = Promise.resolve()
  private readonly filePath: string

  constructor(filePath: string) {
    this.filePath = filePath
  }

  async read(): Promise<PublishedCanvasSnapshot | null> {
    try {
      const value = JSON.parse(await readFile(this.filePath, 'utf8')) as PublishedCanvasSnapshot
      if (!value || typeof value.version !== 'string' || typeof value.publishedAt !== 'string') return null
      return { ...value, canvas: validateCanvasSnapshot(value.canvas) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  async publish(value: unknown): Promise<PublishedCanvasSnapshot> {
    const canvas = validateCanvasSnapshot(value)
    const snapshot: PublishedCanvasSnapshot = {
      version: randomUUID(),
      publishedAt: new Date().toISOString(),
      canvas,
    }
    const operation = async () => {
      const directory = dirname(this.filePath)
      const tempPath = `${this.filePath}.${randomUUID()}.tmp`
      await mkdir(directory, { recursive: true })
      await writeFile(tempPath, JSON.stringify(snapshot, null, 2), { encoding: 'utf8', mode: 0o600 })
      await rename(tempPath, this.filePath)
    }
    this.writeQueue = this.writeQueue.then(operation, operation)
    await this.writeQueue
    return snapshot
  }
}
