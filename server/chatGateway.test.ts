import assert from 'node:assert/strict'
import test from 'node:test'
import type { ChatRequest } from '../src/shared/chat.ts'
import {
  buildUpstreamRequest,
  extractModelList,
  extractProviderText,
  parseWithSingleJsonRepair,
  resolveModelListUrl,
  resolveUpstreamUrl,
} from './chatGateway.ts'
import {
  AgentJsonParseError,
  agentJsonRepairProviderInput,
  agentProviderInput,
  parseAgentAnalysis,
  parseAgentDiscussion,
  parseAgentManagement,
  parseAgentNodeSummary,
  parseAgentPlanReview,
  parseAgentTreePlan,
  validateAgentManagementEvidence,
  validateAgentRequest,
} from './learningAgent.ts'
import { validateCanvasSnapshot } from './canvasSnapshotStore.ts'
import type { StoredModelProfile } from './modelProfiles.ts'
import { ProviderSseDecoder } from './providerStream.ts'

const request: ChatRequest = {
  profileId: 'profile-test',
  messages: [{ role: 'user', content: '解释闭包' }],
  sourceQuote: '函数会记住词法作用域',
}

test('OpenAI Responses protocol maps fields and extracts text', () => {
  const profile: StoredModelProfile = {
    id: 'openai-test',
    name: 'OpenAI Test',
    protocol: 'openai-responses',
    apiKey: 'openai-test-key',
    requestUrl: 'https://api.openai.com/v1/responses',
    model: 'test-openai-model',
  }
  const upstream = buildUpstreamRequest(profile, request)
  const body = JSON.parse(upstream.init.body as string)
  const headers = upstream.init.headers as Record<string, string>

  assert.equal(upstream.url, 'https://api.openai.com/v1/responses')
  assert.equal(headers.Authorization, 'Bearer openai-test-key')
  assert.equal(body.model, 'test-openai-model')
  assert.equal(body.store, false)
  assert.match(body.input[0].content, /<source_quote>/)
  assert.equal(
    extractProviderText('openai-responses', {
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'OpenAI reply' }] }],
    }),
    'OpenAI reply',
  )
})

test('Anthropic Messages protocol maps headers and extracts text', () => {
  const profile: StoredModelProfile = {
    id: 'anthropic-test',
    name: 'Anthropic Test',
    protocol: 'anthropic-messages',
    apiKey: 'anthropic-test-key',
    requestUrl: 'https://api.anthropic.com/v1/messages',
    model: 'test-anthropic-model',
  }
  const upstream = buildUpstreamRequest(profile, request)
  const body = JSON.parse(upstream.init.body as string)
  const headers = upstream.init.headers as Record<string, string>

  assert.equal(upstream.url, 'https://api.anthropic.com/v1/messages')
  assert.equal(headers['x-api-key'], 'anthropic-test-key')
  assert.equal(headers['anthropic-version'], '2023-06-01')
  assert.equal(body.model, 'test-anthropic-model')
  assert.equal(
    extractProviderText('anthropic-messages', { content: [{ type: 'text', text: 'Anthropic reply' }] }),
    'Anthropic reply',
  )
})

test('structured Agent calls can request a larger provider output budget', () => {
  const anthropicProfile: StoredModelProfile = {
    id: 'anthropic-agent-test',
    name: 'Anthropic Agent Test',
    protocol: 'anthropic-messages',
    apiKey: 'anthropic-test-key',
    requestUrl: 'https://api.anthropic.com/v1/messages',
    model: 'test-anthropic-model',
  }
  const openAiProfile: StoredModelProfile = {
    ...anthropicProfile,
    id: 'openai-agent-test',
    protocol: 'openai-responses',
    requestUrl: 'https://api.openai.com/v1/responses',
  }
  const anthropicBody = JSON.parse(buildUpstreamRequest(anthropicProfile, request, undefined, 8192).init.body as string)
  const openAiBody = JSON.parse(buildUpstreamRequest(openAiProfile, request, undefined, 8192).init.body as string)

  assert.equal(anthropicBody.max_tokens, 8192)
  assert.equal(openAiBody.max_output_tokens, 8192)
})

test('streaming requests enable the selected upstream protocol', () => {
  const openAiProfile: StoredModelProfile = {
    id: 'openai-stream-test',
    name: 'OpenAI Stream Test',
    protocol: 'openai-responses',
    apiKey: 'test-key',
    requestUrl: 'https://api.openai.com/v1/responses',
    model: 'test-model',
  }
  const anthropicProfile: StoredModelProfile = {
    ...openAiProfile,
    id: 'anthropic-stream-test',
    protocol: 'anthropic-messages',
    requestUrl: 'https://api.anthropic.com/v1/messages',
  }

  const openAiBody = JSON.parse(buildUpstreamRequest(openAiProfile, request, undefined, undefined, true).init.body as string)
  const anthropicBody = JSON.parse(buildUpstreamRequest(anthropicProfile, request, undefined, undefined, true).init.body as string)
  assert.equal(openAiBody.stream, true)
  assert.equal(anthropicBody.stream, true)
})

test('OpenAI Responses SSE remains correct when event frames cross chunks', () => {
  const decoder = new ProviderSseDecoder('openai-responses')
  const events = [
    ...decoder.push('event: response.output_text.delta\r\ndata: {"type":"response.output_'),
    ...decoder.push('text.delta","delta":"你'),
    ...decoder.push('好"}\r\n\r\ndata: {"type":"response.completed"}\r'),
    ...decoder.push('\n\r\n'),
    ...decoder.finish(),
  ]

  assert.deepEqual(events, [
    { type: 'delta', delta: '你好' },
    { type: 'done' },
  ])
})

test('Anthropic and compatible Chat Completions SSE produce unified deltas', () => {
  const anthropic = new ProviderSseDecoder('anthropic-messages')
  const compatible = new ProviderSseDecoder('openai-responses')

  assert.deepEqual(anthropic.push(
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"分段"}}\n\n',
  ), [{ type: 'delta', delta: '分段' }])
  assert.deepEqual(compatible.push(
    'data: {"choices":[{"delta":{"content":"兼容输出"}}]}\n\ndata: [DONE]\n\n',
  ), [
    { type: 'delta', delta: '兼容输出' },
    { type: 'done' },
  ])
})

test('a clean provider EOF after visible text is accepted as an implicit completion', () => {
  const decoder = new ProviderSseDecoder('anthropic-messages')
  const events = [
    ...decoder.push(
      'event: message_start\ndata: {"type":"message_start"}\n\n'
      + 'event: content_block_start\ndata: {"type":"content_block_start","content_block":{"type":"text","text":""}}\n\n'
      + 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"回答完整。"}}\n\n',
    ),
    ...decoder.finish(),
  ]

  assert.deepEqual(events, [
    { type: 'delta', delta: '回答完整。' },
    { type: 'done', implicit: true },
  ])
})

test('a clean provider EOF with thinking only is not treated as complete', () => {
  const decoder = new ProviderSseDecoder('anthropic-messages')
  const events = [
    ...decoder.push(
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"尚未作答"}}\n\n',
    ),
    ...decoder.finish(),
  ]

  assert.deepEqual(events, [])
})

test('provider SSE error events retain a safe display message', () => {
  const decoder = new ProviderSseDecoder('openai-responses')
  assert.deepEqual(decoder.push(
    'event: error\ndata: {"type":"error","message":"upstream stopped"}\n\n',
  ), [{ type: 'error', message: 'upstream stopped' }])
})

test('service root URLs are expanded to the selected protocol endpoint', () => {
  assert.equal(
    resolveUpstreamUrl('openai-responses', 'https://gateway.example.com/'),
    'https://gateway.example.com/v1/responses',
  )
  assert.equal(
    resolveUpstreamUrl('anthropic-messages', 'https://gateway.example.com'),
    'https://gateway.example.com/v1/messages',
  )
  assert.equal(
    resolveUpstreamUrl('anthropic-messages', 'https://gateway.example.com/v1'),
    'https://gateway.example.com/v1/messages',
  )
})

test('complete endpoint URLs remain unchanged and compatible proxy text is accepted', () => {
  assert.equal(
    resolveUpstreamUrl('anthropic-messages', 'https://gateway.example.com/custom/messages?channel=study'),
    'https://gateway.example.com/custom/messages?channel=study',
  )
  assert.equal(
    extractProviderText('anthropic-messages', {
      choices: [{ message: { content: 'Compatible proxy reply' } }],
    }),
    'Compatible proxy reply',
  )
})

test('provider URLs reject embedded credentials', () => {
  assert.throws(
    () => resolveUpstreamUrl('openai-responses', 'https://user:password@example.com/v1'),
    (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'URL_CREDENTIALS_NOT_ALLOWED'),
  )
})

test('OpenAI model discovery derives endpoints and normalizes compatible lists', () => {
  assert.equal(
    resolveModelListUrl('https://api.openai.com/v1/responses'),
    'https://api.openai.com/v1/models',
  )
  assert.equal(
    resolveModelListUrl('https://gateway.example.com/', 'https://catalog.example.com/custom/models'),
    'https://catalog.example.com/custom/models',
  )
  assert.deepEqual(
    extractModelList({ data: [
      { id: 'gpt-test', owned_by: 'provider' },
      { id: 'gpt-other' },
      { id: 'gpt-test' },
    ] }),
    [
      { id: 'gpt-other' },
      { id: 'gpt-test', ownedBy: 'provider' },
    ],
  )
})

test('Agent requests accept a session-level model override', () => {
  const result = validateAgentRequest({
    profileId: 'profile-test',
    model: 'override-model',
    mode: 'manage',
    messages: [{ role: 'user', content: '分析当前树' }],
    canvas: {
      id: 'canvas',
      revision: 1,
      title: 'Redis',
      learningGoal: '掌握 Redis',
      nodes: [{ id: 'root', title: 'Redis', brief: 'Redis 学习', status: 'learning', messageCount: 1 }],
    },
  })
  assert.equal(result.model, 'override-model')
})

test('Agent node summaries receive the complete transcript and system-owned source IDs', () => {
  const request = validateAgentRequest({
    profileId: 'profile-test',
    mode: 'summarize-node',
    node: {
      id: 'node-test',
      title: 'Redis Hash',
      brief: '理解 Hash 的场景与实现',
      messages: [
        { id: 'message-1', role: 'user', content: '先讨论对象存储。' },
        { id: 'message-2', role: 'assistant', content: 'Hash 适合局部字段更新。' },
        { id: 'message-3', role: 'user', content: '只提一次：我还不理解 listpack。' },
      ],
    },
  })
  const input = agentProviderInput(request)
  assert.match(input.messages[0].content, /先讨论对象存储/)
  assert.match(input.messages[0].content, /我还不理解 listpack/)

  const summary = parseAgentNodeSummary(JSON.stringify({
    topic: 'Redis Hash',
    mastered: [],
    keyPoints: ['适合局部字段更新'],
    unresolvedQuestions: ['listpack 的作用'],
    nextRecommendations: ['继续学习底层编码'],
    sourceMessageIds: ['model-invented-id'],
  }), request.node!.messages.map((message) => message.id))
  assert.deepEqual(summary.sourceMessageIds, ['message-1', 'message-2', 'message-3'])
  assert.deepEqual(summary.unresolvedQuestions, ['listpack 的作用'])
})

test('Agent initialization accepts fenced JSON and normalizes a bounded tree', () => {
  const plan = parseAgentTreePlan(`\`\`\`json
  {
    "canvasTitle": "Redis 数据结构",
    "learningGoal": "掌握核心数据结构",
    "targetOutcome": "能在项目中正确选型",
    "pathMode": "project",
    "root": { "title": "掌握 Redis 数据结构", "purpose": "协调完整学习路径", "openingPrompt": "从 Redis 能解决的真实后端问题出发，介绍整条学习路线。" },
    "chapters": [
      { "title": "基础模型", "purpose": "理解键和值", "openingPrompt": "先用一个最小例子解释 Redis 的键值模型。" },
      { "title": "String", "purpose": "掌握字符串及计数场景", "openingPrompt": "从计数器场景开始，解释 String 适合解决什么问题。" },
      { "title": "Hash", "purpose": "掌握对象存储场景", "openingPrompt": "请用一个对象存储例子引导我理解 Hash。", "children": [
        { "title": "Hash 底层编码", "brief": "理解 listpack 和哈希表", "openingPrompt": "从小对象的紧凑存储开始。" }
      ] }
    ]
  }
  \`\`\``)

  assert.equal(plan.pathMode, 'project')
  assert.equal(plan.chapters.length, 3)
  assert.equal(plan.root.title, '掌握 Redis 数据结构')
  assert.match(plan.root.brief, /完整学习路径/)
  assert.match(plan.root.openingPrompt, /学习路线/)
  assert.match(plan.chapters[0].openingPrompt, /键值模型/)
  assert.equal(plan.chapters[2].children?.[0].title, 'Hash 底层编码')
})

test('structured Agent output gets one syntax-only JSON repair attempt', async () => {
  let repairs = 0
  const result = await parseWithSingleJsonRepair(
    '{"overview":"结构待评审",',
    parseAgentAnalysis,
    async (malformed) => {
      repairs += 1
      assert.match(agentJsonRepairProviderInput(malformed).messages[0].content, /JSON-encoded string/)
      return '{"overview":"结构待评审","proposals":[]}'
    },
  )
  assert.equal(repairs, 1)
  assert.equal(result.overview, '结构待评审')
})

test('a failed repair returns the original readable syntax error without looping', async () => {
  let repairs = 0
  const original = new AgentJsonParseError('首次结构无法解析。')
  const parser = (content: string) => {
    if (content === 'first') throw original
    throw new AgentJsonParseError('修复结果仍然无效。')
  }
  await assert.rejects(
    () => parseWithSingleJsonRepair('first', parser, async () => {
      repairs += 1
      return 'second'
    }),
    (error) => error === original,
  )
  assert.equal(repairs, 1)
})

test('semantic Agent validation errors are not sent through JSON repair', async () => {
  let repairs = 0
  const semanticallyInvalidPlan = JSON.stringify({
    canvasTitle: 'Redis', learningGoal: '掌握 Redis', targetOutcome: '能够选型', pathMode: 'course',
    root: { title: 'Redis', brief: '学习 Redis', openingPrompt: '开始学习。' },
    chapters: [
      { title: 'String', brief: 'String', openingPrompt: '开始 String。' },
      { title: 'Hash', brief: 'Hash', openingPrompt: '开始 Hash。' },
    ],
  })
  await assert.rejects(
    () => parseWithSingleJsonRepair(semanticallyInvalidPlan, parseAgentTreePlan, async () => {
      repairs += 1
      return '{}'
    }),
    /3 到 7 个基础章节/,
  )
  assert.equal(repairs, 0)
})

test('Agent plan review exposes the model readiness flag when the caller allows adoption', () => {
  const response = JSON.stringify({
    message: '这套结构先建立共同基础，再进入数据结构选型。请重点确认是否需要项目实践章节。',
    readyToAdopt: true,
    plan: {
      canvasTitle: 'Redis 数据结构',
      learningGoal: '掌握核心数据结构',
      targetOutcome: '能在项目中正确选型',
      pathMode: 'project',
      root: { title: '掌握 Redis 数据结构', brief: '协调完整学习路径', openingPrompt: '介绍学习路线。' },
      chapters: [
        { title: '基础模型', brief: '理解键和值', openingPrompt: '从键值模型开始。' },
        { title: 'String', brief: '掌握字符串场景', openingPrompt: '从计数器开始。' },
        { title: 'Hash', brief: '掌握对象存储场景', openingPrompt: '从对象存储开始。' },
      ],
    },
  })
  assert.equal(parseAgentPlanReview(response, false).readyToAdopt, false)
  assert.equal(parseAgentPlanReview(response, true).readyToAdopt, true)
  assert.match(parseAgentPlanReview(response, true).message, /重点确认/)
})

test('Agent discussion exposes initialization only after explicit structured confirmation', () => {
  const ready = parseAgentDiscussion(JSON.stringify({
    message: '**主题已确认**，现在可以生成初始结构。',
    nextAction: 'offer-generation',
    missingInformation: [],
    scopeChanged: false,
  }))
  assert.equal(ready.readyToInitialize, true)
  assert.equal(ready.nextAction, 'offer-generation')
  assert.deepEqual(ready.missingInformation, [])
  assert.match(ready.message, /主题已确认/)

  const stillClarifying = parseAgentDiscussion(JSON.stringify({
    message: '还需要确认最终希望达到什么结果。',
    nextAction: 'clarify',
    missingInformation: ['最终希望达到的可观察成果'],
    scopeChanged: false,
  }))
  assert.equal(stillClarifying.readyToInitialize, false)
  assert.equal(stillClarifying.nextAction, 'clarify')
  assert.deepEqual(stillClarifying.missingInformation, ['最终希望达到的可观察成果'])
  assert.match(stillClarifying.message, /什么结果/)
})

test('Agent discussion recovers a readiness signal when message and structured action conflict', () => {
  const recovered = parseAgentDiscussion(JSON.stringify({
    message: '主题和目标都已明确，现在可以生成第一版结构草稿。',
    nextAction: 'clarify',
    missingInformation: ['无'],
    scopeChanged: false,
  }))
  assert.equal(recovered.readyToInitialize, true)
  assert.equal(recovered.nextAction, 'offer-generation')
  assert.deepEqual(recovered.missingInformation, [])

  const negative = parseAgentDiscussion(JSON.stringify({
    message: '目标尚未明确，现在还不能生成结构。',
    nextAction: 'clarify',
    missingInformation: ['目标成果'],
    scopeChanged: false,
  }))
  assert.equal(negative.readyToInitialize, false)

  const prematureClaim = parseAgentDiscussion(JSON.stringify({
    message: '基础学习骨架已经生成，可以继续。',
    nextAction: 'offer-generation',
    missingInformation: [],
    scopeChanged: false,
  }))
  assert.match(prematureClaim.message, /已经准备好生成/)
  assert.doesNotMatch(prematureClaim.message, /已经生成/)

  const malformedPrematureClaim = parseAgentDiscussion('学习骨架已经生成，可以点击按钮查看。')
  assert.match(malformedPrematureClaim.message, /已经准备好生成/)
  assert.equal(malformedPrematureClaim.readyToInitialize, false)
})

test('Agent revision validates and supplies the current unaccepted plan', () => {
  const currentPlan = {
    canvasTitle: 'Redis 数据结构',
    learningGoal: '掌握核心数据结构',
    targetOutcome: '能在项目中正确选型',
    pathMode: 'project' as const,
    root: {
      title: '掌握 Redis 数据结构',
      brief: '协调完整学习路径',
      openingPrompt: '介绍整条学习路线。',
    },
    chapters: [
      { title: '基础模型', brief: '理解键和值', openingPrompt: '从键值模型开始。' },
      { title: 'String', brief: '掌握字符串场景', openingPrompt: '从计数器开始。' },
      { title: 'Hash', brief: '掌握对象存储场景', openingPrompt: '从对象存储开始。' },
    ],
  }
  const request = validateAgentRequest({
    profileId: 'profile-test',
    mode: 'revise',
    plan: currentPlan,
    messages: [
      { role: 'assistant', content: '这是当前结构。' },
      { role: 'user', content: '请把 Hash 提前，并增加更多项目实践导向。' },
    ],
  })
  const input = agentProviderInput(request)

  assert.equal(request.mode, 'revise')
  assert.equal(request.plan?.chapters.length, 3)
  assert.match(input.instructions, /Preserve parts/)
  assert.match(input.messages.at(-1)!.content, /current_unaccepted_plan/)
  assert.match(input.messages.at(-1)!.content, /Redis 数据结构/)
  assert.match(input.messages.at(-2)!.content, /Hash 提前/)
  assert.throws(
    () => validateAgentRequest({
      profileId: 'profile-test',
      mode: 'revise',
      messages: [{ role: 'user', content: '修改结构' }],
    }),
    /缺少需要修改的基础结构草稿/,
  )
})

test('Agent analysis rejects unsupported mutating proposal types', () => {
  assert.throws(
    () => parseAgentAnalysis(JSON.stringify({
      overview: '结构清晰',
      proposals: [{ type: 'delete-node', title: '删除节点', reason: '不需要' }],
    })),
    /不支持的建议类型/,
  )
})

test('Agent management parses reviewable tree operations and rejects destructive actions', () => {
  const management = parseAgentManagement(JSON.stringify({
    message: '建议补充 Hash 的底层实现。',
    next: 'review',
    operations: [
      {
        id: 'create-hash-internals',
        type: 'create-child',
        parentId: 'hash',
        title: 'Hash 底层实现',
        brief: '理解 listpack 与哈希表编码的切换条件。',
        openingPrompt: '从小对象的紧凑存储开始介绍 listpack。',
        reason: '当前节点只有使用场景，缺少实现层理解。',
      },
    ],
  }))
  assert.equal(management.operations.length, 1)
  assert.equal(management.operations[0].type, 'create-child')
  assert.throws(
    () => parseAgentManagement(JSON.stringify({
      message: '删除节点。',
      next: 'review',
      operations: [{ id: 'delete', type: 'delete-node', nodeId: 'hash', reason: '不需要' }],
    })),
    /不支持的操作类型/,
  )
  assert.throws(
    () => parseAgentManagement(JSON.stringify({
      message: '更新摘要。',
      next: 'review',
      operations: [{
        id: 'summarize-hash',
        type: 'update-summary',
        nodeId: 'hash',
        summary: {
          topic: 'Redis Hash',
          mastered: [],
          keyPoints: [],
          unresolvedQuestions: [],
          nextRecommendations: [],
          sourceMessageIds: [],
        },
        reason: '摘要需要更新。',
      }],
    })),
    /不支持的操作类型/,
  )
})

test('Agent management has one fixed next step and accepts progressive node reads', () => {
  const read = parseAgentManagement(JSON.stringify({
    message: '需要核对 Hash 节点的实际讨论。',
    next: 'read-node',
    readRequest: { nodeId: 'hash', reason: '树摘要不足以判断是否偏题。' },
    operations: [],
  }))
  assert.equal(read.next, 'read-node')
  assert.equal(read.readRequest?.nodeId, 'hash')

  const finished = parseAgentManagement(JSON.stringify({
    message: '当前讨论仍然服务于 Hash 学习，不需要创建分支。',
    next: 'finish',
    operations: [],
    completionReason: 'no-action',
  }))
  assert.equal(finished.completionReason, 'no-action')

  assert.throws(
    () => parseAgentManagement(JSON.stringify({
      message: '一边读取一边修改。',
      next: 'read-node',
      readRequest: { nodeId: 'hash', reason: '查看会话。' },
      operations: [{ id: 'rename', type: 'rename-node', nodeId: 'hash', title: '新标题', reason: '修改。' }],
    })),
    /不能同时提出修改/,
  )
})

test('Agent management receives only explicitly requested node conversations', () => {
  const request = validateAgentRequest({
    profileId: 'profile-test',
    mode: 'manage',
    messages: [{ role: 'user', content: '检查 Hash 是否偏题' }],
    canvas: {
      id: 'canvas',
      revision: 2,
      title: 'Redis',
      learningGoal: '掌握 Redis',
      nodes: [
        { id: 'root', title: 'Redis', brief: '总目标', status: 'learning', messageCount: 2 },
        { id: 'hash', parentId: 'root', title: 'Hash', brief: '理解 Hash', status: 'learning', messageCount: 2 },
      ],
    },
    observedNodes: [{
      id: 'hash',
      title: 'Hash',
      brief: '理解 Hash',
      messages: [
        { id: 'hash-q', role: 'user', content: '为什么不用 MySQL 存对象？' },
        { id: 'hash-a', role: 'assistant', content: '这涉及缓存与数据库的职责。' },
      ],
    }],
  })
  const input = agentProviderInput(request)
  assert.match(input.messages[0].content, /requested_node_conversations/)
  assert.match(input.messages[0].content, /为什么不用 MySQL/)
  assert.equal(request.observedNodes?.length, 1)
})

test('topic inspection branches must cite real messages from the read parent', () => {
  const request = validateAgentRequest({
    profileId: 'profile-test',
    mode: 'manage',
    messages: [{ role: 'user', content: '巡检 Hash' }],
    canvas: {
      id: 'canvas', revision: 2, title: 'Redis', learningGoal: '掌握 Redis',
      nodes: [
        { id: 'root', title: 'Redis', brief: '总目标', status: 'learning', messageCount: 0 },
        { id: 'hash', parentId: 'root', title: 'Hash', brief: '理解 Hash', status: 'learning', messageCount: 2 },
      ],
    },
    observedNodes: [{
      id: 'hash', title: 'Hash', brief: '理解 Hash',
      messages: [
        { id: 'hash-q', role: 'user', content: '为什么不用 MySQL 存对象？' },
        { id: 'hash-a', role: 'assistant', content: '这涉及缓存与数据库职责。' },
      ],
    }],
  })
  const management = parseAgentManagement(JSON.stringify({
    message: '这个方向值得独立讨论。',
    next: 'review',
    operations: [{
      id: 'branch-cache-database',
      type: 'create-child',
      parentId: 'hash',
      title: '缓存与数据库职责',
      brief: '理解缓存和持久化存储的边界。',
      openingPrompt: '从一次对象读写请求开始。',
      reason: '实际会话已经转向独立的架构问题。',
      seedContext: {
        summary: '父节点原本讨论 Redis Hash，随后引出了缓存与数据库的职责边界。',
        sourceMessageIds: ['hash-q', 'hash-a'],
        question: 'Redis 为什么不直接使用 MySQL 存储对象？',
      },
    }],
  }))
  assert.equal(validateAgentManagementEvidence(management, request).operations.length, 1)

  const invalid = structuredClone(management)
  const operation = invalid.operations[0]
  if (operation.type === 'create-child' && operation.seedContext) {
    operation.seedContext.sourceMessageIds = ['invented-message']
  }
  assert.throws(
    () => validateAgentManagementEvidence(invalid, request),
    /不存在的消息/,
  )
})

test('published canvas snapshots require a valid single-root tree', () => {
  const root = {
    id: 'root',
    type: 'conversation' as const,
    position: { x: 0, y: 0 },
    data: { title: 'Redis', expanded: false, messages: [], note: '' },
  }
  const child = {
    id: 'child',
    type: 'conversation' as const,
    position: { x: 400, y: 0 },
    data: {
      title: 'String',
      parentId: 'root',
      expanded: false,
      messages: [
        { id: 'question', role: 'user' as const, content: 'String 适合什么场景？' },
        { id: 'answer', role: 'assistant' as const, content: '适合缓存和计数。' },
      ],
      agentOpeningPrompt: '先简要介绍 String，再用一个缓存例子逐步引导。',
      note: '',
    },
  }
  const canvas = validateCanvasSnapshot({
    id: 'redis',
    title: 'Redis 核心数据结构',
    nodes: [root, child],
    edges: [{ id: 'root-child', source: 'root', target: 'child' }],
  })
  assert.equal(canvas.nodes.length, 2)
  assert.match(canvas.nodes[1].data.agentOpeningPrompt ?? '', /逐步引导/)
  assert.throws(
    () => validateCanvasSnapshot({ ...canvas, nodes: [root, { ...child, data: { ...child.data, parentId: undefined } }] }),
    /单根/,
  )
})
