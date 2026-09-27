import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import type { PersistentApplicationState } from '../src/shared/persistence.ts'
import { DATABASE_MIGRATIONS } from './databaseMigrations.ts'
import { LearningDatabase } from './learningDatabase.ts'

function applicationState(): PersistentApplicationState {
  return {
    workspace: {
      activeCanvasId: 'canvas-1',
      canvases: [{
        id: 'canvas-1',
        revision: 3,
        title: 'SQLite learning canvas',
        learningGoal: 'Verify durable storage',
        targetOutcome: 'Reload every entity',
        pathMode: 'project',
        nodes: [{
          id: 'node-1',
          type: 'conversation',
          position: { x: 80, y: 120 },
          data: {
            title: 'Storage root',
            brief: 'Database boundaries',
            expanded: true,
            messages: [
              { id: 'message-1', role: 'user', content: 'Where is this saved?' },
              { id: 'message-2', role: 'assistant', content: 'In SQLite.', generationStatus: 'stopped' },
            ],
            note: 'Keep this note.',
            status: 'learning',
            knowledge: {
              topic: 'Persistence',
              mastered: [],
              keyPoints: ['Transactions'],
              unresolvedQuestions: [],
              nextRecommendations: [],
              sourceMessageIds: ['message-2'],
              stale: false,
            },
          },
        }],
        edges: [],
      }],
    },
    agentPlanningSessions: {
      version: 1,
      activeSessionId: 'planning-1',
      sessions: [{
        id: 'planning-1',
        title: 'Database plan',
        messages: [{ role: 'user', content: 'Plan database learning.' }],
        input: '',
        plan: null,
        pendingPlan: null,
        pendingPlanKind: null,
        readyToInitialize: false,
        missingInformation: ['Target outcome'],
        readyToAdopt: false,
        createdAt: '2026-08-17T00:00:00.000Z',
        updatedAt: '2026-08-17T00:01:00.000Z',
      }],
    },
    agentSessions: [{
      id: 'agent-1',
      canvasId: 'canvas-1',
      canvasTitle: 'SQLite learning canvas',
      title: 'Inspect storage',
      messages: [{ role: 'user', content: 'Inspect this canvas.' }],
      operations: [{
        reviewId: 'review-1',
        operation: {
          id: 'operation-1',
          type: 'update-brief',
          nodeId: 'node-1',
          brief: 'Updated database boundaries',
          reason: 'The original scope was vague.',
        },
        expectedRevision: 3,
        status: 'pending',
      }],
      createdAt: '2026-08-17T00:00:00.000Z',
      updatedAt: '2026-08-17T00:02:00.000Z',
    }],
    preferences: {
      activeProfileId: 'profile-1',
      agentModelSelection: { profileId: 'profile-1', model: 'model-1' },
      redisSnapshotVersion: 'snapshot-1',
    },
  }
}

async function withDatabase(run: (database: LearningDatabase) => void | Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'brace-map-database-'))
  const database = new LearningDatabase(join(directory, 'test.sqlite'))
  try {
    await run(database)
  } finally {
    database.close()
    await rm(directory, { recursive: true, force: true })
  }
}

test('SQLite storage round-trips normalized learning entities and preferences', async () => {
  await withDatabase((database) => {
    const expected = applicationState()
    database.replaceState(expected)
    assert.deepEqual(database.readState(), expected)
    assert.equal(database.check(), true)
    assert.equal(database.schemaVersion, 2)
  })
})

test('invalid workspace replacement leaves the previous transaction intact', async () => {
  await withDatabase((database) => {
    const expected = applicationState()
    database.replaceState(expected)
    assert.throws(() => database.saveWorkspace({
      ...expected.workspace,
      activeCanvasId: 'missing-canvas',
    }, database.readWorkspaceVersion()))
    assert.equal(database.readWorkspace()?.canvases[0].nodes.length, 1)
  })
})

test('browser migration merges newer sessions and remains idempotent', async () => {
  await withDatabase((database) => {
    const initial = applicationState()
    database.replaceState(initial)
    const incoming = structuredClone(initial)
    incoming.agentPlanningSessions.sessions[0].updatedAt = '2026-08-17T00:03:00.000Z'
    incoming.agentPlanningSessions.sessions[0].input = 'newer browser draft'
    database.mergeBrowserState(incoming)
    database.mergeBrowserState(incoming)
    const stored = database.readState()
    assert.equal(stored.workspace?.canvases.length, 1)
    assert.equal(stored.agentPlanningSessions.sessions.length, 1)
    assert.equal(stored.agentPlanningSessions.sessions[0].input, 'newer browser draft')
    assert.equal(database.exportLearningData().data.agentSessions.length, 1)
  })
})

test('planning saves merge by session and never delete sessions omitted by an older client', async () => {
  await withDatabase((database) => {
    const state = applicationState()
    const preserved = {
      ...structuredClone(state.agentPlanningSessions.sessions[0]),
      id: 'planning-preserved',
      title: 'Preserved plan',
      updatedAt: '2026-08-17T00:02:00.000Z',
    }
    state.agentPlanningSessions.sessions.push(preserved)
    state.agentPlanningSessions.activeSessionId = preserved.id
    database.replaceState(state)

    const incoming = structuredClone(state.agentPlanningSessions)
    incoming.sessions = [{
      ...incoming.sessions[0],
      input: 'new content from the current client',
      updatedAt: '2026-08-17T00:03:00.000Z',
    }]
    incoming.activeSessionId = incoming.sessions[0].id
    const merged = database.savePlanningSessions(incoming)

    assert.deepEqual(merged.sessions.map((session) => session.id), ['planning-1', 'planning-preserved'])
    assert.equal(merged.sessions[0].input, 'new content from the current client')
    assert.equal(merged.sessions[1].title, 'Preserved plan')
    assert.equal(merged.activeSessionId, 'planning-1')

    const stale = structuredClone(incoming)
    stale.sessions[0].input = 'stale overwrite'
    stale.sessions[0].updatedAt = '2026-08-17T00:00:30.000Z'
    database.savePlanningSessions(stale)
    assert.equal(database.readPlanningSessions().sessions[0].input, 'new content from the current client')
  })
})

test('planning sessions are removed only through explicit single-session deletion', async () => {
  await withDatabase((database) => {
    const state = applicationState()
    state.agentPlanningSessions.sessions.push({
      ...structuredClone(state.agentPlanningSessions.sessions[0]),
      id: 'planning-2',
      title: 'Remaining plan',
      updatedAt: '2026-08-17T00:02:00.000Z',
    })
    database.replaceState(state)

    const remaining = database.deletePlanningSession('planning-1')
    assert.deepEqual(remaining.sessions.map((session) => session.id), ['planning-2'])
    assert.equal(remaining.activeSessionId, null)

    const idempotent = database.deletePlanningSession('planning-1')
    assert.deepEqual(idempotent.sessions.map((session) => session.id), ['planning-2'])
  })
})

test('first workspace save creates durable data and advances the storage version', async () => {
  await withDatabase((database) => {
    const workspace = applicationState().workspace!
    assert.equal(database.readWorkspaceVersion(), 0)
    const result = database.saveWorkspace(workspace, 0)
    assert.equal(result.workspaceVersion, 1)
    assert.deepEqual(database.readWorkspace(), workspace)
  })
})

test('stale workspace writers receive a conflict without changing stored data', async () => {
  await withDatabase((database) => {
    const workspace = applicationState().workspace!
    database.saveWorkspace(workspace, 0)
    const staleWorkspace = structuredClone(workspace)
    staleWorkspace.canvases[0].title = 'Stale writer title'
    staleWorkspace.canvases[0].revision = (staleWorkspace.canvases[0].revision ?? 0) + 1
    assert.throws(
      () => database.saveWorkspace(staleWorkspace, 0),
      (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'WORKSPACE_CONFLICT'),
    )
    assert.equal(database.readWorkspace()?.canvases[0].title, workspace.canvases[0].title)
    assert.equal(database.readWorkspaceVersion(), 1)
  })
})

test('different canvases may reuse node and message IDs', async () => {
  await withDatabase((database) => {
    const state = applicationState()
    const secondCanvas = structuredClone(state.workspace!.canvases[0])
    secondCanvas.id = 'canvas-2'
    secondCanvas.title = 'Second canvas'
    state.workspace!.canvases.push(secondCanvas)
    database.replaceState(state)
    const stored = database.readWorkspace()!
    assert.equal(stored.canvases.length, 2)
    assert.deepEqual(stored.canvases.map((canvas) => canvas.nodes[0].id), ['node-1', 'node-1'])
    assert.deepEqual(stored.canvases.map((canvas) => canvas.nodes[0].data.messages[0].id), ['message-1', 'message-1'])
  })
})

test('duplicate message and edge IDs are rejected before writing', async () => {
  await withDatabase((database) => {
    const workspace = applicationState().workspace!
    const duplicateMessages = structuredClone(workspace)
    duplicateMessages.canvases[0].nodes[0].data.messages.push({
      ...duplicateMessages.canvases[0].nodes[0].data.messages[0],
      content: 'Duplicate ID',
    })
    assert.throws(() => database.saveWorkspace(duplicateMessages, 0))

    const duplicateEdges = structuredClone(workspace)
    duplicateEdges.canvases[0].nodes.push({
      id: 'node-2',
      type: 'conversation',
      position: { x: 400, y: 120 },
      data: {
        title: 'Child',
        parentId: 'node-1',
        expanded: false,
        messages: [],
        note: '',
      },
    })
    duplicateEdges.canvases[0].edges = [
      { id: 'edge-1', source: 'node-1', target: 'node-2' },
      { id: 'edge-1', source: 'node-1', target: 'node-2' },
    ]
    assert.throws(() => database.saveWorkspace(duplicateEdges, 0))
    assert.equal(database.readWorkspace(), null)
  })
})

test('deleting a canvas cascades its Agent sessions and clears planning adoption', async () => {
  await withDatabase((database) => {
    const state = applicationState()
    const remainingCanvas = structuredClone(state.workspace!.canvases[0])
    remainingCanvas.id = 'canvas-2'
    remainingCanvas.title = 'Remaining canvas'
    state.workspace!.canvases.push(remainingCanvas)
    state.agentPlanningSessions.sessions[0].adoptedCanvasId = 'canvas-1'
    database.replaceState(state)

    const nextWorkspace = {
      activeCanvasId: 'canvas-2',
      canvases: [remainingCanvas],
    }
    database.saveWorkspace(nextWorkspace, database.readWorkspaceVersion())
    assert.deepEqual(database.readAgentSessions(), [])
    assert.equal(database.readPlanningSessions().sessions[0].adoptedCanvasId, undefined)
  })
})

test('incomplete and error response states survive a SQLite round trip', async () => {
  await withDatabase((database) => {
    const state = applicationState()
    state.workspace!.canvases[0].nodes[0].data.messages[1].generationStatus = 'incomplete'
    state.workspace!.canvases[0].nodes[0].data.messages.push({
      id: 'message-3',
      role: 'assistant',
      content: 'Generation failed.',
      generationStatus: 'error',
    })
    database.replaceState(state)
    assert.deepEqual(
      database.readWorkspace()!.canvases[0].nodes[0].data.messages.map((message) => message.generationStatus),
      [undefined, 'incomplete', 'error'],
    )
  })
})

test('schema v1 databases migrate to v2 without losing learning or Agent data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'brace-map-v1-migration-'))
  const filePath = join(directory, 'legacy.sqlite')
  const legacy = new DatabaseSync(filePath)
  try {
    legacy.exec('PRAGMA foreign_keys = ON')
    legacy.exec(DATABASE_MIGRATIONS[0].sql)
    legacy.exec(`
      INSERT INTO canvases (id, title, revision, sort_order)
      VALUES ('canvas-1', 'Legacy canvas', 4, 0);
      UPDATE app_settings SET active_canvas_id = 'canvas-1' WHERE singleton_id = 1;
      INSERT INTO nodes (
        id, canvas_id, node_type, position_x, position_y, title, expanded, note, sort_order
      ) VALUES ('node-1', 'canvas-1', 'conversation', 80, 120, 'Legacy node', 1, 'Legacy note', 0);
      INSERT INTO node_messages (node_id, message_id, role, content, generation_status, sort_order)
      VALUES ('node-1', 'message-1', 'assistant', 'Partial legacy answer', 'incomplete', 0);
      INSERT INTO agent_planning_sessions (
        id, title, input, ready_to_initialize, missing_information_json, ready_to_adopt,
        created_at, updated_at, adopted_canvas_id, sort_order
      ) VALUES (
        'planning-1', 'Legacy plan', '', 0, '[]', 0,
        '2026-08-17T00:00:00.000Z', '2026-08-17T00:00:00.000Z', 'canvas-1', 0
      );
      INSERT INTO agent_sessions (id, canvas_id, canvas_title, title, created_at, updated_at, sort_order)
      VALUES (
        'agent-1', 'canvas-1', 'Legacy canvas', 'Legacy Agent',
        '2026-08-17T00:00:00.000Z', '2026-08-17T00:00:00.000Z', 0
      );
      INSERT INTO agent_session_messages (session_id, role, content, sort_order)
      VALUES ('agent-1', 'user', 'Inspect legacy data.', 0);
      PRAGMA user_version = 1;
    `)
  } finally {
    legacy.close()
  }

  const migrated = new LearningDatabase(filePath)
  try {
    assert.equal(migrated.schemaVersion, 2)
    assert.equal(migrated.readWorkspace()?.canvases[0].nodes[0].data.note, 'Legacy note')
    assert.equal(migrated.readWorkspace()?.canvases[0].nodes[0].data.messages[0].generationStatus, 'incomplete')
    assert.equal(migrated.readAgentSessions()[0].messages[0].content, 'Inspect legacy data.')
    assert.equal(migrated.readPlanningSessions().sessions[0].adoptedCanvasId, 'canvas-1')
    assert.equal(migrated.check(), true)
  } finally {
    migrated.close()
    await rm(directory, { recursive: true, force: true })
  }
})
