export type PublicProjectInstance = {
  pid: number
  startedAt: string
  url: string
}

export type EditorLeaseAcquiredEvent = {
  type: 'acquired'
  clientId: string
  leaseToken: string
  acquiredAt: string
  instance: PublicProjectInstance
}

export type EditorLeaseHeartbeatEvent = {
  type: 'heartbeat'
  at: string
}

export type EditorLeaseEvent = EditorLeaseAcquiredEvent | EditorLeaseHeartbeatEvent
