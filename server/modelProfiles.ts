import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type {
  ModelProfileInput,
  ModelProfileSummary,
  ProtocolId,
} from '../src/shared/chat.ts'
import { GatewayError } from './gatewayError.ts'

export type StoredModelProfile = {
  id: string
  name: string
  protocol: ProtocolId
  model: string
  requestUrl: string
  modelsUrl?: string
  apiKey: string
}

function summarize(profile: StoredModelProfile): ModelProfileSummary {
  return {
    id: profile.id,
    name: profile.name,
    protocol: profile.protocol,
    model: profile.model,
    requestUrl: profile.requestUrl,
    modelsUrl: profile.modelsUrl,
    hasApiKey: Boolean(profile.apiKey),
  }
}

export class ModelProfileStore {
  readonly filePath: string
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(filePath: string) {
    this.filePath = filePath
  }

  private async readAll(): Promise<StoredModelProfile[]> {
    try {
      const value = JSON.parse(await readFile(this.filePath, 'utf8')) as unknown
      if (!Array.isArray(value)) {
        throw new GatewayError(500, 'MODEL_CONFIG_CORRUPT', '模型配置文件格式已损坏。')
      }
      const profiles = value.map((item) => {
        if (!item || typeof item !== 'object') {
          throw new GatewayError(500, 'MODEL_CONFIG_CORRUPT', '模型配置文件包含无效项目。')
        }
        const profile = item as Partial<StoredModelProfile>
        if (
          typeof profile.id !== 'string' || !profile.id
          || typeof profile.name !== 'string' || !profile.name
          || (profile.protocol !== 'openai-responses' && profile.protocol !== 'anthropic-messages')
          || typeof profile.model !== 'string' || !profile.model
          || typeof profile.requestUrl !== 'string' || !profile.requestUrl
          || typeof profile.apiKey !== 'string'
          || (typeof profile.modelsUrl !== 'undefined' && typeof profile.modelsUrl !== 'string')
        ) {
          throw new GatewayError(500, 'MODEL_CONFIG_CORRUPT', '模型配置文件包含无效字段。')
        }
        return profile as StoredModelProfile
      })
      if (new Set(profiles.map((profile) => profile.id)).size !== profiles.length) {
        throw new GatewayError(500, 'MODEL_CONFIG_CORRUPT', '模型配置文件包含重复 ID。')
      }
      return profiles
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return []
      throw error
    }
  }

  private async writeAll(profiles: StoredModelProfile[]) {
    const directory = dirname(this.filePath)
    const tempPath = `${this.filePath}.${randomUUID()}.tmp`
    await mkdir(directory, { recursive: true })
    await writeFile(tempPath, JSON.stringify(profiles, null, 2), { encoding: 'utf8', mode: 0o600 })
    await rename(tempPath, this.filePath)
  }

  private enqueueMutation<T>(operation: () => Promise<T>) {
    const result = this.writeQueue.then(operation, operation)
    this.writeQueue = result.then(() => undefined, () => undefined)
    return result
  }

  async list() {
    return (await this.readAll()).map(summarize)
  }

  async find(profileId: string) {
    return (await this.readAll()).find((profile) => profile.id === profileId) ?? null
  }

  async save(input: ModelProfileInput) {
    return this.enqueueMutation(async () => {
      const profiles = await this.readAll()
      const existingIndex = input.id
        ? profiles.findIndex((profile) => profile.id === input.id)
        : -1
      const existing = existingIndex >= 0 ? profiles[existingIndex] : null
      const profile: StoredModelProfile = {
        id: existing?.id ?? randomUUID(),
        name: input.name.trim(),
        protocol: input.protocol,
        model: input.model.trim(),
        requestUrl: input.requestUrl.trim(),
        modelsUrl: input.modelsUrl?.trim() || undefined,
        apiKey: input.apiKey?.trim() || existing?.apiKey || '',
      }

      if (existingIndex >= 0) profiles[existingIndex] = profile
      else profiles.push(profile)
      await this.writeAll(profiles)
      return summarize(profile)
    })
  }

  async delete(profileId: string) {
    return this.enqueueMutation(async () => {
      const profiles = await this.readAll()
      const next = profiles.filter((profile) => profile.id !== profileId)
      if (next.length === profiles.length) return false
      await this.writeAll(next)
      return true
    })
  }
}
