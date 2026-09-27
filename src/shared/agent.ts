import type { ApiChatMessage } from './chat.ts'

export type LearningPathMode = 'course' | 'exam' | 'project' | 'exploration'

export type LearningNodeStatus = 'not-started' | 'learning' | 'review' | 'completed'

export type NodeKnowledgeSummary = {
  topic: string
  mastered: string[]
  keyPoints: string[]
  unresolvedQuestions: string[]
  nextRecommendations: string[]
  sourceMessageIds: string[]
  updatedAt?: string
  updatedBy?: 'user' | 'agent'
  stale: boolean
}

export type AgentTreeChapter = {
  title: string
  brief: string
  openingPrompt: string
  children?: AgentTreeChapter[]
}

export type AgentTreePlan = {
  canvasTitle: string
  learningGoal: string
  targetOutcome: string
  pathMode: LearningPathMode
  root: {
    title: string
    brief: string
    openingPrompt: string
  }
  chapters: AgentTreeChapter[]
}

export type AgentPlanReview = {
  message: string
  plan: AgentTreePlan
  readyToAdopt: boolean
}

export type AgentCanvasNodeSnapshot = {
  id: string
  parentId?: string
  title: string
  brief: string
  status: LearningNodeStatus
  summary?: NodeKnowledgeSummary
  messageCount: number
}

export type AgentCanvasSnapshot = {
  id: string
  revision: number
  title: string
  learningGoal: string
  targetOutcome?: string
  pathMode?: LearningPathMode
  nodes: AgentCanvasNodeSnapshot[]
}

export type AgentNodeContext = {
  id: string
  title: string
  brief: string
  messages: Array<ApiChatMessage & { id: string }>
}

export type AgentNodeReadRequest = {
  nodeId: string
  reason: string
}

export type AgentNodeSummary = Omit<NodeKnowledgeSummary, 'updatedAt' | 'updatedBy' | 'stale'>

export type AgentProposalType =
  | 'next-node'
  | 'missing-topic'
  | 'expand-node'
  | 'refresh-summary'
  | 'possible-duplicate'

export type AgentProposal = {
  type: AgentProposalType
  title: string
  reason: string
  nodeId?: string
  suggestedTitle?: string
}

export type AgentCanvasAnalysis = {
  overview: string
  proposals: AgentProposal[]
}

type AgentOperationBase = {
  id: string
  reason: string
}

export type AgentOperation = AgentOperationBase & (
  | {
      type: 'create-child'
      parentId: string
      title: string
      brief: string
      openingPrompt: string
      seedContext?: {
        summary: string
        sourceMessageIds: string[]
        question: string
      }
    }
  | {
      type: 'update-brief'
      nodeId: string
      brief: string
    }
  | {
      type: 'set-status'
      nodeId: string
      status: LearningNodeStatus
    }
  | {
      type: 'rename-node'
      nodeId: string
      title: string
    }
)

export type AgentCompletionReason = 'goal-complete' | 'no-action' | 'needs-user'

export type AgentManagement = {
  message: string
  next: 'read-node' | 'review' | 'finish'
  readRequest?: AgentNodeReadRequest
  operations: AgentOperation[]
  completionReason?: AgentCompletionReason
}

export type AgentDiscussion = {
  message: string
  readyToInitialize: boolean
  nextAction: 'clarify' | 'offer-generation'
  missingInformation: string[]
  scopeChanged: boolean
}

export type AgentOperationApplyResult = {
  ok: boolean
  revision: number
  message: string
}

export type AgentRequest = {
  profileId: string
  model?: string
  mode: 'discuss' | 'initialize' | 'revise' | 'analyze' | 'manage' | 'summarize-node'
  messages?: ApiChatMessage[]
  plan?: AgentTreePlan
  canvas?: AgentCanvasSnapshot
  node?: AgentNodeContext
  observedNodes?: AgentNodeContext[]
}

export type AgentResponse = {
  mode: AgentRequest['mode']
  message?: ApiChatMessage & { role: 'assistant' }
  readyToInitialize?: boolean
  nextAction?: AgentDiscussion['nextAction']
  missingInformation?: string[]
  scopeChanged?: boolean
  readyToAdopt?: boolean
  plan?: AgentTreePlan
  analysis?: AgentCanvasAnalysis
  management?: AgentManagement
  summary?: AgentNodeSummary
}
