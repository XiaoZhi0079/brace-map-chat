import type { LearningNodeStatus, LearningPathMode, NodeKnowledgeSummary } from './agent.ts'
import type { ApiChatMessage } from './chat.ts'

export type CanvasSnapshotMessage = ApiChatMessage & {
  id: string
  generationStatus?: 'stopped' | 'incomplete' | 'error'
}

export type CanvasSnapshotNode = {
  id: string
  type: 'conversation'
  position: { x: number; y: number }
  data: {
    title: string
    brief?: string
    parentId?: string
    expanded: boolean
    messages: CanvasSnapshotMessage[]
    note: string
    status?: LearningNodeStatus
    knowledge?: NodeKnowledgeSummary
    sourceQuote?: string
    branchContext?: string
    agentOpeningPrompt?: string
  }
}

export type CanvasSnapshotEdge = {
  id: string
  source: string
  target: string
}

export type CanvasSnapshotCanvas = {
  id: string
  revision?: number
  title: string
  learningGoal?: string
  targetOutcome?: string
  pathMode?: LearningPathMode
  nodes: CanvasSnapshotNode[]
  edges: CanvasSnapshotEdge[]
}

export type PublishedCanvasSnapshot = {
  version: string
  publishedAt: string
  canvas: CanvasSnapshotCanvas
}

export type PublishCanvasSnapshotRequest = {
  canvas: CanvasSnapshotCanvas
}
