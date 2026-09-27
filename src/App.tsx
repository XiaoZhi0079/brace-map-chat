import {
  createContext,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { createPortal } from 'react-dom'
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react'
import {
  ArrowsInSimple,
  ArrowsOutSimple,
  ArrowLeft,
  ArrowClockwise,
  ArrowRight,
  Broom,
  ChatCenteredText,
  ChatCircleDots,
  Check,
  CircleNotch,
  Gear,
  GitBranch,
  MagicWand,
  NotePencil,
  PaperPlaneRight,
  PencilSimple,
  Plus,
  Quotes,
  Sparkle,
  Trash,
  TreeStructure,
  WarningCircle,
  X,
} from '@phosphor-icons/react'
import '@xyflow/react/dist/style.css'
import {
  ApiError,
  acquireEditorLease,
  createAgentResponse,
  createModelResponse,
  deletePlanningSession,
  getStorageState,
  getPublishedRedisCanvas,
  importLearningData as importLearningDataToStorage,
  listModelProfiles,
  migrateBrowserStorage,
  saveAgentRuntime,
  savePlanningSessions,
  saveStoragePreferences,
  saveWorkspace,
  streamModelResponse,
} from './chatApi.ts'
import { AgentAnalysisPanel } from './agent/AgentAnalysisPanel.tsx'
import { AgentSetupDialog } from './agent/AgentSetupDialog.tsx'
import {
  agentOpeningPromptFor,
  agentRootOpeningPromptFor,
  isCurrentRootOverviewPrompt,
} from './agent/nodeOpeningPrompts.ts'
import {
  createAgentPlanningSession,
  type AgentPlanningSession,
  type AgentPlanningSessionCollection,
} from './agent/agentPlanningSessions.ts'
import { CanvasCreationDialog } from './CanvasCreationDialog.tsx'
import { LearningDataBackupError, type AgentSessionBackup, type LearningDataBackup } from './dataBackup.ts'
import type {
  AgentCanvasSnapshot,
  AgentNodeContext,
  AgentOperation,
  AgentOperationApplyResult,
  AgentTreePlan,
  LearningNodeStatus,
  LearningPathMode,
  NodeKnowledgeSummary,
} from './shared/agent.ts'
import { SettingsDialog } from './SettingsDialog.tsx'
import type { ApiChatMessage, ModelProfileSummary } from './shared/chat.ts'
import type { AgentModelSelection, PersistentApplicationState, StorageStateResponse } from './shared/persistence.ts'
import { clearLegacyBrowserData, readLegacyBrowserState } from './browserStorageMigration.ts'
import {
  arrangeCanvasTree,
  initialProgressiveTreePositions,
  progressiveVisibleNodeIds,
  resolveCanvasCollisions,
  type CanvasLayoutNode,
} from './canvasLayout.ts'

const MarkdownMessage = lazy(() => import('./MarkdownMessage.tsx'))

function canvasMotionDuration() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 240
}

type ChatMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  generationStatus?: 'stopped' | 'incomplete' | 'error'
}

type ConversationData = {
  title: string
  brief?: string
  parentId?: string
  expanded: boolean
  messages: ChatMessage[]
  note: string
  sourceQuote?: string
  branchContext?: string
  agentOpeningPrompt?: string
  status?: LearningNodeStatus
  knowledge?: NodeKnowledgeSummary
}

type ConversationFlowNode = Node<ConversationData, 'conversation'>

const DEFAULT_EXPANDED_NODE_HEIGHT = 400
const MIN_EXPANDED_NODE_HEIGHT = 280
const MAX_EXPANDED_NODE_HEIGHT = 820
type ResizeEdge = 'top' | 'bottom'
type ConversationPresentation = 'node' | 'focus'

type ConversationContentProps = {
  id: string
  data: ConversationData
  selected?: boolean
  presentation?: ConversationPresentation
  canvasTitle?: string
  breadcrumbs?: string[]
  initialScrollTop?: number
  onScrollTopChange?: (scrollTop: number) => void
  onCloseFocus?: () => void
}

type CanvasDocument = {
  id: string
  revision?: number
  title: string
  learningGoal?: string
  targetOutcome?: string
  pathMode?: LearningPathMode
  nodes: ConversationFlowNode[]
  edges: Edge[]
}

type CanvasCollection = {
  canvases: CanvasDocument[]
  activeCanvasId: string
  requiresPersist?: boolean
}

type PickedSegment = {
  id: string
  start: number
  end: number
  messageIndexes: number[]
  sourceLabel: string
  text: string
}

type SelectionParagraph = {
  graphemes: string[]
  start: number
  end: number
  messageIndex: number
  paragraphIndex: number
}

type SelectionRun = {
  text: string
  order?: number
  startsExcerpt: boolean
}

type BranchDraft = {
  parentId: string
  title: string
  excerpts: PickedSegment[]
  summary: string
  question: string
}

type NodeActions = {
  toggleExpanded: (nodeId: string) => void
  openChildDialog: (parentId: string) => void
  startPicking: (nodeId: string) => void
  stopPicking: (nodeId: string) => void
  addPickedSegment: (nodeId: string, segment: PickedSegment) => void
  clearPickedSegments: (nodeId: string) => void
  updateTitle: (nodeId: string, title: string) => void
  updateNote: (nodeId: string, note: string) => void
  updateBrief: (nodeId: string, brief: string) => void
  updateKnowledgeField: (
    nodeId: string,
    field: 'mastered' | 'keyPoints' | 'unresolvedQuestions' | 'nextRecommendations',
    values: string[],
  ) => void
  generateNodeSummary: (nodeId: string) => Promise<void>
  updateStatus: (nodeId: string, status: LearningNodeStatus) => void
  updateMessage: (nodeId: string, messageId: string, content: string) => void
  deleteMessage: (nodeId: string, messageId: string) => void
  sendMessage: (nodeId: string, content: string) => Promise<void>
  regenerateMessage: (nodeId: string, messageId: string) => Promise<void>
  stopGeneration: (nodeId: string) => void
  clearConversation: (nodeId: string) => void
  deleteNode: (nodeId: string) => void
  resizeNode: (nodeId: string, deltaY: number, commit?: boolean) => void
  openConversation: (nodeId: string) => void
  pickingNodeId: string | null
  pickedSegmentsByNode: Readonly<Record<string, PickedSegment[]>>
  pendingNodeIds: ReadonlySet<string>
  streamingNodeIds: ReadonlySet<string>
  errorsByNode: Readonly<Record<string, string>>
  compactAllNodes: boolean
}

const NodeActionsContext = createContext<NodeActions | null>(null)
const EMPTY_PICKED_SEGMENTS: PickedSegment[] = []

const learningStatusOptions: Array<{ value: LearningNodeStatus; label: string }> = [
  { value: 'not-started', label: '未开始' },
  { value: 'learning', label: '学习中' },
  { value: 'review', label: '待复习' },
  { value: 'completed', label: '已完成' },
]

const knowledgeFieldOptions = [
  { field: 'mastered' as const, label: '已经掌握', placeholder: '每行一项，只记录有明确依据的掌握内容' },
  { field: 'keyPoints' as const, label: '关键知识点', placeholder: '每行一项' },
  { field: 'unresolvedQuestions' as const, label: '未解决问题', placeholder: '每行一项' },
  { field: 'nextRecommendations' as const, label: '后续建议', placeholder: '每行一项' },
]

function summaryLines(value: string) {
  return value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)
}

function conversationBreadcrumbs(nodes: ConversationFlowNode[], nodeId: string) {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const titles: string[] = []
  const visited = new Set<string>()
  let current = byId.get(nodeId)
  while (current && !visited.has(current.id)) {
    visited.add(current.id)
    titles.push(current.data.title)
    current = current.data.parentId ? byId.get(current.data.parentId) : undefined
  }
  return titles.reverse()
}

function focusedNodeIdFromUrl() {
  const parameters = new URLSearchParams(window.location.search)
  return parameters.get('view') === 'conversation' ? parameters.get('node') : null
}

function writeFocusedConversationUrl(mode: 'push' | 'replace', nodeId?: string, canvasId?: string) {
  const url = new URL(window.location.href)
  if (nodeId) {
    url.searchParams.set('view', 'conversation')
    url.searchParams.set('node', nodeId)
    if (canvasId) url.searchParams.set('canvas', canvasId)
  } else {
    url.searchParams.delete('view')
    url.searchParams.delete('node')
    url.searchParams.delete('canvas')
  }
  const state = { ...(window.history.state ?? {}) }
  if (nodeId) state.braceMapConversation = nodeId
  else delete state.braceMapConversation
  if (mode === 'push') window.history.pushState(state, '', url)
  else window.history.replaceState(state, '', url)
}

function splitGraphemes(text: string) {
  if (typeof Intl.Segmenter === 'function') {
    return Array.from(new Intl.Segmenter('zh-CN', { granularity: 'grapheme' }).segment(text), ({ segment }) => segment)
  }
  return Array.from(text)
}

function selectionParagraphs(message: ChatMessage) {
  if (message.role === 'user') return message.content.split(/\n+/).filter((line) => line.trim())
  const plainText = message.content
    .replace(/^\s*```[^\n]*$/gm, '')
    .replace(/^\s*'''[^\n]*$/gm, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '[图片：$1]')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-+*]|\d+[.)])\s+/gm, '')
    .replace(/(\*\*|__|~~|`)/g, '')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1$2')
    .replace(/(^|[^_])_([^_]+)_/g, '$1$2')
    .replace(/<[^>]+>/g, '')
  return plainText.split(/\n+/).filter((line) => line.trim())
}

function selectionRuns(paragraph: SelectionParagraph, pickedSegments: PickedSegment[]): SelectionRun[] {
  const boundaries = new Set([0, paragraph.graphemes.length])
  const intervals = pickedSegments.flatMap((segment, order) => {
    const start = Math.max(segment.start, paragraph.start)
    const end = Math.min(segment.end, paragraph.end)
    if (start > end) return []
    const localStart = start - paragraph.start
    const localEnd = end - paragraph.start + 1
    boundaries.add(localStart)
    boundaries.add(localEnd)
    return [{ start, end, localStart, localEnd, order: order + 1, segmentStart: segment.start }]
  })
  const points = [...boundaries].sort((left, right) => left - right)
  return points.slice(0, -1).map((start, index) => {
    const end = points[index + 1]
    const globalStart = paragraph.start + start
    const interval = intervals.find((candidate) => candidate.start <= globalStart && candidate.end >= globalStart)
    return {
      text: paragraph.graphemes.slice(start, end).join(''),
      order: interval?.order,
      startsExcerpt: Boolean(interval && interval.segmentStart === globalStart),
    }
  }).filter((run) => run.text)
}

function graphemeIndexAtOffset(graphemes: string[], offset: number) {
  let cursor = 0
  for (let index = 0; index < graphemes.length; index += 1) {
    cursor += graphemes[index].length
    if (offset < cursor) return index
  }
  return Math.max(0, graphemes.length - 1)
}

function branchContextFor(draft: BranchDraft) {
  const source = draft.excerpts.map((excerpt, index) => `[${index + 1}] ${excerpt.text}`).join('\n')
  return branchContextFromSections(draft.summary, source, draft.question)
}

function branchContextFromSections(summary: string, source: string, question: string) {
  return `<parent_node_summary>\n${summary.trim()}\n</parent_node_summary>\n\n`
    + `<selected_source>\n${source.trim()}\n</selected_source>\n\n`
    + `<user_question>\n${question.trim()}\n</user_question>`
}

function modelMessagesForNode(data: ConversationData, messages: ChatMessage[]): ApiChatMessage[] {
  const visibleMessages = messages.map(({ role, content }) => ({ role, content }))
  const openingPrompt = data.agentOpeningPrompt?.trim()
  if (!openingPrompt) return visibleMessages
  if (visibleMessages[0]?.role === 'user') {
    return [{
      role: 'user',
      content: `${openingPrompt}\n\n以下是学习者刚刚发来的真实消息，请从这里继续引导：\n${visibleMessages[0].content}`,
    }, ...visibleMessages.slice(1)]
  }
  return [{ role: 'user', content: openingPrompt }, ...visibleMessages]
}

type NodeOpeningResponse = Awaited<ReturnType<typeof createModelResponse>>

function pageNodeOpeningRequests() {
  const pageWindow = window as Window & {
    __braceMapChatNodeOpeningRequests?: Map<string, Promise<NodeOpeningResponse>>
  }
  pageWindow.__braceMapChatNodeOpeningRequests ??= new Map()
  return pageWindow.__braceMapChatNodeOpeningRequests
}

function normalizeAgentOpenings(canvas: CanvasDocument): CanvasDocument {
  const rootId = canvas.nodes.find((node) => !node.data.parentId)?.id
  const isAgentCanvas = Boolean(canvas.learningGoal && canvas.targetOutcome && canvas.pathMode && rootId)
  const chapterTitles = rootId
    ? canvas.nodes.filter((node) => node.data.parentId === rootId).map((node) => node.data.title)
    : []
  let changed = typeof canvas.revision !== 'number'
  const nodes = canvas.nodes.map((node) => {
    const existingKnowledge = node.data.knowledge
    const isPlanningPlaceholder = Boolean(
      existingKnowledge
      && !existingKnowledge.updatedAt
      && !(existingKnowledge.mastered?.length)
      && !existingKnowledge.keyPoints.length
      && !existingKnowledge.unresolvedQuestions.length
      && !existingKnowledge.nextRecommendations.length,
    )
    const brief = node.data.brief?.trim() || existingKnowledge?.topic || node.data.title
    const knowledge = isPlanningPlaceholder
      ? undefined
      : existingKnowledge && { ...existingKnowledge, mastered: existingKnowledge.mastered ?? [] }
    const firstMessage = node.data.messages[0]
    const shouldMigrateOpening = Boolean(
      isAgentCanvas
      && node.data.parentId === rootId
      && !node.data.agentOpeningPrompt
      && existingKnowledge
      && firstMessage?.role === 'user',
    )
    const shouldMigrateRootOpening = Boolean(
      isAgentCanvas
      && node.id === rootId
      && !isCurrentRootOverviewPrompt(node.data.agentOpeningPrompt),
    )
    if (brief !== node.data.brief || knowledge !== existingKnowledge || shouldMigrateOpening || shouldMigrateRootOpening) changed = true
    return {
      ...node,
      data: {
        ...node.data,
        brief,
        knowledge,
        ...(shouldMigrateRootOpening
          ? {
              agentOpeningPrompt: agentRootOpeningPromptFor({
                canvasTitle: canvas.title,
                learningGoal: canvas.learningGoal!,
                targetOutcome: canvas.targetOutcome,
                rootTitle: node.data.title,
                rootPurpose: brief,
                chapterTitles,
              }),
            }
          : {}),
        ...(shouldMigrateOpening
          ? {
              agentOpeningPrompt: agentOpeningPromptFor({
                canvasTitle: canvas.title,
                learningGoal: canvas.learningGoal!,
                targetOutcome: canvas.targetOutcome,
                chapterTitle: node.data.title,
                chapterPurpose: brief,
                openingCue: firstMessage.content,
              }),
              messages: node.data.messages.slice(1),
            }
          : {}),
      },
    }
  })
  return changed ? { ...canvas, revision: canvas.revision ?? 0, nodes } : canvas
}

const demoNodes: ConversationFlowNode[] = [
  {
    id: 'closure-basics',
    type: 'conversation',
    position: { x: 80, y: 240 },
    data: {
      title: '理解 JavaScript 闭包',
      expanded: false,
      note: '闭包让函数继续访问定义时的词法作用域。',
      messages: [
        {
          id: 'm-1',
          role: 'user',
          content: '我总是弄不清闭包。能不能先用直觉解释，再给一个最小例子？',
        },
        {
          id: 'm-2',
          role: 'assistant',
          content:
            '可以把闭包理解为：一个函数离开出生地之后，仍然带着出生地的变量环境。\n\n当内部函数被返回时，外层函数虽然执行完了，但内部函数还引用着外层变量，所以这些变量不会立刻消失。',
        },
      ],
    },
  },
  {
    id: 'loop-question',
    type: 'conversation',
    position: { x: 560, y: 150 },
    data: {
      title: '循环中的闭包为什么出错？',
      parentId: 'closure-basics',
      expanded: false,
      note: '',
      sourceQuote: '内部函数还引用着外层变量，所以这些变量不会立刻消失。',
      messages: [
        {
          id: 'm-3',
          role: 'user',
          content: '那为什么用 var 写循环时，几个回调最后读到的是同一个值？',
        },
        {
          id: 'm-4',
          role: 'assistant',
          content: '因为这些回调闭包捕获的是同一个函数作用域变量，而不是每次循环各自的副本。',
        },
      ],
    },
  },
  {
    id: 'memory-question',
    type: 'conversation',
    position: { x: 560, y: 330 },
    data: {
      title: '闭包会造成内存泄漏吗？',
      parentId: 'closure-basics',
      expanded: false,
      note: '',
      sourceQuote: '这些变量不会立刻消失。',
      messages: [
        {
          id: 'm-5',
          role: 'user',
          content: '变量不消失是否意味着闭包一定会造成内存泄漏？',
        },
      ],
    },
  },
]

const demoEdges: Edge[] = [
  { id: 'closure-loop', source: 'closure-basics', target: 'loop-question' },
  { id: 'closure-memory', source: 'closure-basics', target: 'memory-question' },
]

function createRootNode(title: string): ConversationFlowNode {
  return {
    id: crypto.randomUUID(),
    type: 'conversation',
    position: { x: 80, y: 220 },
    data: {
      title,
      brief: title,
      expanded: true,
      messages: [],
      note: '',
      status: 'not-started',
    },
  }
}

function createCanvasDocument(title: string): CanvasDocument {
  return {
    id: crypto.randomUUID(),
    revision: 0,
    title,
    nodes: [createRootNode(title)],
    edges: [],
  }
}

function createCanvasFromPlan(plan: AgentTreePlan): CanvasDocument {
  const canvasId = crypto.randomUUID()
  const rootId = crypto.randomUUID()
  const root: ConversationFlowNode = {
    id: rootId,
    type: 'conversation',
    position: { x: 80, y: 220 },
    data: {
      title: plan.root.title,
      brief: plan.root.brief,
      expanded: true,
      messages: [],
      agentOpeningPrompt: agentRootOpeningPromptFor({
        canvasTitle: plan.canvasTitle,
        learningGoal: plan.learningGoal,
        targetOutcome: plan.targetOutcome,
        rootTitle: plan.root.title,
        rootPurpose: plan.root.brief,
        openingCue: plan.root.openingPrompt,
        chapterTitles: plan.chapters.map((chapter) => chapter.title),
      }),
      note: '',
      status: 'learning',
    },
  }
  const chapters: ConversationFlowNode[] = []
  const subchapters: ConversationFlowNode[] = []
  const treeEdges: Edge[] = []
  for (const chapter of plan.chapters) {
    const id = crypto.randomUUID()
    const children = chapter.children ?? []
    const chapterNode: ConversationFlowNode = {
      id,
      type: 'conversation',
      position: { x: 840, y: 40 },
      data: {
        title: chapter.title,
        brief: chapter.brief,
        parentId: rootId,
        expanded: false,
        messages: [],
        agentOpeningPrompt: agentOpeningPromptFor({
          canvasTitle: plan.canvasTitle,
          learningGoal: plan.learningGoal,
          targetOutcome: plan.targetOutcome,
          chapterTitle: chapter.title,
          chapterPurpose: chapter.brief,
          openingCue: chapter.openingPrompt,
        }),
        note: '',
        status: 'learning',
      },
    }
    chapters.push(chapterNode)
    treeEdges.push({ id: `${rootId}-${id}`, source: rootId, target: id })
    children.forEach((child) => {
      const childId = crypto.randomUUID()
      subchapters.push({
        id: childId,
        type: 'conversation',
        position: { x: 1600, y: 40 },
        data: {
          title: child.title,
          brief: child.brief,
          parentId: id,
          expanded: false,
          messages: [],
          agentOpeningPrompt: agentOpeningPromptFor({
            canvasTitle: plan.canvasTitle,
            learningGoal: plan.learningGoal,
            targetOutcome: plan.targetOutcome,
            chapterTitle: child.title,
            chapterPurpose: child.brief,
            openingCue: child.openingPrompt,
          }),
          note: '',
          status: 'learning',
        },
      })
      treeEdges.push({ id: `${id}-${childId}`, source: id, target: childId })
    })
  }
  const plannedNodes = [root, ...chapters, ...subchapters]
  const initialPositions = initialProgressiveTreePositions(plannedNodes.map((node) => ({
    id: node.id,
    parentId: node.data.parentId,
    expanded: node.data.expanded,
    position: node.position,
  })))
  return {
    id: canvasId,
    revision: 0,
    title: plan.canvasTitle,
    learningGoal: plan.learningGoal,
    targetOutcome: plan.targetOutcome,
    pathMode: plan.pathMode,
    nodes: plannedNodes.map((node) => ({
      ...node,
      position: initialPositions.get(node.id) ?? node.position,
    })),
    edges: treeEdges,
  }
}

function defaultCanvasCollection(): CanvasCollection {
  const canvas = {
    id: crypto.randomUUID(),
    title: '理解 JavaScript 闭包',
    nodes: structuredClone(demoNodes),
    edges: structuredClone(demoEdges),
  }
  return { canvases: [canvas], activeCanvasId: canvas.id }
}

function useNodeActions() {
  const actions = useContext(NodeActionsContext)
  if (!actions) throw new Error('Node actions are not available')
  return actions
}

function NodeNoteEditor({ id, data, actions, presentation }: {
  id: string
  data: ConversationData
  actions: NodeActions
  presentation: ConversationPresentation
}) {
  const fieldId = `${presentation}-note-${id}`
  return (
    <div className="nodrag nowheel note-editor">
      <label htmlFor={fieldId}>个人笔记</label>
      <textarea
        id={fieldId}
        value={data.note}
        onChange={(event) => actions.updateNote(id, event.target.value)}
        placeholder="记录你真正理解了什么。这部分不会自动发给模型。"
      />
      <small>自动保存在本机 SQLite 学习数据库中</small>
    </div>
  )
}

function NodeSummaryEditor({ id, data, actions, presentation, isPending, requestError }: {
  id: string
  data: ConversationData
  actions: NodeActions
  presentation: ConversationPresentation
  isPending: boolean
  requestError?: string
}) {
  const fieldId = `${presentation}-brief-${id}`
  return (
    <div className="nodrag nowheel node-summary-editor">
      <div className="node-summary-heading">
        <label htmlFor={fieldId}>节点简介</label>
        <select
          value={data.status ?? 'not-started'}
          onChange={(event) => actions.updateStatus(id, event.target.value as LearningNodeStatus)}
          aria-label="学习状态"
        >
          {learningStatusOptions.map((option) => (
            <option value={option.value} key={option.value}>{option.label}</option>
          ))}
        </select>
      </div>
      <textarea
        id={fieldId}
        className="node-brief-field"
        value={data.brief ?? data.title}
        onChange={(event) => actions.updateBrief(id, event.target.value)}
        placeholder="说明这个节点计划讨论什么"
      />
      <div className="node-learning-summary-heading">
        <div>
          <b>学习摘要</b>
          <small>
            {data.knowledge?.stale
              ? '完整会话发生变化，需要重新生成或复核'
              : data.knowledge?.updatedAt
                ? `${data.knowledge.updatedBy === 'agent' ? 'Agent' : '用户'}更新于 ${new Date(data.knowledge.updatedAt).toLocaleString()}`
                : '尚未更新，不会根据聊天自动推断'}
          </small>
        </div>
        <button
          className="node-summary-generate-button"
          type="button"
          onClick={() => void actions.generateNodeSummary(id)}
          disabled={!data.messages.length || isPending}
        >
          {isPending ? <CircleNotch className="loading-icon" size={13} /> : <MagicWand size={13} weight="fill" />}
          {isPending ? '正在通读' : '完整会话生成'}
        </button>
      </div>
      {requestError && <div className="node-summary-error" role="alert"><WarningCircle size={13} />{requestError}</div>}
      <div className="node-summary-grid">
        {knowledgeFieldOptions.map((option) => (
          <label key={option.field}>
            <span>{option.label}</span>
            <textarea
              value={(data.knowledge?.[option.field] ?? []).join('\n')}
              onChange={(event) => actions.updateKnowledgeField(id, option.field, summaryLines(event.target.value))}
              placeholder={option.placeholder}
            />
          </label>
        ))}
      </div>
    </div>
  )
}

function ConversationContent({
  id,
  data,
  selected = false,
  presentation = 'node',
  canvasTitle = '',
  breadcrumbs = [],
  initialScrollTop = 0,
  onScrollTopChange,
  onCloseFocus,
}: ConversationContentProps) {
  const actions = useNodeActions()
  const messageViewportRef = useRef<HTMLDivElement | null>(null)
  const composerRef = useRef<HTMLTextAreaElement | null>(null)
  const followStreamRef = useRef(true)
  const resizeStateRef = useRef<{
    pointerId: number
    edge: ResizeEdge
    lastY: number
    currentHeight: number
  } | null>(null)
  const [draft, setDraft] = useState('')
  const [activeView, setActiveView] = useState<'chat' | 'summary' | 'note'>('chat')
  const [editingTitle, setEditingTitle] = useState(false)
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null)
  const [messageDraft, setMessageDraft] = useState('')
  const [expandedHeight, setExpandedHeight] = useState(DEFAULT_EXPANDED_NODE_HEIGHT)
  const isFocused = presentation === 'focus'
  const isPending = actions.pendingNodeIds.has(id)
  const isStreaming = actions.streamingNodeIds.has(id)
  const requestError = actions.errorsByNode[id]
  const isPicking = actions.pickingNodeId === id
  const pickedSegments = actions.pickedSegmentsByNode[id] ?? EMPTY_PICKED_SEGMENTS
  const displayExpanded = isFocused || (data.expanded && !actions.compactAllNodes)
  const editingMessage = editingMessageId
    ? data.messages.find((message) => message.id === editingMessageId)
    : undefined

  const selectionRows = useMemo(() => {
    if (!isPicking) return []
    let characterIndex = 0
    return data.messages.map((message, messageIndex) => selectionParagraphs(message).map((paragraph, paragraphIndex) => (
      (() => {
        const graphemes = splitGraphemes(paragraph)
        const start = characterIndex
        characterIndex += graphemes.length
        return {
          graphemes,
          start,
          end: characterIndex - 1,
          messageIndex,
          paragraphIndex,
        } satisfies SelectionParagraph
      })()
    )))
  }, [data.messages, isPicking])

  const allSelectionParagraphs = useMemo(() => selectionRows.flat(), [selectionRows])
  const pickedCharacterCount = useMemo(
    () => pickedSegments.reduce((total, segment) => total + segment.end - segment.start + 1, 0),
    [pickedSegments],
  )

  useEffect(() => {
    if (isPicking) return
    window.getSelection()?.removeAllRanges()
  }, [isPicking])

  useEffect(() => {
    if (!isFocused) return
    const viewport = messageViewportRef.current
    if (!viewport) return
    const frame = window.requestAnimationFrame(() => {
      viewport.scrollTop = initialScrollTop
    })
    return () => window.cancelAnimationFrame(frame)
  }, [id, initialScrollTop, isFocused])

  useEffect(() => {
    if (!isFocused || !onCloseFocus) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (activeView !== 'chat') {
        setActiveView('chat')
        return
      }
      onCloseFocus()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [activeView, isFocused, onCloseFocus])

  useEffect(() => {
    const viewport = messageViewportRef.current
    if (!viewport) return
    if (!isStreaming) {
      followStreamRef.current = true
      return
    }
    if (followStreamRef.current) viewport.scrollTop = viewport.scrollHeight
  }, [data.messages, isStreaming])

  const resizeComposer = useCallback(() => {
    const textarea = composerRef.current
    if (!textarea) return

    textarea.style.height = '0px'
    const styles = window.getComputedStyle(textarea)
    const fontSize = Number.parseFloat(styles.fontSize) || 12
    const lineHeight = Number.parseFloat(styles.lineHeight) || fontSize * 1.55
    const verticalPadding = (Number.parseFloat(styles.paddingTop) || 0) + (Number.parseFloat(styles.paddingBottom) || 0)
    const verticalBorder = (Number.parseFloat(styles.borderTopWidth) || 0) + (Number.parseFloat(styles.borderBottomWidth) || 0)
    const minimumHeight = Number.parseFloat(styles.minHeight) || 0
    const maximumHeight = Math.ceil(lineHeight * 8 + verticalPadding + verticalBorder)
    const contentHeight = textarea.scrollHeight + verticalBorder
    const nextHeight = Math.max(minimumHeight, Math.min(contentHeight, maximumHeight))

    textarea.style.height = `${nextHeight}px`
    textarea.style.overflowY = contentHeight > maximumHeight ? 'auto' : 'hidden'
  }, [])

  useLayoutEffect(() => {
    resizeComposer()
  }, [draft, presentation, resizeComposer])

  useEffect(() => {
    window.addEventListener('resize', resizeComposer)
    return () => window.removeEventListener('resize', resizeComposer)
  }, [resizeComposer])

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const content = draft.trim()
    if (!content) return
    setDraft('')
    void actions.sendMessage(id, content)
  }

  function handleMessageScroll() {
    const viewport = messageViewportRef.current
    if (!viewport) return
    if (isStreaming) {
      followStreamRef.current = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 48
    }
    if (isFocused) onScrollTopChange?.(viewport.scrollTop)
  }

  function segmentFromRange(rangeStart: number, rangeEnd: number): PickedSegment | null {
    const start = Math.min(rangeStart, rangeEnd)
    const end = Math.max(rangeStart, rangeEnd)
    const selectedParagraphs = allSelectionParagraphs.filter((paragraph) => paragraph.end >= start && paragraph.start <= end)
    if (!selectedParagraphs.length) return null

    let text = ''
    selectedParagraphs.forEach((paragraph, index) => {
      const previous = selectedParagraphs[index - 1]
      if (previous && previous.messageIndex !== paragraph.messageIndex) text += '\n\n'
      else if (previous && previous.paragraphIndex !== paragraph.paragraphIndex) text += '\n'
      const localStart = Math.max(start, paragraph.start) - paragraph.start
      const localEnd = Math.min(end, paragraph.end) - paragraph.start
      text += paragraph.graphemes.slice(localStart, localEnd + 1).join('')
    })
    const messageIndexes = [...new Set(selectedParagraphs.map((paragraph) => paragraph.messageIndex))]
    const sourceLabel = messageIndexes.length === 1
      ? `第 ${messageIndexes[0] + 1} 条消息`
      : `跨第 ${messageIndexes.map((index) => index + 1).join('、')} 条消息`
    return { id: crypto.randomUUID(), start, end, messageIndexes, sourceLabel, text }
  }

  function beginSelection(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    if (!(event.target as HTMLElement).closest('[data-pick-paragraph]')) return
    window.getSelection()?.removeAllRanges()
  }

  function finishSelection() {
    window.setTimeout(() => {
      const selection = window.getSelection()
      const viewport = messageViewportRef.current
      if (!selection || selection.isCollapsed || !selection.rangeCount || !viewport) return
      const range = selection.getRangeAt(0)
      let rangeStart: number | null = null
      let rangeEnd: number | null = null
      const paragraphElements = viewport.querySelectorAll<HTMLElement>('[data-pick-paragraph]')
      for (const paragraphElement of paragraphElements) {
        if (!range.intersectsNode(paragraphElement)) continue
        const messageIndex = Number(paragraphElement.dataset.messageIndex)
        const paragraphIndex = Number(paragraphElement.dataset.paragraphIndex)
        const paragraph = selectionRows[messageIndex]?.[paragraphIndex]
        if (!paragraph?.graphemes.length) continue

        const paragraphRange = document.createRange()
        paragraphRange.selectNodeContents(paragraphElement)
        const intersection = paragraphRange.cloneRange()
        if (range.compareBoundaryPoints(Range.START_TO_START, paragraphRange) > 0) {
          intersection.setStart(range.startContainer, range.startOffset)
        }
        if (range.compareBoundaryPoints(Range.END_TO_END, paragraphRange) < 0) {
          intersection.setEnd(range.endContainer, range.endOffset)
        }
        const selectedText = intersection.toString()
        if (!selectedText) continue
        const prefix = document.createRange()
        prefix.selectNodeContents(paragraphElement)
        prefix.setEnd(intersection.startContainer, intersection.startOffset)
        const utfStart = prefix.toString().length
        const utfEnd = utfStart + selectedText.length
        const localStart = graphemeIndexAtOffset(paragraph.graphemes, utfStart)
        const localEnd = graphemeIndexAtOffset(paragraph.graphemes, Math.max(utfStart, utfEnd - 1))
        const globalStart = paragraph.start + localStart
        const globalEnd = paragraph.start + localEnd
        rangeStart = rangeStart === null ? globalStart : Math.min(rangeStart, globalStart)
        rangeEnd = rangeEnd === null ? globalEnd : Math.max(rangeEnd, globalEnd)
      }
      selection.removeAllRanges()
      if (rangeStart === null || rangeEnd === null) return
      const segment = segmentFromRange(rangeStart, rangeEnd)
      if (!segment || pickedSegments.some((item) => item.start === segment.start && item.end === segment.end)) return
      actions.addPickedSegment(id, segment)
    }, 0)
  }

  function handleCompactOpen(event: ReactMouseEvent<HTMLElement>) {
    if ((event.target as HTMLElement).closest('button, input')) return
    actions.toggleExpanded(id)
  }

  function startEditingMessage(message: ChatMessage) {
    setEditingMessageId(message.id)
    setMessageDraft(message.content)
  }

  function stopEditingMessage() {
    setEditingMessageId(null)
    setMessageDraft('')
  }

  function beginResize(event: ReactPointerEvent<HTMLDivElement>, edge: ResizeEdge) {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    resizeStateRef.current = {
      pointerId: event.pointerId,
      edge,
      lastY: event.clientY,
      currentHeight: expandedHeight,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function resize(event: ReactPointerEvent<HTMLDivElement>) {
    const resizeState = resizeStateRef.current
    if (!resizeState || resizeState.pointerId !== event.pointerId) return
    event.preventDefault()
    event.stopPropagation()
    const pointerDelta = event.clientY - resizeState.lastY
    if (!pointerDelta) return
    const nextHeight = Math.min(
      MAX_EXPANDED_NODE_HEIGHT,
      Math.max(
        MIN_EXPANDED_NODE_HEIGHT,
        resizeState.currentHeight + (resizeState.edge === 'top' ? -pointerDelta : pointerDelta),
      ),
    )
    const heightDelta = nextHeight - resizeState.currentHeight
    resizeState.currentHeight = nextHeight
    resizeState.lastY = event.clientY
    setExpandedHeight(nextHeight)
    if (resizeState.edge === 'top' && heightDelta) {
      actions.resizeNode(id, -heightDelta)
    }
  }

  function finishResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (resizeStateRef.current?.pointerId !== event.pointerId) return
    event.preventDefault()
    event.stopPropagation()
    resizeStateRef.current = null
    actions.resizeNode(id, 0, true)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  function finishResizeFromLostCapture() {
    if (!resizeStateRef.current) return
    resizeStateRef.current = null
    actions.resizeNode(id, 0, true)
  }

  function resizeWithKeyboard(event: ReactKeyboardEvent<HTMLDivElement>, edge: ResizeEdge) {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    event.preventDefault()
    event.stopPropagation()
    const pointerDelta = event.key === 'ArrowUp' ? -16 : 16
    const heightDelta = edge === 'top' ? -pointerDelta : pointerDelta
    const nextHeight = Math.min(MAX_EXPANDED_NODE_HEIGHT, Math.max(MIN_EXPANDED_NODE_HEIGHT, expandedHeight + heightDelta))
    if (nextHeight === expandedHeight) return
    setExpandedHeight(nextHeight)
    if (edge === 'top') actions.resizeNode(id, -(nextHeight - expandedHeight), true)
  }

  function saveMessage(messageId: string) {
    const content = messageDraft.trim()
    if (!content) return
    actions.updateMessage(id, messageId, content)
    stopEditingMessage()
  }

  return (
    <>
      <article
      className={isFocused
        ? 'focused-conversation'
        : `conversation-node ${displayExpanded ? 'conversation-node--expanded' : 'conversation-node--compact'} ${selected ? 'is-selected' : ''}`}
      style={!isFocused && displayExpanded ? { height: `${expandedHeight}px` } : undefined}
      aria-label={`会话：${data.title}`}
    >
      {!isFocused && data.parentId && <Handle type="target" position={Position.Left} isConnectable={false} />}

      {isFocused ? (
        <header className="focused-conversation-header">
          <button className="focused-conversation-back" type="button" onClick={onCloseFocus}>
            <ArrowLeft size={17} /> 返回画布
          </button>
          <div className="focused-conversation-heading">
            <div className="focused-conversation-breadcrumbs" aria-label="节点路径">
              {canvasTitle && <span>{canvasTitle}</span>}
              {breadcrumbs.slice(0, -1).map((title, index) => (
                <span key={`${title}-${index}`}>{title}</span>
              ))}
            </div>
            <input
              className="focused-conversation-title"
              value={data.title}
              onChange={(event) => actions.updateTitle(id, event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  event.currentTarget.blur()
                }
              }}
              aria-label="会话标题"
            />
          </div>
          <nav className="focused-conversation-header-actions" aria-label="会话辅助内容">
            <button
              className={activeView === 'summary' ? 'is-active' : ''}
              type="button"
              onClick={() => setActiveView((current) => current === 'summary' ? 'chat' : 'summary')}
              aria-pressed={activeView === 'summary'}
            >
              <Sparkle size={16} /> 摘要
            </button>
            <button
              className={activeView === 'note' ? 'is-active' : ''}
              type="button"
              onClick={() => setActiveView((current) => current === 'note' ? 'chat' : 'note')}
              aria-pressed={activeView === 'note'}
            >
              <NotePencil size={16} /> 笔记
            </button>
          </nav>
        </header>
      ) : (
        <header className="node-header" onClick={displayExpanded ? undefined : handleCompactOpen}>
          <div className="node-title-block">
            <span className="node-kicker">{data.parentId ? '子会话' : '主会话'}</span>
            {displayExpanded || editingTitle ? (
              <input
                className="nodrag node-title-input"
                value={data.title}
                onChange={(event) => actions.updateTitle(id, event.target.value)}
                onBlur={() => setEditingTitle(false)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    setEditingTitle(false)
                    event.currentTarget.blur()
                  }
                }}
                aria-label="会话标题"
                autoFocus={editingTitle}
              />
            ) : (
              <h2>{data.title}</h2>
            )}
          </div>
          <div className="node-header-actions nodrag">
            {!displayExpanded && (
              <button
                className="icon-button"
                type="button"
                onClick={() => setEditingTitle(true)}
                aria-label="编辑标题"
              >
                <PencilSimple size={16} />
              </button>
            )}
            <button
              className="open-full-conversation-button"
              type="button"
              onClick={() => actions.openConversation(id)}
              aria-label="进入完整会话"
              title="以全页面模式查看并继续此节点的全部对话"
            >
              <ChatCenteredText size={16} weight="fill" />
              <span>完整会话</span>
            </button>
            <button
              className="icon-button"
              type="button"
              onClick={() => actions.toggleExpanded(id)}
              aria-label={displayExpanded ? '收起会话' : '打开会话'}
            >
              {displayExpanded ? <ArrowsInSimple size={18} /> : <ArrowsOutSimple size={18} />}
            </button>
            {!displayExpanded && (
              <button
                className="icon-button icon-button--danger"
                type="button"
                onClick={() => actions.deleteNode(id)}
                aria-label="删除节点"
              >
                <Trash size={16} />
              </button>
            )}
          </div>
        </header>
      )}

      {displayExpanded && (
        <>
          {!isFocused && <nav className="nodrag node-tabs" aria-label="节点内容">
            <button
              className={activeView === 'chat' ? 'is-active' : ''}
              type="button"
              onClick={() => setActiveView('chat')}
            >
              <ChatCircleDots size={16} /> 会话
            </button>
            <button
              className={activeView === 'summary' ? 'is-active' : ''}
              type="button"
              onClick={() => setActiveView('summary')}
            >
              <Sparkle size={16} /> 摘要
            </button>
            <button
              className={activeView === 'note' ? 'is-active' : ''}
              type="button"
              onClick={() => setActiveView('note')}
            >
              <NotePencil size={16} /> 笔记
            </button>
          </nav>}

          {(isFocused || activeView === 'chat') && isPicking && (
            <div className="nodrag node-picking-toolbar" aria-live="polite">
              <div><Quotes size={14} weight="fill" /><span><b>拖拽摘录</b><small>从任意字按住，拖到终点后松开</small></span></div>
              <strong>{pickedSegments.length} 处 · {pickedCharacterCount} 字</strong>
            </div>
          )}

          {isFocused || activeView === 'chat' ? (
            <>
              <div
                ref={messageViewportRef}
                className={`nodrag nowheel message-viewport ${isPicking ? 'is-picking' : ''}`}
                onScroll={handleMessageScroll}
                onPointerDown={isPicking ? beginSelection : undefined}
                onPointerUp={isPicking ? finishSelection : undefined}
              >
                {data.sourceQuote && (
                  <blockquote className="source-quote">
                    <Quotes size={16} weight="fill" />
                    <span>{data.sourceQuote}</span>
                  </blockquote>
                )}
                <div className="message-list">
                  {data.messages.length ? data.messages.map((message, messageIndex) => (
                    <section
                      className={`message message--${message.role} ${isStreaming && messageIndex === data.messages.length - 1 && message.role === 'assistant' ? 'message--streaming' : ''}`}
                      aria-live={isStreaming && messageIndex === data.messages.length - 1 ? 'polite' : undefined}
                      key={message.id}
                    >
                      <span className="message-avatar">{message.role === 'user' ? '你' : 'AI'}</span>
                      <div className="message-content">
                        {isPicking ? (
                          <div className="message-bubble message-bubble--picking">
                            {selectionRows[messageIndex].map((paragraph) => (
                              <p
                                data-pick-paragraph
                                data-message-index={paragraph.messageIndex}
                                data-paragraph-index={paragraph.paragraphIndex}
                                key={`${message.id}-${paragraph.paragraphIndex}`}
                              >
                                {selectionRuns(paragraph, pickedSegments).map((run, runIndex) => (
                                  <span
                                    className={`node-pick-run ${run.order ? 'is-picked' : ''} ${run.startsExcerpt ? 'is-picked-start' : ''}`}
                                    data-order={run.startsExcerpt ? run.order : undefined}
                                    key={`${paragraph.start}-${runIndex}`}
                                  >
                                    {run.text}
                                  </span>
                                ))}
                              </p>
                            ))}
                          </div>
                        ) : (
                          <>
                            <div className="message-bubble">
                              {message.role === 'assistant'
                                ? isStreaming && messageIndex === data.messages.length - 1
                                  ? <p className="streaming-plain-text">{message.content}</p>
                                  : (
                                    <Suspense fallback={<p className="markdown-loading">正在排版…</p>}>
                                      <MarkdownMessage content={message.content} />
                                    </Suspense>
                                  )
                                : <p>{message.content}</p>}
                              {isStreaming && messageIndex === data.messages.length - 1 && message.role === 'assistant' && (
                                <span className="streaming-cursor" aria-label="正在生成" />
                              )}
                            </div>
                            {message.generationStatus && (
                              <p className={`generation-stopped generation-stopped--${message.generationStatus}`} role="status">
                                {message.generationStatus === 'stopped'
                                  ? '已停止生成'
                                  : message.generationStatus === 'incomplete'
                                    ? '回答未完整生成'
                                    : '回答生成失败'}
                              </p>
                            )}
                            <div
                              className={`message-actions ${message.role === 'assistant' && messageIndex === data.messages.length - 1 ? 'message-actions--latest-assistant' : ''}`}
                              aria-label="消息操作"
                            >
                              {message.role === 'assistant' && messageIndex === data.messages.length - 1 && (
                                <button
                                  className="message-regenerate-button"
                                  type="button"
                                  onClick={() => void actions.regenerateMessage(id, message.id)}
                                  disabled={isPending}
                                  aria-label="重新生成回答"
                                  title="使用原问题和此前上下文替换这条回答"
                                >
                                  <ArrowClockwise size={12} /> 重新生成回答
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => startEditingMessage(message)}
                                disabled={isPending}
                                aria-label={`编辑${message.role === 'user' ? '用户' : 'AI'}消息`}
                              >
                                <PencilSimple size={12} /> 编辑
                              </button>
                              <button
                                className="message-delete-button"
                                type="button"
                                onClick={() => actions.deleteMessage(id, message.id)}
                                disabled={isPending}
                                aria-label={`删除${message.role === 'user' ? '用户' : 'AI'}消息`}
                              >
                                <Trash size={12} /> 删除
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    </section>
                  )) : (
                    <div className="empty-chat">
                      <ChatCircleDots size={24} />
                      <p>这是一段新的会话，写下你想继续探索的问题。</p>
                    </div>
                  )}
                  {isPending && !isPicking && (!isStreaming || data.messages.at(-1)?.role !== 'assistant') && (
                    <section className="message message--assistant message--pending" aria-live="polite">
                      <span className="message-avatar">AI</span>
                      <div className="message-bubble"><p><i /><i /><i /><b>正在思考</b></p></div>
                    </section>
                  )}
                </div>
              </div>

              {requestError && !isPicking && (
                <div className="nodrag request-error" role="alert">
                  <WarningCircle size={16} weight="fill" />
                  <span>{requestError}</span>
                </div>
              )}

              {!isPicking && <form className="nodrag nowheel composer" onSubmit={handleSubmit}>
                <textarea
                  ref={composerRef}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                      event.preventDefault()
                      event.currentTarget.form?.requestSubmit()
                    }
                  }}
                  placeholder="输入消息；Enter 发送，Shift + Enter 换行"
                  aria-label="消息内容"
                  disabled={isPending}
                />
                <button
                  className={isStreaming ? 'composer-stop-button' : undefined}
                  type={isStreaming ? 'button' : 'submit'}
                  onClick={isStreaming ? () => actions.stopGeneration(id) : undefined}
                  disabled={isStreaming ? false : !draft.trim() || isPending}
                  aria-label={isStreaming ? '停止生成' : '发送消息'}
                >
                  {isStreaming
                    ? <span className="stop-generation-icon" />
                    : isPending
                      ? <CircleNotch className="loading-icon" size={18} weight="bold" />
                      : <PaperPlaneRight size={18} weight="fill" />}
                </button>
              </form>}
            </>
          ) : activeView === 'note' ? (
            <NodeNoteEditor id={id} data={data} actions={actions} presentation={presentation} />
          ) : (
            <NodeSummaryEditor
              id={id}
              data={data}
              actions={actions}
              presentation={presentation}
              isPending={isPending}
              requestError={requestError}
            />
          )}

          {isFocused && activeView !== 'chat' && (
            <aside className="focused-conversation-drawer" aria-label={activeView === 'note' ? '个人笔记' : '节点摘要'}>
              <header>
                <div>
                  {activeView === 'note' ? <NotePencil size={17} /> : <Sparkle size={17} />}
                  <b>{activeView === 'note' ? '个人笔记' : '节点摘要'}</b>
                </div>
                <button type="button" onClick={() => setActiveView('chat')} aria-label="关闭侧栏"><X size={16} /></button>
              </header>
              {activeView === 'note'
                ? <NodeNoteEditor id={id} data={data} actions={actions} presentation={presentation} />
                : (
                  <NodeSummaryEditor
                    id={id}
                    data={data}
                    actions={actions}
                    presentation={presentation}
                    isPending={isPending}
                    requestError={requestError}
                  />
                )}
            </aside>
          )}

          <footer className={`node-footer nodrag ${isPicking ? 'is-picking' : ''}`}>
            <span>{isPicking ? '可反向拖动；原文仍按正常阅读顺序保存' : `${data.messages.length} 条消息`}</span>
            {isPicking ? (
              <div>
                <button type="button" onClick={() => actions.clearPickedSegments(id)} disabled={!pickedSegments.length}>清空</button>
                <button type="button" onClick={() => actions.stopPicking(id)}>退出</button>
                <button className="finish-picking-node-button" type="button" onClick={() => actions.openChildDialog(id)} disabled={!pickedSegments.length}>
                  <Check size={15} weight="bold" /> 完成并整理
                </button>
              </div>
            ) : (
              <div>
                {pickedSegments.length > 0 && (
                  <button type="button" onClick={() => actions.openChildDialog(id)}><GitBranch size={15} /> 整理上下文</button>
                )}
                <button type="button" onClick={() => { setActiveView('chat'); actions.startPicking(id) }} disabled={!data.messages.length || isPending}>
                  <Quotes size={15} weight="fill" /> {pickedSegments.length ? '继续摘录' : '摘录原文'}
                </button>
                <button type="button" onClick={() => actions.clearConversation(id)} disabled={isPending}><Broom size={15} /> 清空会话</button>
                <button className="danger-node-action" type="button" onClick={() => actions.deleteNode(id)}><Trash size={15} /> 删除节点</button>
              </div>
            )}
          </footer>
        </>
      )}

      {!isFocused && displayExpanded && (
        <>
          {(['top', 'bottom'] as const).map((edge) => (
            <div
              className={`nodrag nowheel node-resize-handle node-resize-handle--${edge}`}
              role="separator"
              aria-label={edge === 'top' ? '调整节点顶部' : '调整节点底部'}
              aria-orientation="horizontal"
              aria-valuemin={MIN_EXPANDED_NODE_HEIGHT}
              aria-valuemax={MAX_EXPANDED_NODE_HEIGHT}
              aria-valuenow={Math.round(expandedHeight)}
              tabIndex={0}
              key={edge}
              onPointerDown={(event) => beginResize(event, edge)}
              onPointerMove={resize}
              onPointerUp={finishResize}
              onPointerCancel={finishResize}
              onLostPointerCapture={finishResizeFromLostCapture}
              onKeyDown={(event) => resizeWithKeyboard(event, edge)}
            />
          ))}
        </>
      )}

      {!isFocused && <Handle type="source" position={Position.Right} isConnectable={false} />}
      </article>

      {editingMessage && typeof document !== 'undefined' && createPortal(
        <div className="modal-backdrop message-edit-backdrop" role="presentation">
          <form
            className="message-edit-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby={`message-edit-title-${editingMessage.id}`}
            aria-describedby={`message-edit-description-${editingMessage.id}`}
            onSubmit={(event) => {
              event.preventDefault()
              saveMessage(editingMessage.id)
            }}
          >
            <header className="message-edit-header">
              <span className={`message-avatar message-edit-avatar message-edit-avatar--${editingMessage.role}`}>
                {editingMessage.role === 'user' ? '你' : 'AI'}
              </span>
              <div>
                <h2 id={`message-edit-title-${editingMessage.id}`}>
                  编辑{editingMessage.role === 'user' ? '用户' : 'AI'}消息
                </h2>
                <p id={`message-edit-description-${editingMessage.id}`}>
                  保存后，后续提问将使用修改后的会话内容作为上下文。
                </p>
              </div>
              <button type="button" onClick={stopEditingMessage} aria-label="关闭消息编辑器">
                <X size={18} />
              </button>
            </header>

            <label className="message-edit-field">
              <span>消息原文</span>
              <textarea
                value={messageDraft}
                onChange={(event) => setMessageDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault()
                    stopEditingMessage()
                  }
                  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                    event.preventDefault()
                    saveMessage(editingMessage.id)
                  }
                }}
                aria-label={`编辑${editingMessage.role === 'user' ? '用户' : 'AI'}消息`}
                autoFocus
              />
            </label>

            <footer className="message-edit-footer">
              <span>{messageDraft.length} 字符 · Ctrl/⌘ + Enter 保存 · Esc 取消</span>
              <div className="message-editor-actions">
                <button type="button" onClick={stopEditingMessage}>取消</button>
                <button className="message-save-button" type="submit" disabled={!messageDraft.trim()}>
                  <Check size={15} weight="bold" /> 保存修改
                </button>
              </div>
            </footer>
          </form>
        </div>,
        document.body,
      )}
    </>
  )
}

function ConversationNode({ id, data, selected }: NodeProps<ConversationFlowNode>) {
  return <ConversationContent id={id} data={data} selected={selected} />
}

type MapWorkspaceProps = {
  initialState: PersistentApplicationState
  initialStorageVersion: number
  initialStorageWarning?: string
}

function MapWorkspace({ initialState, initialStorageVersion, initialStorageWarning = '' }: MapWorkspaceProps) {
  const stored = useMemo<CanvasCollection>(() => {
    if (!initialState.workspace?.canvases.length) return defaultCanvasCollection()
    let requiresPersist = false
    const canvases = initialState.workspace.canvases.map((canvas) => {
      const candidate = {
        ...canvas,
        nodes: canvas.nodes as ConversationFlowNode[],
        edges: canvas.edges,
      }
      const normalized = normalizeAgentOpenings(candidate)
      if (normalized !== candidate) requiresPersist = true
      return normalized
    })
    return {
      canvases,
      activeCanvasId: canvases.some((canvas) => canvas.id === initialState.workspace?.activeCanvasId)
        ? initialState.workspace.activeCanvasId
        : canvases[0].id,
      requiresPersist,
    }
  }, [initialState.workspace])
  const initialCanvas = stored.canvases.find((canvas) => canvas.id === stored.activeCanvasId) ?? stored.canvases[0]
  const [canvases, setCanvases] = useState<CanvasDocument[]>(stored.canvases)
  const [activeCanvasId, setActiveCanvasId] = useState(stored.activeCanvasId)
  const [workspaceRevision, setWorkspaceRevision] = useState(initialCanvas.revision ?? 0)
  const [nodes, setNodes, onNodesChange] = useNodesState<ConversationFlowNode>(initialCanvas.nodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialCanvas.edges)
  const { fitView, getNodesBounds, getViewport, setViewport, updateNode } = useReactFlow<ConversationFlowNode>()
  const [pickingNodeId, setPickingNodeId] = useState<string | null>(null)
  const [pickedSegmentsByNode, setPickedSegmentsByNode] = useState<Record<string, PickedSegment[]>>({})
  const [branchDraft, setBranchDraft] = useState<BranchDraft | null>(null)
  const [branchStep, setBranchStep] = useState<1 | 2 | 3>(1)
  const [generatingSummary, setGeneratingSummary] = useState(false)
  const [branchError, setBranchError] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [canvasCreationOpen, setCanvasCreationOpen] = useState(false)
  const [planningSessions, setPlanningSessions] = useState<AgentPlanningSessionCollection>(initialState.agentPlanningSessions)
  const [agentSessions, setAgentSessions] = useState<AgentSessionBackup[]>(initialState.agentSessions)
  const [agentModelSelection, setAgentModelSelection] = useState<AgentModelSelection | null>(initialState.preferences.agentModelSelection)
  const [agentSetupOpen, setAgentSetupOpen] = useState(false)
  const [agentAnalysisOpen, setAgentAnalysisOpen] = useState(false)
  const [treeOverviewOpen, setTreeOverviewOpen] = useState(false)
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(() => focusedNodeIdFromUrl())
  const [nodeDragging, setNodeDragging] = useState(false)
  const [dataImportRevision, setDataImportRevision] = useState(0)
  const [profiles, setProfiles] = useState<ModelProfileSummary[]>([])
  const [profilesError, setProfilesError] = useState(false)
  const [activeProfileId, setActiveProfileId] = useState<string | null>(initialState.preferences.activeProfileId)
  const [pendingNodeIds, setPendingNodeIds] = useState<Set<string>>(() => new Set())
  const [streamingNodeIds, setStreamingNodeIds] = useState<Set<string>>(() => new Set())
  const [errorsByNode, setErrorsByNode] = useState<Record<string, string>>({})
  const [storageError, setStorageError] = useState(initialStorageWarning)
  const snapshotSyncStartedRef = useRef(false)
  const snapshotVersionRef = useRef(initialState.preferences.redisSnapshotVersion)
  const persistTimerRef = useRef<number | null>(null)
  const workspaceSaveQueueRef = useRef<Promise<void>>(Promise.resolve())
  const planningSaveQueueRef = useRef<Promise<void>>(Promise.resolve())
  const agentRuntimeSaveQueueRef = useRef<Promise<void>>(Promise.resolve())
  const workspaceDirtyRef = useRef(Boolean(stored.requiresPersist))
  const workspaceInteractionReadyRef = useRef(Boolean(initialState.workspace))
  const workspaceStorageVersionRef = useRef(initialStorageVersion)
  const workspaceMutationVersionRef = useRef(0)
  const queuedWorkspaceMutationRef = useRef({ epoch: -1, mutationVersion: -1 })
  const persistenceEpochRef = useRef(0)
  const draggingNodeRef = useRef(false)
  const generationControllersRef = useRef(new Map<string, AbortController>())
  const mapAreaRef = useRef<HTMLElement | null>(null)
  const focusedScrollPositionsRef = useRef(new Map<string, number>())

  const canvasesRef = useRef(canvases)
  const activeCanvasIdRef = useRef(activeCanvasId)
  const nodesRef = useRef(nodes)
  const edgesRef = useRef(edges)
  const pendingNodeIdsRef = useRef(pendingNodeIds)
  const workspaceRevisionRef = useRef(workspaceRevision)
  canvasesRef.current = canvases
  activeCanvasIdRef.current = activeCanvasId
  nodesRef.current = nodes
  edgesRef.current = edges
  pendingNodeIdsRef.current = pendingNodeIds
  workspaceRevisionRef.current = workspaceRevision

  const activeProfile = profiles.find((profile) => profile.id === activeProfileId) ?? null
  const activePlanningSession = planningSessions.sessions.find((session) => (
    session.id === planningSessions.activeSessionId
  )) ?? null
  const activeCanvas = canvases.find((canvas) => canvas.id === activeCanvasId) ?? canvases[0]
  const focusedNode = focusedNodeId ? nodes.find((node) => node.id === focusedNodeId) ?? null : null
  const focusedBreadcrumbs = useMemo(
    () => focusedNodeId ? conversationBreadcrumbs(nodes, focusedNodeId) : [],
    [focusedNodeId, nodes],
  )
  const layoutNodes = useMemo<CanvasLayoutNode[]>(() => nodes.map((node) => ({
    id: node.id,
    parentId: node.data.parentId,
    expanded: node.data.expanded,
    position: node.position,
  })), [nodes])
  const visibleNodeIds = useMemo(() => (
    treeOverviewOpen
      ? new Set(nodes.map((node) => node.id))
      : progressiveVisibleNodeIds(layoutNodes)
  ), [layoutNodes, nodes, treeOverviewOpen])
  const visibleNodes = useMemo(() => {
    const selectedNodes = nodes.filter((node) => visibleNodeIds.has(node.id))
    const selectedLayoutNodes = layoutNodes.filter((node) => visibleNodeIds.has(node.id))
    const positions = treeOverviewOpen
      ? arrangeCanvasTree(layoutNodes, { compactAll: true, visibleIds: visibleNodeIds })
      : resolveCanvasCollisions(selectedLayoutNodes)
    return selectedNodes.map((node) => ({
      ...node,
      position: positions.get(node.id) ?? node.position,
    }))
  }, [layoutNodes, nodes, treeOverviewOpen, visibleNodeIds])
  const visibleEdges = useMemo(() => edges.filter((edge) => (
    visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target)
  )), [edges, visibleNodeIds])

  const agentCanvasSnapshot = useMemo<AgentCanvasSnapshot>(() => ({
    id: activeCanvas.id,
    revision: workspaceRevision,
    title: activeCanvas.title,
    learningGoal: activeCanvas.learningGoal?.trim() || activeCanvas.title,
    targetOutcome: activeCanvas.targetOutcome,
    pathMode: activeCanvas.pathMode,
    nodes: nodes.map((node) => ({
      id: node.id,
      parentId: node.data.parentId,
      title: node.data.title,
      brief: node.data.brief?.trim() || node.data.knowledge?.topic || node.data.title,
      status: node.data.status ?? 'not-started',
      summary: node.data.knowledge,
      messageCount: node.data.messages.length,
    })),
  }), [activeCanvas.id, activeCanvas.learningGoal, activeCanvas.pathMode, activeCanvas.targetOutcome, activeCanvas.title, nodes, workspaceRevision])

  const readAgentNode = useCallback((nodeId: string): AgentNodeContext | null => {
    const node = nodesRef.current.find((candidate) => candidate.id === nodeId)
    if (!node) return null
    return {
      id: node.id,
      title: node.data.title,
      brief: node.data.brief?.trim() || node.data.title,
      messages: node.data.messages.map(({ id, role, content }) => ({ id, role, content })),
    }
  }, [])

  const bumpWorkspaceRevision = useCallback(() => {
    workspaceDirtyRef.current = true
    workspaceMutationVersionRef.current += 1
    const nextRevision = workspaceRevisionRef.current + 1
    workspaceRevisionRef.current = nextRevision
    setWorkspaceRevision(nextRevision)
    return nextRevision
  }, [])

  const markWorkspaceDirty = useCallback(() => {
    workspaceDirtyRef.current = true
    workspaceMutationVersionRef.current += 1
  }, [])

  const loadWorkspaceRevision = useCallback((revision: number | undefined) => {
    const nextRevision = revision ?? 0
    workspaceRevisionRef.current = nextRevision
    setWorkspaceRevision(nextRevision)
  }, [])

  const clearPickedSegments = useCallback((nodeId: string) => {
    setPickedSegmentsByNode((current) => {
      const next = { ...current }
      delete next[nodeId]
      return next
    })
  }, [])

  const startPicking = useCallback((nodeId: string) => {
    window.getSelection()?.removeAllRanges()
    setPickingNodeId(nodeId)
    setBranchDraft(null)
  }, [])

  const stopPicking = useCallback((nodeId: string) => {
    setPickingNodeId((current) => current === nodeId ? null : current)
  }, [])

  const addPickedSegment = useCallback((nodeId: string, segment: PickedSegment) => {
    setPickedSegmentsByNode((current) => ({
      ...current,
      [nodeId]: [...(current[nodeId] ?? []), segment],
    }))
  }, [])

  const cancelScheduledPersist = useCallback(() => {
    if (persistTimerRef.current === null) return
    window.clearTimeout(persistTimerRef.current)
    persistTimerRef.current = null
  }, [])

  const persistWorkspace = useCallback((options?: { keepalive?: boolean }) => {
    cancelScheduledPersist()
    const serializableNodes = nodesRef.current.map(({ id, type, position, data }) => ({ id, type, position, data }))
    const nextCanvases = canvasesRef.current.map((canvas) => canvas.id === activeCanvasIdRef.current
      ? { ...canvas, revision: workspaceRevisionRef.current, nodes: serializableNodes, edges: edgesRef.current }
      : canvas)
    const workspace = {
      canvases: nextCanvases,
      activeCanvasId: activeCanvasIdRef.current,
    }
    const mutationVersion = workspaceMutationVersionRef.current
    const persistenceEpoch = persistenceEpochRef.current
    if (
      queuedWorkspaceMutationRef.current.epoch === persistenceEpoch
      && queuedWorkspaceMutationRef.current.mutationVersion === mutationVersion
    ) return workspaceSaveQueueRef.current
    queuedWorkspaceMutationRef.current = { epoch: persistenceEpoch, mutationVersion }
    const operation = workspaceSaveQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        if (persistenceEpoch !== persistenceEpochRef.current) return
        const result = await saveWorkspace(
          workspace,
          workspaceStorageVersionRef.current,
          options?.keepalive === true,
        )
        workspaceStorageVersionRef.current = result.workspaceVersion
        if (mutationVersion === workspaceMutationVersionRef.current) workspaceDirtyRef.current = false
        setStorageError('')
      })
      .catch((error) => {
        if (
          queuedWorkspaceMutationRef.current.epoch === persistenceEpoch
          && queuedWorkspaceMutationRef.current.mutationVersion === mutationVersion
        ) queuedWorkspaceMutationRef.current = { epoch: -1, mutationVersion: -1 }
        setStorageError(error instanceof ApiError ? error.message : '学习数据保存失败，请确认本地服务正在运行。')
        throw error
      })
    workspaceSaveQueueRef.current = operation.catch(() => undefined)
    return operation
  }, [cancelScheduledPersist])

  useEffect(() => {
    cancelScheduledPersist()
    if (draggingNodeRef.current) return
    if (!workspaceDirtyRef.current) return
    persistTimerRef.current = window.setTimeout(() => void persistWorkspace(), 450)
    return cancelScheduledPersist
  }, [activeCanvasId, canvases, cancelScheduledPersist, edges, nodes, persistWorkspace, workspaceRevision])

  const handleNodeDragStart = useCallback(() => {
    bumpWorkspaceRevision()
    draggingNodeRef.current = true
    setNodeDragging(true)
    cancelScheduledPersist()
  }, [bumpWorkspaceRevision, cancelScheduledPersist])

  const handleNodeDragStop = useCallback(() => {
    draggingNodeRef.current = false
    setNodeDragging(false)
    cancelScheduledPersist()
    window.requestAnimationFrame(() => void persistWorkspace())
  }, [cancelScheduledPersist, persistWorkspace])

  const handleNodesChange = useCallback((changes: Parameters<typeof onNodesChange>[0]) => {
    if (
      workspaceInteractionReadyRef.current
      && changes.some((change) => change.type !== 'select' && change.type !== 'dimensions' && change.type !== 'position')
    ) bumpWorkspaceRevision()
    onNodesChange(changes)
  }, [bumpWorkspaceRevision, onNodesChange])

  const handleEdgesChange = useCallback((changes: Parameters<typeof onEdgesChange>[0]) => {
    if (workspaceInteractionReadyRef.current && changes.some((change) => change.type !== 'select')) {
      bumpWorkspaceRevision()
    }
    onEdgesChange(changes)
  }, [bumpWorkspaceRevision, onEdgesChange])

  useEffect(() => {
    if (initialState.workspace) return
    const timer = window.setTimeout(() => {
      workspaceInteractionReadyRef.current = true
    }, 1000)
    return () => window.clearTimeout(timer)
  }, [initialState.workspace])

  useEffect(() => {
    const flushHiddenWorkspace = () => {
      if (document.visibilityState === 'hidden' && workspaceDirtyRef.current) {
        void persistWorkspace({ keepalive: true })
      }
    }
    const handlePageHide = () => {
      if (workspaceDirtyRef.current) void persistWorkspace({ keepalive: true })
    }
    document.addEventListener('visibilitychange', flushHiddenWorkspace)
    window.addEventListener('pagehide', handlePageHide)
    return () => {
      document.removeEventListener('visibilitychange', flushHiddenWorkspace)
      window.removeEventListener('pagehide', handlePageHide)
    }
  }, [persistWorkspace])

  useEffect(() => {
    void saveStoragePreferences({ activeProfileId }).catch((error) => {
      setStorageError(error instanceof ApiError ? error.message : '当前模型偏好保存失败。')
    })
  }, [activeProfileId])

  const persistPlanningSessions = useCallback((next: AgentPlanningSessionCollection) => {
    const persistenceEpoch = persistenceEpochRef.current
    const operation = planningSaveQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        if (persistenceEpoch !== persistenceEpochRef.current) return
        await savePlanningSessions(next)
        setStorageError('')
      })
      .catch((error) => {
        setStorageError(error instanceof ApiError ? error.message : 'Agent 规划会话保存失败。')
        throw error
      })
    planningSaveQueueRef.current = operation.catch(() => undefined)
  }, [])

  const persistPlanningSessionDeletion = useCallback((sessionId: string) => {
    const persistenceEpoch = persistenceEpochRef.current
    const operation = planningSaveQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        if (persistenceEpoch !== persistenceEpochRef.current) return
        await deletePlanningSession(sessionId)
        setStorageError('')
      })
      .catch((error) => {
        setStorageError(error instanceof ApiError ? error.message : 'Agent 规划会话删除失败。')
        throw error
      })
    planningSaveQueueRef.current = operation.catch(() => undefined)
  }, [])

  const persistAgentRuntime = useCallback((sessions: AgentSessionBackup[], selection: AgentModelSelection | null) => {
    setAgentSessions(sessions)
    setAgentModelSelection(selection)
    const persistenceEpoch = persistenceEpochRef.current
    const operation = agentRuntimeSaveQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        if (persistenceEpoch !== persistenceEpochRef.current) return
        await saveAgentRuntime(sessions, selection)
        setStorageError('')
      })
      .catch((error) => {
        setStorageError(error instanceof ApiError ? error.message : '全局 Agent 会话保存失败。')
        throw error
      })
    agentRuntimeSaveQueueRef.current = operation.catch(() => undefined)
  }, [])

  useEffect(() => () => {
    for (const controller of generationControllersRef.current.values()) controller.abort()
    generationControllersRef.current.clear()
  }, [])

  useEffect(() => {
    let active = true
    listModelProfiles()
      .then((result) => {
        if (!active) return
        setProfiles(result.profiles)
        setProfilesError(false)
        setActiveProfileId((current) =>
          result.profiles.some((profile) => profile.id === current)
            ? current
            : result.profiles[0]?.id ?? null,
        )
      })
      .catch(() => {
        if (active) setProfilesError(true)
      })
    return () => {
      active = false
    }
  }, [])

  const generateNodeOpening = useCallback(async (node: ConversationFlowNode) => {
    const currentNode = nodesRef.current.find((candidate) => candidate.id === node.id)
    if (
      !currentNode?.data.agentOpeningPrompt
      || currentNode.data.messages.length
      || pendingNodeIdsRef.current.has(node.id)
    ) return
    if (!activeProfileId) {
      setErrorsByNode((current) => ({
        ...current,
        [node.id]: '请先选择模型配置，再由老师开始本节点的引导。',
      }))
      return
    }
    const requestKey = `${activeCanvasId}:${node.id}`
    const openingRequests = pageNodeOpeningRequests()
    let openingRequest = openingRequests.get(requestKey)
    if (!openingRequest) {
      openingRequest = createModelResponse({
        profileId: activeProfileId,
        messages: modelMessagesForNode(currentNode.data, currentNode.data.messages),
      })
      openingRequests.set(requestKey, openingRequest)
    }
    pendingNodeIdsRef.current = new Set(pendingNodeIdsRef.current).add(node.id)
    setPendingNodeIds((current) => new Set(current).add(node.id))
    setErrorsByNode((current) => {
      const next = { ...current }
      delete next[node.id]
      return next
    })
    try {
      const result = await openingRequest
      const latestNode = nodesRef.current.find((candidate) => candidate.id === node.id)
      if (latestNode && !latestNode.data.messages.length) {
        const nextNodes = nodesRef.current.map((candidate) => candidate.id === node.id
          ? {
              ...candidate,
              data: {
                ...candidate.data,
                messages: [{ id: crypto.randomUUID(), ...result.message }],
              },
            }
          : candidate)
        nodesRef.current = nextNodes
        setNodes(nextNodes)
        bumpWorkspaceRevision()
      }
    } catch (error) {
      const latestNode = nodesRef.current.find((candidate) => candidate.id === node.id)
      if (latestNode && !latestNode.data.messages.length) {
        setErrorsByNode((current) => ({
          ...current,
          [node.id]: error instanceof ApiError ? error.message : '生成节点开场讲解时发生了未预期错误。',
        }))
      }
    } finally {
      if (openingRequests.get(requestKey) === openingRequest) openingRequests.delete(requestKey)
      pendingNodeIdsRef.current = new Set(pendingNodeIdsRef.current)
      pendingNodeIdsRef.current.delete(node.id)
      setPendingNodeIds((current) => {
        const next = new Set(current)
        next.delete(node.id)
        return next
      })
    }
  }, [activeCanvasId, activeProfileId, bumpWorkspaceRevision, setNodes])

  useEffect(() => {
    const root = nodes.find((node) => !node.data.parentId)
    if (
      !root
      || !root.data.expanded
      || !root.data.agentOpeningPrompt
      || root.data.messages.length
      || pendingNodeIdsRef.current.has(root.id)
    ) return
    void generateNodeOpening(root)
  }, [activeCanvasId, activeProfileId, generateNodeOpening, nodes])

  const revealNodesInViewport = useCallback((nodeIds: string[]) => {
    const revealIds = [...new Set(nodeIds)]
    if (!revealIds.length) return
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const mapArea = mapAreaRef.current
        if (!mapArea) return
        const bounds = getNodesBounds(revealIds)
        if (!Number.isFinite(bounds.x) || !Number.isFinite(bounds.y) || bounds.width <= 0 || bounds.height <= 0) return

        const viewport = getViewport()
        const area = mapArea.getBoundingClientRect()
        const safeArea = { top: 72, right: 28, bottom: 28, left: 28 }
        const availableWidth = Math.max(1, area.width - safeArea.left - safeArea.right)
        const availableHeight = Math.max(1, area.height - safeArea.top - safeArea.bottom)
        const renderedWidth = bounds.width * viewport.zoom
        const renderedHeight = bounds.height * viewport.zoom
        const duration = canvasMotionDuration()

        if (renderedWidth > availableWidth || renderedHeight > availableHeight) {
          void fitView({
            nodes: revealIds.map((id) => ({ id })),
            padding: 0.16,
            maxZoom: viewport.zoom,
            duration,
          })
          return
        }

        const screenLeft = bounds.x * viewport.zoom + viewport.x
        const screenRight = (bounds.x + bounds.width) * viewport.zoom + viewport.x
        const screenTop = bounds.y * viewport.zoom + viewport.y
        const screenBottom = (bounds.y + bounds.height) * viewport.zoom + viewport.y
        let deltaX = 0
        let deltaY = 0
        if (screenLeft < safeArea.left) deltaX = safeArea.left - screenLeft
        else if (screenRight > area.width - safeArea.right) deltaX = area.width - safeArea.right - screenRight
        if (screenTop < safeArea.top) deltaY = safeArea.top - screenTop
        else if (screenBottom > area.height - safeArea.bottom) deltaY = area.height - safeArea.bottom - screenBottom
        if (Math.abs(deltaX) < 1 && Math.abs(deltaY) < 1) return
        void setViewport({
          x: viewport.x + deltaX,
          y: viewport.y + deltaY,
          zoom: viewport.zoom,
        }, {
          duration,
          ease: (progress) => 1 - (1 - progress) ** 3,
        })
      })
    })
  }, [fitView, getNodesBounds, getViewport, setViewport])

  const toggleExpanded = useCallback((nodeId: string) => {
    const node = nodesRef.current.find((candidate) => candidate.id === nodeId)
    if (!node) return
    if (treeOverviewOpen) {
      const byId = new Map(nodesRef.current.map((candidate) => [candidate.id, candidate]))
      const branchIds = new Set<string>([nodeId])
      let ancestor = node.data.parentId ? byId.get(node.data.parentId) : undefined
      while (ancestor && !branchIds.has(ancestor.id)) {
        branchIds.add(ancestor.id)
        ancestor = ancestor.data.parentId ? byId.get(ancestor.data.parentId) : undefined
      }
      const changed = nodesRef.current.some((candidate) => branchIds.has(candidate.id) && !candidate.data.expanded)
      if (changed) {
        setNodes((current) => current.map((candidate) => branchIds.has(candidate.id)
          ? { ...candidate, data: { ...candidate.data, expanded: true } }
          : candidate))
        bumpWorkspaceRevision()
      }
      setTreeOverviewOpen(false)
      if (!node.data.expanded && !node.data.messages.length && node.data.agentOpeningPrompt) {
        void generateNodeOpening(node)
      }
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => void fitView({ padding: 0.18, duration: canvasMotionDuration() }))
      })
      return
    }
    const opening = !node.data.expanded
    const shouldGenerateOpening = opening
      && !node.data.messages.length
      && Boolean(node.data.agentOpeningPrompt)
    setNodes((current) => current.map((node) =>
      node.id === nodeId ? { ...node, data: { ...node.data, expanded: !node.data.expanded } } : node,
    ))
    bumpWorkspaceRevision()
    if (shouldGenerateOpening) void generateNodeOpening(node)
    if (opening) {
      revealNodesInViewport([
        nodeId,
        ...nodesRef.current
          .filter((candidate) => candidate.data.parentId === nodeId)
          .map((candidate) => candidate.id),
      ])
    }
  }, [bumpWorkspaceRevision, fitView, generateNodeOpening, revealNodesInViewport, setNodes, treeOverviewOpen])

  const resizeNode = useCallback((nodeId: string, deltaY: number, commit = false) => {
    if (deltaY) {
      let nextPosition: ConversationFlowNode['position'] | null = null
      const nextNodes = nodesRef.current.map((node) => {
        if (node.id !== nodeId) return node
        nextPosition = { ...node.position, y: node.position.y + deltaY }
        return { ...node, position: nextPosition }
      })
      nodesRef.current = nextNodes
      setNodes(nextNodes)
      if (nextPosition) updateNode(nodeId, { position: nextPosition })
    }
    if (commit) bumpWorkspaceRevision()
  }, [bumpWorkspaceRevision, setNodes, updateNode])

  const openConversation = useCallback((nodeId: string) => {
    if (!nodesRef.current.some((node) => node.id === nodeId)) return
    setFocusedNodeId(nodeId)
    writeFocusedConversationUrl('push', nodeId, activeCanvasIdRef.current)
  }, [])

  const closeFocusedConversation = useCallback(() => {
    if (window.history.state?.braceMapConversation === focusedNodeId) {
      window.history.back()
      return
    }
    setFocusedNodeId(null)
    writeFocusedConversationUrl('replace')
  }, [focusedNodeId])

  useEffect(() => {
    const handleHistoryChange = () => setFocusedNodeId(focusedNodeIdFromUrl())
    window.addEventListener('popstate', handleHistoryChange)
    return () => window.removeEventListener('popstate', handleHistoryChange)
  }, [])

  useEffect(() => {
    if (!focusedNodeId || focusedNode) return
    setFocusedNodeId(null)
    writeFocusedConversationUrl('replace')
  }, [focusedNode, focusedNodeId])

  const updateTitle = useCallback((nodeId: string, title: string) => {
    setNodes((current) => current.map((node) =>
      node.id === nodeId ? { ...node, data: { ...node.data, title } } : node,
    ))
    bumpWorkspaceRevision()
  }, [bumpWorkspaceRevision, setNodes])

  const updateNote = useCallback((nodeId: string, note: string) => {
    setNodes((current) => current.map((node) =>
      node.id === nodeId ? { ...node, data: { ...node.data, note } } : node,
    ))
    bumpWorkspaceRevision()
  }, [bumpWorkspaceRevision, setNodes])

  const updateBrief = useCallback((nodeId: string, brief: string) => {
    setNodes((current) => current.map((node) => node.id === nodeId
      ? { ...node, data: { ...node.data, brief } }
      : node))
    bumpWorkspaceRevision()
  }, [bumpWorkspaceRevision, setNodes])

  const updateKnowledgeField = useCallback((
    nodeId: string,
    field: 'mastered' | 'keyPoints' | 'unresolvedQuestions' | 'nextRecommendations',
    values: string[],
  ) => {
    setNodes((current) => current.map((node) => {
      if (node.id !== nodeId) return node
      const knowledge: NodeKnowledgeSummary = node.data.knowledge ?? {
        topic: node.data.brief?.trim() || node.data.title,
        mastered: [],
        keyPoints: [],
        unresolvedQuestions: [],
        nextRecommendations: [],
        sourceMessageIds: [],
        stale: false,
      }
      return {
        ...node,
        data: {
          ...node.data,
          knowledge: {
            ...knowledge,
            [field]: values,
            updatedAt: new Date().toISOString(),
            updatedBy: 'user',
            stale: false,
          },
        },
      }
    }))
    bumpWorkspaceRevision()
  }, [bumpWorkspaceRevision, setNodes])

  const generateNodeSummary = useCallback(async (nodeId: string) => {
    const node = nodesRef.current.find((candidate) => candidate.id === nodeId)
    if (!node || pendingNodeIdsRef.current.has(nodeId)) return
    if (!node.data.messages.length) {
      setErrorsByNode((current) => ({ ...current, [nodeId]: '当前节点还没有可总结的会话。' }))
      return
    }
    if (!activeProfileId) {
      setErrorsByNode((current) => ({ ...current, [nodeId]: '请先在设置中添加并选择一个模型。' }))
      return
    }
    if (node.data.knowledge && !window.confirm('重新生成会覆盖当前学习摘要。继续吗？')) return

    setPendingNodeIds((current) => new Set(current).add(nodeId))
    setErrorsByNode((current) => {
      const next = { ...current }
      delete next[nodeId]
      return next
    })
    try {
      const result = await createAgentResponse({
        profileId: activeProfileId,
        mode: 'summarize-node',
        node: {
          id: node.id,
          title: node.data.title,
          brief: node.data.brief?.trim() || node.data.title,
          messages: node.data.messages,
        },
      })
      if (!result.summary) throw new Error('missing node summary')
      setNodes((current) => current.map((candidate) => candidate.id === nodeId
        ? {
            ...candidate,
            data: {
              ...candidate.data,
              knowledge: {
                ...result.summary!,
                updatedAt: new Date().toISOString(),
                updatedBy: 'agent',
                stale: false,
              },
            },
          }
        : candidate))
      bumpWorkspaceRevision()
    } catch (summaryError) {
      setErrorsByNode((current) => ({
        ...current,
        [nodeId]: summaryError instanceof ApiError ? summaryError.message : '生成完整节点摘要失败，请稍后重试。',
      }))
    } finally {
      setPendingNodeIds((current) => {
        const next = new Set(current)
        next.delete(nodeId)
        return next
      })
    }
  }, [activeProfileId, bumpWorkspaceRevision, setNodes])

  const updateStatus = useCallback((nodeId: string, status: LearningNodeStatus) => {
    setNodes((current) => current.map((node) => node.id === nodeId
      ? { ...node, data: { ...node.data, status } }
      : node))
    bumpWorkspaceRevision()
  }, [bumpWorkspaceRevision, setNodes])

  const updateMessage = useCallback((nodeId: string, messageId: string, content: string) => {
    const nextContent = content.trim()
    if (!nextContent) return
    setNodes((current) => current.map((node) =>
      node.id === nodeId
        ? {
            ...node,
            data: {
              ...node.data,
              messages: node.data.messages.map((message) =>
                message.id === messageId ? { ...message, content: nextContent } : message,
              ),
              knowledge: node.data.knowledge ? { ...node.data.knowledge, stale: true } : undefined,
            },
          }
        : node,
    ))
    setErrorsByNode((current) => {
      const next = { ...current }
      delete next[nodeId]
      return next
    })
    clearPickedSegments(nodeId)
    bumpWorkspaceRevision()
  }, [bumpWorkspaceRevision, clearPickedSegments, setNodes])

  const deleteMessage = useCallback((nodeId: string, messageId: string) => {
    const node = nodesRef.current.find((candidate) => candidate.id === nodeId)
    const message = node?.data.messages.find((candidate) => candidate.id === messageId)
    if (!node || !message || pendingNodeIdsRef.current.has(nodeId)) return
    const roleName = message.role === 'user' ? '用户消息' : 'AI 消息'
    if (!window.confirm(`删除这条${roleName}？后续提问将不会再把它发送给模型。`)) return
    setNodes((current) => current.map((candidate) =>
      candidate.id === nodeId
        ? {
            ...candidate,
            data: {
              ...candidate.data,
              messages: candidate.data.messages.filter((item) => item.id !== messageId),
              knowledge: candidate.data.knowledge ? { ...candidate.data.knowledge, stale: true } : undefined,
            },
          }
        : candidate,
    ))
    setErrorsByNode((current) => {
      const next = { ...current }
      delete next[nodeId]
      return next
    })
    clearPickedSegments(nodeId)
    bumpWorkspaceRevision()
  }, [bumpWorkspaceRevision, clearPickedSegments, setNodes])

  const stopGeneration = useCallback((nodeId: string) => {
    generationControllersRef.current.get(nodeId)?.abort()
  }, [])

  const runAssistantGeneration = useCallback(async ({
    nodeId,
    assistantMessageId,
    requestMessages,
    replaceExisting,
  }: {
    nodeId: string
    assistantMessageId: string
    requestMessages: ChatMessage[]
    replaceExisting: boolean
  }) => {
    const node = nodesRef.current.find((candidate) => candidate.id === nodeId)
    if (!node || pendingNodeIdsRef.current.has(nodeId)) return
    if (!activeProfileId) {
      setErrorsByNode((current) => ({ ...current, [nodeId]: '请先点击右上角“设置”，添加并选择一个模型配置。' }))
      return
    }

    const originalAssistantMessage = replaceExisting
      ? node.data.messages.find((message) => message.id === assistantMessageId)
      : undefined
    const controller = new AbortController()
    generationControllersRef.current.set(nodeId, controller)
    pendingNodeIdsRef.current = new Set(pendingNodeIdsRef.current).add(nodeId)
    setNodes((current) => current.map((candidate) =>
      candidate.id === nodeId
        ? {
            ...candidate,
            data: {
              ...candidate.data,
              messages: replaceExisting
                ? candidate.data.messages.map((message) => message.id === assistantMessageId
                  ? { id: message.id, role: message.role, content: message.content }
                  : message)
                : requestMessages,
              knowledge: replaceExisting
                ? candidate.data.knowledge
                : candidate.data.knowledge ? { ...candidate.data.knowledge, stale: true } : undefined,
            },
          }
        : candidate,
    ))
    bumpWorkspaceRevision()
    setPendingNodeIds((current) => new Set(current).add(nodeId))
    setStreamingNodeIds((current) => new Set(current).add(nodeId))
    setErrorsByNode((current) => {
      const next = { ...current }
      delete next[nodeId]
      return next
    })

    let bufferedDelta = ''
    let animationFrame: number | null = null
    let replaceOnNextFlush = replaceExisting
    let receivedNewText = false
    const flushDelta = () => {
      if (animationFrame !== null) {
        window.cancelAnimationFrame(animationFrame)
        animationFrame = null
      }
      if (!bufferedDelta) return
      const delta = bufferedDelta
      bufferedDelta = ''
      const replaceContent = replaceOnNextFlush
      replaceOnNextFlush = false
      setNodes((current) => current.map((candidate) => {
        if (candidate.id !== nodeId) return candidate
        const existing = candidate.data.messages.some((message) => message.id === assistantMessageId)
        return {
          ...candidate,
          data: {
            ...candidate.data,
            knowledge: candidate.data.knowledge ? { ...candidate.data.knowledge, stale: true } : undefined,
            messages: existing
              ? candidate.data.messages.map((message) => message.id === assistantMessageId
                ? { ...message, content: replaceContent ? delta : message.content + delta }
                : message)
              : [...candidate.data.messages, { id: assistantMessageId, role: 'assistant', content: delta }],
          },
        }
      }))
    }

    try {
      await streamModelResponse({
        profileId: activeProfileId,
        messages: modelMessagesForNode(node.data, requestMessages),
        sourceQuote: node.data.branchContext ?? node.data.sourceQuote,
      }, {
        signal: controller.signal,
        onDelta: (delta) => {
          if (delta) receivedNewText = true
          bufferedDelta += delta
          if (animationFrame === null) animationFrame = window.requestAnimationFrame(flushDelta)
        },
      })
      flushDelta()
      bumpWorkspaceRevision()
    } catch (error) {
      flushDelta()
      if (controller.signal.aborted) {
        setNodes((current) => current.map((candidate) => {
          if (candidate.id !== nodeId) return candidate
          const existing = candidate.data.messages.find((message) => message.id === assistantMessageId)
          return {
            ...candidate,
            data: {
              ...candidate.data,
              messages: replaceExisting && !receivedNewText && originalAssistantMessage
                ? candidate.data.messages.map((message) => message.id === assistantMessageId
                  ? originalAssistantMessage
                  : message)
                : existing
                ? candidate.data.messages.map((message) => message.id === assistantMessageId
                  ? {
                      ...message,
                      content: message.content || '生成已停止。',
                      generationStatus: 'stopped',
                    }
                  : message)
                : [
                    ...candidate.data.messages,
                    { id: assistantMessageId, role: 'assistant', content: '生成已停止。', generationStatus: 'stopped' },
                  ],
            },
          }
        }))
        bumpWorkspaceRevision()
      } else {
        setNodes((current) => current.map((candidate) => {
          if (candidate.id !== nodeId) return candidate
          const existing = candidate.data.messages.find((message) => message.id === assistantMessageId)
          return {
            ...candidate,
            data: {
              ...candidate.data,
              messages: replaceExisting && !receivedNewText && originalAssistantMessage
                ? candidate.data.messages.map((message) => message.id === assistantMessageId
                  ? originalAssistantMessage
                  : message)
                : existing
                ? candidate.data.messages.map((message) => message.id === assistantMessageId
                  ? message.content
                    ? { ...message, generationStatus: 'incomplete' }
                    : {
                        ...message,
                        content: '回答生成失败，请重试。',
                        generationStatus: 'error',
                      }
                  : message)
                : [
                    ...candidate.data.messages,
                    {
                      id: assistantMessageId,
                      role: 'assistant',
                      content: '回答生成失败，请重试。',
                      generationStatus: 'error',
                    },
                  ],
            },
          }
        }))
        bumpWorkspaceRevision()
        setErrorsByNode((current) => ({
          ...current,
          [nodeId]: error instanceof ApiError ? error.message : '生成回答时发生了未预期错误。',
        }))
      }
    } finally {
      if (animationFrame !== null) window.cancelAnimationFrame(animationFrame)
      if (generationControllersRef.current.get(nodeId) === controller) {
        generationControllersRef.current.delete(nodeId)
        pendingNodeIdsRef.current = new Set(pendingNodeIdsRef.current)
        pendingNodeIdsRef.current.delete(nodeId)
        setPendingNodeIds((current) => {
          const next = new Set(current)
          next.delete(nodeId)
          return next
        })
        setStreamingNodeIds((current) => {
          const next = new Set(current)
          next.delete(nodeId)
          return next
        })
      }
    }
  }, [activeProfileId, bumpWorkspaceRevision, setNodes])

  const sendMessage = useCallback(async (nodeId: string, content: string) => {
    const node = nodesRef.current.find((candidate) => candidate.id === nodeId)
    if (!node || pendingNodeIdsRef.current.has(nodeId)) return
    const userMessage: ChatMessage = { id: crypto.randomUUID(), role: 'user', content }
    await runAssistantGeneration({
      nodeId,
      assistantMessageId: crypto.randomUUID(),
      requestMessages: [...node.data.messages, userMessage],
      replaceExisting: false,
    })
  }, [runAssistantGeneration])

  const regenerateMessage = useCallback(async (nodeId: string, messageId: string) => {
    const node = nodesRef.current.find((candidate) => candidate.id === nodeId)
    if (!node || pendingNodeIdsRef.current.has(nodeId)) return
    const messageIndex = node.data.messages.findIndex((message) => message.id === messageId)
    const message = node.data.messages[messageIndex]
    if (!message || message.role !== 'assistant' || messageIndex !== node.data.messages.length - 1) return

    const requestMessages = node.data.messages.slice(0, messageIndex)
    if (!requestMessages.length && !node.data.agentOpeningPrompt?.trim()) {
      setErrorsByNode((current) => ({ ...current, [nodeId]: '这条回答前没有可复用的问题或节点开场提示，无法重新生成。' }))
      return
    }
    await runAssistantGeneration({
      nodeId,
      assistantMessageId: messageId,
      requestMessages,
      replaceExisting: true,
    })
  }, [runAssistantGeneration])

  const openChildDialog = useCallback((parentId: string) => {
    const excerpts = pickedSegmentsByNode[parentId] ?? []
    if (!excerpts.length) {
      startPicking(parentId)
      return
    }
    setPickingNodeId(null)
    setBranchStep(1)
    setBranchError('')
    setBranchDraft({
      parentId,
      title: '关于摘录原文的追问',
      excerpts: [...excerpts],
      summary: '',
      question: '',
    })
  }, [pickedSegmentsByNode, startPicking])

  const generateBranchSummary = useCallback(async () => {
    if (!branchDraft || generatingSummary) return
    const parent = nodesRef.current.find((node) => node.id === branchDraft.parentId)
    if (!parent) return
    if (!activeProfileId) {
      setBranchError('请先在设置中添加并选择一个模型配置；也可以直接手动填写摘要。')
      return
    }

    const transcript = parent.data.messages
      .map((message) => `${message.role === 'user' ? '用户' : 'AI'}：${message.content}`)
      .join('\n\n')

    setGeneratingSummary(true)
    setBranchError('')
    try {
      const result = await createModelResponse({
        profileId: activeProfileId,
        messages: [{
          role: 'user',
          content: '请通读上方完整节点会话，并写一段简洁、准确的背景摘要，供新的子会话理解父节点整体讨论了什么。必须顾及全文；重要性不取决于出现频率，不能因为某个概念、修正、结论、约束或未解决问题只出现一次就忽略。不要回答新的问题，不要使用标题、列表或 XML 标签，只输出摘要正文。',
        }],
        sourceQuote: transcript,
      })
      setBranchDraft((current) => current && ({ ...current, summary: result.message.content.trim() }))
    } catch (error) {
      setBranchError(error instanceof ApiError ? error.message : '生成摘要时发生了未预期错误。')
    } finally {
      setGeneratingSummary(false)
    }
  }, [activeProfileId, branchDraft, generatingSummary])

  const createChild = useCallback(async (draft: BranchDraft) => {
    const currentNodes = nodesRef.current
    const parent = currentNodes.find((node) => node.id === draft.parentId)
    if (!parent || !draft.summary.trim() || !draft.excerpts.length || !draft.question.trim()) return
    const siblingCount = currentNodes.filter((node) => node.data.parentId === draft.parentId).length
    const childId = crypto.randomUUID()
    const userMessage: ChatMessage = { id: crypto.randomUUID(), role: 'user', content: draft.question.trim() }
    const sourceQuote = draft.excerpts.map((excerpt, index) => `[${index + 1}] ${excerpt.text}`).join('\n\n')
    const branchContext = branchContextFor(draft)
    const child: ConversationFlowNode = {
      id: childId,
      type: 'conversation',
      position: {
        x: parent.position.x + (parent.data.expanded ? 820 : 470),
        y: parent.position.y + siblingCount * 450,
      },
      data: {
        title: draft.title.trim() || '未命名子会话',
        brief: draft.question.trim(),
        parentId: draft.parentId,
        expanded: true,
        messages: [userMessage],
        note: '',
        sourceQuote,
        branchContext,
      },
    }
    setNodes((current) => [...current, child])
    setEdges((currentEdges) => [
      ...currentEdges,
      { id: `${draft.parentId}-${childId}`, source: draft.parentId, target: childId },
    ])
    bumpWorkspaceRevision()
    setBranchDraft(null)
    clearPickedSegments(draft.parentId)
    window.getSelection()?.removeAllRanges()

    if (!activeProfileId) {
      setErrorsByNode((current) => ({ ...current, [childId]: '子节点已创建。请先选择模型配置，再继续发送消息。' }))
      return
    }
    setPendingNodeIds((current) => new Set(current).add(childId))
    try {
      const result = await createModelResponse({
        profileId: activeProfileId,
        messages: [{ role: 'user', content: userMessage.content }],
        sourceQuote: branchContext,
      })
      setNodes((current) => current.map((node) => node.id === childId
        ? {
            ...node,
            data: {
              ...node.data,
              messages: [...node.data.messages, { id: crypto.randomUUID(), ...result.message }],
            },
          }
        : node))
      bumpWorkspaceRevision()
    } catch (error) {
      setErrorsByNode((current) => ({
        ...current,
        [childId]: error instanceof ApiError ? error.message : '生成回答时发生了未预期错误。',
      }))
    } finally {
      setPendingNodeIds((current) => {
        const next = new Set(current)
        next.delete(childId)
        return next
      })
    }
  }, [activeProfileId, bumpWorkspaceRevision, clearPickedSegments, setEdges, setNodes])

  const clearConversation = useCallback((nodeId: string) => {
    const node = nodesRef.current.find((candidate) => candidate.id === nodeId)
    if (!node || !node.data.messages.length) return
    const willRegenerateOpening = Boolean(node.data.agentOpeningPrompt)
    const regenerationNotice = willRegenerateOpening ? ' 清空后，老师会重新生成本节点的开场白。' : ''
    if (!window.confirm(`清空“${node.data.title}”中的全部消息？节点、标题、引用和笔记会保留。${regenerationNotice}`)) return
    const clearedNode = {
      ...node,
      data: {
        ...node.data,
        messages: [],
        knowledge: node.data.knowledge ? { ...node.data.knowledge, stale: true } : undefined,
      },
    }
    const nextNodes = nodesRef.current.map((candidate) => candidate.id === nodeId ? clearedNode : candidate)
    nodesRef.current = nextNodes
    setNodes(nextNodes)
    setErrorsByNode((current) => {
      const next = { ...current }
      delete next[nodeId]
      return next
    })
    clearPickedSegments(nodeId)
    bumpWorkspaceRevision()
    if (willRegenerateOpening) void generateNodeOpening(clearedNode)
  }, [bumpWorkspaceRevision, clearPickedSegments, generateNodeOpening, setNodes])

  const deleteNode = useCallback((nodeId: string) => {
    const currentNodes = nodesRef.current
    const node = currentNodes.find((candidate) => candidate.id === nodeId)
    if (!node) return
    const ids = new Set([nodeId])
    let changed = true
    while (changed) {
      changed = false
      for (const candidate of currentNodes) {
        if (candidate.data.parentId && ids.has(candidate.data.parentId) && !ids.has(candidate.id)) {
          ids.add(candidate.id)
          changed = true
        }
      }
    }
    const descendantCount = ids.size - 1
    const detail = descendantCount
      ? `它下面的 ${descendantCount} 个子孙节点也会一起删除。`
      : '该操作无法撤销。'
    if (!window.confirm(`删除节点“${node.data.title}”？${detail}`)) return

    for (const id of ids) generationControllersRef.current.get(id)?.abort()

    setNodes((current) => current.filter((candidate) => !ids.has(candidate.id)))
    setEdges((current) => current.filter((edge) => !ids.has(edge.source) && !ids.has(edge.target)))
    setPickingNodeId((current) => current && ids.has(current) ? null : current)
    setPickedSegmentsByNode((current) => Object.fromEntries(
      Object.entries(current).filter(([id]) => !ids.has(id)),
    ))
    setBranchDraft((current) => current && ids.has(current.parentId) ? null : current)
    setPendingNodeIds((current) => new Set([...current].filter((id) => !ids.has(id))))
    setErrorsByNode((current) => Object.fromEntries(
      Object.entries(current).filter(([id]) => !ids.has(id)),
    ))
    bumpWorkspaceRevision()
  }, [bumpWorkspaceRevision, setEdges, setNodes])

  const resetCanvasInteraction = useCallback(() => {
    setPickingNodeId(null)
    setPickedSegmentsByNode({})
    setBranchDraft(null)
    setBranchError('')
    setBranchStep(1)
    setErrorsByNode({})
    setTreeOverviewOpen(false)
    setFocusedNodeId(null)
    if (focusedNodeIdFromUrl()) writeFocusedConversationUrl('replace')
  }, [])

  const fitCanvas = useCallback(() => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => void fitView({ padding: 0.18, duration: canvasMotionDuration() }))
    })
  }, [fitView])

  const toggleTreeOverview = useCallback(() => {
    setTreeOverviewOpen((current) => !current)
    fitCanvas()
  }, [fitCanvas])

  const arrangeTree = useCallback(() => {
    const currentLayoutNodes = nodesRef.current.map((node) => ({
      id: node.id,
      parentId: node.data.parentId,
      expanded: node.data.expanded,
      position: node.position,
    }))
    const targetIds = treeOverviewOpen
      ? new Set(currentLayoutNodes.map((node) => node.id))
      : progressiveVisibleNodeIds(currentLayoutNodes)
    const positions = arrangeCanvasTree(currentLayoutNodes, {
      compactAll: treeOverviewOpen,
      visibleIds: targetIds,
    })
    setNodes((current) => current.map((node) => {
      const position = positions.get(node.id)
      return position ? { ...node, position } : node
    }))
    bumpWorkspaceRevision()
    fitCanvas()
  }, [bumpWorkspaceRevision, fitCanvas, setNodes, treeOverviewOpen])

  const importLearningData = useCallback(async (backup: LearningDataBackup) => {
    if (pendingNodeIdsRef.current.size) {
      throw new LearningDataBackupError('请等待当前节点回复完成后再导入备份。')
    }
    cancelScheduledPersist()
    persistenceEpochRef.current += 1
    await Promise.all([
      workspaceSaveQueueRef.current.catch(() => undefined),
      planningSaveQueueRef.current.catch(() => undefined),
      agentRuntimeSaveQueueRef.current.catch(() => undefined),
    ])
    const imported = await importLearningDataToStorage(backup)
    const nextCanvases = imported.state.workspace!.canvases.map((canvas) => normalizeAgentOpenings({
      ...canvas,
      nodes: canvas.nodes as ConversationFlowNode[],
      edges: canvas.edges,
    }))
    const nextActiveCanvasId = imported.state.workspace!.activeCanvasId
    const nextCanvas = nextCanvases.find((canvas) => canvas.id === nextActiveCanvasId) ?? nextCanvases[0]

    canvasesRef.current = nextCanvases
    activeCanvasIdRef.current = nextCanvas.id
    nodesRef.current = nextCanvas.nodes
    edgesRef.current = nextCanvas.edges
    setCanvases(nextCanvases)
    setActiveCanvasId(nextCanvas.id)
    setNodes(nextCanvas.nodes)
    setEdges(nextCanvas.edges)
    loadWorkspaceRevision(nextCanvas.revision)
    workspaceStorageVersionRef.current = imported.storage.workspaceVersion
    workspaceMutationVersionRef.current += 1
    workspaceDirtyRef.current = false
    setCanvasCreationOpen(false)
    setAgentSetupOpen(false)
    setAgentAnalysisOpen(false)
    setPlanningSessions(imported.state.agentPlanningSessions)
    setAgentSessions(imported.state.agentSessions)
    setAgentModelSelection(imported.state.preferences.agentModelSelection)
    setDataImportRevision((current) => current + 1)
    resetCanvasInteraction()
    fitCanvas()
  }, [cancelScheduledPersist, fitCanvas, loadWorkspaceRevision, resetCanvasInteraction, setEdges, setNodes])

  const snapshotImportContextRef = useRef({
    fitCanvas,
    loadWorkspaceRevision,
    resetCanvasInteraction,
    setEdges,
    setNodes,
  })

  useEffect(() => {
    if (snapshotSyncStartedRef.current) return
    snapshotSyncStartedRef.current = true
    const requestMutationVersion = workspaceMutationVersionRef.current
    getPublishedRedisCanvas()
      .then((snapshot) => {
        if (!snapshot || snapshotVersionRef.current === snapshot.version) return
        if (workspaceMutationVersionRef.current !== requestMutationVersion) return
        const context = snapshotImportContextRef.current
        const currentCanvases = canvasesRef.current
        const targetIndex = currentCanvases.findIndex((canvas) => (
          canvas.title.replaceAll(/\s/g, '').toLocaleLowerCase() === 'redis核心数据结构'
          || canvas.learningGoal?.includes('Redis 核心数据结构')
        ))
        const target = targetIndex >= 0 ? currentCanvases[targetIndex] : null
        const replacement = normalizeAgentOpenings({
          ...snapshot.canvas,
          id: target?.id ?? snapshot.canvas.id,
          nodes: snapshot.canvas.nodes as ConversationFlowNode[],
          edges: snapshot.canvas.edges,
        })
        const nextCanvases = targetIndex >= 0
          ? currentCanvases.map((canvas, index) => index === targetIndex ? replacement : canvas)
          : [...currentCanvases, replacement]
        snapshotVersionRef.current = snapshot.version
        void saveStoragePreferences({ redisSnapshotVersion: snapshot.version }).catch(() => undefined)
        setCanvases(nextCanvases)
        canvasesRef.current = nextCanvases
        setActiveCanvasId(replacement.id)
        activeCanvasIdRef.current = replacement.id
        nodesRef.current = replacement.nodes
        edgesRef.current = replacement.edges
        context.setNodes(replacement.nodes)
        context.setEdges(replacement.edges)
        context.loadWorkspaceRevision(replacement.revision)
        markWorkspaceDirty()
        context.resetCanvasInteraction()
        context.fitCanvas()
      })
      .catch(() => {
        // Snapshot sync is optional; the local canvas remains usable when the service is unavailable.
      })
  }, [markWorkspaceDirty])

  const switchCanvas = useCallback((nextCanvasId: string) => {
    if (nextCanvasId === activeCanvasId || pendingNodeIds.size) return
    const target = canvases.find((canvas) => canvas.id === nextCanvasId)
    if (!target) return
    const serializableNodes = nodes.map(({ id, type, position, data }) => ({ id, type, position, data }))
    setCanvases((current) => current.map((canvas) => canvas.id === activeCanvasId
      ? { ...canvas, revision: workspaceRevisionRef.current, nodes: serializableNodes, edges }
      : canvas))
    setActiveCanvasId(target.id)
    setNodes(target.nodes)
    setEdges(target.edges)
    loadWorkspaceRevision(target.revision)
    markWorkspaceDirty()
    resetCanvasInteraction()
    fitCanvas()
  }, [activeCanvasId, canvases, edges, fitCanvas, loadWorkspaceRevision, markWorkspaceDirty, nodes, pendingNodeIds.size, resetCanvasInteraction, setEdges, setNodes])

  const addCanvas = useCallback(() => {
    if (pendingNodeIds.size) return
    setCanvasCreationOpen(true)
  }, [pendingNodeIds.size])

  const activateNewCanvas = useCallback((nextCanvas: CanvasDocument) => {
    const serializableNodes = nodes.map(({ id, type, position, data }) => ({ id, type, position, data }))
    setCanvases((current) => [
      ...current.map((canvas) => canvas.id === activeCanvasId
        ? { ...canvas, revision: workspaceRevisionRef.current, nodes: serializableNodes, edges }
        : canvas),
      nextCanvas,
    ])
    setActiveCanvasId(nextCanvas.id)
    setNodes(nextCanvas.nodes)
    setEdges(nextCanvas.edges)
    loadWorkspaceRevision(nextCanvas.revision)
    markWorkspaceDirty()
    setAgentAnalysisOpen(false)
    resetCanvasInteraction()
    fitCanvas()
  }, [activeCanvasId, edges, fitCanvas, loadWorkspaceRevision, markWorkspaceDirty, nodes, resetCanvasInteraction, setEdges, setNodes])

  const createManualCanvas = useCallback(() => {
    if (pendingNodeIds.size) return
    activateNewCanvas(createCanvasDocument('新的学习主题'))
    setCanvasCreationOpen(false)
  }, [activateNewCanvas, pendingNodeIds.size])

  const openAgentPlanningSession = useCallback((sessionId: string) => {
    setPlanningSessions((current) => {
      const next = { ...current, activeSessionId: sessionId }
      persistPlanningSessions(next)
      return next
    })
    setCanvasCreationOpen(false)
    setAgentSetupOpen(true)
  }, [persistPlanningSessions])

  const startNewAgentSetup = useCallback(() => {
    const session = createAgentPlanningSession()
    setPlanningSessions((current) => {
      const next = {
        version: 1 as const,
        sessions: [...current.sessions, session],
        activeSessionId: session.id,
      }
      persistPlanningSessions(next)
      return next
    })
    setCanvasCreationOpen(false)
    setAgentSetupOpen(true)
  }, [persistPlanningSessions])

  const updateAgentPlanningSession = useCallback((session: AgentPlanningSession) => {
    setPlanningSessions((current) => {
      if (!current.sessions.some((item) => item.id === session.id)) return current
      const next = {
        ...current,
        sessions: current.sessions.map((item) => item.id === session.id ? session : item),
      }
      persistPlanningSessions(next)
      return next
    })
  }, [persistPlanningSessions])

  const renameAgentPlanningSession = useCallback((sessionId: string) => {
    const session = planningSessions.sessions.find((item) => item.id === sessionId)
    if (!session) return
    const requested = window.prompt('重命名 Agent 规划会话', session.title)
    const title = requested?.trim()
    if (!title || title === session.title) return
    updateAgentPlanningSession({ ...session, title: title.slice(0, 80), updatedAt: new Date().toISOString() })
  }, [planningSessions.sessions, updateAgentPlanningSession])

  const deleteAgentPlanningSession = useCallback((sessionId: string) => {
    const session = planningSessions.sessions.find((item) => item.id === sessionId)
    if (!session) return
    const warning = session.adoptedCanvasId
      ? `删除规划会话“${session.title}”？关联画布不会被删除，但这份规划对话将无法恢复。`
      : `删除未完成的规划会话“${session.title}”？其中的对话和结构将无法恢复。`
    if (!window.confirm(warning)) return
    setPlanningSessions((current) => {
      const sessions = current.sessions.filter((item) => item.id !== sessionId)
      const next = {
        ...current,
        sessions,
        activeSessionId: current.activeSessionId === sessionId ? null : current.activeSessionId,
      }
      persistPlanningSessionDeletion(sessionId)
      return next
    })
  }, [persistPlanningSessionDeletion, planningSessions.sessions])

  const createCanvasFromAgentPlan = useCallback(async (plan: AgentTreePlan, sessionId: string) => {
    if (pendingNodeIds.size) return
    const nextCanvas = createCanvasFromPlan(plan)
    setPlanningSessions((current) => {
      const next = {
        ...current,
        sessions: current.sessions.map((session) => session.id === sessionId
          ? { ...session, adoptedCanvasId: nextCanvas.id, updatedAt: new Date().toISOString() }
          : session),
        activeSessionId: sessionId,
      }
      persistPlanningSessions(next)
      return next
    })
    activateNewCanvas(nextCanvas)
    setAgentSetupOpen(false)

    const rootNode = nextCanvas.nodes.find((node) => !node.data.parentId)
    if (rootNode) await generateNodeOpening(rootNode)
  }, [activateNewCanvas, generateNodeOpening, pendingNodeIds.size, persistPlanningSessions])

  const openCanvasFromPlanningSession = useCallback((canvasId: string) => {
    if (canvasId === activeCanvasId) {
      setCanvasCreationOpen(false)
      return
    }
    switchCanvas(canvasId)
    setCanvasCreationOpen(false)
  }, [activeCanvasId, switchCanvas])

  const renameCanvas = useCallback(() => {
    const requestedTitle = window.prompt('重命名画布', activeCanvas.title)
    const title = requestedTitle?.trim()
    if (!title || title === activeCanvas.title) return
    setCanvases((current) => current.map((canvas) => canvas.id === activeCanvasId ? { ...canvas, title } : canvas))
    bumpWorkspaceRevision()
  }, [activeCanvas.title, activeCanvasId, bumpWorkspaceRevision])

  const deleteCanvas = useCallback(() => {
    if (pendingNodeIds.size) return
    if (!window.confirm(`删除画布“${activeCanvas.title}”及其中的全部会话节点？该操作无法撤销。`)) return
    const currentIndex = canvases.findIndex((canvas) => canvas.id === activeCanvasId)
    const remaining = canvases.filter((canvas) => canvas.id !== activeCanvasId)
    const nextCanvases = remaining.length ? remaining : [createCanvasDocument('新的学习主题')]
    const target = nextCanvases[Math.min(currentIndex, nextCanvases.length - 1)]
    const nextAgentSessions = agentSessions.filter((session) => session.canvasId !== activeCanvasId)
    persistAgentRuntime(nextAgentSessions, agentModelSelection)
    setPlanningSessions((current) => {
      const next = {
        ...current,
        sessions: current.sessions.map((session) => {
          if (session.adoptedCanvasId !== activeCanvasId) return session
          const nextSession = { ...session }
          delete nextSession.adoptedCanvasId
          return nextSession
        }),
      }
      persistPlanningSessions(next)
      return next
    })
    setCanvases(nextCanvases)
    setActiveCanvasId(target.id)
    setNodes(target.nodes)
    setEdges(target.edges)
    loadWorkspaceRevision(target.revision)
    markWorkspaceDirty()
    resetCanvasInteraction()
    fitCanvas()
  }, [activeCanvas.title, activeCanvasId, agentModelSelection, agentSessions, canvases, fitCanvas, loadWorkspaceRevision, markWorkspaceDirty, pendingNodeIds.size, persistAgentRuntime, persistPlanningSessions, resetCanvasInteraction, setEdges, setNodes])

  const addRoot = useCallback(() => {
    if (nodes.length) return
    setNodes([createRootNode(activeCanvas.title || '新的学习主题')])
    bumpWorkspaceRevision()
    fitCanvas()
  }, [activeCanvas.title, bumpWorkspaceRevision, fitCanvas, nodes.length, setNodes])

  const applyAgentOperation = useCallback(async (
    operation: AgentOperation,
    expectedRevision: number,
  ): Promise<AgentOperationApplyResult> => {
    if (expectedRevision !== workspaceRevisionRef.current) {
      return {
        ok: false,
        revision: workspaceRevisionRef.current,
        message: '画布在提案后发生了变化。请让 Agent 基于最新工作区重新生成提案。',
      }
    }

    const currentNodes = nodesRef.current
    if (operation.type === 'create-child') {
      const parent = currentNodes.find((node) => node.id === operation.parentId)
      if (!parent) {
        return { ok: false, revision: workspaceRevisionRef.current, message: '父节点已不存在，未创建子节点。' }
      }
      const duplicate = currentNodes.some((node) => (
        node.data.parentId === operation.parentId
        && node.data.title.trim().toLocaleLowerCase() === operation.title.trim().toLocaleLowerCase()
      ))
      if (duplicate) {
        return { ok: false, revision: workspaceRevisionRef.current, message: '同一父节点下已经存在同名节点。' }
      }
      const seedContext = operation.seedContext
      const evidenceMessages = seedContext
        ? seedContext.sourceMessageIds.map((messageId) => parent.data.messages.find((message) => message.id === messageId))
        : []
      if (seedContext && evidenceMessages.some((message) => !message)) {
        return { ok: false, revision: workspaceRevisionRef.current, message: '分支依据中的原消息已不存在，请让 Agent 重新巡检。' }
      }
      const sourceQuote = seedContext
        ? evidenceMessages.map((message, index) => `[${index + 1}] ${message!.role === 'user' ? '用户' : 'AI'}：${message!.content}`).join('\n\n')
        : undefined
      const branchContext = seedContext && sourceQuote
        ? branchContextFromSections(seedContext.summary, sourceQuote, seedContext.question)
        : undefined
      const childId = crypto.randomUUID()
      const siblingCount = currentNodes.filter((node) => node.data.parentId === parent.id).length
      const child: ConversationFlowNode = {
        id: childId,
        type: 'conversation',
        position: {
          x: parent.position.x + (parent.data.expanded ? 820 : 470),
          y: parent.position.y + siblingCount * 450,
        },
        data: {
          title: operation.title,
          brief: operation.brief,
          parentId: parent.id,
          expanded: Boolean(seedContext),
          messages: seedContext
            ? [{ id: crypto.randomUUID(), role: 'user', content: seedContext.question }]
            : [],
          note: '',
          status: 'not-started',
          sourceQuote,
          branchContext,
          agentOpeningPrompt: agentOpeningPromptFor({
            canvasTitle: activeCanvas.title,
            learningGoal: activeCanvas.learningGoal?.trim() || activeCanvas.title,
            targetOutcome: activeCanvas.targetOutcome,
            chapterTitle: operation.title,
            chapterPurpose: operation.brief,
            openingCue: operation.openingPrompt,
          }),
        },
      }
      setNodes((current) => [...current, child])
      setEdges((current) => [...current, {
        id: `${parent.id}-${childId}`,
        source: parent.id,
        target: childId,
      }])
      let revision = bumpWorkspaceRevision()
      if (!activeProfileId) {
        return {
          ok: true,
          revision,
          message: seedContext
            ? '依据原会话的子节点已创建；选择模型配置后可继续教学。'
            : '子节点已创建；选择模型配置后可开始教学。',
        }
      }

      setPendingNodeIds((current) => new Set(current).add(childId))
      try {
        const result = await createModelResponse({
          profileId: activeProfileId,
          messages: modelMessagesForNode(child.data, child.data.messages),
          sourceQuote: child.data.branchContext ?? child.data.sourceQuote,
        })
        setNodes((current) => current.map((node) => node.id === childId
          ? {
              ...node,
              data: {
                ...node.data,
                status: 'learning',
                messages: [...node.data.messages, { id: crypto.randomUUID(), ...result.message }],
              },
            }
          : node))
        revision = bumpWorkspaceRevision()
        return {
          ok: true,
          revision,
          message: seedContext
            ? '依据原会话的子节点已创建，并已围绕分支问题开始教学。'
            : '子节点已创建，老师式开场也已生成。',
        }
      } catch (error) {
        const message = error instanceof ApiError ? error.message : '生成节点开场时发生了未预期错误。'
        setErrorsByNode((current) => ({ ...current, [childId]: message }))
        return { ok: true, revision, message: `子节点已创建，但开场生成失败：${message}` }
      } finally {
        setPendingNodeIds((current) => {
          const next = new Set(current)
          next.delete(childId)
          return next
        })
      }
    }

    const nodeId = operation.nodeId
    if (!currentNodes.some((node) => node.id === nodeId)) {
      return { ok: false, revision: workspaceRevisionRef.current, message: '目标节点已不存在，未应用操作。' }
    }

    setNodes((current) => current.map((node) => {
      if (node.id !== nodeId) return node
      if (operation.type === 'update-brief') {
        return { ...node, data: { ...node.data, brief: operation.brief } }
      }
      if (operation.type === 'set-status') {
        return { ...node, data: { ...node.data, status: operation.status } }
      }
      return { ...node, data: { ...node.data, title: operation.title } }
    }))
    const revision = bumpWorkspaceRevision()
    return { ok: true, revision, message: '操作已应用到当前画布。' }
  }, [activeCanvas.learningGoal, activeCanvas.targetOutcome, activeCanvas.title, activeProfileId, bumpWorkspaceRevision, setEdges, setNodes])

  const actions = useMemo<NodeActions>(() => ({
    toggleExpanded,
    openChildDialog,
    startPicking,
    stopPicking,
    addPickedSegment,
    clearPickedSegments,
    updateTitle,
    updateNote,
    updateBrief,
    updateKnowledgeField,
    generateNodeSummary,
    updateStatus,
    updateMessage,
    deleteMessage,
    sendMessage,
    regenerateMessage,
    stopGeneration,
    clearConversation,
    deleteNode,
    resizeNode,
    openConversation,
    pickingNodeId,
    pickedSegmentsByNode,
    pendingNodeIds,
    streamingNodeIds,
    errorsByNode,
    compactAllNodes: treeOverviewOpen,
  }), [
    clearConversation,
    clearPickedSegments,
    deleteNode,
    errorsByNode,
    openChildDialog,
    pickingNodeId,
    pickedSegmentsByNode,
    pendingNodeIds,
    streamingNodeIds,
    treeOverviewOpen,
    sendMessage,
    regenerateMessage,
    stopGeneration,
    startPicking,
    stopPicking,
    addPickedSegment,
    toggleExpanded,
    updateMessage,
    deleteMessage,
    updateNote,
    updateBrief,
    updateKnowledgeField,
    generateNodeSummary,
    updateStatus,
    updateTitle,
    resizeNode,
    openConversation,
  ])

  const nodeTypes = useMemo(() => ({ conversation: ConversationNode }), [])

  return (
    <NodeActionsContext.Provider value={actions}>
      <main className="app-shell">
        <header className="app-bar" inert={focusedNode ? true : undefined}>
          <div className="brand-mark"><GitBranch size={20} weight="bold" /></div>
          <div className="app-title">
            <h1>Brace Map Chat</h1>
            <span>本地交互原型</span>
          </div>
          <div className="canvas-switcher">
            <span>画布</span>
            <select
              value={activeCanvasId}
              onChange={(event) => switchCanvas(event.target.value)}
              disabled={pendingNodeIds.size > 0}
              aria-label="切换画布"
            >
              {canvases.map((canvas) => <option value={canvas.id} key={canvas.id}>{canvas.title}</option>)}
            </select>
            <button type="button" onClick={renameCanvas} aria-label="重命名当前画布"><PencilSimple size={14} /></button>
            <button type="button" onClick={deleteCanvas} disabled={pendingNodeIds.size > 0} aria-label="删除当前画布"><Trash size={14} /></button>
          </div>
          <div className="app-instructions">
            一个画布对应一个学习主题 · 画布内通过节点继续分支
          </div>
          <button
            className={`agent-toolbar-button ${agentAnalysisOpen ? 'is-active' : ''}`}
            type="button"
            onClick={() => setAgentAnalysisOpen((current) => !current)}
          >
            <Sparkle size={16} weight="fill" /> Agent
          </button>
          <button className="settings-button" type="button" onClick={() => setSettingsOpen(true)}>
            <Gear size={17} weight="bold" /> 设置
          </button>
          <button className="primary-button" type="button" onClick={addCanvas} disabled={pendingNodeIds.size > 0}>
            <Plus size={17} weight="bold" /> 新建画布
          </button>
        </header>

        <section
          ref={mapAreaRef}
          className={`map-area${nodeDragging ? ' is-node-dragging' : ''}`}
          aria-label="会话树画布"
          inert={focusedNode ? true : undefined}
        >
          {nodes.length > 1 && (
            <div className="map-toolbar" aria-label="画布视图工具">
              <button
                className={treeOverviewOpen ? 'is-active' : ''}
                type="button"
                onClick={toggleTreeOverview}
                aria-pressed={treeOverviewOpen}
              >
                <TreeStructure size={15} weight={treeOverviewOpen ? 'fill' : 'regular'} />
                {treeOverviewOpen ? '返回学习视图' : '全树概览'}
              </button>
              <button type="button" onClick={arrangeTree}>
                <Broom size={15} />
                {treeOverviewOpen ? '整理整棵树' : '整理当前分支'}
              </button>
              <span aria-live="polite">
                {treeOverviewOpen ? '概览' : '学习'} · {visibleNodes.length}/{nodes.length} 个节点
              </span>
            </div>
          )}
          <ReactFlow
            nodes={visibleNodes}
            edges={visibleEdges}
            nodeTypes={nodeTypes}
            onNodesChange={handleNodesChange}
            onEdgesChange={handleEdgesChange}
            onNodeDragStart={handleNodeDragStart}
            onNodeDragStop={handleNodeDragStop}
            nodesConnectable={false}
            edgesFocusable={false}
            deleteKeyCode={null}
            minZoom={0.2}
            maxZoom={1.8}
            onlyRenderVisibleElements
            fitView
            fitViewOptions={{ padding: 0.18 }}
            defaultEdgeOptions={{ style: { stroke: '#b9ab98', strokeWidth: 2 } }}
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={24} size={1.2} color="#d8d0c5" />
            <Controls position="bottom-left" showInteractive={false} />
            <MiniMap
              position="bottom-right"
              pannable
              zoomable
              nodeColor={(node) => node.data?.parentId ? '#d79a72' : '#6f7861'}
              maskColor="rgba(241, 237, 229, 0.74)"
            />
          </ReactFlow>

          {!nodes.length && (
            <div className="empty-map" role="status">
              <GitBranch size={28} />
              <h2>这个画布还是空的</h2>
              <p>创建起始节点，继续当前画布的学习主题。</p>
              <button type="button" onClick={addRoot}><Plus size={16} /> 创建起始节点</button>
            </div>
          )}

          <div className={`model-notice ${storageError ? 'is-error' : activeProfile ? 'is-ready' : ''}`} role={storageError ? 'alert' : 'status'}>
            {storageError
              ? `SQLite 保存失败：${storageError}`
              : profilesError
              ? '本地配置服务不可用'
              : activeProfile
                ? `当前模型配置：${activeProfile.name}`
                : '尚未选择模型配置，请打开设置'}
          </div>

          <AgentAnalysisPanel
            key={dataImportRevision}
            open={agentAnalysisOpen}
            canvas={agentCanvasSnapshot}
            profile={activeProfile}
            profiles={profiles}
            onClose={() => setAgentAnalysisOpen(false)}
            onOpenSettings={() => setSettingsOpen(true)}
            onReadNode={readAgentNode}
            onApplyOperation={applyAgentOperation}
            initialSessions={agentSessions}
            initialModelSelection={agentModelSelection}
            onPersistRuntime={persistAgentRuntime}
          />
        </section>

        {focusedNode && (
          <section className="focused-conversation-view" aria-label={`完整会话：${focusedNode.data.title}`}>
            <ConversationContent
              key={focusedNode.id}
              id={focusedNode.id}
              data={focusedNode.data}
              presentation="focus"
              canvasTitle={activeCanvas.title}
              breadcrumbs={focusedBreadcrumbs}
              initialScrollTop={focusedScrollPositionsRef.current.get(focusedNode.id) ?? 0}
              onScrollTopChange={(scrollTop) => focusedScrollPositionsRef.current.set(focusedNode.id, scrollTop)}
              onCloseFocus={closeFocusedConversation}
            />
          </section>
        )}
      </main>

      {settingsOpen && (
        <SettingsDialog
          profiles={profiles}
          activeProfileId={activeProfileId}
          onActiveProfileChange={setActiveProfileId}
          onProfilesChange={setProfiles}
          onBeforeDataExport={persistWorkspace}
          onImportLearningData={importLearningData}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {canvasCreationOpen && (
        <CanvasCreationDialog
          sessions={planningSessions.sessions}
          canvasTitlesById={Object.fromEntries(canvases.map((canvas) => [canvas.id, canvas.title]))}
          onClose={() => setCanvasCreationOpen(false)}
          onManual={createManualCanvas}
          onOpenAgentSession={openAgentPlanningSession}
          onNewAgentSession={startNewAgentSetup}
          onRenameAgentSession={renameAgentPlanningSession}
          onDeleteAgentSession={deleteAgentPlanningSession}
          onOpenCanvas={openCanvasFromPlanningSession}
        />
      )}

      {agentSetupOpen && activePlanningSession && (
        <AgentSetupDialog
          key={activePlanningSession.id}
          session={activePlanningSession}
          profile={activeProfile}
          onClose={() => setAgentSetupOpen(false)}
          onOpenSettings={() => setSettingsOpen(true)}
          onChange={updateAgentPlanningSession}
          onCreate={createCanvasFromAgentPlan}
        />
      )}

      {branchDraft && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setBranchDraft(null)
        }}>
          <form className="branch-dialog" role="dialog" aria-modal="true" aria-labelledby="branch-title" onSubmit={(event) => {
            event.preventDefault()
            if (branchStep === 3) void createChild(branchDraft)
          }}>
            <header>
              <div>
                <GitBranch size={19} weight="bold" />
                <div>
                  <h2 id="branch-title">创建子会话</h2>
                  <p>整理背景摘要、摘录原文和真正想问的问题。</p>
                </div>
              </div>
              <button type="button" onClick={() => setBranchDraft(null)} aria-label="关闭">
                <X size={18} />
              </button>
            </header>
            <nav className="branch-stepper" aria-label="创建步骤">
              {[
                { value: 1, label: '背景摘要' },
                { value: 2, label: '引用原文' },
                { value: 3, label: '用户疑问' },
              ].map((item) => (
                <button
                  className={branchStep === item.value ? 'is-current' : branchStep > item.value ? 'is-done' : ''}
                  type="button"
                  disabled={(item.value >= 2 && !branchDraft.summary.trim()) || (item.value === 3 && !branchDraft.excerpts.length)}
                  onClick={() => setBranchStep(item.value as 1 | 2 | 3)}
                  key={item.value}
                >
                  <i>{branchStep > item.value ? <Check size={11} weight="bold" /> : item.value}</i>
                  <span>{item.label}</span>
                </button>
              ))}
            </nav>

            <div className="branch-dialog-body">
              {branchStep === 1 ? (
                <section className="branch-dialog-step">
                  <div className="branch-step-heading"><span>STEP 01</span><h3>父节点正在讨论什么？</h3></div>
                  <p>摘要始终通读父节点的完整会话，并与个人笔记完全分开。低频但重要的内容也必须保留。</p>
                  <div className="branch-summary-basis">
                    <Sparkle size={15} weight="fill" />
                    <span><b>完整节点</b><small>{nodes.find((node) => node.id === branchDraft.parentId)?.data.messages.length ?? 0} 条消息全部进入摘要材料</small></span>
                  </div>
                  <button className="branch-generate-button" type="button" onClick={() => void generateBranchSummary()} disabled={generatingSummary}>
                    {generatingSummary ? <CircleNotch className="loading-icon" size={15} weight="bold" /> : <MagicWand size={15} weight="fill" />}
                    {generatingSummary ? '正在生成背景摘要…' : branchDraft.summary ? '重新生成摘要' : '生成摘要草稿'}
                  </button>
                  {branchError && <div className="branch-dialog-error" role="alert"><WarningCircle size={15} weight="fill" />{branchError}</div>}
                  <label className="branch-field">
                    <span>父节点背景摘要 <b>可编辑</b></span>
                    <textarea
                      value={branchDraft.summary}
                      onChange={(event) => setBranchDraft((current) => current && ({ ...current, summary: event.target.value }))}
                      placeholder="使用模型生成草稿，或直接手动填写。"
                      autoFocus
                    />
                    <small>{branchDraft.summary.length} 字 · 不会覆盖个人笔记</small>
                  </label>
                  <footer className="branch-step-footer">
                    <button className="secondary-dialog-button" type="button" onClick={() => setBranchDraft(null)}>取消</button>
                    <button className="primary-dialog-button" type="button" disabled={!branchDraft.summary.trim()} onClick={() => setBranchStep(2)}>
                      确认原文 <ArrowRight size={14} />
                    </button>
                  </footer>
                </section>
              ) : branchStep === 2 ? (
                <section className="branch-dialog-step">
                  <div className="branch-step-heading"><span>STEP 02</span><h3>我具体对哪些原文有疑问？</h3></div>
                  <p>原文按照拖拽完成顺序组合，并保持只读。</p>
                  {branchDraft.excerpts.length ? <div className="branch-excerpt-list">
                    {branchDraft.excerpts.map((excerpt, index) => (
                      <article className="branch-excerpt" key={excerpt.id}>
                        <header><i>{index + 1}</i><span>{excerpt.sourceLabel}</span><b>{excerpt.end - excerpt.start + 1} 字</b></header>
                        <p>{excerpt.text}</p>
                        <button
                          type="button"
                          aria-label={`移除第 ${index + 1} 处摘录`}
                          onClick={() => setBranchDraft((current) => {
                            if (!current) return current
                            const excerpts = current.excerpts.filter((item) => item.id !== excerpt.id)
                            return { ...current, excerpts }
                          })}
                        ><X size={13} /></button>
                      </article>
                    ))}
                  </div> : (
                    <div className="branch-excerpt-empty"><Quotes size={22} /><b>当前没有摘录</b><span>返回节点继续拖拽需要引用的原文。</span></div>
                  )}
                  <button className="branch-resume-picking" type="button" onClick={() => {
                    setPickedSegmentsByNode((current) => ({ ...current, [branchDraft.parentId]: branchDraft.excerpts }))
                    setBranchDraft(null)
                    startPicking(branchDraft.parentId)
                  }}><Quotes size={14} weight="fill" /> 继续拖拽摘录</button>
                  <footer className="branch-step-footer">
                    <button className="secondary-dialog-button" type="button" onClick={() => setBranchStep(1)}><ArrowLeft size={14} /> 返回摘要</button>
                    <button className="primary-dialog-button" type="button" disabled={!branchDraft.excerpts.length} onClick={() => setBranchStep(3)}>
                      填写疑问 <ArrowRight size={14} />
                    </button>
                  </footer>
                </section>
              ) : (
                <section className="branch-dialog-step">
                  <div className="branch-step-heading"><span>STEP 03</span><h3>我真正想弄清楚什么？</h3></div>
                  <p>创建后会立即把三段上下文和这个问题发送给当前模型。</p>
                  <label className="branch-field">
                    <span>子会话标题</span>
                    <input value={branchDraft.title} onChange={(event) => setBranchDraft((current) => current && ({ ...current, title: event.target.value }))} required />
                  </label>
                  <label className="branch-field">
                    <span>用户疑问</span>
                    <textarea
                      className="branch-question-field"
                      value={branchDraft.question}
                      onChange={(event) => setBranchDraft((current) => current && ({ ...current, question: event.target.value }))}
                      placeholder="写下你希望在子会话中继续追问的问题。"
                      required
                      autoFocus
                    />
                  </label>
                  <details className="branch-context-preview">
                    <summary><Sparkle size={14} /> 预览最终注入上下文</summary>
                    <pre>{branchContextFor(branchDraft)}</pre>
                  </details>
                  <footer className="branch-step-footer">
                    <button className="secondary-dialog-button" type="button" onClick={() => setBranchStep(2)}><ArrowLeft size={14} /> 返回原文</button>
                    <button className="primary-dialog-button" type="submit" disabled={!branchDraft.title.trim() || !branchDraft.question.trim()}>
                      <GitBranch size={16} /> 创建并提问
                    </button>
                  </footer>
                </section>
              )}
            </div>
          </form>
        </div>
      )}
    </NodeActionsContext.Provider>
  )
}

function App() {
  const [initialStorage, setInitialStorage] = useState<StorageStateResponse | null>(null)
  const [bootstrapError, setBootstrapError] = useState('')
  const [bootstrapErrorCode, setBootstrapErrorCode] = useState('')
  const [bootstrapWarning, setBootstrapWarning] = useState('')
  const [bootstrapRevision, setBootstrapRevision] = useState(0)
  const editorClientIdRef = useRef(crypto.randomUUID())

  useEffect(() => {
    let active = true
    let retryTimer: number | null = null
    const leaseController = new AbortController()
    setBootstrapError('')
    setBootstrapErrorCode('')
    setBootstrapWarning('')
    const retryLease = () => {
      if (retryTimer !== null) window.clearTimeout(retryTimer)
      retryTimer = window.setTimeout(() => {
        if (active) setBootstrapRevision((current) => current + 1)
      }, 1500)
    }
    const reportBootstrapError = (error: unknown) => {
      if (!active) return
      const code = error instanceof ApiError ? error.code : 'BOOTSTRAP_ERROR'
      setBootstrapErrorCode(code)
      setBootstrapError(error instanceof ApiError ? error.message : '无法读取 SQLite 学习数据库。')
      if (code === 'EDITOR_LEASE_HELD' || code === 'EDITOR_LEASE_LOST') retryLease()
    }

    void (async () => {
      const lease = await acquireEditorLease(editorClientIdRef.current, leaseController.signal)
      void lease.closed.catch((error) => {
        if (!active) return
        setInitialStorage(null)
        reportBootstrapError(error)
      })
      let response = await getStorageState()
      try {
        let legacyState: PersistentApplicationState | null = null
        try {
          legacyState = readLegacyBrowserState()
        } catch {
          if (active) setBootstrapWarning('检测到损坏的旧版浏览器数据，已跳过迁移并保留原始数据。SQLite 数据仍可正常使用。')
          legacyState = null
        }
        if (legacyState) {
          response = await migrateBrowserStorage({ state: legacyState })
          clearLegacyBrowserData()
        }
      } catch (error) {
        if (error instanceof ApiError) throw error
        throw new ApiError(0, 'BROWSER_MIGRATION_ERROR', '旧版浏览器数据迁移失败，SQLite 数据未被修改。')
      }
      if (active) setInitialStorage(response)
    })().catch(reportBootstrapError)

    return () => {
      active = false
      leaseController.abort()
      if (retryTimer !== null) window.clearTimeout(retryTimer)
    }
  }, [bootstrapRevision])

  if (!initialStorage) {
    const leaseUnavailable = bootstrapErrorCode === 'EDITOR_LEASE_HELD'
      || bootstrapErrorCode === 'EDITOR_LEASE_LOST'
    return (
      <main className="app-bootstrap" role={bootstrapError ? 'alert' : 'status'}>
        {bootstrapError ? <WarningCircle size={28} weight="fill" /> : <CircleNotch className="loading-icon" size={28} />}
        <h1>{bootstrapError
          ? leaseUnavailable ? '项目已在另一个页面打开' : '学习数据库暂时不可用'
          : '正在取得项目编辑权'}</h1>
        {bootstrapError && (
          <>
            <p>{bootstrapError}</p>
            {leaseUnavailable && <small>本页不会读取或修改工作区；原页面关闭后将自动重试。</small>}
            <button type="button" onClick={() => setBootstrapRevision((current) => current + 1)}>
              {leaseUnavailable ? '立即重试' : '重新连接'}
            </button>
          </>
        )}
      </main>
    )
  }

  return (
    <ReactFlowProvider>
      <MapWorkspace
        initialState={initialStorage.state}
        initialStorageVersion={initialStorage.storage.workspaceVersion}
        initialStorageWarning={bootstrapWarning}
      />
    </ReactFlowProvider>
  )
}

export default App
