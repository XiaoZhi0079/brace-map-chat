import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join, resolve } from 'node:path'
import type { PublicProjectInstance } from '../src/shared/instance.ts'

export type ProjectInstanceMetadata = PublicProjectInstance & {
  instanceId: string
  databasePath: string
}

export type ProjectInstanceLock = {
  info: ProjectInstanceMetadata
  lockPath: string
  release: () => void
}

export type ProjectInstanceOptions = {
  args?: string[]
  env?: Record<string, string | undefined>
  isProcessAlive?: (pid: number) => boolean
  lockPath?: string
  now?: () => Date
  pid?: number
}

export class ProjectInstanceAlreadyRunningError extends Error {
  readonly owner: ProjectInstanceMetadata
  readonly lockPath: string

  constructor(owner: ProjectInstanceMetadata, lockPath: string) {
    super([
      'Brace Map Chat 已有实例正在运行。',
      `访问地址：${owner.url}`,
      `进程 PID：${owner.pid}`,
      `启动时间：${owner.startedAt}`,
      '请使用上面的地址，或先关闭该进程后再启动。',
      `实例锁：${lockPath}`,
    ].join('\n'))
    this.name = 'ProjectInstanceAlreadyRunningError'
    this.owner = owner
    this.lockPath = lockPath
  }
}

function argumentValue(args: string[], name: string) {
  const inline = args.find((argument) => argument.startsWith(`${name}=`))
  if (inline) return inline.slice(name.length + 1)
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

function requestedInstanceUrl(args: string[], env: Record<string, string | undefined>) {
  const preview = args.some((argument) => argument === 'preview')
  const portCandidate = argumentValue(args, '--port') ?? env.PORT ?? (preview ? '4173' : '5173')
  const port = Number.parseInt(portCandidate, 10)
  const hostCandidate = argumentValue(args, '--host') ?? env.HOST ?? '127.0.0.1'
  const host = hostCandidate === '0.0.0.0' || hostCandidate === '::' || hostCandidate === 'true'
    ? '127.0.0.1'
    : hostCandidate
  return `http://${host}:${Number.isInteger(port) && port > 0 ? port : preview ? 4173 : 5173}`
}

function processIsAlive(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function readMetadata(lockPath: string): ProjectInstanceMetadata | null {
  try {
    const value = JSON.parse(readFileSync(lockPath, 'utf8')) as Partial<ProjectInstanceMetadata>
    if (
      typeof value.instanceId !== 'string'
      || typeof value.pid !== 'number'
      || typeof value.startedAt !== 'string'
      || typeof value.url !== 'string'
      || typeof value.databasePath !== 'string'
    ) return null
    return value as ProjectInstanceMetadata
  } catch {
    return null
  }
}

export function acquireProjectInstance(
  databasePath: string,
  options: ProjectInstanceOptions = {},
): ProjectInstanceLock {
  const databaseDirectory = resolve(dirname(databasePath))
  mkdirSync(databaseDirectory, { recursive: true })
  const canonicalDirectory = realpathSync.native(databaseDirectory)
  const canonicalDatabasePath = join(canonicalDirectory, basename(databasePath))
  const lockPath = options.lockPath
    ? resolve(options.lockPath)
    : `${canonicalDatabasePath}.instance.lock`
  mkdirSync(dirname(lockPath), { recursive: true })
  const args = options.args ?? process.argv.slice(2)
  const env = options.env ?? process.env
  const isProcessAlive = options.isProcessAlive ?? processIsAlive
  const info: ProjectInstanceMetadata = {
    instanceId: randomUUID(),
    pid: options.pid ?? process.pid,
    startedAt: (options.now?.() ?? new Date()).toISOString(),
    url: requestedInstanceUrl(args, env),
    databasePath: canonicalDatabasePath,
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const descriptor = openSync(lockPath, 'wx')
      try {
        writeFileSync(descriptor, `${JSON.stringify(info, null, 2)}\n`, 'utf8')
      } finally {
        closeSync(descriptor)
      }

      let released = false
      const release = () => {
        if (released) return
        released = true
        process.off('exit', release)
        const current = readMetadata(lockPath)
        if (current?.instanceId !== info.instanceId) return
        try {
          unlinkSync(lockPath)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
      process.once('exit', release)
      return { info, lockPath, release }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const owner = readMetadata(lockPath)
      if (owner && isProcessAlive(owner.pid)) {
        if (owner.pid !== info.pid) {
          throw new ProjectInstanceAlreadyRunningError(owner, lockPath)
        }
      }
      try {
        unlinkSync(lockPath)
      } catch (unlinkError) {
        if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkError
      }
    }
  }
  throw new Error(`无法取得 Brace Map Chat 实例锁：${lockPath}`)
}
