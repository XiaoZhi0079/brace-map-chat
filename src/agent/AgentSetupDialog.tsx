import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  ArrowCounterClockwise,
  CircleNotch,
  GitBranch,
  PaperPlaneRight,
  Sparkle,
  WarningCircle,
  X,
} from '@phosphor-icons/react'
import { ApiError, createAgentResponse } from '../chatApi.ts'
import type { AgentTreePlan } from '../shared/agent.ts'
import type { ApiChatMessage, ModelProfileSummary } from '../shared/chat.ts'
import {
  DEFAULT_AGENT_PLANNING_TITLE,
  suggestedAgentPlanningTitle,
  type PendingAgentPlanKind,
  type AgentPlanningSession,
} from './agentPlanningSessions.ts'
import { AgentMessageContent } from './AgentMessageContent.tsx'
import { AgentPlanDraft } from './AgentPlanDraft.tsx'
import { normalizeEditableAgentPlan } from './agentPlan.ts'
import { hasExplicitGenerationIntent } from './agentSetupFlow.ts'

const MANUAL_PLAN_REVIEW_PROMPT = '我已经手动编辑了基础结构。请评价这次修改是否合理，说明覆盖范围、章节边界、学习顺序、拆分粒度和目标匹配度；如果需要调整，请返回一份待我确认的完整调整方案，不要直接假定我已经接受。'

type AgentSetupDialogProps = {
  session: AgentPlanningSession
  profile: ModelProfileSummary | null
  onClose: () => void
  onOpenSettings: () => void
  onChange: (session: AgentPlanningSession) => void
  onCreate: (plan: AgentTreePlan, sessionId: string) => void
}

export function AgentSetupDialog({ session, profile, onClose, onOpenSettings, onChange, onCreate }: AgentSetupDialogProps) {
  const [messages, setMessages] = useState<ApiChatMessage[]>(session.messages)
  const [draft, setDraft] = useState(session.input)
  const [plan, setPlan] = useState<AgentTreePlan | null>(session.plan)
  const [pendingPlan, setPendingPlan] = useState<AgentTreePlan | null>(session.pendingPlan)
  const [pendingPlanKind, setPendingPlanKind] = useState<PendingAgentPlanKind | null>(session.pendingPlanKind)
  const [readyToInitialize, setReadyToInitialize] = useState(session.readyToInitialize)
  const [missingInformation, setMissingInformation] = useState<string[]>(session.missingInformation)
  const [pending, setPending] = useState<'discuss' | 'initialize' | 'revise' | null>(null)
  const [pendingContent, setPendingContent] = useState('')
  const [editingPlan, setEditingPlan] = useState(false)
  const [error, setError] = useState('')
  const sessionSnapshotRef = useRef<AgentPlanningSession>(session)
  const messageListRef = useRef<HTMLDivElement | null>(null)
  const composerRef = useRef<HTMLTextAreaElement | null>(null)
  const requestInFlightRef = useRef(false)
  const requestControllerRef = useRef<AbortController | null>(null)
  const readOnly = Boolean(session.adoptedCanvasId)
  const displayedPlan = pendingPlan ?? plan
  const readyToAdopt = Boolean(plan && !pendingPlan)
  const planStatus: 'ready' | 'agent-proposal' | 'manual-edit' = pendingPlan
    ? pendingPlanKind ?? 'agent-proposal'
    : 'ready'

  const previousSuggestedTitle = suggestedAgentPlanningTitle(session.messages, session.input, session.plan)
  const keepsAutomaticTitle = session.title === DEFAULT_AGENT_PLANNING_TITLE
    || session.title === previousSuggestedTitle
  const nextTitle = keepsAutomaticTitle
    ? suggestedAgentPlanningTitle(messages, draft, plan)
    : session.title
  const hasDraftChanges = nextTitle !== session.title
    || messages !== session.messages
    || draft !== session.input
    || plan !== session.plan
    || pendingPlan !== session.pendingPlan
    || pendingPlanKind !== session.pendingPlanKind
    || readyToInitialize !== session.readyToInitialize
    || missingInformation !== session.missingInformation
    || readyToAdopt !== session.readyToAdopt
  sessionSnapshotRef.current = {
    ...session,
    title: nextTitle,
    messages,
    input: draft,
    plan,
    pendingPlan,
    pendingPlanKind,
    readyToInitialize,
    missingInformation,
    readyToAdopt,
    createdAt: session.createdAt,
    updatedAt: hasDraftChanges ? new Date().toISOString() : session.updatedAt,
  }

  useEffect(() => {
    if (!hasDraftChanges) return
    const timer = window.setTimeout(() => {
      onChange(sessionSnapshotRef.current)
    }, 150)
    return () => window.clearTimeout(timer)
  }, [draft, hasDraftChanges, messages, missingInformation, onChange, pendingPlan, pendingPlanKind, plan, readyToAdopt, readyToInitialize])

  useEffect(() => {
    const persistImmediately = () => {
      if (hasDraftChanges) onChange(sessionSnapshotRef.current)
    }
    window.addEventListener('pagehide', persistImmediately)
    return () => window.removeEventListener('pagehide', persistImmediately)
  }, [hasDraftChanges, onChange])

  useEffect(() => () => {
    requestControllerRef.current?.abort()
    requestControllerRef.current = null
  }, [])

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      messageListRef.current?.scrollTo({
        top: messageListRef.current.scrollHeight,
        behavior: 'smooth',
      })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [messages, pending, pendingContent, plan, pendingPlan, readyToInitialize])

  function resetSetupDraft() {
    if ((messages.length || draft.trim() || plan) && !window.confirm('清除当前 Agent 对话和章节方案，重新开始吗？')) return
    setMessages([])
    setDraft('')
    setPlan(null)
    setPendingPlan(null)
    setPendingPlanKind(null)
    setEditingPlan(false)
    setReadyToInitialize(false)
    setMissingInformation([])
    setError('')
  }

  function closeSetup() {
    requestControllerRef.current?.abort()
    onChange(sessionSnapshotRef.current)
    onClose()
  }

  function adoptPlan(selectedPlan: AgentTreePlan) {
    const normalizedPlan = normalizeEditableAgentPlan(selectedPlan)
    if (!normalizedPlan) {
      setError('请先补全基础结构，并确保章节标题不重复。')
      return
    }
    onChange(sessionSnapshotRef.current)
    onCreate(normalizedPlan, session.id)
  }

  function startEditingPlan() {
    const basePlan = pendingPlan ?? plan
    if (!basePlan) return
    setPendingPlan(structuredClone(basePlan))
    setPendingPlanKind('manual-edit')
    setEditingPlan(true)
    setError('')
  }

  function discardPendingPlan() {
    setPendingPlan(null)
    setPendingPlanKind(null)
    setEditingPlan(false)
    setError('')
  }

  function acceptPendingPlan() {
    if (!pendingPlan) return
    const normalizedPlan = normalizeEditableAgentPlan(pendingPlan)
    if (!normalizedPlan) {
      setError('请先补全调整方案，并确保章节标题不重复。')
      return
    }
    setPlan(normalizedPlan)
    setPendingPlan(null)
    setPendingPlanKind(null)
    setEditingPlan(false)
    setError('')
  }

  function focusAdjustment() {
    composerRef.current?.focus()
  }

  async function sendContent(rawContent: string, options: { restoreDraftOnFailure?: boolean } = {}) {
    const content = rawContent.trim()
    if (!content || !profile || pending || requestInFlightRef.current) return
    const requestPlan = pendingPlan ?? plan
    const currentPlan = requestPlan ? normalizeEditableAgentPlan(requestPlan) : null
    if (requestPlan && !currentPlan) {
      setError('请先补全当前结构，再让 Agent 根据意见修改。')
      return
    }
    const nextMessages = [...messages, { role: 'user' as const, content }]
    setDraft('')
    const hasEarlierPlanningContext = messages.some((message) => (
      message.role === 'user' && !hasExplicitGenerationIntent(message.content)
    ))
    const explicitlyRequestedGeneration = !currentPlan
      && hasExplicitGenerationIntent(content)
      && (readyToInitialize || hasEarlierPlanningContext || content.replace(/\s+/g, '').length >= 8)
    requestInFlightRef.current = true
    const controller = new AbortController()
    requestControllerRef.current = controller
    setPendingContent(content)
    setPending(currentPlan ? 'revise' : 'discuss')
    setError('')
    try {
      const result = currentPlan
        ? await createAgentResponse({
            profileId: profile.id,
            mode: 'revise',
            messages: nextMessages.slice(-30),
            plan: currentPlan,
          }, controller.signal)
        : await createAgentResponse({
            profileId: profile.id,
            mode: 'discuss',
            messages: nextMessages.slice(-30),
          }, controller.signal)
      if (currentPlan) {
        if (!result.plan) throw new Error('missing revised plan')
        setMessages((current) => [
          ...current,
          { role: 'user', content },
          ...(result.message ? [result.message] : []),
        ])
        setPendingPlan(result.plan)
        setPendingPlanKind('agent-proposal')
        setEditingPlan(false)
        setReadyToInitialize(true)
      } else {
        setMessages((current) => [
          ...current,
          { role: 'user', content },
          ...(result.message ? [result.message] : []),
        ])
        const readinessWasReset = result.scopeChanged === true && !explicitlyRequestedGeneration
        setReadyToInitialize((current) => readinessWasReset
          ? result.readyToInitialize === true
          : current || explicitlyRequestedGeneration || result.readyToInitialize === true)
        if (!explicitlyRequestedGeneration && (readinessWasReset || !readyToInitialize) && result.readyToInitialize !== true) {
          setMissingInformation(result.missingInformation ?? [])
        } else {
          setMissingInformation([])
        }
      }
    } catch (requestError) {
      if (controller.signal.aborted) return
      if (options.restoreDraftOnFailure !== false) setDraft(content)
      setError(requestError instanceof ApiError
        ? requestError.message
        : currentPlan
          ? 'Agent 修改基础结构失败，请稍后重试。'
          : 'Agent 对话失败，请稍后重试。')
    } finally {
      if (requestControllerRef.current === controller) {
        requestControllerRef.current = null
        setPending(null)
        setPendingContent('')
        requestInFlightRef.current = false
      }
    }
  }

  function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    void sendContent(draft)
  }

  async function generatePlan() {
    if (!profile || pending || requestInFlightRef.current || (!readyToInitialize && !plan)) return
    requestInFlightRef.current = true
    const controller = new AbortController()
    requestControllerRef.current = controller
    setPending('initialize')
    setError('')
    try {
      const result = await createAgentResponse({
        profileId: profile.id,
        mode: 'initialize',
        messages: messages.slice(-30),
      }, controller.signal)
      if (!result.plan) throw new Error('missing plan')
      setPlan(result.plan)
      setPendingPlan(null)
      setPendingPlanKind(null)
      setEditingPlan(false)
      if (result.message) setMessages((current) => [...current, result.message!])
    } catch (requestError) {
      if (controller.signal.aborted) return
      setError(requestError instanceof ApiError ? requestError.message : '生成结构草稿失败，请重新尝试。')
    } finally {
      if (requestControllerRef.current === controller) {
        requestControllerRef.current = null
        setPending(null)
        requestInFlightRef.current = false
      }
    }
  }

  return (
    <div className="modal-backdrop agent-modal-backdrop" role="presentation">
      <section className="agent-setup-dialog" role="dialog" aria-modal="true" aria-labelledby="agent-setup-title">
        <header className="agent-dialog-header">
          <div>
            <Sparkle size={19} weight="fill" />
            <div>
              <h2 id="agent-setup-title">{readOnly ? session.title : '建立学习主题'}</h2>
              <p>{readOnly ? '已采用的 Agent 规划会话记录' : profile ? `规划模型：${profile.name}` : '需要先选择模型配置'}</p>
            </div>
          </div>
          <button type="button" onClick={closeSetup} aria-label="关闭"><X size={18} /></button>
        </header>

        {!profile && !readOnly ? (
          <div className="agent-profile-required">
            <WarningCircle size={28} weight="fill" />
            <h3>尚未选择模型配置</h3>
            <button type="button" onClick={onOpenSettings}>打开设置</button>
          </div>
        ) : (
          <div className="agent-conversation-view">
            <div className="agent-message-list" ref={messageListRef}>
              {!messages.length && (
                <div className="agent-conversation-empty">
                  <Sparkle size={25} weight="duotone" />
                  <h3>你准备学习什么？</h3>
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
              {pendingContent && (
                <article className="agent-message agent-message--user agent-message--pending-user">
                  <span>你</span><p>{pendingContent}</p>
                </article>
              )}
              {pending === 'discuss' && (
                <article className="agent-message agent-message--assistant agent-message--pending">
                  <span>Agent</span><p><CircleNotch className="loading-icon" size={14} /> 正在梳理</p>
                </article>
              )}
              {!readyToInitialize && !plan && !pending && missingInformation.length > 0 && (
                <section className="agent-missing-information" aria-label="生成结构前还需确认">
                  <b>生成结构草稿前，还需要确认</b>
                  <ul>{missingInformation.map((item) => <li key={item}>{item}</li>)}</ul>
                </section>
              )}
              {readyToInitialize && !plan && (
                <section className="agent-chat-confirm" aria-label="生成结构草稿">
                  <div>
                    <GitBranch size={17} weight="bold" />
                    <div>
                      <b>已准备好生成结构草稿</b>
                      <p>将根据截至目前的讨论创建总目标、整体教学开场、主要章节和必要的二级章节；你也可以继续补充要求。</p>
                    </div>
                  </div>
                  <button
                    className="agent-primary-button"
                    type="button"
                    onClick={() => void generatePlan()}
                    disabled={Boolean(pending)}
                  >
                    {pending === 'initialize'
                      ? <CircleNotch className="loading-icon" size={15} />
                      : <GitBranch size={15} weight="bold" />}
                    生成结构草稿
                  </button>
                </section>
              )}
              {displayedPlan && (
                <AgentPlanDraft
                  plan={displayedPlan}
                  planStatus={planStatus}
                  editing={editingPlan}
                  pending={Boolean(pending)}
                  regenerating={pending === 'initialize'}
                  readOnly={readOnly}
                  onChange={(nextPlan) => {
                    setPendingPlan(nextPlan)
                    setPendingPlanKind('manual-edit')
                  }}
                  onStartEditing={startEditingPlan}
                  onEditingChange={setEditingPlan}
                  onRegenerate={() => {
                    if (!window.confirm('重新生成会替换当前学习结构，继续吗？')) return
                    void generatePlan()
                  }}
                  onFocusAdjustment={focusAdjustment}
                  onRequestManualReview={() => void sendContent(MANUAL_PLAN_REVIEW_PROMPT, { restoreDraftOnFailure: false })}
                  onAcceptProposal={acceptPendingPlan}
                  onDiscardProposal={discardPendingPlan}
                  onAdopt={() => adoptPlan(plan!)}
                />
              )}
              {pending === 'revise' && (
                <article className="agent-message agent-message--assistant agent-message--pending">
                  <span>Agent</span><p><CircleNotch className="loading-icon" size={14} /> 正在评估你的调整</p>
                </article>
              )}
              {error && <div className="agent-error" role="alert"><WarningCircle size={15} />{error}</div>}
            </div>
            {!readOnly && <form className="agent-composer" onSubmit={sendMessage}>
              <textarea
                ref={composerRef}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault()
                    event.currentTarget.form?.requestSubmit()
                  }
                }}
                placeholder={plan
                  ? pendingPlan
                    ? '可以继续说明保留、合并或新增哪些部分'
                    : '如果有异议，可以告诉 Agent 想调整哪些章节或顺序'
                  : readyToInitialize
                    ? '可以继续补充要求，或点击上方按钮生成结构草稿'
                    : '例如：我想系统学习 Redis 数据结构，用于后端项目实践'}
                aria-label="学习主题规划输入"
                disabled={Boolean(pending)}
                autoFocus
              />
              <button type="submit" disabled={!draft.trim() || Boolean(pending)} aria-label="发送给 Agent">
                <PaperPlaneRight size={17} weight="fill" />
              </button>
            </form>}
            <footer className="agent-conversation-footer">
              <div>
                <span>{messages.filter((message) => message.role === 'user').length} 条需求信息</span>
                {!readOnly && (messages.length > 0 || draft.trim() || plan) && (
                  <button type="button" onClick={resetSetupDraft}><ArrowCounterClockwise size={13} /> 重新开始</button>
                )}
              </div>
            </footer>
          </div>
        )}
      </section>
    </div>
  )
}
