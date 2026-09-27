import { useEffect, useMemo, useState, type FormEvent } from 'react'
import {
  ArrowClockwise,
  Check,
  CircleNotch,
  FloppyDisk,
  Gear,
  Key,
  Plus,
  Trash,
  X,
} from '@phosphor-icons/react'
import {
  ApiError,
  deleteModelProfile,
  discoverProfileModels,
  listModelProfiles,
  saveModelProfile,
} from './chatApi.ts'
import type {
  ModelProfileInput,
  ModelListItem,
  ModelProfileSummary,
  ProtocolId,
} from './shared/chat.ts'
import { DataBackupPanel } from './DataBackupPanel.tsx'
import type { LearningDataBackup } from './dataBackup.ts'

const PROTOCOL_OPTIONS: Record<ProtocolId, { label: string; defaultUrl: string }> = {
  'openai-responses': {
    label: 'OpenAI Responses API',
    defaultUrl: 'https://api.openai.com/v1/responses',
  },
  'anthropic-messages': {
    label: 'Anthropic Messages API',
    defaultUrl: 'https://api.anthropic.com/v1/messages',
  },
}

type Props = {
  activeProfileId: string | null
  onActiveProfileChange: (profileId: string | null) => void
  onClose: () => void
  onProfilesChange: (profiles: ModelProfileSummary[]) => void
  profiles: ModelProfileSummary[]
  onBeforeDataExport: () => Promise<void>
  onImportLearningData: (backup: LearningDataBackup) => Promise<void>
}

function blankProfile(): ModelProfileInput {
  return {
    name: '',
    protocol: 'openai-responses',
    model: '',
    requestUrl: PROTOCOL_OPTIONS['openai-responses'].defaultUrl,
    modelsUrl: '',
    apiKey: '',
  }
}

function profileToForm(profile: ModelProfileSummary): ModelProfileInput {
  return {
    id: profile.id,
    name: profile.name,
    protocol: profile.protocol,
    model: profile.model,
    requestUrl: profile.requestUrl,
    modelsUrl: profile.modelsUrl ?? '',
    apiKey: '',
  }
}

export function SettingsDialog({
  activeProfileId,
  onActiveProfileChange,
  onClose,
  onProfilesChange,
  profiles,
  onBeforeDataExport,
  onImportLearningData,
}: Props) {
  const [form, setForm] = useState<ModelProfileInput>(() =>
    profiles[0] ? profileToForm(profiles[0]) : blankProfile(),
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [availableModels, setAvailableModels] = useState<ModelListItem[]>([])
  const [modelSearch, setModelSearch] = useState('')
  const [loadingModels, setLoadingModels] = useState(false)
  const [modelError, setModelError] = useState('')
  const editedProfile = profiles.find((profile) => profile.id === form.id)
  const filteredModels = useMemo(() => {
    const query = modelSearch.trim().toLocaleLowerCase()
    return query
      ? availableModels.filter((model) => model.id.toLocaleLowerCase().includes(query))
      : availableModels
  }, [availableModels, modelSearch])

  function resetModelDiscovery() {
    setAvailableModels([])
    setModelSearch('')
    setModelError('')
  }

  useEffect(() => {
    if (!form.id) return
    const latest = profiles.find((profile) => profile.id === form.id)
    if (!latest) setForm(profiles[0] ? profileToForm(profiles[0]) : blankProfile())
  }, [form.id, profiles])

  async function refreshProfiles(preferredId?: string) {
    const result = await listModelProfiles()
    onProfilesChange(result.profiles)
    const nextActive = preferredId
      ?? (result.profiles.some((profile) => profile.id === activeProfileId) ? activeProfileId : null)
      ?? result.profiles[0]?.id
      ?? null
    onActiveProfileChange(nextActive)
    return result.profiles
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSaving(true)
    setError('')
    try {
      const result = await saveModelProfile(form)
      const latest = await refreshProfiles(result.profile.id)
      const saved = latest.find((profile) => profile.id === result.profile.id)
      if (saved) setForm(profileToForm(saved))
    } catch (submitError) {
      setError(submitError instanceof ApiError ? submitError.message : '保存配置失败。')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (!form.id || !editedProfile) return
    const confirmed = window.confirm(`删除模型配置“${editedProfile.name}”？已保存的 API Key 也会一起删除。`)
    if (!confirmed) return
    setSaving(true)
    setError('')
    try {
      await deleteModelProfile(form.id)
      const latest = await refreshProfiles()
      setForm(latest[0] ? profileToForm(latest[0]) : blankProfile())
    } catch (deleteError) {
      setError(deleteError instanceof ApiError ? deleteError.message : '删除配置失败。')
    } finally {
      setSaving(false)
    }
  }

  async function handleDiscoverModels() {
    setLoadingModels(true)
    setModelError('')
    setAvailableModels([])
    try {
      const result = await discoverProfileModels({
        profileId: form.id,
        protocol: form.protocol,
        requestUrl: form.requestUrl,
        modelsUrl: form.modelsUrl,
        apiKey: form.apiKey,
      })
      setAvailableModels(result.models)
      if (!result.models.length) setModelError('模型列表为空。')
    } catch (requestError) {
      setModelError(requestError instanceof ApiError ? requestError.message : '拉取模型列表失败。')
    } finally {
      setLoadingModels(false)
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header className="settings-header">
          <div>
            <Gear size={20} weight="bold" />
            <div>
              <h2 id="settings-title">模型设置</h2>
              <p>拉取、添加和编辑模型，并选择当前会话使用哪一个。</p>
            </div>
          </div>
          <button className="dialog-close" type="button" onClick={onClose} aria-label="关闭设置">
            <X size={18} />
          </button>
        </header>

        <DataBackupPanel onBeforeExport={onBeforeDataExport} onImport={onImportLearningData} />

        <div className="settings-layout">
          <aside className="profile-list" aria-label="模型列表">
            <button className="new-profile-button" type="button" onClick={() => {
              setForm(blankProfile())
              setError('')
              resetModelDiscovery()
            }}>
              <Plus size={16} weight="bold" /> 添加模型
            </button>
            <div className="profile-scroll">
              {profiles.length ? profiles.map((profile) => (
                <button
                  className={`profile-item ${form.id === profile.id ? 'is-editing' : ''}`}
                  type="button"
                  onClick={() => {
                    setForm(profileToForm(profile))
                    setError('')
                    resetModelDiscovery()
                  }}
                  key={profile.id}
                >
                  <span>{profile.name}</span>
                  <small>{profile.model} · {PROTOCOL_OPTIONS[profile.protocol].label}</small>
                  {activeProfileId === profile.id && <b><Check size={12} /> 当前使用</b>}
                </button>
              )) : (
                <div className="profile-empty">
                  <Key size={22} />
                  <p>还没有模型配置</p>
                  <span>新建后即可在会话中发送消息。</span>
                </div>
              )}
            </div>
          </aside>

          <form className="profile-form" onSubmit={handleSubmit}>
            <div className="form-heading">
              <div>
                <h3>{form.id ? '编辑模型' : '添加模型'}</h3>
                <p>密钥写入本地服务端文件，读取列表时不会返回到浏览器。</p>
              </div>
              {form.id && (
                <button
                  className={`active-profile-button ${activeProfileId === form.id ? 'is-active' : ''}`}
                  type="button"
                  onClick={() => onActiveProfileChange(form.id ?? null)}
                >
                  <Check size={14} weight="bold" />
                  {activeProfileId === form.id ? '当前使用' : '设为当前'}
                </button>
              )}
            </div>

            <div className="profile-form-scroll">
              <div className="form-grid">
              <label>
                <span>配置名称</span>
                <input
                  value={form.name}
                  onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
                  placeholder="例如：学习助手"
                  required
                  maxLength={80}
                />
              </label>

              <label>
                <span>接口协议</span>
                <select
                  value={form.protocol}
                  onChange={(event) => {
                    const protocol = event.target.value as ProtocolId
                    const previousDefault = PROTOCOL_OPTIONS[form.protocol].defaultUrl
                    setForm((current) => ({
                      ...current,
                      protocol,
                      requestUrl: !current.requestUrl || current.requestUrl === previousDefault
                        ? PROTOCOL_OPTIONS[protocol].defaultUrl
                        : current.requestUrl,
                    }))
                  }}
                >
                  {Object.entries(PROTOCOL_OPTIONS).map(([value, option]) => (
                    <option value={value} key={value}>{option.label}</option>
                  ))}
                </select>
              </label>

              <label className="form-span-2">
                <span>服务地址 / 完整接口地址</span>
                <input
                  type="url"
                  value={form.requestUrl}
                  onChange={(event) => setForm((current) => ({ ...current, requestUrl: event.target.value }))}
                  placeholder="https://..."
                  required
                />
                <small>
                  可填写服务根地址，系统会自动补全
                  {form.protocol === 'openai-responses' ? ' `/v1/responses`' : ' `/v1/messages`'}；也可以直接填写完整接口地址。
                </small>
              </label>

              <label className="form-span-2">
                <span>模型列表地址（可选）</span>
                <input
                  type="url"
                  value={form.modelsUrl ?? ''}
                  onChange={(event) => setForm((current) => ({ ...current, modelsUrl: event.target.value }))}
                  placeholder="留空时从服务地址推导 /v1/models"
                />
                <small>按 OpenAI Models 列表格式读取；代理平台路径不标准时可在这里填写完整地址。</small>
              </label>

              <div className="settings-model-field form-span-2">
                <div className="settings-model-field-heading">
                  <span>模型 ID</span>
                  <button type="button" onClick={() => void handleDiscoverModels()} disabled={loadingModels || !form.requestUrl.trim()}>
                    {loadingModels ? <CircleNotch className="loading-icon" size={13} /> : <ArrowClockwise size={13} />}
                    {loadingModels ? '正在拉取' : '拉取模型'}
                  </button>
                </div>
                <input
                  value={form.model}
                  onChange={(event) => setForm((current) => ({ ...current, model: event.target.value }))}
                  placeholder="可手动添加或编辑模型 ID"
                  required
                  maxLength={120}
                />
                <small>可以直接填写模型 ID，也可以从当前接口实时拉取后选择。</small>
                {availableModels.length > 0 && (
                  <div className="settings-model-results">
                    <input value={modelSearch} onChange={(event) => setModelSearch(event.target.value)} placeholder={`筛选 ${availableModels.length} 个模型`} />
                    <div>
                      {filteredModels.length ? filteredModels.map((model) => (
                        <button
                          className={form.model === model.id ? 'is-selected' : ''}
                          type="button"
                          onClick={() => setForm((current) => ({ ...current, model: model.id }))}
                          key={model.id}
                        >
                          <span>{model.id}</span>
                          {model.ownedBy && <small>{model.ownedBy}</small>}
                          {form.model === model.id && <Check size={13} weight="bold" />}
                        </button>
                      )) : <p>没有匹配的模型。</p>}
                    </div>
                  </div>
                )}
                {modelError && <div className="settings-model-error" role="alert">{modelError}</div>}
              </div>

              <label>
                <span>API Key</span>
                <input
                  type="password"
                  value={form.apiKey ?? ''}
                  onChange={(event) => setForm((current) => ({ ...current, apiKey: event.target.value }))}
                  placeholder={editedProfile?.hasApiKey ? '已保存；留空则不修改' : '输入 API Key'}
                  autoComplete="off"
                  required={!editedProfile?.hasApiKey}
                />
              </label>
              </div>

              {error && <div className="form-error" role="alert">{error}</div>}
            </div>

            <footer className="profile-form-footer">
              {form.id ? (
                <button className="danger-text-button" type="button" onClick={handleDelete} disabled={saving}>
                  <Trash size={15} /> 删除模型
                </button>
              ) : <span />}
              <button className="save-profile-button" type="submit" disabled={saving}>
                <FloppyDisk size={16} weight="bold" /> {saving ? '正在保存…' : '保存模型'}
              </button>
            </footer>
          </form>
        </div>
      </section>
    </div>
  )
}
