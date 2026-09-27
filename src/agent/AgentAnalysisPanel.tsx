import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import {
  Check,
  CircleNotch,
  MagnifyingGlass,
  PaperPlaneRight,
  Plus,
  Sparkle,
  Trash,
  WarningCircle,
  X,
} from '@phosphor-icons/react'
import { ApiError, createAgentResponse, listProfileModels } from '../chatApi.ts'
import type {
  AgentCanvasSnapshot,
  AgentCompletionReason,
  AgentNodeContext,
  AgentOperation,
  AgentOperationApplyResult,
} from '../shared/agent.ts'
import { AgentMessageContent } from './AgentMessageContent.tsx'
import type { ApiChatMessage, ModelListItem, ModelProfileSummary } from '../shared/chat.ts'
import type { AgentSessionBackup, ReviewedOperationBackup } from '../dataBackup.ts'
import type { AgentModelSelection } from '../shared/persistence.ts'

const MAX_AGENT_STEPS = 4

type AgentAnalysisPanelProps = {
  open: boolean
  canvas: AgentCanvasSnapshot
  profile: ModelProfileSummary | null
  profiles: ModelProfileSummary[]
  onClose: () => void
  onOpenSettings: () => void
  onReadNode: (nodeId: string) => AgentNodeContext | null
  onApplyOperation: (operation: AgentOperation, expectedRevision: number) => Promise<AgentOperationApplyResult>
  initialSessions: AgentSessionBackup[]
  initialModelSelection: AgentModelSelection | null
  onPersistRuntime: (sessions: AgentSessionBackup[], modelSelection: AgentModelSelection | null) => void
}

type ReviewedOperation = ReviewedOperationBackup
type AgentSession = AgentSessionBackup

const slashCommands = [
  { name: '/model' as const, description: '切换配置或模型' },
  { name: '/resume' as const, description: '恢复 Agent 会话' },
  { name: '/inspect' as const, description: '巡检一个节点的主题' },
]

function resolveSlashCommand(command: string) {
  const normalized = command.toLocaleLowerCase()
  const matches = slashCommands.filter((item) => item.name.startsWith(normalized))
  return matches.find((item) => item.name === normalized) ?? (matches.length === 1 ? matches[0] : null)
}

const operationLabels: Record<AgentOperation['type'], string> = {
  'create-child': '创建子节点',
  'update-brief': '更新节点简介',
  'set-status': '修改学习状态',
  'rename-node': '重命名节点',
}

const completionLabels: Record<AgentCompletionReason, string> = {
  'goal-complete': '目标已完成',
  'no-action': '当前无需修改',
  'needs-user': '等待你的决定',
}

const supportedOperationTypes = new Set<AgentOperation['type']>([
  'create-child',
  'update-brief',
  'set-status',
  'rename-node',
])

function operationTarget(operation: AgentOperation, canvas: AgentCanvasSnapshot) {
  const targetId = operation.type === 'create-child' ? operation.parentId : operation.nodeId
  return canvas.nodes.find((node) => node.id === targetId)?.title ?? targetId
}

function operationValue(operation: AgentOperation) {
  if (operation.type === 'create-child') {
    const evidence = operation.seedContext ? ` · ${operation.seedContext.sourceMessageIds.length} 条会话依据` : ''
    return `${operation.title} · ${operation.brief}${evidence}`
  }
  if (operation.type === 'update-brief') return operation.brief
  if (operation.type === 'set-status') return operation.status
  return operation.title
}

function sessionTitle(content: string) {
  const title = content.replace(/^\/(model|resume)\b/i, '').trim() || content.trim()
  return title.length > 32 ? `${title.slice(0, 32)}…` : title
}

export function AgentAnalysisPanel({
  open,
  canvas,
  profile,
  profiles,
  onClose,
  onOpenSettings,
  onReadNode,
  onApplyOperation,
  initialSessions,
  initialModelSelection,
  onPersistRuntime,
}: AgentAnalysisPanelProps) {
  const [sessions, setSessions] = useState<AgentSession[]>(() => initialSessions.map((session) => ({
    ...session,
    operations: session.operations.filter((reviewed) => supportedOperationTypes.has(reviewed.operation.type)),
  })))
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ApiChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [operations, setOperations] = useState<ReviewedOperation[]>([])
  const [pending, setPending] = useState(false)
  const [applyingId, setApplyingId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [commandView, setCommandView] = useState<'model' | 'resume' | 'inspect' | null>(null)
  const [inspectionNodeId, setInspectionNodeId] = useState('')
  const [runActivity, setRunActivity] = useState('')
  const [modelSelection, setModelSelection] = useState<AgentModelSelection | null>(initialModelSelection)
  const [modelProfileId, setModelProfileId] = useState('')
  const [availableModels, setAvailableModels] = useState<ModelListItem[]>([])
  const [modelSearch, setModelSearch] = useState('')
  const [manualModel, setManualModel] = useState('')
  const [loadingModels, setLoadingModels] = useState(false)
  const [modelError, setModelError] = useState('')
  const workspaceIdRef = useRef(canvas.id)
  const canvasRef = useRef(canvas)
  const requestInFlightRef = useRef(false)
  const requestControllerRef = useRef<AbortController | null>(null)
  workspaceIdRef.current = canvas.id
  canvasRef.current = canvas

  const selectedProfile = profiles.find((item) => item.id === modelSelection?.profileId)
    ?? profile
    ?? profiles[0]
    ?? null
  const selectedModel = selectedProfile
    ? modelSelection?.profileId === selectedProfile.id && modelSelection.model.trim()
      ? modelSelection.model.trim()
      : selectedProfile.model
    : ''
  const workspaceSessions = useMemo(() => sessions
    .filter((session) => session.canvasId === canvas.id)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)), [canvas.id, sessions])
  const filteredModels = useMemo(() => {
    const query = modelSearch.trim().toLocaleLowerCase()
    return query
      ? availableModels.filter((model) => model.id.toLocaleLowerCase().includes(query))
      : availableModels
  }, [availableModels, modelSearch])

  useEffect(() => {
    onPersistRuntime(sessions.slice(0, 100), modelSelection)
  }, [modelSelection, onPersistRuntime, sessions])

  useEffect(() => {
    if (!profiles.length) return
    if (modelSelection && profiles.some((item) => item.id === modelSelection.profileId)) return
    const fallback = profile ?? profiles[0]
    setModelSelection({ profileId: fallback.id, model: fallback.model })
  }, [modelSelection, profile, profiles])

  useEffect(() => {
    requestControllerRef.current?.abort()
    requestControllerRef.current = null
    requestInFlightRef.current = false
    setActiveSessionId(null)
    setMessages([])
    setDraft('')
    setOperations([])
    setError('')
    setNotice('')
    setPending(false)
    setApplyingId(null)
    setCommandView(null)
    setInspectionNodeId('')
    setRunActivity('')
  }, [canvas.id])

  useEffect(() => {
    if (!open) requestControllerRef.current?.abort()
  }, [open])

  useEffect(() => () => {
    requestControllerRef.current?.abort()
    requestControllerRef.current = null
  }, [])

  useEffect(() => {
    if (!activeSessionId) return
    setSessions((current) => current.map((session) => session.id === activeSessionId
      ? {
          ...session,
          canvasTitle: canvas.title,
          messages,
          operations,
          updatedAt: new Date().toISOString(),
        }
      : session))
  }, [activeSessionId, canvas.title, messages, operations])

  function ensureSession(nextMessages: ApiChatMessage[]) {
    if (activeSessionId) return activeSessionId
    const now = new Date().toISOString()
    const id = crypto.randomUUID()
    const firstUserMessage = nextMessages.find((message) => message.role === 'user')?.content ?? 'Agent 会话'
    setSessions((current) => [{
      id,
      canvasId: canvas.id,
      canvasTitle: canvas.title,
      title: sessionTitle(firstUserMessage),
      messages: nextMessages,
      operations: [],
      createdAt: now,
      updatedAt: now,
    }, ...current].slice(0, 100))
    setActiveSessionId(id)
    return id
  }

  async function loadModels(profileId: string) {
    const target = profiles.find((item) => item.id === profileId)
    if (!target) return
    setModelProfileId(profileId)
    setLoadingModels(true)
    setModelError('')
    setAvailableModels([])
    try {
      const result = await listProfileModels(profileId)
      const models = result.models.some((model) => model.id === target.model)
        ? result.models
        : [{ id: target.model }, ...result.models]
      setAvailableModels(models)
    } catch (requestError) {
      setAvailableModels([{ id: target.model }])
      setModelError(requestError instanceof ApiError ? requestError.message : '拉取模型列表失败。')
    } finally {
      setLoadingModels(false)
    }
  }

  function openModelCommand() {
    const target = selectedProfile ?? profiles[0]
    setCommandView('model')
    setDraft('')
    setNotice('')
    setModelSearch('')
    setManualModel('')
    if (target) void loadModels(target.id)
  }

  function selectModel(profileId: string, model: string) {
    const nextModel = model.trim()
    if (!nextModel) return
    const nextProfile = profiles.find((item) => item.id === profileId)
    if (!nextProfile) return
    setModelSelection({ profileId, model: nextModel })
    setDraft('')
    setNotice(`Agent 模型已切换为 ${nextProfile.name} / ${nextModel}`)
    setCommandView(null)
    setModelError('')
  }

  function openResumeCommand() {
    setCommandView('resume')
    setDraft('')
    setNotice('')
  }

  function openInspectCommand() {
    setCommandView('inspect')
    setDraft('')
    setNotice('')
    setInspectionNodeId((current) => current || canvas.nodes.find((node) => node.messageCount > 0)?.id || canvas.nodes[0]?.id || '')
  }

  function inspectionPrompt(nodeId: string) {
    const node = canvas.nodes.find((candidate) => candidate.id === nodeId)
    if (!node) return ''
    return `请巡检节点“${node.title}”（节点 ID：${node.id}）的主题。先读取该节点的完整会话，再判断实际讨论是否仍服务于节点简介；短暂类比或辅助说明不算偏题。只有出现值得独立多轮学习的新方向时，才提出创建子节点的审核操作。`
  }

  function resumeSession(session: AgentSession) {
    setActiveSessionId(session.id)
    setMessages(session.messages)
    setOperations(session.operations)
    setCommandView(null)
    setError('')
    setNotice(`已恢复“${session.title}”`)
  }

  function startNewSession() {
    setActiveSessionId(null)
    setMessages([])
    setOperations([])
    setDraft('')
    setCommandView(null)
    setError('')
    setNotice('已开始新的 Agent 会话。')
  }

  function deleteSession(sessionId: string) {
    setSessions((current) => current.filter((session) => session.id !== sessionId))
    if (activeSessionId === sessionId) startNewSession()
  }

  async function executeManagement(requestMessages: ApiChatMessage[]) {
    if (!selectedProfile || pending || requestInFlightRef.current) return
    const requestWorkspaceId = canvasRef.current.id
    const observedNodes: AgentNodeContext[] = []
    const controller = new AbortController()
    requestControllerRef.current = controller
    requestInFlightRef.current = true
    setPending(true)
    setError('')
    setNotice('')
    try {
      for (let step = 1; step <= MAX_AGENT_STEPS; step += 1) {
        setRunActivity(step === 1
          ? `第 ${step}/${MAX_AGENT_STEPS} 步：读取知识树摘要`
          : `第 ${step}/${MAX_AGENT_STEPS} 步：分析已读取内容`)
        const result = await createAgentResponse({
          profileId: selectedProfile.id,
          model: selectedModel,
          mode: 'manage',
          messages: requestMessages,
          canvas: canvasRef.current,
          observedNodes,
        }, controller.signal)
        if (workspaceIdRef.current !== requestWorkspaceId) return
        if (!result.management) throw new Error('missing management response')
        const management = result.management
        if (management.next === 'read-node') {
          const request = management.readRequest
          if (!request) throw new Error('missing node read request')
          if (step === MAX_AGENT_STEPS) {
            setNotice(`本轮达到 ${MAX_AGENT_STEPS} 步上限，未继续读取更多节点；可以发送“继续”让 Agent 重新检查最新状态。`)
            return
          }
          if (observedNodes.some((node) => node.id === request.nodeId)) {
            throw new Error('Agent 重复请求了同一个节点。')
          }
          const node = onReadNode(request.nodeId)
          if (!node) throw new Error('Agent 请求的节点已经不存在。')
          observedNodes.push(node)
          setRunActivity(`第 ${step}/${MAX_AGENT_STEPS} 步：读取“${node.title}”完整会话`)
          continue
        }

        setMessages((current) => [...current, { role: 'assistant' as const, content: management.message }].slice(-100))
        if (management.next === 'review') {
          setOperations((current) => [
            ...current,
            ...management.operations.map((operation) => ({
              reviewId: crypto.randomUUID(),
              operation,
              expectedRevision: canvasRef.current.revision,
              status: 'pending' as const,
            })),
          ])
          setNotice('Agent 已暂停，等待你审核操作。')
        } else if (management.completionReason) {
          setNotice(`Agent 已停止：${completionLabels[management.completionReason]}`)
        }
        return
      }
      setNotice(`本轮达到 ${MAX_AGENT_STEPS} 步上限，已停止自动读取；可以继续发送消息让 Agent 基于最新状态处理。`)
    } catch (requestError) {
      if (controller.signal.aborted) return
      if (workspaceIdRef.current !== requestWorkspaceId) return
      setError(requestError instanceof ApiError
        ? requestError.message
        : requestError instanceof Error
          ? requestError.message
          : 'Agent 管理请求失败，请稍后重试。')
    } finally {
      if (requestControllerRef.current === controller) {
        requestControllerRef.current = null
        requestInFlightRef.current = false
        if (workspaceIdRef.current === requestWorkspaceId) {
          setPending(false)
          setRunActivity('')
        }
      }
    }
  }

  async function send(content: string) {
    const nextContent = content.trim()
    if (!nextContent || pending || requestInFlightRef.current) return
    const [command, ...commandArguments] = nextContent.split(/\s+/)
    const resolvedCommand = command.startsWith('/') ? resolveSlashCommand(command) : null
    if (resolvedCommand?.name === '/model') {
      const requestedModel = commandArguments.join(' ').trim()
      if (requestedModel && selectedProfile) selectModel(selectedProfile.id, requestedModel)
      else openModelCommand()
      return
    }
    if (resolvedCommand?.name === '/resume') {
      openResumeCommand()
      return
    }
    if (resolvedCommand?.name === '/inspect') {
      const query = commandArguments.join(' ').trim().toLocaleLowerCase()
      if (!query) {
        openInspectCommand()
        return
      }
      const exact = canvas.nodes.find((node) => node.id.toLocaleLowerCase() === query || node.title.toLocaleLowerCase() === query)
      const matches = exact ? [exact] : canvas.nodes.filter((node) => node.title.toLocaleLowerCase().includes(query))
      if (matches.length !== 1) {
        setError(matches.length ? '匹配到多个节点，请从巡检面板中选择。' : '没有找到匹配的节点。')
        openInspectCommand()
        return
      }
      await send(inspectionPrompt(matches[0].id))
      return
    }
    if (command.startsWith('/')) {
      setError(`未知命令：${command}`)
      return
    }
    if (!selectedProfile) {
      setError('请先添加一个模型配置。')
      return
    }

    const visibleMessages = [...messages, { role: 'user' as const, content: nextContent }].slice(-100)
    const requestMessages = visibleMessages.slice(-30)
    ensureSession(visibleMessages)
    setMessages(visibleMessages)
    setDraft('')
    setCommandView(null)
    await executeManagement(requestMessages)
  }

  function retryInterruptedRequest() {
    if (messages.at(-1)?.role !== 'user' || pending) return
    void executeManagement(messages.slice(-30))
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    void send(draft)
  }

  function continueAfterReview(reviewedOperations: ReviewedOperation[]) {
    const results = reviewedOperations.slice(-5).map((item) => ({
      operationId: item.operation.id,
      operationType: item.operation.type,
      status: item.status,
      result: item.result,
    }))
    const observation: ApiChatMessage = {
      role: 'user',
      content: `<operation_review_results>\n${JSON.stringify(results)}\n</operation_review_results>\n用户已经完成本批操作审核。请读取最新画布，核对执行结果，并继续判断原任务是否完成。`,
    }
    window.setTimeout(() => void executeManagement([...messages, observation].slice(-30)), 0)
  }

  async function applyOperation(reviewed: ReviewedOperation) {
    if (applyingId || reviewed.status !== 'pending') return
    setApplyingId(reviewed.reviewId)
    const result = await onApplyOperation(reviewed.operation, reviewed.expectedRevision)
    const nextOperations: ReviewedOperation[] = operations.map((item) => {
      if (item.reviewId === reviewed.reviewId) {
        return {
          ...item,
          expectedRevision: result.revision,
          status: result.ok ? 'applied' as const : 'error' as const,
          result: result.message,
        }
      }
      return result.ok && item.status === 'pending'
        ? { ...item, expectedRevision: result.revision }
        : item
    })
    setOperations(nextOperations)
    setApplyingId(null)
    if (nextOperations.every((item) => item.status !== 'pending')) continueAfterReview(nextOperations)
  }

  function rejectOperation(reviewId: string) {
    const nextOperations: ReviewedOperation[] = operations.map((item) => item.reviewId === reviewId
      ? { ...item, status: 'rejected' as const, result: '已拒绝，画布未修改。' }
      : item)
    setOperations(nextOperations)
    if (nextOperations.every((item) => item.status !== 'pending')) continueAfterReview(nextOperations)
  }

  const slashQuery = draft.trim()
  const commandSuggestions = slashQuery.startsWith('/') && !/\s/.test(slashQuery)
    ? slashCommands.filter((item) => item.name.startsWith(slashQuery.toLocaleLowerCase()))
    : []

  return (
    <aside className={`agent-analysis-panel ${open ? '' : 'is-hidden'}`} aria-label="全局学习树 Agent" aria-hidden={!open}>
      <header>
        <div>
          <Sparkle size={17} weight="fill" />
          <span>
            <b>学习树 Agent</b>
            <small>{selectedProfile ? `${selectedProfile.name} / ${selectedModel}` : '尚未配置模型'}</small>
          </span>
        </div>
        <button type="button" onClick={onClose} aria-label="关闭 Agent 面板"><X size={17} /></button>
      </header>

      <div className="agent-analysis-body">
        <section className="agent-analysis-goal">
          <span>当前工作区</span>
          <h3>{canvas.title}</h3>
          <p>{canvas.learningGoal}</p>
          <small>{canvas.nodes.length} 个节点 · 版本 {canvas.revision}</small>
        </section>

        {commandView === 'model' && (
          <section className="agent-command-panel agent-model-command">
            <header><div><b>/model</b><span>选择 Agent 使用的模型</span></div><button type="button" onClick={() => setCommandView(null)}><X size={14} /></button></header>
            <label>
              <span>接口配置</span>
              <select value={modelProfileId} onChange={(event) => void loadModels(event.target.value)}>
                {profiles.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}
              </select>
            </label>
            <label>
              <span>筛选模型</span>
              <input value={modelSearch} onChange={(event) => setModelSearch(event.target.value)} placeholder="输入模型 ID" />
            </label>
            <div className="agent-model-list">
              {loadingModels ? (
                <p><CircleNotch className="loading-icon" size={14} /> 正在拉取模型列表</p>
              ) : filteredModels.length ? filteredModels.map((model) => (
                <button
                  className={modelProfileId === selectedProfile?.id && model.id === selectedModel ? 'is-selected' : ''}
                  type="button"
                  onClick={() => selectModel(modelProfileId, model.id)}
                  key={model.id}
                >
                  <span>{model.id}</span>{model.ownedBy && <small>{model.ownedBy}</small>}
                  {modelProfileId === selectedProfile?.id && model.id === selectedModel && <Check size={13} />}
                </button>
              )) : <p>没有匹配的模型。</p>}
            </div>
            {modelError && <div className="agent-command-error"><WarningCircle size={13} />{modelError}</div>}
            <form className="agent-manual-model" onSubmit={(event) => {
              event.preventDefault()
              selectModel(modelProfileId, manualModel)
            }}>
              <input value={manualModel} onChange={(event) => setManualModel(event.target.value)} placeholder="或手动填写模型 ID" />
              <button type="submit" disabled={!manualModel.trim()}>使用</button>
            </form>
          </section>
        )}

        {commandView === 'resume' && (
          <section className="agent-command-panel agent-resume-command">
            <header><div><b>/resume</b><span>恢复当前工作区的 Agent 会话</span></div><button type="button" onClick={() => setCommandView(null)}><X size={14} /></button></header>
            <button className="agent-new-session" type="button" onClick={startNewSession}><Plus size={14} /> 新建会话</button>
            <div className="agent-session-list">
              {workspaceSessions.length ? workspaceSessions.map((session) => (
                <article className={session.id === activeSessionId ? 'is-active' : ''} key={session.id}>
                  <button type="button" onClick={() => resumeSession(session)}>
                    <b>{session.title}</b>
                    <span>{session.messages.length} 条消息 · {new Date(session.updatedAt).toLocaleString()}</span>
                  </button>
                  <button type="button" onClick={() => deleteSession(session.id)} aria-label={`删除 Agent 会话：${session.title}`}><Trash size={13} /></button>
                </article>
              )) : <p>当前工作区还没有可恢复的 Agent 会话。</p>}
            </div>
          </section>
        )}

        {commandView === 'inspect' && (
          <section className="agent-command-panel agent-inspect-command">
            <header><div><b>/inspect</b><span>由全局 Agent 巡检一个节点</span></div><button type="button" onClick={() => setCommandView(null)}><X size={14} /></button></header>
            <label>
              <span>目标节点</span>
              <select value={inspectionNodeId} onChange={(event) => setInspectionNodeId(event.target.value)}>
                {canvas.nodes.map((node) => (
                  <option value={node.id} key={node.id}>{node.title} · {node.messageCount} 条消息</option>
                ))}
              </select>
            </label>
            <p>巡检只读取所选节点的完整会话；短暂延伸不会被当成偏题，创建分支仍需你审核。</p>
            <button
              className="agent-new-session"
              type="button"
              disabled={!inspectionNodeId || pending}
              onClick={() => {
                const prompt = inspectionPrompt(inspectionNodeId)
                if (prompt) void send(prompt)
              }}
            >
              <MagnifyingGlass size={14} /> 开始巡检
            </button>
          </section>
        )}

        {!selectedProfile ? (
          <div className="agent-analysis-empty">
            <WarningCircle size={24} />
            <p>需要先选择模型配置。</p>
            <button type="button" onClick={onOpenSettings}>打开设置</button>
          </div>
        ) : (
          <>
            <div className="agent-management-messages" aria-live="polite">
              {!messages.length && !commandView && (
                <div className="agent-management-empty">
                  <Sparkle size={24} weight="duotone" />
                  <p>我会先读取当前画布的结构、节点简介和学习摘要。</p>
                  <button type="button" onClick={() => void send('请分析当前学习树，告诉我下一步最值得做什么；没有必要时不要提出结构修改。')}>
                    分析当前学习树
                  </button>
                  <button type="button" onClick={openInspectCommand}>
                    巡检一个节点
                  </button>
                </div>
              )}
              {messages.map((message, index) => (
                <article className={`agent-message agent-message--${message.role}`} key={`${message.role}-${index}`}>
                  <span>{message.role === 'user' ? '你' : 'Agent'}</span>
                  {message.role === 'assistant'
                    ? <AgentMessageContent content={message.content} />
                    : <p>{message.content}</p>}
                </article>
              ))}
              {pending && (
                <article className="agent-message agent-message--assistant agent-message--pending">
                  <span>Agent</span><p><CircleNotch className="loading-icon" size={14} /> {runActivity || '正在处理当前任务'}</p>
                </article>
              )}
              {!pending && messages.at(-1)?.role === 'user' && (
                <button className="agent-retry-run" type="button" onClick={retryInterruptedRequest}>
                  重新执行这条未完成请求
                </button>
              )}
            </div>

            {operations.length > 0 && (
              <section className="agent-operation-list">
                <header><span>待审核操作</span><b>{operations.filter((item) => item.status === 'pending').length}</b></header>
                {operations.map((reviewed) => {
                  const seed = reviewed.operation.type === 'create-child' ? reviewed.operation.seedContext : undefined
                  const sourceNode = seed ? onReadNode(reviewed.operation.type === 'create-child' ? reviewed.operation.parentId : '') : null
                  const evidence = seed
                    ? seed.sourceMessageIds.map((id) => sourceNode?.messages.find((message) => message.id === id)).filter(Boolean)
                    : []
                  return (
                    <article className={`agent-operation agent-operation--${reviewed.status}`} key={reviewed.reviewId}>
                    <div>
                      <span>{operationLabels[reviewed.operation.type]}</span>
                      <small>目标：{operationTarget(reviewed.operation, canvas)}</small>
                    </div>
                    <strong>{operationValue(reviewed.operation)}</strong>
                    <p>{reviewed.operation.reason}</p>
                    {seed && (
                      <details className="agent-operation-evidence">
                        <summary>查看分支依据与起始问题</summary>
                        <b>必要背景</b>
                        <p>{seed.summary}</p>
                        <b>原会话依据</b>
                        {evidence.map((message) => message && (
                          <blockquote key={message.id}>{message.role === 'user' ? '用户' : 'AI'}：{message.content}</blockquote>
                        ))}
                        <b>分支问题</b>
                        <p>{seed.question}</p>
                      </details>
                    )}
                    {reviewed.result && <em>{reviewed.result}</em>}
                    {reviewed.status === 'pending' && (
                      <footer>
                        <button type="button" onClick={() => rejectOperation(reviewed.reviewId)} disabled={Boolean(applyingId)}>拒绝</button>
                        <button type="button" onClick={() => void applyOperation(reviewed)} disabled={Boolean(applyingId)}>
                          {applyingId === reviewed.reviewId
                            ? <CircleNotch className="loading-icon" size={12} />
                            : <Check size={12} weight="bold" />}
                          应用
                        </button>
                      </footer>
                    )}
                    </article>
                  )
                })}
              </section>
            )}
          </>
        )}
        {notice && <div className="agent-command-notice"><Check size={13} />{notice}</div>}
        {error && <div className="agent-error agent-management-error" role="alert"><WarningCircle size={15} />{error}</div>}
      </div>

      {selectedProfile && (
        <div className="agent-command-composer">
          {commandSuggestions.length > 0 && (
            <div className="agent-slash-menu">
              {commandSuggestions.map((command) => (
                <button
                  type="button"
                  onClick={command.name === '/model'
                    ? openModelCommand
                    : command.name === '/resume'
                      ? openResumeCommand
                      : openInspectCommand}
                  key={command.name}
                >
                  <b>{command.name}</b><span>{command.description}</span>
                </button>
              ))}
            </div>
          )}
          <form className="agent-management-composer" onSubmit={submit}>
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  event.currentTarget.form?.requestSubmit()
                }
              }}
              placeholder="输入消息，或使用 /model、/resume、/inspect"
              disabled={pending}
            />
            <button type="submit" disabled={!draft.trim() || pending} aria-label="发送给 Agent">
              {pending ? <CircleNotch className="loading-icon" size={16} /> : <PaperPlaneRight size={16} weight="fill" />}
            </button>
          </form>
        </div>
      )}
    </aside>
  )
}
