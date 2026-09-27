import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  acquireProjectInstance,
  ProjectInstanceAlreadyRunningError,
} from './projectInstance.ts'

test('a live project instance blocks the whole project on every database and port', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'brace-map-instance-'))
  const databasePath = join(directory, 'learning.sqlite')
  const lockPath = join(directory, 'project.instance.lock')
  const first = acquireProjectInstance(databasePath, {
    args: ['--host', '127.0.0.1', '--port', '5173'],
    pid: 4242,
    isProcessAlive: () => true,
    lockPath,
    now: () => new Date('2026-08-17T12:00:00.000Z'),
  })
  try {
    assert.throws(() => acquireProjectInstance(join(directory, 'isolated-test.sqlite'), {
      args: ['--host', '127.0.0.1', '--port', '5199'],
      pid: 9898,
      isProcessAlive: (pid) => pid === 4242,
      lockPath,
    }), (error) => {
      assert.ok(error instanceof ProjectInstanceAlreadyRunningError)
      assert.equal(error.owner.pid, 4242)
      assert.equal(error.owner.url, 'http://127.0.0.1:5173')
      assert.match(error.message, /5173/)
      return true
    })
  } finally {
    first.release()
    await rm(directory, { recursive: true, force: true })
  }
})

test('a stale instance lock is replaced and only its owner may release it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'brace-map-instance-stale-'))
  const databasePath = join(directory, 'learning.sqlite')
  const lockPath = `${databasePath}.instance.lock`
  await writeFile(lockPath, JSON.stringify({
    instanceId: 'stale-instance',
    pid: 1010,
    startedAt: '2026-08-16T12:00:00.000Z',
    url: 'http://127.0.0.1:4000',
    databasePath,
  }))
  const current = acquireProjectInstance(databasePath, {
    args: ['--port=5173'],
    pid: 2020,
    isProcessAlive: () => false,
  })
  try {
    const stored = JSON.parse(await readFile(lockPath, 'utf8')) as { instanceId: string; pid: number }
    assert.equal(stored.instanceId, current.info.instanceId)
    assert.equal(stored.pid, 2020)
  } finally {
    current.release()
    await assert.rejects(readFile(lockPath, 'utf8'), { code: 'ENOENT' })
    await rm(directory, { recursive: true, force: true })
  }
})

test('the same process can atomically replace its lock during a Vite server restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'brace-map-instance-restart-'))
  const databasePath = join(directory, 'learning.sqlite')
  const lockPath = join(directory, 'project.instance.lock')
  const first = acquireProjectInstance(databasePath, {
    args: ['--port=5173'],
    pid: 4242,
    isProcessAlive: () => true,
    lockPath,
    now: () => new Date('2026-09-02T12:00:00.000Z'),
  })
  const replacement = acquireProjectInstance(databasePath, {
    args: ['--port=5173'],
    pid: 4242,
    isProcessAlive: () => true,
    lockPath,
    now: () => new Date('2026-09-02T12:01:00.000Z'),
  })
  try {
    assert.notEqual(replacement.info.instanceId, first.info.instanceId)
    first.release()
    const stored = JSON.parse(await readFile(lockPath, 'utf8')) as { instanceId: string; pid: number }
    assert.equal(stored.instanceId, replacement.info.instanceId)
    assert.equal(stored.pid, 4242)
  } finally {
    replacement.release()
    await assert.rejects(readFile(lockPath, 'utf8'), { code: 'ENOENT' })
    await rm(directory, { recursive: true, force: true })
  }
})
