import { useRef, useState, type ChangeEvent } from 'react'
import { Database, DownloadSimple, UploadSimple, WarningCircle } from '@phosphor-icons/react'
import {
  learningDataBackupFilename,
  LearningDataBackupError,
  MAX_LEARNING_DATA_BACKUP_BYTES,
  parseLearningDataBackup,
  summarizeLearningDataBackup,
  type LearningDataBackup,
} from './dataBackup.ts'
import { ApiError, exportLearningData } from './chatApi.ts'

type DataBackupPanelProps = {
  onBeforeExport: () => Promise<void>
  onImport: (backup: LearningDataBackup) => Promise<void>
}

function summaryText(backup: LearningDataBackup) {
  const summary = summarizeLearningDataBackup(backup)
  return `${summary.canvasCount} 个画布、${summary.nodeCount} 个节点、${summary.messageCount} 条节点消息、${summary.agentSessionCount} 个全局 Agent 会话、${summary.planningSessionCount} 个 Agent 规划会话`
}

export function DataBackupPanel({ onBeforeExport, onImport }: DataBackupPanelProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [importing, setImporting] = useState(false)
  const [exporting, setExporting] = useState(false)

  async function handleExportLearningData() {
    setError('')
    setNotice('')
    setExporting(true)
    try {
      await onBeforeExport()
      const backup = await exportLearningData()
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = learningDataBackupFilename()
      anchor.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 0)
      setNotice(`已导出${summaryText(backup)}。`)
    } catch (exportError) {
      setError(exportError instanceof LearningDataBackupError || exportError instanceof ApiError
        ? exportError.message
        : '导出学习数据失败。')
    } finally {
      setExporting(false)
    }
  }

  async function importLearningData(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setError('')
    setNotice('')
    if (file.size > MAX_LEARNING_DATA_BACKUP_BYTES) {
      setError(`备份文件不能超过 ${Math.round(MAX_LEARNING_DATA_BACKUP_BYTES / 1_000_000)} MB。`)
      return
    }
    setImporting(true)
    try {
      const backup = parseLearningDataBackup(await file.text())
      const description = summaryText(backup)
      if (!window.confirm(`导入将用备份中的${description}替换当前全部学习数据。\n\n模型配置和 API Key 不会改变。继续吗？`)) return
      await onImport(backup)
      setNotice(`已导入${description}。`)
    } catch (importError) {
      setError(importError instanceof LearningDataBackupError || importError instanceof ApiError
        ? importError.message
        : '导入学习数据失败。')
    } finally {
      setImporting(false)
    }
  }

  return (
    <section className="settings-data-backup" aria-labelledby="settings-data-backup-title">
      <div className="settings-data-backup-copy">
        <Database size={18} weight="duotone" />
        <div>
          <b id="settings-data-backup-title">学习数据备份</b>
          <small>包含画布、节点、消息、摘要、笔记和 Agent 规划会话；不包含模型配置或 API Key。</small>
        </div>
      </div>
      <div className="settings-data-backup-actions">
        <button type="button" onClick={() => void handleExportLearningData()} disabled={exporting || importing}>
          <DownloadSimple size={14} weight="bold" /> {exporting ? '正在导出' : '导出备份'}
        </button>
        <button type="button" onClick={() => fileInputRef.current?.click()} disabled={importing || exporting}>
          <UploadSimple size={14} weight="bold" /> {importing ? '正在校验' : '导入备份'}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          onChange={(event) => void importLearningData(event)}
          aria-label="选择学习数据备份文件"
        />
      </div>
      {notice && <p className="settings-data-backup-notice" role="status">{notice}</p>}
      {error && <p className="settings-data-backup-error" role="alert"><WarningCircle size={13} />{error}</p>}
    </section>
  )
}
