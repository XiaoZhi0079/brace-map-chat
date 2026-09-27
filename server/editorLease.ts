import { randomUUID } from 'node:crypto'
import type { PublicProjectInstance } from '../src/shared/instance.ts'

export type EditorLeaseOwner = {
  leaseId: string
  clientId: string
  acquiredAt: string
  instance: PublicProjectInstance
}

export type EditorLeaseResult =
  | { acquired: true; owner: EditorLeaseOwner; replaced?: EditorLeaseOwner }
  | { acquired: false; owner: EditorLeaseOwner }

export class EditorLeaseRegistry {
  #owner: EditorLeaseOwner | null = null

  acquire(clientId: string, instance: PublicProjectInstance): EditorLeaseResult {
    if (this.#owner && this.#owner.clientId !== clientId) {
      return { acquired: false, owner: this.#owner }
    }
    const replaced = this.#owner ?? undefined
    const owner: EditorLeaseOwner = {
      leaseId: randomUUID(),
      clientId,
      acquiredAt: new Date().toISOString(),
      instance,
    }
    this.#owner = owner
    return { acquired: true, owner, ...(replaced ? { replaced } : {}) }
  }

  release(leaseId: string) {
    if (this.#owner?.leaseId !== leaseId) return false
    this.#owner = null
    return true
  }

  current() {
    return this.#owner
  }

  holds(leaseId: string) {
    return Boolean(leaseId && this.#owner?.leaseId === leaseId)
  }
}
