import type { AgentTreePlan } from '../shared/agent.ts'
import type { ApiChatMessage } from '../shared/chat.ts'
import { removeDuplicateLegacyReviewPrompts } from './agentSetupFlow.ts'

export type StoredAgentSetupDraft = {
  version: 1
  messages: ApiChatMessage[]
  input: string
  plan: AgentTreePlan | null
  readyToInitialize: boolean
  missingInformation: string[]
  readyToAdopt: boolean
  updatedAt: string
}

export function normalizeAgentTreePlan(value: unknown): AgentTreePlan | null {
  if (!value || typeof value !== 'object') return null
  const plan = value as Partial<AgentTreePlan>
  const root = plan.root as Partial<AgentTreePlan['root']> | undefined
  const valid = typeof plan.canvasTitle === 'string'
    && typeof plan.learningGoal === 'string'
    && typeof plan.targetOutcome === 'string'
    && (plan.pathMode === 'course' || plan.pathMode === 'exam' || plan.pathMode === 'project' || plan.pathMode === 'exploration')
    && Boolean(root && typeof root.title === 'string' && typeof root.brief === 'string')
    && Array.isArray(plan.chapters)
    && plan.chapters.length >= 3
    && plan.chapters.length <= 7
    && plan.chapters.reduce((total, chapter) => total + (chapter.children?.length ?? 0), 0) <= 16
    && plan.chapters.every((chapter) => (
      typeof chapter?.title === 'string'
      && typeof chapter.brief === 'string'
      && typeof chapter.openingPrompt === 'string'
      && (typeof chapter.children === 'undefined' || (
        Array.isArray(chapter.children)
        && chapter.children.length <= 3
        && chapter.children.every((child) => (
          typeof child?.title === 'string'
          && typeof child.brief === 'string'
          && typeof child.openingPrompt === 'string'
        ))
      ))
    ))
  if (!valid || !root || !plan.chapters) return null
  return {
    canvasTitle: plan.canvasTitle!,
    learningGoal: plan.learningGoal!,
    targetOutcome: plan.targetOutcome!,
    pathMode: plan.pathMode!,
    root: {
      title: root.title!,
      brief: root.brief!,
      openingPrompt: typeof root.openingPrompt === 'string' && root.openingPrompt.trim()
        ? root.openingPrompt
        : `从“${root.brief}”出发，介绍整个学习主题、目标成果与学习路线。`,
    },
    chapters: plan.chapters.map((chapter) => ({
      title: chapter.title,
      brief: chapter.brief,
      openingPrompt: chapter.openingPrompt,
      children: (chapter.children ?? []).map((child) => ({
        title: child.title,
        brief: child.brief,
        openingPrompt: child.openingPrompt,
        children: [],
      })),
    })),
  }
}

export function normalizeStoredAgentSetupDraft(value: unknown): StoredAgentSetupDraft | null {
  if (!value || typeof value !== 'object') return null
  const draft = value as Partial<StoredAgentSetupDraft>
  if (draft.version !== 1 || !Array.isArray(draft.messages)) return null
  const messages = removeDuplicateLegacyReviewPrompts(draft.messages.filter((message): message is ApiChatMessage => (
    Boolean(message)
    && (message.role === 'user' || message.role === 'assistant')
    && typeof message.content === 'string'
    && Boolean(message.content.trim())
  ))).slice(-30)
  const input = typeof draft.input === 'string' ? draft.input.slice(0, 20_000) : ''
  const plan = normalizeAgentTreePlan(draft.plan)
  if (!messages.length && !input.trim() && !plan) return null
  return {
    version: 1,
    messages,
    input,
    plan,
    readyToInitialize: draft.readyToInitialize === true,
    missingInformation: Array.isArray(draft.missingInformation)
      ? draft.missingInformation.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).slice(0, 2)
      : [],
    readyToAdopt: Boolean(plan && draft.readyToAdopt === true),
    updatedAt: typeof draft.updatedAt === 'string' ? draft.updatedAt : new Date().toISOString(),
  }
}
