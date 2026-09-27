import assert from 'node:assert/strict'
import test from 'node:test'
import {
  normalizeAgentPlanningSessionCollection,
  readStoredAgentPlanningSessions,
  sortAgentPlanningSessions,
} from '../src/agent/agentPlanningSessions.ts'
import {
  AGENT_PLANNING_SESSIONS_STORAGE_KEY,
  AGENT_SETUP_DRAFT_STORAGE_KEY,
} from '../src/storageKeys.ts'

class MemoryStorage {
  readonly values = new Map<string, string>()

  getItem(key: string) {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string) {
    this.values.set(key, value)
  }

  removeItem(key: string) {
    this.values.delete(key)
  }
}

function session(id: string, updatedAt: string) {
  return {
    id,
    title: `规划 ${id}`,
    messages: [{ role: 'user' as const, content: `主题 ${id}` }],
    input: '',
    plan: null,
    pendingPlan: null,
    pendingPlanKind: null,
    readyToInitialize: false,
    missingInformation: [],
    readyToAdopt: false,
    createdAt: updatedAt,
    updatedAt,
  }
}

test('a legacy single setup draft migrates once without losing its conversation', () => {
  const storage = new MemoryStorage()
  storage.setItem(AGENT_SETUP_DRAFT_STORAGE_KEY, JSON.stringify({
    version: 1,
    messages: [{ role: 'user', content: '学习代理协议' }],
    input: '尚未发送的补充',
    plan: null,
    readyToInitialize: true,
    missingInformation: [],
    readyToAdopt: false,
    updatedAt: '2026-08-12T08:00:00.000Z',
  }))

  const migrated = readStoredAgentPlanningSessions(storage)

  assert.equal(migrated.sessions.length, 1)
  assert.equal(migrated.sessions[0].title, '学习代理协议')
  assert.equal(migrated.sessions[0].input, '尚未发送的补充')
  assert.equal(migrated.activeSessionId, migrated.sessions[0].id)
  assert.equal(storage.getItem(AGENT_SETUP_DRAFT_STORAGE_KEY), null)
  assert.ok(storage.getItem(AGENT_PLANNING_SESSIONS_STORAGE_KEY))
})

test('multiple sessions remain independent and accept an empty new session', () => {
  const normalized = normalizeAgentPlanningSessionCollection({
    version: 1,
    sessions: [
      session('one', '2026-08-12T08:00:00.000Z'),
      {
        ...session('empty', '2026-08-12T09:00:00.000Z'),
        title: '未命名学习主题',
        messages: [],
      },
    ],
    activeSessionId: 'empty',
  })

  assert.equal(normalized?.sessions.length, 2)
  assert.equal(normalized?.sessions[0].messages[0].content, '主题 one')
  assert.deepEqual(normalized?.sessions[1].messages, [])
  assert.equal(normalized?.activeSessionId, 'empty')
})

test('a leftover legacy draft is merged once when the new collection already exists', () => {
  const storage = new MemoryStorage()
  storage.setItem(AGENT_PLANNING_SESSIONS_STORAGE_KEY, JSON.stringify({
    version: 1,
    sessions: [session('current', '2026-08-13T08:00:00.000Z')],
    activeSessionId: 'current',
  }))
  storage.setItem(AGENT_SETUP_DRAFT_STORAGE_KEY, JSON.stringify({
    version: 1,
    messages: [{ role: 'user', content: '不能丢失的旧规划' }],
    input: '',
    plan: null,
    readyToInitialize: false,
    missingInformation: [],
    readyToAdopt: false,
    updatedAt: '2026-08-12T08:00:00.000Z',
  }))

  const firstRead = readStoredAgentPlanningSessions(storage)
  const secondRead = readStoredAgentPlanningSessions(storage)

  assert.equal(firstRead.sessions.length, 2)
  assert.equal(secondRead.sessions.length, 2)
  assert.ok(secondRead.sessions.some((item) => item.title === '不能丢失的旧规划'))
  assert.equal(storage.getItem(AGENT_SETUP_DRAFT_STORAGE_KEY), null)
})

test('planning sessions are sorted by most recent update without mutating storage order', () => {
  const sessions = [
    session('old', '2026-08-10T08:00:00.000Z'),
    session('new', '2026-08-12T08:00:00.000Z'),
    session('middle', '2026-08-11T08:00:00.000Z'),
  ]

  assert.deepEqual(sortAgentPlanningSessions(sessions).map((item) => item.id), ['new', 'middle', 'old'])
  assert.deepEqual(sessions.map((item) => item.id), ['old', 'new', 'middle'])
})

test('stored plans become directly adoptable and pending proposals remain separate', () => {
  const plan = {
    canvasTitle: 'Redis 数据结构', learningGoal: '掌握选型', targetOutcome: '完成项目选型', pathMode: 'project',
    root: { title: 'Redis', brief: '学习 Redis', openingPrompt: '从整体路线开始。' },
    chapters: [
      { title: '基础', brief: '基础', openingPrompt: '开始基础。', children: [] },
      { title: '结构', brief: '结构', openingPrompt: '开始结构。', children: [] },
      { title: '实践', brief: '实践', openingPrompt: '开始实践。', children: [] },
    ],
  }
  const normalized = normalizeAgentPlanningSessionCollection({
    version: 1,
    sessions: [{
      ...session('plan', '2026-08-12T08:00:00.000Z'),
      plan,
      pendingPlan: { ...plan, canvasTitle: 'Redis 数据结构调整稿' },
      pendingPlanKind: 'agent-proposal',
      readyToAdopt: true,
    }],
    activeSessionId: 'plan',
  })

  assert.equal(normalized?.sessions[0].plan?.canvasTitle, 'Redis 数据结构')
  assert.equal(normalized?.sessions[0].pendingPlan?.canvasTitle, 'Redis 数据结构调整稿')
  assert.equal(normalized?.sessions[0].pendingPlanKind, 'agent-proposal')
  assert.equal(normalized?.sessions[0].readyToAdopt, false)
})
