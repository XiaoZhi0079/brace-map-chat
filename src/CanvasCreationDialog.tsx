import {
  ArrowLeft,
  ArrowRight,
  GitBranch,
  PencilSimple,
  Plus,
  Sparkle,
  Trash,
  X,
} from '@phosphor-icons/react'
import { useState } from 'react'
import {
  sortAgentPlanningSessions,
  type AgentPlanningSession,
} from './agent/agentPlanningSessions.ts'

type CanvasCreationDialogProps = {
  sessions: AgentPlanningSession[]
  canvasTitlesById: Record<string, string>
  onClose: () => void
  onManual: () => void
  onOpenAgentSession: (sessionId: string) => void
  onNewAgentSession: () => void
  onRenameAgentSession: (sessionId: string) => void
  onDeleteAgentSession: (sessionId: string) => void
  onOpenCanvas: (canvasId: string) => void
}

function compactText(value: string, maxLength: number) {
  const compact = value.replace(/\s+/g, ' ').trim()
  return compact.length > maxLength ? `${compact.slice(0, maxLength)}…` : compact
}

function sessionPreview(session: AgentPlanningSession) {
  const userMessages = session.messages.filter((message) => message.role === 'user')
  const latestUserMessage = userMessages.at(-1)?.content ?? session.input
  const excerpt = session.plan?.learningGoal
    ?? (compactText(latestUserMessage, 92) || '尚未填写学习需求')
  const stage = session.adoptedCanvasId
    ? '已创建画布'
    : session.plan
      ? `${session.pendingPlan ? '调整方案待确认' : '结构可直接采用'} · ${session.plan.chapters.length} 个章节`
      : session.readyToInitialize
        ? '主题已确认 · 可生成结构草稿'
        : `规划对话中 · ${userMessages.length} 条需求信息`
  const updatedAt = new Date(session.updatedAt)
  const time = Number.isNaN(updatedAt.getTime())
    ? ''
    : updatedAt.toLocaleString('zh-CN', {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
  return { excerpt, meta: time ? `${stage} · ${time}` : stage }
}

function PlanningSessionRow({
  session,
  canvasTitle,
  onOpen,
  onRename,
  onDelete,
  onOpenCanvas,
}: {
  session: AgentPlanningSession
  canvasTitle?: string
  onOpen: () => void
  onRename: () => void
  onDelete: () => void
  onOpenCanvas: () => void
}) {
  const preview = sessionPreview(session)
  const adopted = Boolean(session.adoptedCanvasId)
  return (
    <article className={`planning-session-row${adopted ? ' is-adopted' : ''}`}>
      <button
        className="planning-session-main"
        type="button"
        onClick={onOpen}
        aria-label={`${adopted ? '查看' : '继续'} Agent 规划：${session.title}`}
      >
        <i><Sparkle size={18} weight={adopted ? 'duotone' : 'fill'} /></i>
        <span>
          <strong>{session.title}</strong>
          <small>{preview.excerpt}</small>
          <em>{preview.meta}</em>
        </span>
        <ArrowRight size={15} />
      </button>
      <div className="planning-session-actions">
        {session.adoptedCanvasId && canvasTitle && (
          <button type="button" onClick={onOpenCanvas}>打开画布“{canvasTitle}”</button>
        )}
        {session.adoptedCanvasId && !canvasTitle && <span>关联画布已删除</span>}
        <button type="button" onClick={onRename} aria-label={`重命名规划会话：${session.title}`}>
          <PencilSimple size={12} /> 重命名
        </button>
        <button className="planning-session-delete" type="button" onClick={onDelete} aria-label={`删除规划会话：${session.title}`}>
          <Trash size={12} /> 删除
        </button>
      </div>
    </article>
  )
}

export function CanvasCreationDialog({
  sessions,
  canvasTitlesById,
  onClose,
  onManual,
  onOpenAgentSession,
  onNewAgentSession,
  onRenameAgentSession,
  onDeleteAgentSession,
  onOpenCanvas,
}: CanvasCreationDialogProps) {
  const [showAll, setShowAll] = useState(false)
  const sorted = sortAgentPlanningSessions(sessions)
  const unfinished = sorted.filter((session) => !session.adoptedCanvasId)
  const adopted = sorted.filter((session) => session.adoptedCanvasId)
  const recent = unfinished.slice(0, 3)

  function sessionRow(session: AgentPlanningSession) {
    return (
      <PlanningSessionRow
        key={session.id}
        session={session}
        canvasTitle={session.adoptedCanvasId ? canvasTitlesById[session.adoptedCanvasId] : undefined}
        onOpen={() => onOpenAgentSession(session.id)}
        onRename={() => onRenameAgentSession(session.id)}
        onDelete={() => onDeleteAgentSession(session.id)}
        onOpenCanvas={() => session.adoptedCanvasId && onOpenCanvas(session.adoptedCanvasId)}
      />
    )
  }

  return (
    <div className="modal-backdrop canvas-creation-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <section className={`canvas-creation-dialog${showAll ? ' is-library' : ''}`} role="dialog" aria-modal="true" aria-labelledby="canvas-creation-title">
        <header>
          <div>
            {showAll ? (
              <button className="canvas-dialog-back" type="button" onClick={() => setShowAll(false)} aria-label="返回新建画布">
                <ArrowLeft size={16} />
              </button>
            ) : <GitBranch size={18} weight="bold" />}
            <div>
              <h2 id="canvas-creation-title">{showAll ? 'Agent 规划会话' : '新建画布'}</h2>
              <p>{showAll ? '继续未完成的规划，或回看已经采用的方案' : '选择起步方式'}</p>
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="关闭新建画布"><X size={17} /></button>
        </header>

        {showAll ? (
          <div className="planning-session-library">
            <button className="planning-session-new" type="button" onClick={onNewAgentSession}>
              <Plus size={14} weight="bold" /> 新建 Agent 规划会话
            </button>
            <section aria-labelledby="unfinished-planning-title">
              <h3 id="unfinished-planning-title">未完成 <span>{unfinished.length}</span></h3>
              <div>{unfinished.length ? unfinished.map(sessionRow) : <p>没有未完成的规划会话。</p>}</div>
            </section>
            <section aria-labelledby="adopted-planning-title">
              <h3 id="adopted-planning-title">已创建画布 <span>{adopted.length}</span></h3>
              <div>{adopted.length ? adopted.map(sessionRow) : <p>采用规划后，会在这里保留一份记录。</p>}</div>
            </section>
          </div>
        ) : (
          <div className="canvas-creation-options">
            <button type="button" onClick={onManual}>
              <i><PencilSimple size={19} weight="bold" /></i>
              <span><b>自主创建</b><small>从一个空白起始节点开始</small></span>
              <ArrowRight size={16} />
            </button>
            <button type="button" onClick={onNewAgentSession}>
              <i><Sparkle size={19} weight="fill" /></i>
              <span><b>新建 Agent 规划</b><small>开启一份独立对话，生成初始章节</small></span>
              <ArrowRight size={16} />
            </button>
            {recent.length > 0 && (
              <section className="recent-planning-sessions" aria-label="未采用的 Agent 规划草稿">
                <header><b>最近的规划会话</b><span>按更新时间排序</span></header>
                <div>{recent.map(sessionRow)}</div>
              </section>
            )}
            {sessions.length > 0 && (
              <button className="planning-session-view-all" type="button" onClick={() => setShowAll(true)}>
                <span><b>查看全部规划会话</b><small>{unfinished.length} 个未完成 · {adopted.length} 个已创建画布</small></span>
                <ArrowRight size={16} />
              </button>
            )}
          </div>
        )}
      </section>
    </div>
  )
}
