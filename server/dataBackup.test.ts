import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyLearningDataBackup,
  createLearningDataBackup,
  LEARNING_DATA_BACKUP_FORMAT,
  parseLearningDataBackup,
  summarizeLearningDataBackup,
} from '../src/dataBackup.ts'
import {
  ACTIVE_PROFILE_STORAGE_KEY,
  AGENT_PLANNING_SESSIONS_STORAGE_KEY,
  AGENT_SESSIONS_STORAGE_KEY,
  AGENT_SETUP_DRAFT_STORAGE_KEY,
  WORKSPACE_STORAGE_KEY,
} from '../src/storageKeys.ts'

class MemoryStorage {
  readonly values = new Map<string, string>()
  failOnKey: string | null = null

  getItem(key: string) {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string) {
    if (key === this.failOnKey) {
      this.failOnKey = null
      throw new Error('quota exceeded')
    }
    this.values.set(key, value)
  }

  removeItem(key: string) {
    this.values.delete(key)
  }
}

function workspaceFixture(title = 'Redis 学习') {
  return {
    activeCanvasId: 'canvas-redis',
    canvases: [{
      id: 'canvas-redis',
      revision: 3,
      title,
      learningGoal: '掌握 Redis 数据结构选型',
      targetOutcome: '能够解释选型理由',
      pathMode: 'project',
      nodes: [{
        id: 'root',
        type: 'conversation',
        position: { x: 80, y: 120 },
        data: {
          title: 'Redis 总目标',
          expanded: true,
          messages: [
            { id: 'message-1', role: 'user', content: 'String 和 Hash 应该如何选择？' },
            { id: 'message-2', role: 'assistant', content: '先比较整体读写与字段级更新。' },
          ],
          note: '关注更新粒度。',
          status: 'learning',
          knowledge: {
            topic: 'Redis 数据结构选型',
            mastered: [],
            keyPoints: ['更新粒度会影响选型'],
            unresolvedQuestions: [],
            nextRecommendations: ['继续比较内存开销'],
            sourceMessageIds: ['message-1', 'message-2'],
            stale: false,
          },
        },
      }],
      edges: [],
    }],
  }
}

function setupStorage() {
  const storage = new MemoryStorage()
  storage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(workspaceFixture()))
  storage.setItem(AGENT_SESSIONS_STORAGE_KEY, JSON.stringify([{
    id: 'session-1',
    canvasId: 'canvas-redis',
    canvasTitle: 'Redis 学习',
    title: '检查学习路径',
    messages: [{ role: 'user', content: '检查当前树。' }],
    operations: [],
    createdAt: '2026-08-11T00:00:00.000Z',
    updatedAt: '2026-08-11T00:00:00.000Z',
  }]))
  storage.setItem(AGENT_SETUP_DRAFT_STORAGE_KEY, JSON.stringify({
    version: 1,
    messages: [{ role: 'user', content: '学习缓存设计' }],
    input: '',
    plan: null,
    readyToInitialize: false,
    readyToAdopt: false,
    updatedAt: '2026-08-11T00:00:00.000Z',
  }))
  return storage
}

test('learning data export includes all learning state but never model credentials', () => {
  const storage = setupStorage()
  storage.setItem(ACTIVE_PROFILE_STORAGE_KEY, 'profile-secret')
  storage.setItem('unrelated-api-key', 'sk-do-not-export')

  const backup = createLearningDataBackup(storage, new Date('2026-08-11T01:02:03.000Z'))
  const serialized = JSON.stringify(backup)

  assert.equal(backup.format, LEARNING_DATA_BACKUP_FORMAT)
  assert.equal(backup.exportedAt, '2026-08-11T01:02:03.000Z')
  assert.deepEqual(summarizeLearningDataBackup(backup), {
    canvasCount: 1,
    nodeCount: 1,
    messageCount: 2,
    agentSessionCount: 1,
    planningSessionCount: 1,
  })
  assert.doesNotMatch(serialized, /profile-secret|sk-do-not-export|apiKey/i)
})

test('a validated backup migrates and replaces workspace, Agent sessions, and planning sessions together', () => {
  const source = setupStorage()
  const backup = parseLearningDataBackup(JSON.stringify(createLearningDataBackup(source)))
  const target = new MemoryStorage()
  target.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(workspaceFixture('旧画布')))

  applyLearningDataBackup(backup, target)

  assert.equal(JSON.parse(target.getItem(WORKSPACE_STORAGE_KEY)!).canvases[0].title, 'Redis 学习')
  assert.equal(JSON.parse(target.getItem(AGENT_SESSIONS_STORAGE_KEY)!).length, 1)
  const planning = JSON.parse(target.getItem(AGENT_PLANNING_SESSIONS_STORAGE_KEY)!)
  assert.equal(planning.sessions[0].messages[0].content, '学习缓存设计')
  assert.equal(target.getItem(AGENT_SETUP_DRAFT_STORAGE_KEY), null)
})

test('old backup files with one setup draft are accepted and migrated', () => {
  const current = createLearningDataBackup(setupStorage())
  const oldBackup = structuredClone(current) as unknown as {
    data: Record<string, unknown>
  }
  delete oldBackup.data.agentPlanningSessions
  oldBackup.data.agentSetupDraft = {
    version: 1,
    messages: [{ role: 'user', content: '旧备份中的代理协议规划' }],
    input: '',
    plan: null,
    readyToInitialize: false,
    readyToAdopt: false,
    updatedAt: '2026-08-10T00:00:00.000Z',
  }

  const parsed = parseLearningDataBackup(JSON.stringify(oldBackup))

  assert.equal(parsed.data.agentPlanningSessions.sessions.length, 1)
  assert.equal(parsed.data.agentPlanningSessions.sessions[0].title, '旧备份中的代理协议规划')
})

test('invalid tree data is rejected before any existing data is changed', () => {
  const source = setupStorage()
  const backup = createLearningDataBackup(source)
  const invalid = structuredClone(backup)
  invalid.data.workspace.canvases[0].nodes[0].data.parentId = 'missing-parent'
  const target = new MemoryStorage()
  const previous = JSON.stringify(workspaceFixture('必须保留'))
  target.setItem(WORKSPACE_STORAGE_KEY, previous)

  assert.throws(() => parseLearningDataBackup(JSON.stringify(invalid)), /找不到父节点|总目标节点/)
  assert.equal(target.getItem(WORKSPACE_STORAGE_KEY), previous)
})

test('Agent sessions cannot reference canvases missing from the imported workspace', () => {
  const invalid = createLearningDataBackup(setupStorage())
  invalid.data.agentSessions[0].canvasId = 'missing-canvas'

  assert.throws(
    () => parseLearningDataBackup(JSON.stringify(invalid)),
    /Agent 会话引用了备份中不存在的画布/,
  )
})

test('storage quota failures roll back every imported key', () => {
  const backup = createLearningDataBackup(setupStorage())
  const target = new MemoryStorage()
  const previousWorkspace = JSON.stringify(workspaceFixture('导入前画布'))
  target.setItem(WORKSPACE_STORAGE_KEY, previousWorkspace)
  target.setItem(AGENT_SESSIONS_STORAGE_KEY, '[]')
  target.failOnKey = AGENT_SESSIONS_STORAGE_KEY

  assert.throws(() => applyLearningDataBackup(backup, target), /存储空间不足/)
  assert.equal(target.getItem(WORKSPACE_STORAGE_KEY), previousWorkspace)
  assert.equal(target.getItem(AGENT_SESSIONS_STORAGE_KEY), '[]')
})
