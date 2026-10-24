import { useCallback, useEffect, useState } from 'react'
import { useBackend } from '../data/BackendContext'
import { Badge, Banner, Button } from '../ui'
import { Icon } from '../icons'

const ALLOWED = /\.(litematic|nbt|schem)$/i

/**
 * Import dialog for schematics, shaped like the modpack importer: drop files
 * into the dialog itself (no page-wide overlay) or pick them with the system
 * dialog, review the list, then confirm.
 */
export function SchematicImportDialog({
  open,
  instanceName,
  onClose,
  onImport,
}: {
  open: boolean
  instanceName: string
  onClose: () => void
  onImport: (paths: string[]) => Promise<void>
}) {
  const backend = useBackend()
  const [paths, setPaths] = useState<string[]>([])
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    if (!open) {
      setPaths([])
      setMessage(null)
      setDragging(false)
    }
  }, [open])

  const addFiles = useCallback(
    (files: File[]) => {
      const accepted: string[] = []
      const rejected: string[] = []
      for (const file of files) {
        let full = ''
        try {
          full = backend.system.getPathForFile(file)
        } catch {
          full = ''
        }
        if (!full) continue
        if (ALLOWED.test(full)) accepted.push(full)
        else rejected.push(file.name)
      }
      if (accepted.length > 0) {
        setPaths((previous) => [...new Set([...previous, ...accepted])])
        setMessage(null)
      }
      if (rejected.length > 0) {
        setMessage(`已忽略 ${rejected.length} 个非投影文件（只接受 .litematic / .nbt / .schem）`)
      }
    },
    [backend],
  )

  const pickFiles = async () => {
    try {
      const picked = await backend.system.pickFiles({
        title: '选择投影文件',
        multi: true,
        filters: [{ name: '投影文件（.litematic / .nbt / .schem）', extensions: ['litematic', 'nbt', 'schem'] }],
      })
      if (picked.cancelled || picked.paths.length === 0) return
      setPaths((previous) => [...new Set([...previous, ...picked.paths])])
      setMessage(null)
    } catch {
      setMessage('无法打开文件选择器，请直接把文件拖进来')
    }
  }

  const confirm = async () => {
    if (paths.length === 0) return
    setBusy(true)
    try {
      await onImport(paths)
      onClose()
    } finally {
      setBusy(false)
    }
  }

  if (!open) return null

  return (
    <div
      className="rename-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="rename-dialog schematic-import" role="dialog" aria-modal="true" aria-labelledby="schematic-import-title">
        <div className="rename-dialog__head">
          <span className="rename-dialog__icon"><Icon name="schematic" /></span>
          <div>
            <div className="eyebrow">导入投影</div>
            <h2 id="schematic-import-title">导入到「{instanceName}」</h2>
          </div>
        </div>

        <div
          className={dragging ? 'schematic-drop is-dragging' : 'schematic-drop'}
          onDragOver={(event) => {
            event.preventDefault()
            setDragging(true)
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false)
          }}
          onDrop={(event) => {
            event.preventDefault()
            setDragging(false)
            addFiles(Array.from(event.dataTransfer?.files ?? []))
          }}
        >
          <Icon name="upload" />
          <strong>把投影文件拖到这里</strong>
          <span>支持 .litematic / .nbt / .schem，可一次拖多个</span>
          <Button size="sm" variant="secondary" icon="folder" onClick={() => void pickFiles()}>选择文件…</Button>
        </div>

        {message ? <p className="schematic-import__note">{message}</p> : null}

        {paths.length > 0 ? (
          <>
            <div className="schematic-import__head">
              <strong>待导入 {paths.length} 个</strong>
              <Button size="xs" variant="ghost" icon="close" onClick={() => setPaths([])}>清空</Button>
            </div>
            <ul className="schematic-import__list">
              {paths.map((entry) => (
                <li key={entry}>
                  <Badge tone="outline">{entry.split(/[\\/]/).pop()}</Badge>
                  <Button
                    size="xs"
                    variant="ghost"
                    icon="close"
                    aria-label="移除"
                    onClick={() => setPaths((previous) => previous.filter((item) => item !== entry))}
                  />
                </li>
              ))}
            </ul>
          </>
        ) : (
          <Banner tone="info" title="还没有选择文件">拖入或点「选择文件…」，确认后统一导入到当前来源实例的 schematics 目录。</Banner>
        )}

        <div className="rename-dialog__actions">
          <Button variant="secondary" onClick={onClose} disabled={busy}>取消</Button>
          <Button variant="primary" loading={busy} disabled={paths.length === 0} onClick={() => void confirm()}>
            导入 {paths.length > 0 ? `(${paths.length})` : ''}
          </Button>
        </div>
      </div>
    </div>
  )
}
