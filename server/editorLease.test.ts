import assert from 'node:assert/strict'
import test from 'node:test'
import { EditorLeaseRegistry } from './editorLease.ts'

const instance = {
  pid: 1234,
  startedAt: '2026-08-17T12:00:00.000Z',
  url: 'http://127.0.0.1:5173',
}

test('only one browser connection owns the editor lease at a time', () => {
  const leases = new EditorLeaseRegistry()
  const first = leases.acquire('first-client', instance)
  assert.equal(first.acquired, true)
  if (!first.acquired) return

  const blocked = leases.acquire('second-client', instance)
  assert.equal(blocked.acquired, false)
  if (blocked.acquired) return
  assert.equal(blocked.owner.clientId, 'first-client')
  assert.equal(leases.holds(first.owner.leaseId), true)
  assert.equal(leases.holds('not-the-owner'), false)
  assert.equal(leases.release('not-the-owner'), false)
  assert.equal(leases.release(first.owner.leaseId), true)

  const second = leases.acquire('second-client', instance)
  assert.equal(second.acquired, true)
})

test('the same browser client atomically replaces its stale lease connection', () => {
  const leases = new EditorLeaseRegistry()
  const first = leases.acquire('same-client', instance)
  assert.equal(first.acquired, true)
  if (!first.acquired) return

  const replacement = leases.acquire('same-client', instance)
  assert.equal(replacement.acquired, true)
  if (!replacement.acquired) return
  assert.equal(replacement.replaced?.leaseId, first.owner.leaseId)
  assert.notEqual(replacement.owner.leaseId, first.owner.leaseId)
  assert.equal(leases.holds(first.owner.leaseId), false)
  assert.equal(leases.holds(replacement.owner.leaseId), true)

  assert.equal(leases.release(first.owner.leaseId), false)
  assert.equal(leases.holds(replacement.owner.leaseId), true)
  assert.equal(leases.release(replacement.owner.leaseId), true)
})
