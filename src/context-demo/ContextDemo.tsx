import {
  ArrowLeft,
  ArrowRight,
  BookOpenText,
  Check,
  GitBranch,
  MagicWand,
  NotePencil,
  Quotes,
  Sparkle,
  X,
} from '@phosphor-icons/react'
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'

type DemoMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
}

type PickedSegment = {
  id: string
  start: number
  end: number
  messageIndexes: number[]
  sourceLabel: string
  text: string
}
type TextCharacter = {
  index: number
  value: string
  messageIndex: number
  paragraphIndex: number
}
type DragRange = { start: number; end: number }

const messages: DemoMessage[] = [
  {
    id: 'turn-1-user',
    role: 'user',
    content: '我还是不太理解闭包。为什么外层函数已经执行结束，里面的变量却没有消失？',
  },
  {
    id: 'turn-1-assistant',
    role: 'assistant',
    content: '闭包可以理解成函数随身带着一份“出生环境”。内部函数不仅保存了自己的代码，也保存了它定义时能够访问的词法作用域。\n\n只要这个内部函数仍然可达，它引用的外层变量就仍然有用途，垃圾回收器不会释放这些变量。不是所有外层变量都会被保留，真正需要保留的是仍被闭包引用的部分。',
  },
  {
    id: 'turn-2-user',
    role: 'user',
    content: '那为什么在 for 循环里用 var 创建回调，经常最后都得到同一个数字？',
  },
  {
    id: 'turn-2-assistant',
    role: 'assistant',
    content: '因为 var 是函数作用域，循环中的多个回调闭包引用的是同一个变量 i，而不是每次循环各自拥有一个 i。等回调真正执行时，循环通常已经结束，所以它们读到的是 i 的最终值。\n\n改用 let 后，每轮循环都会创建新的块级绑定，每个闭包捕获不同的 i；也可以通过立即执行函数显式创建一层新的作用域。',
  },
]

function splitGraphemes(text: string) {
  if (typeof Intl.Segmenter === 'function') {
    return Array.from(new Intl.Segmenter('zh-CN', { granularity: 'grapheme' }).segment(text), ({ segment }) => segment)
  }
  return Array.from(text)
}

function summaryFor() {
  return '这个节点正在讨论 JavaScript 闭包。已经明确闭包会保留仍被引用的词法作用域，并进一步比较了 for 循环中 var 共享函数级变量与 let 为每轮创建块级绑定的差异。'
}

export default function ContextDemo() {
  const summaryTimer = useRef<number | null>(null)
  const dragStartRef = useRef<number | null>(null)
  const dragEndRef = useRef<number | null>(null)
  const dragPointerRef = useRef<number | null>(null)
  const [pickingMode, setPickingMode] = useState(false)
  const [dragRange, setDragRange] = useState<DragRange | null>(null)
  const [pickedSegments, setPickedSegments] = useState<PickedSegment[]>([])
  const [workbenchOpen, setWorkbenchOpen] = useState(false)
  const [step, setStep] = useState<1 | 2 | 3>(1)
  const [summary, setSummary] = useState('')
  const [title, setTitle] = useState('为什么 var 循环中的闭包共享变量？')
  const [question, setQuestion] = useState('请从执行时机和作用域绑定两个角度解释，并给出 var 与 let 的对照示例。')
  const [generating, setGenerating] = useState(false)
  const [completed, setCompleted] = useState(false)
  const [status, setStatus] = useState('普通阅读模式：可以照常框选、复制或使用右键菜单。')
  const [manualNote, setManualNote] = useState('闭包保留的是仍被引用的环境；需要继续弄清循环中的绑定差异。')

  useEffect(() => () => {
    if (summaryTimer.current !== null) window.clearTimeout(summaryTimer.current)
  }, [])

  const characterRows = useMemo(() => {
    let characterIndex = 0
    return messages.map((message, messageIndex) => message.content.split('\n\n').map((paragraph, paragraphIndex) => (
      splitGraphemes(paragraph).map((value) => ({
        index: characterIndex++,
        value,
        messageIndex,
        paragraphIndex,
      } satisfies TextCharacter))
    )))
  }, [])

  const allCharacters = useMemo(() => characterRows.flat(2), [characterRows])

  const pickedCharacterOrders = useMemo(() => {
    const result = new Map<number, number>()
    pickedSegments.forEach((segment, order) => {
      for (let index = segment.start; index <= segment.end; index += 1) {
        if (!result.has(index)) result.set(index, order + 1)
      }
    })
    return result
  }, [pickedSegments])

  const pickedCharacterCount = useMemo(
    () => pickedSegments.reduce((total, segment) => total + segment.end - segment.start + 1, 0),
    [pickedSegments],
  )

  const childContext = useMemo(() => {
    const source = pickedSegments.length
      ? pickedSegments.map((segment, index) => `[${index + 1}] ${segment.text}`).join('\n')
      : '（尚未摘录原文）'
    return `<parent_node_summary>\n${summary || '（尚未填写）'}\n</parent_node_summary>\n\n`
      + `<selected_source>\n${source}\n</selected_source>\n\n`
      + `<user_question>\n${question || '（尚未填写）'}\n</user_question>`
  }, [pickedSegments, question, summary])

  function invalidateSelectionSummary(message: string) {
    setCompleted(false)
    setStatus(`${message}；完整节点摘要不依赖摘录，仍然有效。`)
  }

  function startPicking() {
    window.getSelection()?.removeAllRanges()
    setPickingMode(true)
    setWorkbenchOpen(false)
    setCompleted(false)
    setStatus('拖拽摘录已开启：从任意字按住，拖到任意字后松开。')
  }

  function segmentFromRange(rangeStart: number, rangeEnd: number): PickedSegment | null {
    const start = Math.min(rangeStart, rangeEnd)
    const end = Math.max(rangeStart, rangeEnd)
    const selectedCharacters = allCharacters.filter((character) => character.index >= start && character.index <= end)
    if (!selectedCharacters.length) return null

    let text = ''
    selectedCharacters.forEach((character, index) => {
      const previous = selectedCharacters[index - 1]
      if (previous && (previous.messageIndex !== character.messageIndex || previous.paragraphIndex !== character.paragraphIndex)) {
        text += '\n\n'
      }
      text += character.value
    })
    const messageIndexes = [...new Set(selectedCharacters.map((character) => character.messageIndex))]
    const sourceLabel = messageIndexes.length === 1
      ? `第 ${messageIndexes[0] + 1} 条消息`
      : `跨第 ${messageIndexes.map((index) => index + 1).join('、')} 条消息`
    return { id: crypto.randomUUID(), start, end, messageIndexes, sourceLabel, text }
  }

  function beginDrag(event: ReactPointerEvent<HTMLSpanElement>, characterIndex: number) {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    event.preventDefault()
    window.getSelection()?.removeAllRanges()
    dragStartRef.current = characterIndex
    dragEndRef.current = characterIndex
    dragPointerRef.current = event.pointerId
    setDragRange({ start: characterIndex, end: characterIndex })
    event.currentTarget.closest<HTMLElement>('.conversation-scroll')?.setPointerCapture(event.pointerId)
  }

  function updateDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (dragStartRef.current === null || dragPointerRef.current !== event.pointerId) return
    event.preventDefault()
    const element = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-character-index]')
    if (!element || !event.currentTarget.contains(element)) return
    const characterIndex = Number(element.dataset.characterIndex)
    if (!Number.isInteger(characterIndex) || characterIndex === dragEndRef.current) return
    dragEndRef.current = characterIndex
    setDragRange({ start: dragStartRef.current, end: characterIndex })
  }

  function finishDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (dragStartRef.current === null || dragEndRef.current === null || dragPointerRef.current !== event.pointerId) return
    const segment = segmentFromRange(dragStartRef.current, dragEndRef.current)
    dragStartRef.current = null
    dragEndRef.current = null
    dragPointerRef.current = null
    setDragRange(null)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    if (!segment) return
    const duplicate = pickedSegments.some((item) => item.start === segment.start && item.end === segment.end)
    if (duplicate) {
      setStatus('这段原文已经摘录过了，可在右侧列表中移除。')
      return
    }
    const next = [...pickedSegments, segment]
    setPickedSegments(next)
    invalidateSelectionSummary(`已加入第 ${next.length} 处摘录，共 ${segment.end - segment.start + 1} 字`)
  }

  function cancelDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (dragPointerRef.current !== event.pointerId) return
    dragStartRef.current = null
    dragEndRef.current = null
    dragPointerRef.current = null
    setDragRange(null)
  }

  function clearPickedSegments() {
    if (!pickedSegments.length) return
    setPickedSegments([])
    setDragRange(null)
    invalidateSelectionSummary('已清空全部摘录')
  }

  function finishPicking() {
    if (!pickedSegments.length) return
    setPickingMode(false)
    setWorkbenchOpen(true)
    setCompleted(false)
    setStep(summary.trim() ? 2 : 1)
    setStatus(`摘录完成：共 ${pickedSegments.length} 处、${pickedCharacterCount} 字，接下来整理分支上下文。`)
  }

  function openWorkbench() {
    if (!pickedSegments.length) return
    setWorkbenchOpen(true)
    setCompleted(false)
    setStep(summary.trim() ? 2 : 1)
    setStatus('已打开上下文整理面板。')
  }

  function removePickedSegment(id: string) {
    setPickedSegments((current) => current.filter((segment) => segment.id !== id))
    invalidateSelectionSummary('已从引用原文中移除一处摘录')
  }

  function generateSummary() {
    setGenerating(true)
    if (summaryTimer.current !== null) window.clearTimeout(summaryTimer.current)
    summaryTimer.current = window.setTimeout(() => {
      setSummary(summaryFor())
      setGenerating(false)
      setStatus('背景摘要草稿已生成，请在传递前检查和修改。')
    }, 650)
  }

  function draftNoteWithAi() {
    setManualNote('闭包让函数继续访问定义时的词法作用域；循环场景中，var 共享同一绑定，而 let 为每轮创建独立绑定。')
    setStatus('AI 已生成个人笔记草稿；内容仍由用户编辑和确认。')
  }

  function resetDemo() {
    setPickedSegments([])
    setDragRange(null)
    setPickingMode(false)
    setWorkbenchOpen(false)
    setStep(1)
    setSummary('')
    setCompleted(false)
    setStatus('普通阅读模式：可以照常框选、复制或使用右键菜单。')
  }

  return (
    <main className="context-demo-shell">
      <header className="context-demo-header">
        <a href="/" className="back-link"><ArrowLeft size={16} /> 返回主画布</a>
        <div className="demo-heading">
          <span>INTERACTION LAB</span>
          <h1>拖拽式原文摘录</h1>
          <p>从任意字开始拖动，在任意字结束；半句话、单个词也能精确摘录。</p>
        </div>
        <div className="demo-principle"><Check size={15} weight="bold" /> 拖到哪里，摘录哪里</div>
      </header>

      <section className="context-demo-grid">
        <section className={`conversation-lab ${pickingMode ? 'is-picking' : ''}`} aria-label="原会话">
          <header className="conversation-lab-header">
            <div>
              <span>父节点会话</span>
              <h2>理解 JavaScript 闭包</h2>
            </div>
            <div className="node-badge"><BookOpenText size={15} /> 4 条消息</div>
          </header>

          <div className="manual-note-strip">
            <NotePencil size={17} />
            <label>
              <span>个人笔记 <b>用户拥有 · 不自动传入子节点</b></span>
              <input value={manualNote} onChange={(event) => setManualNote(event.target.value)} />
            </label>
            <button className="note-ai-button" type="button" onClick={draftNoteWithAi}>
              <MagicWand size={13} /> AI 草拟
            </button>
          </div>

          {pickingMode && (
            <div className="picking-toolbar" aria-label="摘录模式工具栏">
              <div className="picking-mode-label"><Quotes size={15} weight="fill" /><span><b>拖拽摘录模式</b><small>按住任意字，拖动到终点后松开</small></span></div>
              <span className="drag-tip">可精确到一个字</span>
              <span className="pick-count">{pickedSegments.length} 处 · {pickedCharacterCount} 字</span>
            </div>
          )}

          <div
            className={`conversation-scroll ${pickingMode ? 'is-picking' : ''}`}
            onPointerMove={pickingMode ? updateDrag : undefined}
            onPointerUp={pickingMode ? finishDrag : undefined}
            onPointerCancel={pickingMode ? cancelDrag : undefined}
          >
            {messages.map((message, messageIndex) => (
                <article className={`context-message context-message--${message.role}`} data-message-id={message.id} key={message.id}>
                  <span className="context-avatar">{message.role === 'user' ? '你' : 'AI'}</span>
                  <div className="context-message-column">
                    <div className="context-message-meta">第 {messageIndex + 1} 条 · {message.role === 'user' ? '提问' : '回答'}</div>
                    <div className="context-message-text">
                      {pickingMode ? characterRows[messageIndex].map((characters, paragraphIndex) => (
                        <p key={`${message.id}-${paragraphIndex}`}>
                          {characters.map((character) => {
                            const dragStart = dragRange ? Math.min(dragRange.start, dragRange.end) : -1
                            const dragEnd = dragRange ? Math.max(dragRange.start, dragRange.end) : -1
                            const isDraft = character.index >= dragStart && character.index <= dragEnd
                            const pickedOrder = pickedCharacterOrders.get(character.index)
                            const rangeStartOrder = pickedSegments.findIndex((segment) => segment.start === character.index)
                            return (
                              <span
                                className={`drag-character ${pickedOrder ? 'is-picked' : ''} ${isDraft ? 'is-draft' : ''}`}
                                data-character-index={character.index}
                                onPointerDown={(event) => beginDrag(event, character.index)}
                                key={character.index}
                              >
                                {rangeStartOrder >= 0 && <i className="pick-order" aria-hidden="true">{rangeStartOrder + 1}</i>}
                                {character.value}
                              </span>
                            )
                          })}
                        </p>
                      )) : message.content.split('\n\n').map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
                    </div>
                  </div>
                </article>
            ))}
          </div>

          {pickingMode ? (
            <footer className="picking-action-footer" aria-live="polite">
              <div><strong>按住并拖动，松手完成一处摘录</strong><span>可以反向拖动，也可以多次拖动组合不连续内容</span></div>
              <div className="picking-footer-actions">
                <button type="button" disabled={!pickedSegments.length} onClick={clearPickedSegments}>清空</button>
                <button type="button" onClick={() => { setPickingMode(false); setStatus('已退出摘录模式，当前摘录会保留。') }}>退出</button>
                <button className="finish-picking-button" type="button" disabled={!pickedSegments.length} onClick={finishPicking}>
                  <Check size={14} weight="bold" /> 完成并整理上下文
                </button>
              </div>
            </footer>
          ) : (
            <footer className={`node-action-footer ${pickedSegments.length ? 'has-selection' : ''}`} aria-live="polite">
              <div className="node-action-status">
                <strong>{pickedSegments.length ? `已摘录 ${pickedSegments.length} 处 · ${pickedCharacterCount} 字` : '普通阅读模式'}</strong>
                <span>{pickedSegments.length ? '可以继续添加，或整理为子会话上下文' : '浏览器原生框选、复制和右键功能均保持不变'}</span>
              </div>
              <div className="node-footer-actions">
                {pickedSegments.length > 0 && <button type="button" onClick={openWorkbench}>整理上下文</button>}
                <button className="branch-action-button" type="button" onClick={startPicking}>
                  <Quotes size={15} weight="fill" /> {pickedSegments.length ? '继续摘录' : '摘录原文'}
                </button>
              </div>
            </footer>
          )}
          <div className="sr-status" aria-live="polite">{status}</div>
        </section>

        <aside className={`branch-workbench ${workbenchOpen ? '' : 'is-standby'}`} aria-label="分支上下文工作台">
          <header className="workbench-header">
            <div className="workbench-icon"><GitBranch size={19} weight="bold" /></div>
            <div>
              <span>{workbenchOpen ? '三段式上下文' : pickingMode ? '正在摘录原文' : '等待摘录'}</span>
              <h2>新建子会话</h2>
            </div>
            <b>{workbenchOpen ? '摘要 · 原文 · 疑问' : '明确操作后进入'}</b>
          </header>

          {!workbenchOpen ? (
            <section className="standby-state">
              <div><Quotes size={26} /></div>
              <span>{pickingMode ? 'PICKING SOURCE' : 'READING MODE'}</span>
              <h3>{pickingMode ? '在左侧拖过需要的文字' : '先阅读，需要时再摘录'}</h3>
              <p>{pickingMode
                ? '起点和终点都可以落在任意字上。每次松手形成一处摘录，多次拖动可以组合不连续内容。'
                : '普通阅读不会触发产品操作。点击“摘录原文”后，才会进入字符级拖拽模式。'}</p>
              <ol>
                <li><i>1</i><span>点击“摘录原文”进入专门模式</span></li>
                <li><i>2</i><span>从第一个字按住，拖到最后一个字</span></li>
                <li><i>3</i><span>完成后整理背景摘要与用户疑问</span></li>
              </ol>
            </section>
          ) : (
            <>
              <nav className="stepper" aria-label="创建步骤">
                {[
                  { value: 1, label: '背景摘要' },
                  { value: 2, label: '引用原文' },
                  { value: 3, label: '用户疑问' },
                ].map((item) => (
                  <button
                    className={step === item.value ? 'is-current' : step > item.value ? 'is-done' : ''}
                    type="button"
                    disabled={(item.value === 2 && !summary.trim()) || (item.value === 3 && (!summary.trim() || !pickedSegments.length))}
                    onClick={() => setStep(item.value as 1 | 2 | 3)}
                    key={item.value}
                  >
                    <i>{step > item.value ? <Check size={11} weight="bold" /> : item.value}</i>
                    <span>{item.label}</span>
                  </button>
                ))}
              </nav>

              <div className="workbench-body">
                {completed ? (
                  <section className="completed-state">
                    <div className="completed-mark"><Check size={24} weight="bold" /></div>
                    <span>三段上下文已组装</span>
                    <h3>{title || '未命名子会话'}</h3>
                    <p>Demo 不会修改真实会话树。下面是创建子节点时将注入的最终内容。</p>
                    <pre>{childContext}</pre>
                    <div>
                      <button type="button" onClick={() => { setCompleted(false); setStep(3) }}>继续调整</button>
                      <button type="button" onClick={resetDemo}>重新体验</button>
                    </div>
                  </section>
                ) : step === 1 ? (
                  <section className="workbench-step">
                    <div className="step-heading"><div><span>STEP 01</span><h3>父节点正在讨论什么？</h3></div></div>
                    <p className="step-description">背景摘要在创建分支时通读完整节点，与个人笔记分开。低频但重要的内容也会保留，草稿仍由用户确认。</p>
                    <div className="summary-scope-fixed"><Sparkle size={16} weight="fill" /><span><b>完整节点</b><small>{messages.length} 条消息全部进入摘要材料</small></span></div>
                    <button className="generate-button" type="button" onClick={generateSummary} disabled={generating}>
                      <MagicWand size={16} weight="fill" /> {generating ? '正在生成背景摘要…' : summary ? '重新生成摘要草稿' : '生成摘要草稿'}
                    </button>
                    <label className="summary-field">
                      <span>父节点背景摘要 <b>可编辑</b></span>
                      <textarea value={summary} onChange={(event) => setSummary(event.target.value)} placeholder="先生成草稿，或直接手动填写。" />
                      <small>{summary.length} 字 · 不会覆盖当前节点的个人笔记</small>
                    </label>
                    <footer className="step-footer">
                      <span>第 1 部分：提供全局背景</span>
                      <button className="primary-step-button" type="button" disabled={!summary.trim()} onClick={() => setStep(2)}>确认原文 <ArrowRight size={14} /></button>
                    </footer>
                  </section>
                ) : step === 2 ? (
                  <section className="workbench-step">
                    <div className="step-heading"><div><span>STEP 02</span><h3>我具体对哪些原文有疑问？</h3></div></div>
                    <p className="step-description">以下原文按拖拽完成顺序组合，不进行概括。可单独移除，也可以回到会话继续摘录。</p>
                    {pickedSegments.length ? (
                      <div className="picked-source-list">
                        {pickedSegments.map((segment, index) => (
                          <article className="picked-source-item" key={segment.id}>
                            <header><i>{index + 1}</i><span>{segment.sourceLabel}</span><b>{segment.end - segment.start + 1} 字</b></header>
                            <p>{segment.text}</p>
                            <button type="button" aria-label={`移除第 ${index + 1} 处摘录`} onClick={() => removePickedSegment(segment.id)}><X size={13} /></button>
                          </article>
                        ))}
                      </div>
                    ) : (
                      <div className="quote-empty"><Quotes size={23} /><h4>还没有引用原文</h4><p>进入摘录模式，从任意字开始拖动。</p></div>
                    )}
                    <div className="quote-step-actions">
                      <button type="button" onClick={startPicking}><Quotes size={13} weight="fill" /> 继续摘录</button>
                      <span><Check size={13} weight="bold" /> 原文只读，并保留拖拽顺序</span>
                    </div>
                    <footer className="step-footer">
                      <button type="button" onClick={() => setStep(1)}><ArrowLeft size={14} /> 返回摘要</button>
                      <button className="primary-step-button" type="button" disabled={!pickedSegments.length} onClick={() => setStep(3)}>填写疑问 <ArrowRight size={14} /></button>
                    </footer>
                  </section>
                ) : (
                  <section className="workbench-step">
                    <div className="step-heading"><div><span>STEP 03</span><h3>我真正想弄清楚什么？</h3></div></div>
                    <p className="step-description">疑问是传给模型的真实任务，放在背景摘要和引用原文之后。</p>
                    <label className="text-field"><span>子会话标题</span><input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
                    <label className="text-field"><span>用户疑问</span><textarea value={question} onChange={(event) => setQuestion(event.target.value)} /></label>
                    <details className="context-preview"><summary><Sparkle size={14} /> 预览三段式上下文</summary><pre>{childContext}</pre></details>
                    <footer className="step-footer">
                      <button type="button" onClick={() => setStep(2)}><ArrowLeft size={14} /> 返回原文</button>
                      <button className="primary-step-button" type="button" disabled={!summary.trim() || !title.trim() || !question.trim() || !pickedSegments.length} onClick={() => setCompleted(true)}>
                        <GitBranch size={14} weight="bold" /> 创建子节点
                      </button>
                    </footer>
                  </section>
                )}
              </div>
            </>
          )}
        </aside>
      </section>
    </main>
  )
}
