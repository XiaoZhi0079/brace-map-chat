import {
  ArrowCounterClockwise,
  ArrowDown,
  ArrowUp,
  Check,
  ChatCircleDots,
  CircleNotch,
  GitBranch,
  PencilSimple,
  Plus,
  Trash,
} from '@phosphor-icons/react'
import type { AgentTreeChapter, AgentTreePlan, LearningPathMode } from '../shared/agent.ts'

const pathModeLabels: Record<LearningPathMode, string> = {
  course: '系统课程',
  exam: '考试准备',
  project: '项目实践',
  exploration: '自由探索',
}

type AgentPlanDraftProps = {
  plan: AgentTreePlan
  planStatus: 'ready' | 'agent-proposal' | 'manual-edit'
  editing: boolean
  pending: boolean
  regenerating: boolean
  readOnly?: boolean
  onChange: (plan: AgentTreePlan) => void
  onStartEditing: () => void
  onEditingChange: (editing: boolean) => void
  onRegenerate: () => void
  onFocusAdjustment: () => void
  onRequestManualReview: () => void
  onAcceptProposal: () => void
  onDiscardProposal: () => void
  onAdopt: () => void
}

function editablePlanError(plan: AgentTreePlan) {
  if (plan.chapters.length < 3 || plan.chapters.length > 7) return '基础结构需要保留 3 到 7 个章节。'
  const fields = [
    plan.canvasTitle,
    plan.learningGoal,
    plan.targetOutcome,
    plan.root.title,
    plan.root.brief,
    plan.root.openingPrompt,
    ...plan.chapters.flatMap((chapter) => [
      chapter.title,
      chapter.brief,
      chapter.openingPrompt,
      ...(chapter.children ?? []).flatMap((child) => [child.title, child.brief, child.openingPrompt]),
    ]),
  ]
  if (fields.some((field) => !field.trim())) return '请补全所有标题、简介和开场内容。'
  if (plan.chapters.some((chapter) => (chapter.children?.length ?? 0) > 3)) return '每个主要章节最多保留 3 个二级章节。'
  if (plan.chapters.reduce((total, chapter) => total + (chapter.children?.length ?? 0), 0) > 16) return '二级章节总数不能超过 16 个。'
  const titles = plan.chapters.map((chapter) => chapter.title.trim().toLocaleLowerCase())
  if (new Set(titles).size !== titles.length) return '章节标题不能重复。'
  if (plan.chapters.some((chapter) => {
    const childTitles = (chapter.children ?? []).map((child) => child.title.trim().toLocaleLowerCase())
    return new Set(childTitles).size !== childTitles.length
  })) return '同一主要章节下的二级章节标题不能重复。'
  return ''
}

function PlanField({
  label,
  value,
  onChange,
  multiline = false,
  maxLength,
  disabled,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  multiline?: boolean
  maxLength: number
  disabled: boolean
}) {
  return (
    <label className="agent-plan-field">
      <span>{label}</span>
      {multiline
        ? <textarea value={value} onChange={(event) => onChange(event.target.value)} maxLength={maxLength} rows={2} disabled={disabled} />
        : <input value={value} onChange={(event) => onChange(event.target.value)} maxLength={maxLength} disabled={disabled} />}
    </label>
  )
}

export function AgentPlanDraft({
  plan,
  planStatus,
  editing,
  pending,
  regenerating,
  readOnly = false,
  onChange,
  onStartEditing,
  onEditingChange,
  onRegenerate,
  onFocusAdjustment,
  onRequestManualReview,
  onAcceptProposal,
  onDiscardProposal,
  onAdopt,
}: AgentPlanDraftProps) {
  const validationError = editablePlanError(plan)
  const planLabel = planStatus === 'agent-proposal'
    ? 'Agent 提议的调整'
    : planStatus === 'manual-edit'
      ? '你的修改草稿'
      : '当前学习结构'
  const statusLabel = planStatus === 'agent-proposal'
    ? '调整方案待确认'
    : planStatus === 'manual-edit'
      ? '修改草稿待评价'
      : '可直接采用'

  function updateRoot(patch: Partial<AgentTreePlan['root']>) {
    onChange({ ...plan, root: { ...plan.root, ...patch } })
  }

  function updateChapter(index: number, patch: Partial<AgentTreeChapter>) {
    onChange({
      ...plan,
      chapters: plan.chapters.map((chapter, chapterIndex) => (
        chapterIndex === index ? { ...chapter, ...patch } : chapter
      )),
    })
  }

  function moveChapter(index: number, offset: -1 | 1) {
    const target = index + offset
    if (target < 0 || target >= plan.chapters.length) return
    const chapters = [...plan.chapters]
    ;[chapters[index], chapters[target]] = [chapters[target], chapters[index]]
    onChange({ ...plan, chapters })
  }

  function updateChild(chapterIndex: number, childIndex: number, patch: Partial<AgentTreeChapter>) {
    const chapter = plan.chapters[chapterIndex]
    updateChapter(chapterIndex, {
      children: (chapter.children ?? []).map((child, index) => index === childIndex ? { ...child, ...patch } : child),
    })
  }

  function moveChild(chapterIndex: number, childIndex: number, offset: -1 | 1) {
    const children = [...(plan.chapters[chapterIndex].children ?? [])]
    const target = childIndex + offset
    if (target < 0 || target >= children.length) return
    ;[children[childIndex], children[target]] = [children[target], children[childIndex]]
    updateChapter(chapterIndex, { children })
  }

  function deleteChild(chapterIndex: number, childIndex: number) {
    const chapter = plan.chapters[chapterIndex]
    const child = (chapter.children ?? [])[childIndex]
    if (!child || !window.confirm(`删除二级章节“${child.title}”吗？`)) return
    updateChapter(chapterIndex, {
      children: (chapter.children ?? []).filter((_, index) => index !== childIndex),
    })
  }

  function addChild(chapterIndex: number) {
    const chapter = plan.chapters[chapterIndex]
    const children = chapter.children ?? []
    const totalChildren = plan.chapters.reduce((total, item) => total + (item.children?.length ?? 0), 0)
    if (children.length >= 3 || totalChildren >= 16) return
    updateChapter(chapterIndex, {
      children: [...children, {
        title: `新二级章节 ${children.length + 1}`,
        brief: '说明这个独立学习单元准备覆盖的内容',
        openingPrompt: '从一个具体问题或例子开始介绍本单元。',
        children: [],
      }],
    })
  }

  function deleteChapter(index: number) {
    if (plan.chapters.length <= 3) return
    if (!window.confirm(`删除章节“${plan.chapters[index].title}”吗？`)) return
    onChange({ ...plan, chapters: plan.chapters.filter((_, chapterIndex) => chapterIndex !== index) })
  }

  function addChapter() {
    if (plan.chapters.length >= 7) return
    let suffix = plan.chapters.length + 1
    const existingTitles = new Set(plan.chapters.map((chapter) => chapter.title.trim().toLocaleLowerCase()))
    while (existingTitles.has(`新章节 ${suffix}`.toLocaleLowerCase())) suffix += 1
    onChange({
      ...plan,
      chapters: [
        ...plan.chapters,
        {
          title: `新章节 ${suffix}`,
          brief: '说明本章节准备学习的内容',
          openingPrompt: '从一个具体问题或例子开始介绍本章节。',
          children: [],
        },
      ],
    })
  }

  return (
    <section className={`agent-inline-plan${editing ? ' is-editing' : ''}`} aria-label="Agent 生成的基础结构">
      <header>
        {editing ? (
          <div className="agent-plan-header-fields">
            <PlanField label="学习主题" value={plan.canvasTitle} maxLength={80} disabled={pending} onChange={(canvasTitle) => onChange({ ...plan, canvasTitle })} />
            <PlanField label="学习目标" value={plan.learningGoal} maxLength={1000} multiline disabled={pending} onChange={(learningGoal) => onChange({ ...plan, learningGoal })} />
          </div>
        ) : (
          <div>
            <span>{planLabel}</span>
            <h3>{plan.canvasTitle}</h3>
            <p>{plan.learningGoal}</p>
          </div>
        )}
        <div className="agent-plan-heading-actions">
          {editing ? (
            <label>
              <span>学习方式</span>
              <select
                value={plan.pathMode}
                disabled={pending}
                onChange={(event) => onChange({ ...plan, pathMode: event.target.value as LearningPathMode })}
              >
                {Object.entries(pathModeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
          ) : (
            <span>{pathModeLabels[plan.pathMode]}</span>
          )}
          {!editing && !readOnly && (
            <>
              <em className={planStatus === 'ready' ? 'is-ready' : ''}>{statusLabel}</em>
              <button type="button" onClick={onStartEditing} disabled={pending}>
                <PencilSimple size={13} /> 编辑结构
              </button>
            </>
          )}
        </div>
      </header>

      {editing ? (
        <div className="agent-plan-outcome-field">
          <PlanField label="目标结果" value={plan.targetOutcome} maxLength={1000} multiline disabled={pending} onChange={(targetOutcome) => onChange({ ...plan, targetOutcome })} />
        </div>
      ) : (
        <dl>
          <dt>目标结果</dt>
          <dd>{plan.targetOutcome}</dd>
        </dl>
      )}

      <div className="agent-plan-tree">
        <article className="agent-plan-root">
          <GitBranch size={17} weight="bold" />
          <div>
            {editing ? (
              <div className="agent-plan-edit-fields">
                <PlanField label="总目标标题" value={plan.root.title} maxLength={80} disabled={pending} onChange={(title) => updateRoot({ title })} />
                <PlanField label="总目标简介" value={plan.root.brief} maxLength={500} multiline disabled={pending} onChange={(brief) => updateRoot({ brief })} />
                <PlanField label="整体开场" value={plan.root.openingPrompt} maxLength={800} multiline disabled={pending} onChange={(openingPrompt) => updateRoot({ openingPrompt })} />
              </div>
            ) : (
              <>
                <b>{plan.root.title}</b>
                <p>{plan.root.brief}</p>
                <small>整体开场：{plan.root.openingPrompt}</small>
              </>
            )}
          </div>
        </article>
        <div className="agent-plan-chapters">
          {plan.chapters.map((chapter, index) => (
            <article key={index}>
              <i>{String(index + 1).padStart(2, '0')}</i>
              <div>
                {editing ? (
                  <>
                    <div className="agent-plan-chapter-actions">
                      <button type="button" onClick={() => moveChapter(index, -1)} disabled={index === 0 || pending} aria-label={`上移章节：${chapter.title}`} title="上移章节"><ArrowUp size={13} /></button>
                      <button type="button" onClick={() => moveChapter(index, 1)} disabled={index === plan.chapters.length - 1 || pending} aria-label={`下移章节：${chapter.title}`} title="下移章节"><ArrowDown size={13} /></button>
                      <button type="button" onClick={() => deleteChapter(index)} disabled={plan.chapters.length <= 3 || pending} aria-label={`删除章节：${chapter.title}`} title={plan.chapters.length <= 3 ? '至少保留 3 个章节' : '删除章节'}><Trash size={13} /></button>
                    </div>
                    <div className="agent-plan-edit-fields">
                      <PlanField label="章节标题" value={chapter.title} maxLength={80} disabled={pending} onChange={(title) => updateChapter(index, { title })} />
                      <PlanField label="章节简介" value={chapter.brief} maxLength={500} multiline disabled={pending} onChange={(brief) => updateChapter(index, { brief })} />
                      <PlanField label="章节开场" value={chapter.openingPrompt} maxLength={500} multiline disabled={pending} onChange={(openingPrompt) => updateChapter(index, { openingPrompt })} />
                    </div>
                  </>
                ) : (
                  <>
                    <b>{chapter.title}</b>
                    <p>{chapter.brief}</p>
                    <small>章节开场：{chapter.openingPrompt}</small>
                  </>
                )}
                {(chapter.children ?? []).length > 0 && (
                  <div className="agent-plan-subchapters">
                    {(chapter.children ?? []).map((child, childIndex) => (
                      <section key={childIndex}>
                        {editing ? (
                          <>
                            <div className="agent-plan-chapter-actions">
                              <button type="button" onClick={() => moveChild(index, childIndex, -1)} disabled={childIndex === 0 || pending} aria-label={`上移二级章节：${child.title}`}><ArrowUp size={12} /></button>
                              <button type="button" onClick={() => moveChild(index, childIndex, 1)} disabled={childIndex === (chapter.children?.length ?? 0) - 1 || pending} aria-label={`下移二级章节：${child.title}`}><ArrowDown size={12} /></button>
                              <button type="button" onClick={() => deleteChild(index, childIndex)} disabled={pending} aria-label={`删除二级章节：${child.title}`}><Trash size={12} /></button>
                            </div>
                            <div className="agent-plan-edit-fields">
                              <PlanField label="二级章节标题" value={child.title} maxLength={80} disabled={pending} onChange={(title) => updateChild(index, childIndex, { title })} />
                              <PlanField label="二级章节简介" value={child.brief} maxLength={500} multiline disabled={pending} onChange={(brief) => updateChild(index, childIndex, { brief })} />
                              <PlanField label="二级章节开场" value={child.openingPrompt} maxLength={500} multiline disabled={pending} onChange={(openingPrompt) => updateChild(index, childIndex, { openingPrompt })} />
                            </div>
                          </>
                        ) : (
                          <>
                            <b>{child.title}</b>
                            <p>{child.brief}</p>
                            <small>开场：{child.openingPrompt}</small>
                          </>
                        )}
                      </section>
                    ))}
                  </div>
                )}
                {editing && (chapter.children?.length ?? 0) < 3 && plan.chapters.reduce((total, item) => total + (item.children?.length ?? 0), 0) < 16 && (
                  <button className="agent-plan-add-subchapter" type="button" onClick={() => addChild(index)} disabled={pending}>
                    <Plus size={12} /> 添加二级章节
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
        {editing && plan.chapters.length < 7 && (
          <button className="agent-plan-add-chapter" type="button" onClick={addChapter} disabled={pending}>
            <Plus size={14} weight="bold" /> 添加章节
          </button>
        )}
      </div>

      {validationError && <p className="agent-plan-validation" role="alert">{validationError}</p>}
      {!readOnly && <footer>
        {editing ? (
          <button className="agent-primary-button" type="button" onClick={() => onEditingChange(false)} disabled={pending || Boolean(validationError)}>
            <Check size={15} weight="bold" /> 完成编辑
          </button>
        ) : planStatus === 'agent-proposal' ? (
          <>
            <button type="button" onClick={onDiscardProposal} disabled={pending}>
              <ArrowCounterClockwise size={14} /> 保留原方案
            </button>
            <button type="button" onClick={onFocusAdjustment} disabled={pending}>
              <ChatCircleDots size={14} /> 继续提出意见
            </button>
            <button className="agent-primary-button" type="button" onClick={onAcceptProposal} disabled={pending || Boolean(validationError)}>
              <Check size={15} weight="bold" /> 接受此调整
            </button>
          </>
        ) : planStatus === 'manual-edit' ? (
          <>
            <button type="button" onClick={onDiscardProposal} disabled={pending}>
              <ArrowCounterClockwise size={14} /> 撤销修改
            </button>
            <button type="button" onClick={onStartEditing} disabled={pending}>
              <PencilSimple size={14} /> 继续编辑
            </button>
            <button className="agent-primary-button" type="button" onClick={onRequestManualReview} disabled={pending || Boolean(validationError)}>
              <Check size={15} weight="bold" /> 让 Agent 评价修改
            </button>
          </>
        ) : (
          <>
            <button type="button" onClick={onRegenerate} disabled={pending}>
              {regenerating
                ? <CircleNotch className="loading-icon" size={14} />
                : <ArrowCounterClockwise size={14} />}
              重新生成
            </button>
            <button type="button" onClick={onFocusAdjustment} disabled={pending}>
              <ChatCircleDots size={14} /> 提出调整
            </button>
            <button className="agent-primary-button" type="button" onClick={onAdopt} disabled={pending || Boolean(validationError)}>
              <Check size={15} weight="bold" /> 采用此结构
            </button>
          </>
        )}
      </footer>}
    </section>
  )
}
