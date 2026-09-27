import { readFile, writeFile } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'

const WORKSPACE_KEY = 'brace-map-chat:v3'
const SETUP_DRAFT_KEY = 'brace-map-chat:agent-setup-draft:v1'
const PLANNING_SESSIONS_KEY = 'brace-map-chat:agent-planning-sessions:v1'
const AGENT_SESSIONS_KEY = 'brace-map-chat:agent-sessions:v1'

const profile = {
  id: 'profile-e2e',
  name: 'E2E 模型',
  protocol: 'openai-responses',
  model: 'e2e-model',
  requestUrl: 'https://example.test/v1/responses',
  hasApiKey: true,
}

function workspaceFixture(title = '测试学习画布') {
  return {
    activeCanvasId: 'canvas-e2e',
    canvases: [{
      id: 'canvas-e2e',
      revision: 2,
      title,
      learningGoal: '验证学习数据备份',
      targetOutcome: '能够恢复完整画布',
      pathMode: 'project',
      nodes: [{
        id: 'root-e2e',
        type: 'conversation',
        position: { x: 80, y: 120 },
        data: {
          title: '测试总目标',
          expanded: false,
          messages: [{ id: 'message-e2e', role: 'user', content: '这条消息必须进入备份。' }],
          note: '这条笔记也必须进入备份。',
          status: 'learning',
        },
      }],
      edges: [],
    }],
  }
}

const plan = {
  canvasTitle: 'Redis 数据结构学习',
  learningGoal: '掌握 Redis 数据结构选型',
  targetOutcome: '能够解释项目中的选型理由',
  pathMode: 'project',
  root: {
    title: 'Redis 学习总目标',
    brief: '建立完整的 Redis 数据结构选型能力',
    openingPrompt: '介绍整个学习目标和路线。',
  },
  chapters: [
    { title: '判断框架', brief: '理解选型维度', openingPrompt: '从访问模式开始。', children: [] },
    {
      title: '核心结构', brief: '比较常用结构', openingPrompt: '从数据形态开始。', children: [
        { title: 'String 与 Hash', brief: '理解标量和对象', openingPrompt: '从对象缓存开始。', children: [] },
      ],
    },
    { title: '综合实践', brief: '完成项目选型', openingPrompt: '从综合案例开始。', children: [] },
  ],
}

const fullTreePlan = {
  ...plan,
  canvasTitle: '完整初始化树验证',
  root: {
    ...plan.root,
    title: '完整学习总目标',
    openingPrompt: '先介绍整棵学习树的目标与路线。',
  },
  chapters: Array.from({ length: 7 }, (_, chapterIndex) => ({
    title: `章节 ${chapterIndex + 1}`,
    brief: `第 ${chapterIndex + 1} 章的学习边界`,
    openingPrompt: `从第 ${chapterIndex + 1} 章的核心问题开始。`,
    children: Array.from({ length: chapterIndex < 2 ? 3 : 2 }, (_, childIndex) => ({
      title: `章节 ${chapterIndex + 1}.${childIndex + 1}`,
      brief: `第 ${chapterIndex + 1}.${childIndex + 1} 节的独立主题`,
      openingPrompt: `从第 ${chapterIndex + 1}.${childIndex + 1} 节的例子开始。`,
      children: [],
    })),
  })),
}

async function mockBrowserApi(page: Page) {
  let workspaceVersion = 0
  let storageState = {
    workspace: null as ReturnType<typeof workspaceFixture> | null,
    agentPlanningSessions: { version: 1 as const, sessions: [] as Array<Record<string, unknown>>, activeSessionId: null as string | null },
    agentSessions: [] as Array<Record<string, unknown>>,
    preferences: { activeProfileId: profile.id as string | null, agentModelSelection: null, redisSnapshotVersion: null as string | null },
  }
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path === '/api/editor-lease') {
      await route.continue()
      return
    }
    if (path === '/api/storage/state' && request.method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ state: storageState, storage: { engine: 'sqlite', schemaVersion: 2, workspaceVersion } }),
      })
      return
    }
    if (path === '/api/storage/migrate-browser' && request.method() === 'POST') {
      storageState = request.postDataJSON().state
      workspaceVersion += 1
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ state: storageState, storage: { engine: 'sqlite', schemaVersion: 2, workspaceVersion } }),
      })
      return
    }
    if (path === '/api/storage/workspace' && request.method() === 'PUT') {
      const body = request.postDataJSON()
      if (body.expectedVersion !== workspaceVersion) {
        await route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'WORKSPACE_CONFLICT', message: '学习数据已在另一个页面中更新。' } }),
        })
        return
      }
      storageState.workspace = body.workspace
      workspaceVersion += 1
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ workspace: storageState.workspace, workspaceVersion }),
      })
      return
    }
    if (path === '/api/storage/planning-sessions' && request.method() === 'PUT') {
      storageState.agentPlanningSessions = request.postDataJSON().agentPlanningSessions
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ agentPlanningSessions: storageState.agentPlanningSessions }) })
      return
    }
    if (path.startsWith('/api/storage/planning-sessions/') && request.method() === 'DELETE') {
      const sessionId = decodeURIComponent(path.slice('/api/storage/planning-sessions/'.length))
      storageState.agentPlanningSessions.sessions = storageState.agentPlanningSessions.sessions.filter((session) => session.id !== sessionId)
      if (storageState.agentPlanningSessions.activeSessionId === sessionId) {
        storageState.agentPlanningSessions.activeSessionId = null
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ agentPlanningSessions: storageState.agentPlanningSessions }) })
      return
    }
    if (path === '/api/storage/agent-runtime' && request.method() === 'PUT') {
      const body = request.postDataJSON()
      storageState.agentSessions = body.agentSessions
      storageState.preferences.agentModelSelection = body.agentModelSelection
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
      return
    }
    if (path === '/api/storage/preferences' && request.method() === 'PUT') {
      storageState.preferences = { ...storageState.preferences, ...request.postDataJSON() }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ preferences: storageState.preferences }) })
      return
    }
    if (path === '/api/storage/export' && request.method() === 'GET') {
      if (!storageState.workspace) {
        await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: { code: 'NO_LEARNING_DATA', message: '尚未找到可导出的学习画布。' } }) })
        return
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          format: 'brace-map-chat-learning-data',
          version: 1,
          exportedAt: '2026-08-17T00:00:00.000Z',
          data: {
            workspace: storageState.workspace,
            agentSessions: storageState.agentSessions,
            agentPlanningSessions: storageState.agentPlanningSessions,
          },
        }),
      })
      return
    }
    if (path === '/api/storage/import' && request.method() === 'PUT') {
      const backup = request.postDataJSON()
      storageState = {
        ...storageState,
        workspace: backup.data.workspace,
        agentSessions: backup.data.agentSessions,
        agentPlanningSessions: backup.data.agentPlanningSessions,
      }
      workspaceVersion += 1
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          backup,
          state: storageState,
          storage: { engine: 'sqlite', schemaVersion: 2, workspaceVersion },
        }),
      })
      return
    }
    if (path === '/api/profiles' && request.method() === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ profiles: [profile] }) })
      return
    }
    if (path === '/api/canvas-snapshots/redis-core' && request.method() === 'GET') {
      await route.fulfill({ status: 204, body: '' })
      return
    }
    if (path === '/api/agent' && request.method() === 'POST') {
      const body = request.postDataJSON() as {
        mode: string
        plan?: typeof plan
        observedNodes?: Array<{ id: string }>
        messages?: Array<{ content: string }>
      }
      if (body.mode === 'manage') {
        const reviewed = body.messages?.some((message) => message.content.includes('<operation_review_results>'))
        const management = reviewed
          ? {
              message: '审核结果已经核对，本轮结束。',
              next: 'finish',
              operations: [],
              completionReason: 'no-action',
            }
          : body.observedNodes?.length
            ? {
                message: '当前讨论已经引出一个值得独立学习的新方向。',
                next: 'review',
                operations: [{
                  id: 'create-evidence-branch',
                  type: 'create-child',
                  parentId: 'root-e2e',
                  title: '缓存与数据库职责',
                  brief: '理解缓存和持久化存储的边界',
                  openingPrompt: '从一次对象读取请求开始。',
                  reason: '原会话已经出现值得独立多轮讨论的架构问题。',
                  seedContext: {
                    summary: '父节点正在讨论 Redis 数据结构选型。',
                    sourceMessageIds: ['message-e2e'],
                    question: 'Redis 与数据库应该如何分工？',
                  },
                }],
              }
            : {
                message: '需要先读取目标节点。',
                next: 'read-node',
                readRequest: { nodeId: 'root-e2e', reason: '需要核对真实会话内容。' },
                operations: [],
              }
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ mode: 'manage', management }),
        })
        return
      }
      const latestMessage = body.messages?.at(-1)?.content ?? ''
      if (latestMessage.includes('模拟规划失败')) {
        await route.fulfill({
          status: 429,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'PROVIDER_RATE_LIMITED', message: '接口请求过于频繁，请稍后重试。' } }),
        })
        return
      }
      const response = body.mode === 'discuss'
        ? latestMessage.includes('改为学习 WebSocket')
          ? {
              mode: 'discuss',
              message: { role: 'assistant', content: '学习主题已经更换，需要确认新的目标成果。' },
              readyToInitialize: false,
              nextAction: 'clarify',
              missingInformation: ['WebSocket 学习的目标成果'],
              scopeChanged: true,
            }
          : latestMessage.includes('目标还不明确')
          ? {
              mode: 'discuss',
              message: { role: 'assistant', content: '目前还需要确认最终希望达到的成果。' },
              readyToInitialize: false,
              nextAction: 'clarify',
              missingInformation: ['最终希望达到的可观察成果'],
            }
          : latestMessage.includes('继续补充') || latestMessage.includes('现在就生成')
            ? {
                mode: 'discuss',
                message: { role: 'assistant', content: '我记下了这项补充。' },
                readyToInitialize: false,
                nextAction: 'clarify',
                missingInformation: ['模型误判出的多余信息'],
              }
            : {
                mode: 'discuss',
                message: { role: 'assistant', content: '主题和目标已经明确，可以生成结构草稿。' },
                readyToInitialize: true,
                nextAction: 'offer-generation',
                missingInformation: [],
              }
        : body.mode === 'initialize'
          ? {
              mode: 'initialize',
              message: { role: 'assistant', content: '这是初始划分，请先检查边界、顺序和粒度。' },
              readyToAdopt: true,
              plan,
            }
          : {
              mode: 'revise',
              message: { role: 'assistant', content: '我评估了你的意见，下面是一份待你决定是否接受的调整方案。' },
              readyToAdopt: true,
              plan: latestMessage.includes('增加实战')
                ? { ...(body.plan ?? plan), canvasTitle: 'Redis 数据结构学习（Agent 调整）' }
                : body.plan ?? plan,
            }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(response) })
      return
    }
    if (path === '/api/chat/stream' && request.method() === 'POST') {
      const body = request.postDataJSON() as { messages?: Array<{ content?: string }> }
      const diagnosticFailure = body.messages?.some((message) => message.content?.includes('触发诊断错误'))
      await route.fulfill({
        status: 200,
        contentType: 'application/x-ndjson; charset=utf-8',
        body: diagnosticFailure
          ? [
              JSON.stringify({ type: 'start', profileId: profile.id, protocol: profile.protocol, model: profile.model }),
              JSON.stringify({ type: 'delta', delta: '已经收到的部分回答。' }),
              JSON.stringify({
                type: 'error',
                error: {
                  status: 502,
                  code: 'PROVIDER_STREAM_INTERRUPTED',
                  message: '模拟上游流中断。',
                  requestId: 'request-diagnostic-e2e',
                },
              }),
              '',
            ].join('\n')
          : [
              JSON.stringify({ type: 'start', profileId: profile.id, protocol: profile.protocol, model: profile.model }),
              JSON.stringify({ type: 'delta', delta: '完整会话中的测试回答。' }),
              JSON.stringify({ type: 'done' }),
              '',
            ].join('\n'),
      })
      return
    }
    if (path === '/api/chat' && request.method() === 'POST') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ message: { role: 'assistant', content: '欢迎来到本节点，我们从一个具体问题开始。' } }),
      })
      return
    }
    await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: { message: 'E2E route not mocked' } }) })
  })
}

async function readServerStorageState(page: Page) {
  return page.evaluate(async () => {
    const response = await fetch('/api/storage/state')
    return (await response.json()).state
  })
}

async function readCanvasViewport(page: Page) {
  return page.locator('.react-flow__viewport').evaluate((element) => {
    const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform)
    return { x: matrix.m41, y: matrix.m42, zoom: matrix.a }
  })
}

async function selectPickingText(page: Page, paragraphIndex: number, text: string, reverse = false) {
  await page.evaluate(({ paragraphIndex: targetIndex, text: targetText, reverse: shouldReverse }) => {
    const paragraphs = [...document.querySelectorAll<HTMLElement>('.message-bubble--picking [data-pick-paragraph]')]
    const paragraph = paragraphs[targetIndex]
    if (!paragraph) throw new Error(`Missing picking paragraph ${targetIndex}`)
    const content = paragraph.textContent ?? ''
    const startOffset = content.indexOf(targetText)
    if (startOffset < 0) throw new Error(`Missing picking text: ${targetText}`)

    const locate = (offset: number) => {
      const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT)
      let remaining = offset
      let node = walker.nextNode()
      while (node) {
        const length = node.textContent?.length ?? 0
        if (remaining <= length) return { node, offset: remaining }
        remaining -= length
        node = walker.nextNode()
      }
      throw new Error(`Cannot locate text offset ${offset}`)
    }
    const start = locate(startOffset)
    const end = locate(startOffset + targetText.length)
    const selection = window.getSelection()
    if (!selection) throw new Error('Selection API unavailable')
    selection.removeAllRanges()
    if (shouldReverse) selection.setBaseAndExtent(end.node, end.offset, start.node, start.offset)
    else selection.setBaseAndExtent(start.node, start.offset, end.node, end.offset)
    paragraph.closest('.message-viewport')?.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true,
      pointerId: 1,
      pointerType: 'mouse',
      button: 0,
    }))
  }, { paragraphIndex, text, reverse })
}

async function selectPickingRange(
  page: Page,
  startParagraphIndex: number,
  startText: string,
  endParagraphIndex: number,
  endText: string,
) {
  await page.evaluate((selectionInput) => {
    const paragraphs = [...document.querySelectorAll<HTMLElement>('.message-bubble--picking [data-pick-paragraph]')]
    const startParagraph = paragraphs[selectionInput.startParagraphIndex]
    const endParagraph = paragraphs[selectionInput.endParagraphIndex]
    if (!startParagraph || !endParagraph) throw new Error('Missing picking paragraph for cross-message range')
    const startOffset = (startParagraph.textContent ?? '').indexOf(selectionInput.startText)
    const endStartOffset = (endParagraph.textContent ?? '').indexOf(selectionInput.endText)
    if (startOffset < 0 || endStartOffset < 0) throw new Error('Missing text for cross-message range')
    const locate = (paragraph: HTMLElement, offset: number) => {
      const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT)
      let remaining = offset
      let node = walker.nextNode()
      while (node) {
        const length = node.textContent?.length ?? 0
        if (remaining <= length) return { node, offset: remaining }
        remaining -= length
        node = walker.nextNode()
      }
      throw new Error(`Cannot locate cross-message text offset ${offset}`)
    }
    const start = locate(startParagraph, startOffset)
    const end = locate(endParagraph, endStartOffset + selectionInput.endText.length)
    const selection = window.getSelection()
    if (!selection) throw new Error('Selection API unavailable')
    selection.removeAllRanges()
    selection.setBaseAndExtent(start.node, start.offset, end.node, end.offset)
    startParagraph.closest('.message-viewport')?.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true,
      pointerId: 2,
      pointerType: 'mouse',
      button: 0,
    }))
  }, { startParagraphIndex, startText, endParagraphIndex, endText })
}

test.beforeEach(async ({ page }) => {
  await mockBrowserApi(page)
})

test('only one browser page can hold the project editor lease', async ({ page, context }) => {
  const firstPageLeaseStatuses: number[] = []
  page.on('response', (response) => {
    if (new URL(response.url()).pathname === '/api/editor-lease') {
      firstPageLeaseStatuses.push(response.status())
    }
  })
  await page.goto('/')
  await expect(page.getByRole('combobox', { name: '切换画布' })).toBeVisible()
  expect(firstPageLeaseStatuses.length).toBeGreaterThan(0)
  expect(firstPageLeaseStatuses).not.toContain(423)

  const secondPage = await context.newPage()
  await mockBrowserApi(secondPage)
  await secondPage.route('**/api/storage/preferences', (route) => route.continue())
  await secondPage.goto('/')
  await expect(secondPage.getByRole('heading', { name: '项目已在另一个页面打开' })).toBeVisible()
  await expect(secondPage.getByText('本页不会读取或修改工作区')).toBeVisible()
  await expect.poll(() => secondPage.evaluate(async () => {
    const response = await fetch('/api/storage/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activeProfileId: null }),
    })
    const body = await response.json()
    return { status: response.status, code: body.error?.code }
  })).toEqual({ status: 423, code: 'EDITOR_LEASE_REQUIRED' })

  await page.close()
  await expect(secondPage.getByRole('combobox', { name: '切换画布' })).toBeVisible({ timeout: 8_000 })
  await secondPage.close()
})

test('node replies stream incrementally and stop keeps the partial answer', async ({ page }) => {
  const workspace = workspaceFixture('流式输出测试')
  workspace.canvases[0].nodes[0].data.expanded = true
  workspace.canvases[0].nodes[0].data.messages = []
  await page.addInitScript(({ key, value }) => {
    localStorage.setItem(key, JSON.stringify(value))
    const nativeFetch = window.fetch.bind(window)
    ;(window as typeof window & { __streamAborted?: boolean }).fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (!url.endsWith('/api/chat/stream')) return nativeFetch(input, init)
      const encoder = new TextEncoder()
      const signal = init?.signal
      let laterTimer = 0
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const emit = (event: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
          emit({ type: 'start', profileId: 'profile-e2e', protocol: 'openai-responses', model: 'e2e-model' })
          emit({ type: 'delta', delta: '第一段已经到达。' })
          laterTimer = window.setTimeout(() => {
            emit({ type: 'delta', delta: '这段内容在停止后不应出现。' })
            emit({ type: 'done' })
            controller.close()
          }, 5_000)
          signal?.addEventListener('abort', () => {
            window.clearTimeout(laterTimer)
            ;(window as typeof window & { __streamAborted?: boolean }).__streamAborted = true
            controller.error(new DOMException('Aborted', 'AbortError'))
          }, { once: true })
        },
      })
      return new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8' },
      })
    }
  }, { key: WORKSPACE_KEY, value: workspace })

  await page.goto('/')
  await page.getByRole('textbox', { name: '消息内容' }).fill('请流式回答这个问题。')
  await page.getByRole('button', { name: '发送消息' }).click()

  await expect(page.getByText('第一段已经到达。')).toBeVisible()
  await page.getByRole('button', { name: '停止生成' }).click()
  await expect(page.getByText('已停止生成')).toBeVisible()
  await page.waitForTimeout(200)
  await expect(page.getByText('这段内容在停止后不应出现。')).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => (
    (window as typeof window & { __streamAborted?: boolean }).__streamAborted
  ))).toBe(true)
  await expect(page.getByRole('button', { name: '发送消息' })).toBeVisible()
  await expect(page.getByRole('textbox', { name: '消息内容' })).toBeEnabled()
})

test('stream errors retain the partial answer and expose a request ID for persistent logs', async ({ page }) => {
  const workspace = workspaceFixture('流式诊断测试')
  workspace.canvases[0].nodes[0].data.expanded = true
  workspace.canvases[0].nodes[0].data.messages = []
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), {
    key: WORKSPACE_KEY,
    value: workspace,
  })

  await page.goto('/')
  await page.getByRole('textbox', { name: '消息内容' }).fill('请触发诊断错误。')
  await page.getByRole('button', { name: '发送消息' }).click()

  await expect(page.getByText('已经收到的部分回答。')).toBeVisible()
  await expect(page.getByText('回答未完整生成')).toBeVisible()
  const error = page.getByRole('alert')
  await expect(error).toContainText('模拟上游流中断。')
  await expect(error).toContainText('请求 ID：request-diagnostic-e2e')
})

test('message composer grows to eight lines, scrolls beyond the limit, and resets after sending', async ({ page }) => {
  const workspace = workspaceFixture('输入框自适应高度测试')
  workspace.canvases[0].nodes[0].data.expanded = true
  workspace.canvases[0].nodes[0].data.messages = []
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), {
    key: WORKSPACE_KEY,
    value: workspace,
  })

  await page.goto('/')
  const composer = page.getByRole('textbox', { name: '消息内容' })
  const initialHeight = await composer.evaluate((element) => element.offsetHeight)

  await composer.fill(['第一行', '第二行', '第三行', '第四行'].join('\n'))
  await expect.poll(() => composer.evaluate((element) => element.offsetHeight))
    .toBeGreaterThan(initialHeight)

  await composer.fill(Array.from({ length: 12 }, (_, index) => `第 ${index + 1} 行`).join('\n'))
  const cappedMetrics = await composer.evaluate((element) => {
    const styles = getComputedStyle(element)
    const lineHeight = Number.parseFloat(styles.lineHeight)
    const padding = Number.parseFloat(styles.paddingTop) + Number.parseFloat(styles.paddingBottom)
    const border = Number.parseFloat(styles.borderTopWidth) + Number.parseFloat(styles.borderBottomWidth)
    return {
      height: element.offsetHeight,
      maximumHeight: Math.ceil(lineHeight * 8 + padding + border),
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      overflowY: styles.overflowY,
    }
  })
  expect(cappedMetrics.height).toBeLessThanOrEqual(cappedMetrics.maximumHeight + 1)
  expect(cappedMetrics.scrollHeight).toBeGreaterThan(cappedMetrics.clientHeight)
  expect(cappedMetrics.overflowY).toBe('auto')

  await page.getByRole('button', { name: '发送消息' }).click()
  await expect(composer).toHaveValue('')
  await expect.poll(() => composer.evaluate((element) => element.offsetHeight))
    .toBeCloseTo(initialHeight, 0)
})

test('long messages use a large editor with keyboard save and safe cancellation', async ({ page }) => {
  const workspace = workspaceFixture('长消息编辑测试')
  const node = workspace.canvases[0].nodes[0]
  node.data.expanded = true
  const originalContent = [
    '这是一条较长的 **AI 回答**。',
    '',
    '它包含 Markdown 和多段正文，应该在独立的大编辑器中修改。',
    '',
    '[User]：这段模拟用户的内容需要由用户手动删除。',
  ].join('\n')
  node.data.messages = [{ id: 'assistant-to-edit', role: 'assistant', content: originalContent }]
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), {
    key: WORKSPACE_KEY,
    value: workspace,
  })

  await page.goto('/')
  await page.getByRole('button', { name: '编辑AI消息' }).click()
  const dialog = page.getByRole('dialog', { name: '编辑AI消息' })
  const editor = dialog.getByRole('textbox', { name: '编辑AI消息' })
  await expect(dialog).toBeVisible()
  await expect(editor).toHaveValue(originalContent)
  const editorBox = await editor.boundingBox()
  expect(editorBox?.width ?? 0).toBeGreaterThan(700)
  expect(editorBox?.height ?? 0).toBeGreaterThan(250)

  const repairedContent = '这是一条已经修复的 **AI 回答**。'
  await editor.fill(repairedContent)
  await editor.press('Control+Enter')
  await expect(dialog).toHaveCount(0)
  await expect(page.getByText('这是一条已经修复的')).toBeVisible()
  await expect.poll(async () => {
    const state = await readServerStorageState(page)
    return state.workspace.canvases[0].nodes[0].data.messages[0].content
  }).toBe(repairedContent)

  await page.getByRole('button', { name: '编辑AI消息' }).click()
  await dialog.getByRole('textbox', { name: '编辑AI消息' }).fill('这次修改应被取消。')
  await dialog.getByRole('textbox', { name: '编辑AI消息' }).press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect.poll(async () => {
    const state = await readServerStorageState(page)
    return state.workspace.canvases[0].nodes[0].data.messages[0].content
  }).toBe(repairedContent)
})

test('the latest failed AI answer can be regenerated in place with the original context', async ({ page }) => {
  const workspace = workspaceFixture('重新生成回答测试')
  const root = workspace.canvases[0].nodes[0]
  root.data.expanded = true
  root.data.messages = [
    { id: 'regenerate-user', role: 'user', content: '请解释 TypeScript 的泛型约束。' },
    {
      id: 'regenerate-assistant',
      role: 'assistant',
      content: '回答生成失败，请重试。',
      generationStatus: 'error',
    },
  ]
  const streamRequests: Array<{ messages?: Array<{ role: string; content: string }> }> = []
  const persistedAssistantContents: string[] = []
  page.on('request', (request) => {
    if (new URL(request.url()).pathname !== '/api/storage/workspace' || request.method() !== 'PUT') return
    const body = request.postDataJSON() as ReturnType<typeof workspaceFixture> & {
      workspace?: ReturnType<typeof workspaceFixture>
    }
    const storedMessage = body.workspace?.canvases[0].nodes[0].data.messages
      .find((message) => message.id === 'regenerate-assistant')
    if (storedMessage) persistedAssistantContents.push(storedMessage.content)
  })
  await page.route('**/api/chat/stream', async (route) => {
    streamRequests.push(route.request().postDataJSON())
    await new Promise((resolve) => setTimeout(resolve, 700))
    await route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson; charset=utf-8',
      body: [
        JSON.stringify({ type: 'start', profileId: profile.id, protocol: profile.protocol, model: profile.model }),
        JSON.stringify({ type: 'delta', delta: '泛型约束使用 extends 限定类型参数必须具备的能力。' }),
        JSON.stringify({ type: 'done' }),
        '',
      ].join('\n'),
    })
  })
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), {
    key: WORKSPACE_KEY,
    value: workspace,
  })

  await page.goto('/')
  const rootNode = page.getByRole('article', { name: '会话：测试总目标', exact: true })
  await rootNode.getByRole('button', { name: '重新生成回答' }).click()

  await expect(rootNode.getByText('泛型约束使用 extends 限定类型参数必须具备的能力。')).toBeVisible()
  await expect(rootNode.getByText('回答生成失败，请重试。')).toHaveCount(0)
  await expect(rootNode.locator('.message')).toHaveCount(2)
  expect(streamRequests).toHaveLength(1)
  expect(streamRequests[0].messages).toHaveLength(1)
  expect(streamRequests[0].messages?.[0].role).toBe('user')
  expect(streamRequests[0].messages?.[0].content.match(/请解释 TypeScript 的泛型约束。/g)).toHaveLength(1)
  expect(streamRequests[0].messages?.[0].content).not.toContain('回答生成失败，请重试。')
  expect(persistedAssistantContents.length).toBeGreaterThan(0)
  expect(persistedAssistantContents).not.toContain('')
  await expect.poll(async () => {
    const messages = (await readServerStorageState(page)).workspace?.canvases[0].nodes[0].data.messages
    return messages?.map((message) => ({ id: message.id, role: message.role, content: message.content }))
  }).toEqual([
    { id: 'regenerate-user', role: 'user', content: '请解释 TypeScript 的泛型约束。' },
    {
      id: 'regenerate-assistant',
      role: 'assistant',
      content: '泛型约束使用 extends 限定类型参数必须具备的能力。',
    },
  ])
})

test('expanded conversation nodes resize vertically without changing width', async ({ page }) => {
  const workspace = workspaceFixture('会话高度调整测试')
  workspace.canvases[0].nodes[0].data.expanded = true
  workspace.canvases[0].nodes[0].data.messages = [
    { id: 'message-resize-user', role: 'user', content: '请展开这段会话，验证窗口高度可以调整。' },
    { id: 'message-resize-assistant', role: 'assistant', content: '拖动底部的高度把手，可以增加可见内容区域；窗口宽度保持不变。' },
  ]
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), {
    key: WORKSPACE_KEY,
    value: workspace,
  })

  await page.goto('/')
  const node = page.locator('.conversation-node--expanded')
  const bottomResizeHandle = page.getByRole('separator', { name: '调整节点底部' })
  const topResizeHandle = page.getByRole('separator', { name: '调整节点顶部' })
  await expect(node).toBeVisible()
  await expect(bottomResizeHandle).toBeVisible()
  await expect(topResizeHandle).toBeVisible()

  const initialBox = await node.boundingBox()
  const bottomHandleBox = await bottomResizeHandle.boundingBox()
  if (!initialBox || !bottomHandleBox) throw new Error('无法读取会话节点或底部高度把手的位置。')

  await page.mouse.move(bottomHandleBox.x + bottomHandleBox.width / 2, bottomHandleBox.y + bottomHandleBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(bottomHandleBox.x + bottomHandleBox.width / 2, bottomHandleBox.y + bottomHandleBox.height / 2 + 120)
  await page.mouse.up()

  await expect.poll(async () => (await node.boundingBox())?.height ?? 0).toBeGreaterThan(initialBox.height + 80)
  const bottomResizedBox = await node.boundingBox()
  const topHandleBox = await topResizeHandle.boundingBox()
  if (!bottomResizedBox || !topHandleBox) throw new Error('底部调整后无法读取会话节点尺寸。')
  expect(bottomResizedBox.width).toBeCloseTo(initialBox.width, 0)
  const nodeWrapper = node.locator('xpath=..')
  const bottomWorldY = await nodeWrapper.evaluate((element) => new DOMMatrix(getComputedStyle(element).transform).m42)

  await page.mouse.move(topHandleBox.x + topHandleBox.width / 2, topHandleBox.y + topHandleBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(topHandleBox.x + topHandleBox.width / 2, topHandleBox.y + topHandleBox.height / 2 - 80)
  await page.mouse.up()

  await expect.poll(async () => (await node.boundingBox())?.height ?? 0).toBeGreaterThan(bottomResizedBox.height + 40)
  const topResizedBox = await node.boundingBox()
  if (!topResizedBox) throw new Error('顶部调整后无法读取会话节点尺寸。')
  const topWorldY = await nodeWrapper.evaluate((element) => new DOMMatrix(getComputedStyle(element).transform).m42)
  expect(topWorldY).toBeLessThan(bottomWorldY - 40)
  expect(topResizedBox.width).toBeCloseTo(initialBox.width, 0)
})

test('full conversation view shares node data and restores canvas and reading positions', async ({ page }) => {
  const workspace = workspaceFixture('完整会话模式测试')
  workspace.canvases[0].nodes[0].data.messages = Array.from({ length: 32 }, (_, index) => ({
    id: `focused-message-${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `第 ${index + 1} 条测试消息：用足够长的内容验证完整会话页面能够滚动，并且返回画布后不会丢失阅读位置。`,
  }))
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), {
    key: WORKSPACE_KEY,
    value: workspace,
  })

  await page.goto('/')
  const canvasViewportBefore = await readCanvasViewport(page)
  const canvasNode = page.locator('.conversation-node').filter({ hasText: '测试总目标' })
  const fullConversationButton = canvasNode.getByRole('button', { name: '进入完整会话' })
  await expect(fullConversationButton).toContainText('完整会话')
  await expect(fullConversationButton).toHaveAttribute('title', '以全页面模式查看并继续此节点的全部对话')
  await fullConversationButton.click()

  const focusedView = page.getByRole('region', { name: '完整会话：测试总目标' })
  await expect(focusedView).toBeVisible()
  await expect(page).toHaveURL(/view=conversation/)
  await expect(focusedView.getByRole('textbox', { name: '会话标题' })).toHaveValue('测试总目标')
  await expect(focusedView).toContainText('第 32 条测试消息')
  await expect(page.locator('.app-bar')).toHaveAttribute('inert', '')
  await expect(page.getByRole('region', { name: '会话树画布' })).toHaveAttribute('inert', '')

  await focusedView.getByRole('button', { name: '摘要' }).click()
  await expect(page.getByRole('complementary', { name: '节点摘要' })).toBeVisible()
  await page.getByRole('button', { name: '关闭侧栏' }).click()
  await expect(page.getByRole('complementary', { name: '节点摘要' })).toHaveCount(0)

  await focusedView.getByRole('button', { name: '笔记' }).click()
  const noteDrawer = page.getByRole('complementary', { name: '个人笔记' })
  await expect(noteDrawer).toBeVisible()
  await noteDrawer.getByRole('textbox', { name: '个人笔记' }).fill('从完整会话页面补充的共享笔记。')
  await noteDrawer.getByRole('button', { name: '关闭侧栏' }).click()

  await focusedView.getByRole('textbox', { name: '消息内容' }).fill('这条消息应直接写回当前节点。')
  await focusedView.getByRole('button', { name: '发送消息' }).click()
  await expect(focusedView.getByText('完整会话中的测试回答。')).toBeVisible()

  const messageViewport = focusedView.locator('.message-viewport')
  const targetScrollTop = await messageViewport.evaluate((element) => {
    const target = Math.max(1, Math.min(640, element.scrollHeight - element.clientHeight - 80))
    element.scrollTop = target
    element.dispatchEvent(new Event('scroll', { bubbles: true }))
    return target
  })
  expect(targetScrollTop).toBeGreaterThan(0)
  await expect.poll(() => messageViewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(targetScrollTop - 2)

  await focusedView.getByRole('button', { name: '返回画布' }).click()
  await expect(focusedView).toHaveCount(0)
  await expect(page).not.toHaveURL(/view=conversation/)
  const canvasViewportAfter = await readCanvasViewport(page)
  expect(canvasViewportAfter.x).toBeCloseTo(canvasViewportBefore.x, 4)
  expect(canvasViewportAfter.y).toBeCloseTo(canvasViewportBefore.y, 4)
  expect(canvasViewportAfter.zoom).toBeCloseTo(canvasViewportBefore.zoom, 4)
  await expect.poll(async () => {
    const node = (await readServerStorageState(page)).workspace.canvases[0].nodes[0]
    return {
      note: node.data.note,
      lastMessages: node.data.messages.slice(-2).map((message: { content: string }) => message.content),
    }
  }).toEqual({
    note: '从完整会话页面补充的共享笔记。',
    lastMessages: ['这条消息应直接写回当前节点。', '完整会话中的测试回答。'],
  })

  await canvasNode.getByRole('button', { name: '进入完整会话' }).click()
  await expect(focusedView).toBeVisible()
  await expect.poll(() => focusedView.locator('.message-viewport').evaluate((element) => element.scrollTop))
    .toBeGreaterThan(targetScrollTop - 2)
  await page.goBack()
  await expect(focusedView).toHaveCount(0)
})

test('legacy Agent root prompts migrate to course overview without changing conversation history', async ({ page }) => {
  const workspace = workspaceFixture('旧版 Agent 画布')
  const canvas = workspace.canvases[0]
  canvas.learningGoal = '系统掌握 TypeScript'
  canvas.targetOutcome = '能够完成全栈项目'
  canvas.pathMode = 'course'
  canvas.nodes[0].data.agentOpeningPrompt = '先讲一个 JavaScript 例子，再询问学习者的基础。'
  canvas.nodes[0].data.messages = [
    { id: 'legacy-root-opening', role: 'assistant', content: '这是原有开场，不能在迁移时删除。' },
    { id: 'legacy-root-question', role: 'user', content: '这是原有问题，也必须保留。' },
  ]
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), {
    key: WORKSPACE_KEY,
    value: workspace,
  })

  await page.goto('/')
  await expect.poll(async () => {
    const storedCanvas = (await readServerStorageState(page)).workspace.canvases[0]
    const root = storedCanvas.nodes[0]
    return {
      prompt: root.data.agentOpeningPrompt,
      messages: root.data.messages.map((message: { content: string }) => message.content),
    }
  }).toEqual({
    prompt: expect.stringContaining('<prompt_version>root-overview-v2</prompt_version>'),
    messages: ['这是原有开场，不能在迁移时删除。', '这是原有问题，也必须保留。'],
  })
})

test('an expanded empty Agent root automatically generates its opening after reload', async ({ page }) => {
  const workspace = workspaceFixture('空白顶级节点自动开场')
  const root = workspace.canvases[0].nodes[0]
  root.data.expanded = true
  root.data.messages = []
  root.data.agentOpeningPrompt = '<prompt_version>root-overview-v2</prompt_version>\n请重新介绍课程总览。'
  let openingRequestCount = 0
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/chat' && request.method() === 'POST') {
      openingRequestCount += 1
    }
  })
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), {
    key: WORKSPACE_KEY,
    value: workspace,
  })

  await page.goto('/')
  const rootNode = page.getByRole('article', { name: '会话：测试总目标', exact: true })
  await expect(rootNode.getByText('欢迎来到本节点，我们从一个具体问题开始。')).toBeVisible()
  expect(openingRequestCount).toBe(1)
  await expect.poll(async () => {
    const stored = (await readServerStorageState(page)).workspace?.canvases[0].nodes[0].data.messages
    return stored?.map((message) => message.content)
  }).toEqual(['欢迎来到本节点，我们从一个具体问题开始。'])
})

test('clearing an Agent conversation immediately regenerates one opening', async ({ page }) => {
  const workspace = workspaceFixture('清空后重新开场')
  const root = workspace.canvases[0].nodes[0]
  root.data.expanded = true
  root.data.messages = [{ id: 'old-opening', role: 'assistant', content: '这是需要清除的旧开场。' }]
  root.data.agentOpeningPrompt = '<prompt_version>root-overview-v2</prompt_version>\n请重新介绍课程总览。'
  let openingRequestCount = 0
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/chat' && request.method() === 'POST') {
      openingRequestCount += 1
    }
  })
  page.on('dialog', async (dialog) => {
    expect(dialog.message()).toContain('老师会重新生成本节点的开场白')
    await dialog.accept()
  })
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), {
    key: WORKSPACE_KEY,
    value: workspace,
  })

  await page.goto('/')
  const rootNode = page.getByRole('article', { name: '会话：测试总目标', exact: true })
  await rootNode.getByRole('button', { name: '清空会话' }).click()
  await expect(rootNode.getByText('欢迎来到本节点，我们从一个具体问题开始。')).toBeVisible()
  await expect(rootNode.getByText('这是需要清除的旧开场。')).toHaveCount(0)
  expect(openingRequestCount).toBe(1)
  await expect.poll(async () => {
    const stored = (await readServerStorageState(page)).workspace?.canvases[0].nodes[0].data.messages
    return stored?.map((message) => message.content)
  }).toEqual(['欢迎来到本节点，我们从一个具体问题开始。'])
})

test('an Agent node with conversation history never regenerates its opening on reload or reopen', async ({ page }) => {
  const workspace = workspaceFixture('已有会话不重复开场')
  const root = workspace.canvases[0].nodes[0]
  root.data.expanded = true
  root.data.messages = [
    { id: 'existing-user', role: 'user', content: '这是已经存在的会话。' },
    { id: 'existing-assistant', role: 'assistant', content: '这是已有会话中的回答。' },
  ]
  root.data.agentOpeningPrompt = '<prompt_version>root-overview-v2</prompt_version>\n只在空会话中生成开场。'
  let openingRequestCount = 0
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/chat' && request.method() === 'POST') {
      openingRequestCount += 1
    }
  })
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), {
    key: WORKSPACE_KEY,
    value: workspace,
  })

  await page.goto('/')
  const rootNode = page.getByRole('article', { name: '会话：测试总目标', exact: true })
  await expect(rootNode.getByText('这是已经存在的会话。')).toBeVisible()
  await page.waitForTimeout(500)
  expect(openingRequestCount).toBe(0)

  await rootNode.getByRole('button', { name: '收起会话' }).click()
  await rootNode.getByRole('button', { name: '打开会话' }).click()
  await page.waitForTimeout(500)
  expect(openingRequestCount).toBe(0)
  await expect(rootNode.locator('.message')).toHaveCount(2)
})

test('excerpt mode captures partial reverse selections and keeps multiple excerpts ordered', async ({ page }) => {
  const workspace = workspaceFixture('摘录交互测试')
  workspace.canvases[0].nodes[0].data.messages = [
    { id: 'message-user', role: 'user', content: '第一段内容用于验证反向拖拽。' },
    { id: 'message-assistant', role: 'assistant', content: '第二段会比较整体读写与字段更新。' },
  ]
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), {
    key: WORKSPACE_KEY,
    value: workspace,
  })

  await page.goto('/')
  await page.getByRole('button', { name: '打开会话' }).click()
  await page.getByRole('button', { name: '摘录原文' }).click()
  await selectPickingText(page, 0, '内容用于验证', true)
  await expect(page.getByText(/1 处 · 6 字/)).toBeVisible()
  await selectPickingText(page, 1, '整体读写')
  await expect(page.getByText(/2 处 · 10 字/)).toBeVisible()
  await selectPickingRange(page, 0, '反向拖拽。', 1, '第二段')
  await expect(page.getByText(/3 处 · 18 字/)).toBeVisible()

  await page.getByRole('button', { name: '完成并整理' }).click()
  await page.getByRole('textbox', { name: /父节点背景摘要/ }).fill('父节点正在验证摘录交互。')
  await page.getByRole('button', { name: '确认原文' }).click()
  const excerpts = page.locator('.branch-excerpt p')
  await expect(excerpts).toHaveText(['内容用于验证', '整体读写', '反向拖拽。\n\n第二段'])
})

test('Agent initialization can be adopted directly and keeps adjustments pending until accepted', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '新建画布' }).click()
  await page.getByRole('button', { name: /Agent 规划/ }).click()
  await page.getByRole('textbox', { name: '学习主题规划输入' }).fill('学习 Redis 数据结构，目标是在项目中正确选型。')
  await page.getByRole('button', { name: '发送给 Agent' }).click()

  await expect(page.getByRole('button', { name: '生成结构草稿' })).toBeVisible()
  await page.getByRole('button', { name: '生成结构草稿' }).click()
  await expect(page.getByRole('region', { name: 'Agent 生成的基础结构' })).toBeVisible()
  await expect(page.getByText('可直接采用')).toBeVisible()
  await expect(page.getByRole('button', { name: '采用此结构' })).toBeVisible()

  await page.getByRole('button', { name: '提出调整' }).click()
  await page.getByRole('textbox', { name: '学习主题规划输入' }).fill('请增加实战内容，但先给我调整方案。')
  await page.getByRole('button', { name: '发送给 Agent' }).click()
  await expect(page.getByText('调整方案待确认')).toBeVisible()
  await expect(page.getByRole('button', { name: '保留原方案' })).toBeVisible()
  await expect(page.getByRole('button', { name: '接受此调整' })).toBeVisible()
  await expect.poll(async () => {
    const session = (await readServerStorageState(page)).agentPlanningSessions.sessions[0]
    return [session.plan?.canvasTitle, session.pendingPlan?.canvasTitle]
  }).toEqual(['Redis 数据结构学习', 'Redis 数据结构学习（Agent 调整）'])
  await page.getByRole('button', { name: '接受此调整' }).click()
  await expect(page.getByText('可直接采用')).toBeVisible()

  await page.getByRole('button', { name: '编辑结构' }).click()
  await page.getByRole('textbox', { name: '学习主题', exact: true }).fill('Redis 数据结构学习（手动调整）')
  await page.getByRole('button', { name: '完成编辑' }).click()
  await expect(page.getByText('修改草稿待评价')).toBeVisible()
  await expect(page.getByRole('button', { name: '采用此结构' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '让 Agent 评价修改' })).toBeVisible()

  await page.getByRole('button', { name: '让 Agent 评价修改' }).click()
  await expect(page.getByText('调整方案待确认')).toBeVisible()
  await page.getByRole('button', { name: '接受此调整' }).click()
  await page.getByRole('button', { name: '采用此结构' }).click()
  await expect(page.getByRole('combobox', { name: '切换画布' })).toContainText('Redis 数据结构学习（手动调整）')
  await expect.poll(async () => Boolean(
    (await readServerStorageState(page)).agentPlanningSessions.sessions[0].adoptedCanvasId,
  )).toBe(true)

  await page.getByRole('button', { name: '新建画布' }).click()
  await page.getByRole('button', { name: '查看全部规划会话' }).click()
  await expect(page.getByRole('heading', { name: /已创建画布/ })).toBeVisible()
  await expect(page.locator('.planning-session-library')).toContainText('Redis 数据结构学习（手动调整）')
})

test('adopting a full initialization tree creates every edge and opens only the root teacher', async ({ page }) => {
  const sessionId = 'full-tree-planning-session'
  await page.addInitScript(({ key, session }) => localStorage.setItem(key, JSON.stringify({
    version: 1,
    sessions: [session],
    activeSessionId: session.id,
  })), {
    key: PLANNING_SESSIONS_KEY,
    session: {
      id: sessionId,
      title: fullTreePlan.canvasTitle,
      messages: [
        { role: 'user', content: '请规划一棵完整学习树。' },
        { role: 'assistant', content: '结构已经准备好，可以采用。' },
      ],
      input: '',
      plan: fullTreePlan,
      pendingPlan: null,
      pendingPlanKind: null,
      readyToInitialize: true,
      missingInformation: [],
      readyToAdopt: true,
      createdAt: '2026-08-17T00:00:00.000Z',
      updatedAt: '2026-08-17T00:01:00.000Z',
    },
  })

  await page.goto('/')
  await page.getByRole('button', { name: '新建画布' }).click()
  await page.getByRole('button', { name: `继续 Agent 规划：${fullTreePlan.canvasTitle}` }).click()
  await page.getByRole('button', { name: '采用此结构' }).click()

  await expect.poll(async () => {
    const workspace = (await readServerStorageState(page)).workspace
    const canvas = workspace?.canvases.find((candidate) => candidate.title === fullTreePlan.canvasTitle)
    if (!canvas) return null
    const root = canvas.nodes.find((node) => !node.data.parentId)
    const nonRootMessageCount = canvas.nodes
      .filter((node) => node.data.parentId)
      .reduce((total, node) => total + node.data.messages.length, 0)
    return {
      nodes: canvas.nodes.length,
      edges: canvas.edges.length,
      rootMessages: root?.data.messages.length ?? 0,
      nonRootMessageCount,
    }
  }).toEqual({ nodes: 24, edges: 23, rootMessages: 1, nonRootMessageCount: 0 })

  await expect(page.locator('article.conversation-node')).toHaveCount(8)
  await expect(page.getByText('学习 · 8/24 个节点')).toBeVisible()
  await expect(page.getByRole('article', { name: '会话：章节 1.1' })).toHaveCount(0)

  const firstChapter = page.getByRole('article', { name: '会话：章节 1', exact: true })
  const viewportBeforeExpansion = await readCanvasViewport(page)
  await firstChapter.getByRole('button', { name: '打开会话' }).click()
  await expect(page.getByText('学习 · 11/24 个节点')).toBeVisible()
  await expect(page.getByRole('article', { name: '会话：章节 1.1' })).toBeVisible()
  await expect.poll(async () => (
    Math.abs((await readCanvasViewport(page)).zoom - viewportBeforeExpansion.zoom)
  )).toBeLessThan(0.01)
  await expect.poll(async () => {
    const workspace = (await readServerStorageState(page)).workspace
    const canvas = workspace?.canvases.find((candidate) => candidate.title === fullTreePlan.canvasTitle)
    const chapter = canvas?.nodes.find((node) => node.data.title === '章节 1')
    return chapter?.data.messages.length ?? 0
  }).toBe(1)

  await firstChapter.getByRole('button', { name: '收起会话' }).click()
  await expect(page.getByText('学习 · 8/24 个节点')).toBeVisible()
  await expect(page.getByRole('article', { name: '会话：章节 1.1' })).toHaveCount(0)

  await page.getByRole('button', { name: '全树概览' }).click()
  await expect(page.getByText('概览 · 24/24 个节点')).toBeVisible()
  await expect(page.locator('article.conversation-node')).toHaveCount(24)
  await expect(page.getByRole('button', { name: '收起会话' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '整理整棵树' })).toBeEnabled()
  await page.getByRole('button', { name: '整理整棵树' }).click()

  await page.getByRole('button', { name: '返回学习视图' }).click()
  await expect(page.getByText('学习 · 8/24 个节点')).toBeVisible()
  await expect(page.locator('article.conversation-node')).toHaveCount(8)
  await expect(page.getByRole('button', { name: '整理当前分支' })).toBeEnabled()
  await page.getByRole('button', { name: '整理当前分支' }).click()
})

test('failed planning requests restore the input without polluting conversation context', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '新建画布' }).click()
  await page.getByRole('button', { name: /Agent 规划/ }).click()
  const composer = page.getByRole('textbox', { name: '学习主题规划输入' })
  await composer.fill('模拟规划失败')
  await page.getByRole('button', { name: '发送给 Agent' }).click()

  await expect(page.getByRole('alert')).toContainText('接口请求过于频繁')
  await expect(composer).toHaveValue('模拟规划失败')
  await expect.poll(async () => {
    const session = (await readServerStorageState(page)).agentPlanningSessions.sessions[0]
    return session.messages.filter((message: { content: string }) => message.content === '模拟规划失败').length
  }).toBe(0)
})

test('new canvas shows only the three most recently updated unfinished planning sessions', async ({ page }) => {
  const session = (id: string, title: string, updatedAt: string) => ({
    id,
    title,
    messages: [{ role: 'user', content: `学习 ${title}` }],
    input: '',
    plan: null,
    readyToInitialize: false,
    missingInformation: [],
    readyToAdopt: false,
    createdAt: updatedAt,
    updatedAt,
  })
  await page.addInitScript(({ key, sessions }) => localStorage.setItem(key, JSON.stringify({
    version: 1,
    sessions,
    activeSessionId: null,
  })), {
    key: PLANNING_SESSIONS_KEY,
    sessions: [
      session('one', '第一份规划', '2026-08-10T00:00:00.000Z'),
      session('four', '第四份规划', '2026-08-13T00:00:00.000Z'),
      session('two', '第二份规划', '2026-08-11T00:00:00.000Z'),
      session('three', '第三份规划', '2026-08-12T00:00:00.000Z'),
    ],
  })

  await page.goto('/')
  await page.getByRole('button', { name: '新建画布' }).click()

  await expect(page.locator('.recent-planning-sessions .planning-session-main strong')).toHaveText([
    '第四份规划',
    '第三份规划',
    '第二份规划',
  ])
  await expect(page.getByLabel('未采用的 Agent 规划草稿')).not.toContainText('第一份规划')
})

test('Agent setup keeps generation available while requirements are supplemented', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '新建画布' }).click()
  await page.getByRole('button', { name: /Agent 规划/ }).click()
  const input = page.getByRole('textbox', { name: '学习主题规划输入' })
  await input.fill('学习代理协议，目标是能设计实际系统。')
  await page.getByRole('button', { name: '发送给 Agent' }).click()
  await expect(page.getByRole('button', { name: '生成结构草稿' })).toBeVisible()

  await input.fill('继续补充：案例要偏向 AI Agent 之间的通信。')
  await page.getByRole('button', { name: '发送给 Agent' }).click()
  await expect(page.getByRole('button', { name: '生成结构草稿' })).toBeVisible()
  await expect(page.getByText('模型误判出的多余信息')).toHaveCount(0)
})

test('Agent setup explains missing information and explicit generation intent offers confirmation', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '新建画布' }).click()
  await page.getByRole('button', { name: /Agent 规划/ }).click()
  const input = page.getByRole('textbox', { name: '学习主题规划输入' })
  await input.fill('我想学习代理协议，但目标还不明确。')
  await page.getByRole('button', { name: '发送给 Agent' }).click()
  await expect(page.getByLabel('生成结构前还需确认')).toContainText('最终希望达到的可观察成果')
  await expect(page.getByRole('button', { name: '生成结构草稿' })).toHaveCount(0)

  await input.fill('目标是能完成协议选型，现在就生成结构草稿吧。')
  await page.getByRole('button', { name: '发送给 Agent' }).click()
  await expect(page.getByRole('button', { name: '生成结构草稿' })).toBeVisible()
})

test('Agent setup withdraws generation only when the confirmed scope is explicitly replaced', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '新建画布' }).click()
  await page.getByRole('button', { name: /Agent 规划/ }).click()
  const input = page.getByRole('textbox', { name: '学习主题规划输入' })
  await input.fill('学习代理协议，目标是能设计实际系统。')
  await page.getByRole('button', { name: '发送给 Agent' }).click()
  await expect(page.getByRole('button', { name: '生成结构草稿' })).toBeVisible()

  await input.fill('我改为学习 WebSocket，前面的代理协议主题作废。')
  await page.getByRole('button', { name: '发送给 Agent' }).click()
  await expect(page.getByRole('button', { name: '生成结构草稿' })).toHaveCount(0)
  await expect(page.getByLabel('生成结构前还需确认')).toContainText('WebSocket 学习的目标成果')
})

test('a legacy Agent setup draft migrates, survives refresh, and becomes directly adoptable', async ({ page }) => {
  await page.addInitScript(({ key, draft }) => localStorage.setItem(key, JSON.stringify(draft)), {
    key: SETUP_DRAFT_KEY,
    draft: {
      version: 1,
      messages: [
        { role: 'user', content: '学习 Redis 选型' },
        { role: 'assistant', content: '这是草稿，请继续评审。' },
      ],
      input: '',
      plan,
      readyToInitialize: true,
      readyToAdopt: false,
      updatedAt: '2026-08-11T00:00:00.000Z',
    },
  })
  await page.goto('/')
  await page.getByRole('button', { name: '新建画布' }).click()
  const continuePlanning = page.getByRole('button', { name: /继续 Agent 规划/ })
  await expect(continuePlanning).toContainText('结构可直接采用')
  await continuePlanning.click()
  await expect(page.getByText('可直接采用')).toBeVisible()
  await expect(page.getByRole('button', { name: '采用此结构' })).toBeVisible()

  await page.reload()
  await page.getByRole('button', { name: '新建画布' }).click()
  await expect(page.getByRole('button', { name: /继续 Agent 规划/ })).toContainText('结构可直接采用')
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), SETUP_DRAFT_KEY)).toBeNull()
  await expect.poll(async () => (await readServerStorageState(page)).agentPlanningSessions.sessions.length).toBe(1)
})

test('a saved Agent planning session can be deleted without leaving the new-canvas chooser', async ({ page }) => {
  await page.addInitScript(({ key }) => localStorage.setItem(key, JSON.stringify({
    version: 1,
    messages: [{ role: 'user', content: '这是一份准备舍弃的代理协议草稿' }],
    input: '',
    plan: null,
    readyToInitialize: false,
    missingInformation: [],
    readyToAdopt: false,
    updatedAt: '2026-08-11T00:00:00.000Z',
  })), { key: SETUP_DRAFT_KEY })
  await page.goto('/')
  await page.getByRole('button', { name: '新建画布' }).click()
  await expect(page.getByLabel('未采用的 Agent 规划草稿')).toContainText('这是一份准备舍弃的代理协议草稿')

  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: /删除规划会话/ }).click()
  await expect(page.getByRole('button', { name: '新建 Agent 规划' })).toBeVisible()
  await expect(page.getByLabel('未采用的 Agent 规划草稿')).toHaveCount(0)
  await expect.poll(async () => (await readServerStorageState(page)).agentPlanningSessions.sessions.length).toBe(0)
})

test('opening a planning session without editing does not change its update time', async ({ page }) => {
  const updatedAt = '2026-08-11T07:08:09.000Z'
  await page.addInitScript(({ key, session }) => localStorage.setItem(key, JSON.stringify({
    version: 1,
    sessions: [session],
    activeSessionId: session.id,
  })), {
    key: PLANNING_SESSIONS_KEY,
    session: {
      id: 'view-only-session',
      title: '只查看、不更新时间',
      messages: [{ role: 'user', content: '这份规划只用于查看。' }],
      input: '',
      plan: null,
      pendingPlan: null,
      pendingPlanKind: null,
      readyToInitialize: false,
      missingInformation: [],
      readyToAdopt: false,
      createdAt: updatedAt,
      updatedAt,
    },
  })

  await page.goto('/')
  await page.getByRole('button', { name: '新建画布' }).click()
  await page.getByRole('button', { name: '继续 Agent 规划：只查看、不更新时间' }).click()
  await page.waitForTimeout(250)
  await page.getByRole('button', { name: '关闭' }).click()

  await expect.poll(async () => (
    await readServerStorageState(page)
  ).agentPlanningSessions.sessions[0].updatedAt).toBe(updatedAt)
})

test('starting a new Agent planning session preserves the existing planning conversation', async ({ page }) => {
  await page.addInitScript(({ key }) => localStorage.setItem(key, JSON.stringify({
    version: 1,
    messages: [
      { role: 'user', content: '旧主题：学习代理协议' },
      { role: 'assistant', content: '旧草稿对话不应进入新规划。' },
    ],
    input: '旧的未发送输入',
    plan: null,
    readyToInitialize: true,
    missingInformation: [],
    readyToAdopt: false,
    updatedAt: '2026-08-11T00:00:00.000Z',
  })), { key: SETUP_DRAFT_KEY })
  await page.goto('/')
  await page.getByRole('button', { name: '新建画布' }).click()

  await page.getByRole('button', { name: '新建 Agent 规划' }).click()
  await expect(page.getByRole('heading', { name: '建立学习主题' })).toBeVisible()
  await expect(page.getByText('旧草稿对话不应进入新规划。')).toHaveCount(0)
  await expect(page.getByRole('textbox', { name: '学习主题规划输入' })).toHaveValue('')
  await expect.poll(async () => (await readServerStorageState(page)).agentPlanningSessions.sessions.length).toBe(2)

  await page.getByRole('button', { name: '关闭' }).click()
  await page.getByRole('button', { name: '新建画布' }).click()
  await expect(page.getByLabel('未采用的 Agent 规划草稿')).toContainText('旧主题：学习代理协议')
})

test('settings exports complete learning data and imports a validated replacement', async ({ page }, testInfo) => {
  await page.addInitScript(({ key, workspace }) => localStorage.setItem(key, JSON.stringify(workspace)), {
    key: WORKSPACE_KEY,
    workspace: workspaceFixture(),
  })
  await page.goto('/')
  await page.getByRole('button', { name: '设置' }).click()

  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出备份' }).click()
  const download = await downloadPromise
  const downloadedPath = await download.path()
  assertPath(downloadedPath)
  const backup = JSON.parse(await readFile(downloadedPath, 'utf8'))
  expect(backup.format).toBe('brace-map-chat-learning-data')
  expect(backup.data.workspace.canvases[0].nodes[0].data.note).toBe('这条笔记也必须进入备份。')
  expect(JSON.stringify(backup)).not.toContain('apiKey')

  backup.data.workspace.canvases[0].title = '导入成功的新画布'
  backup.data.workspace.canvases[0].nodes[0].data.title = '导入成功的新总目标'
  const importPath = testInfo.outputPath('learning-data-import.json')
  await writeFile(importPath, JSON.stringify(backup), 'utf8')
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByLabel('选择学习数据备份文件').setInputFiles(importPath)

  await expect(page.getByText(/已导入1 个画布/)).toBeVisible()
  await page.getByRole('button', { name: '关闭设置' }).click()
  await expect(page.getByRole('combobox', { name: '切换画布' })).toContainText('导入成功的新画布')
  await expect(page.getByRole('article', { name: '会话：导入成功的新总目标' })).toBeVisible()
})

test('invalid backup files show an error and preserve current learning data', async ({ page }, testInfo) => {
  await page.addInitScript(({ key, workspace }) => localStorage.setItem(key, JSON.stringify(workspace)), {
    key: WORKSPACE_KEY,
    workspace: workspaceFixture('不能被覆盖的画布'),
  })
  await page.goto('/')
  await page.getByRole('button', { name: '设置' }).click()
  const invalidPath = testInfo.outputPath('invalid-backup.json')
  await writeFile(invalidPath, JSON.stringify({ format: 'unknown', version: 1 }), 'utf8')
  await page.getByLabel('选择学习数据备份文件').setInputFiles(invalidPath)

  await expect(page.getByRole('alert')).toContainText('不是受支持的 Brace Map Chat')
  const currentTitle = (await readServerStorageState(page)).workspace.canvases[0].title
  expect(currentTitle).toBe('不能被覆盖的画布')
})

test('/re resumes a canvas Agent session and /model switches the session model', async ({ page }) => {
  await page.addInitScript(({ workspaceKey, sessionsKey, workspace, sessions }) => {
    localStorage.setItem(workspaceKey, JSON.stringify(workspace))
    localStorage.setItem(sessionsKey, JSON.stringify(sessions))
  }, {
    workspaceKey: WORKSPACE_KEY,
    sessionsKey: AGENT_SESSIONS_KEY,
    workspace: workspaceFixture('命令测试画布'),
    sessions: [{
      id: 'session-e2e',
      canvasId: 'canvas-e2e',
      canvasTitle: '命令测试画布',
      title: '已有的学习规划会话',
      messages: [
        { role: 'user', content: '请检查当前学习路径。' },
        { role: 'assistant', content: '当前路径从基础到实践。' },
      ],
      operations: [],
      createdAt: '2026-08-11T00:00:00.000Z',
      updatedAt: '2026-08-11T00:10:00.000Z',
    }],
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Agent' }).click()
  const composer = page.getByRole('textbox', { name: /输入消息，或使用/ })
  await composer.fill('/re')
  await composer.press('Enter')
  await expect(page.getByText('/resume', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: /^已有的学习规划会话/ }).click()
  await expect(page.getByText('已恢复“已有的学习规划会话”')).toBeVisible()
  await expect(page.getByText('当前路径从基础到实践。')).toBeVisible()

  await composer.fill('/model e2e-override-model')
  await composer.press('Enter')
  await expect(page.getByText('Agent 模型已切换为 E2E 模型 / e2e-override-model')).toBeVisible()
  await expect(page.getByText('E2E 模型 / e2e-override-model', { exact: true })).toBeVisible()
})

test('/inspect displays real message evidence and rejects a stale operation after the canvas changes', async ({ page }) => {
  await page.addInitScript(({ key, workspace }) => localStorage.setItem(key, JSON.stringify(workspace)), {
    key: WORKSPACE_KEY,
    workspace: workspaceFixture('巡检测试画布'),
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Agent' }).click()
  const composer = page.getByRole('textbox', { name: /输入消息，或使用/ })
  await composer.fill('/inspect')
  await composer.press('Enter')
  await expect(page.getByText('/inspect', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '开始巡检' }).click()

  await expect(page.getByText('Agent 已暂停，等待你审核操作。')).toBeVisible()
  await expect(page.getByText('缓存与数据库职责', { exact: false })).toBeVisible()
  await page.getByText('查看分支依据与起始问题').click()
  await expect(page.getByText('父节点正在讨论 Redis 数据结构选型。')).toBeVisible()
  await expect(page.getByText('用户：这条消息必须进入备份。')).toBeVisible()
  await expect(page.getByText('Redis 与数据库应该如何分工？')).toBeVisible()

  page.once('dialog', (dialog) => dialog.accept('巡检后已修改的画布'))
  await page.getByRole('button', { name: '重命名当前画布' }).click()
  await page.getByRole('button', { name: '应用' }).click()
  await expect(page.getByText('画布在提案后发生了变化。请让 Agent 基于最新工作区重新生成提案。')).toBeVisible()
  await expect(page.getByRole('article', { name: '会话：缓存与数据库职责' })).toHaveCount(0)
})

function assertPath(value: string | null): asserts value is string {
  expect(value).not.toBeNull()
}
