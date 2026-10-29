import { useEffect, useRef, useState } from 'react'
import { Menu, IconEllipsisOutlineRegular, IconFolderOpenRegular, IconProjectAddOutlineRegular, type MenuItem } from '@deepseek-ai/dsh-client-ui-primitives'
import { LATEST_SUPPORTED_REMOTE_VERSION, parseSave } from '../shared/validation.js'
import type { ConnectionsApi, ConnectionView, SaveConnection } from '../shared/types.js'
import type { Translate } from './messages.js'
import { css } from './styles.js'
import { ConnectionForm } from './ConnectionForm.js'
import { ConnectionDialog } from './ConnectionDialog.js'
import { AddConnectionDialog } from './AddConnectionDialog.js'
import { ConnectionsIcon } from './ConnectionsIcon.js'
import { pollConnections } from './connection-polling.js'
import { isWorkspaceSurface } from './workspace-surface.js'
import { desktopBrowser } from './desktop-guest.js'

export function isLocalPage(page: Pick<Location, 'protocol' | 'hostname'>): boolean {
  return isWorkspaceSurface(page, desktopBrowser() !== undefined)
}

interface Action extends MenuItem { run(): void }
function Actions({ label, items }: { label: string; items: Action[] }) {
  const [open, setOpen] = useState(false)
  return <Menu open={open} onClose={() => setOpen(false)} portal dense align="end" items={items}
    onSelect={id => { setOpen(false); items.find(item => item.id === id)?.run() }}
    anchor={<button className="dc-icon-button" aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}><IconEllipsisOutlineRegular size={18} /></button>} />
}

export function Panel({ api, t, onOpen, onAddWorkspace, onManagePlugins, local = isLocalPage(window.location) }: {
  api: ConnectionsApi; t: Translate; onOpen(id: string): Promise<void>; onAddWorkspace?(id: string): Promise<void>; onManagePlugins?(id: string): Promise<void>; local?: boolean
}) {
  const [rows, setRows] = useState<ConnectionView[]>()
  const [refreshError, setRefreshError] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState<SaveConnection>()
  const [saving, setSaving] = useState(false)
  const [dialogError, setDialogError] = useState('')
  const [removing, setRemoving] = useState<ConnectionView>()
  const [updating, setUpdating] = useState<ConnectionView>()
  const [opening, setOpening] = useState<string>()
  const polling = useRef<ReturnType<typeof pollConnections>>()
  const generation = useRef(0)
  const operations = useRef(new Map<string, number>())
  const submitting = useRef(false)
  useEffect(() => {
    generation.current++; operations.current.clear(); submitting.current = false; setSaving(false); setOpening(undefined); setDialogError(''); setErrors({})
    const current = pollConnections({ document, read: () => api.list(), onValue: next => { setRows(next); setRefreshError('') }, onError: () => setRefreshError(t('failed')) })
    polling.current = current
    return () => { generation.current++; current.dispose(); if (polling.current === current) polling.current = undefined }
  }, [api, t])
  const replace = (row: ConnectionView) => setRows(values => values?.some(value => value.id === row.id) ? values.map(value => value.id === row.id ? row : value) : [...values ?? [], row])
  const run = async (id: string, action: () => Promise<ConnectionView | void>, optimistic?: Partial<ConnectionView>, onSuccess?: () => void) => {
    const epoch = generation.current
    const version = (operations.current.get(id) ?? 0) + 1
    operations.current.set(id, version)
    setOpening(value => value === id ? undefined : value)
    const current = () => generation.current === epoch && operations.current.get(id) === version
    polling.current?.invalidate()
    setErrors(values => ({ ...values, [id]: '' }))
    if (optimistic) setRows(values => values?.map(row => row.id === id ? { ...row, ...optimistic } : row))
    try {
      const row = await action()
      if (current()) { if (row) replace(row); onSuccess?.() }
    } catch (error) { if (current()) setErrors(values => ({ ...values, [id]: error instanceof Error ? error.message : t('failed') })) }
    finally { if (current()) { polling.current?.invalidate(); polling.current?.refresh() } }
  }
  const enable = (row: ConnectionView, enabled: boolean) => void run(row.id, () => enabled ? api.connect(row.id) : api.disconnect(row.id), { autoConnect: enabled, phase: enabled ? 'connecting' : 'disconnected', stage: undefined, error: undefined })
  const added = (row: ConnectionView) => { polling.current?.invalidate(); replace(row); enable(row, true) }
  const save = async () => {
    if (!draft || submitting.current) return
    submitting.current = true; setSaving(true); setDialogError('')
    const epoch = generation.current
    polling.current?.invalidate()
    if (draft.id) { operations.current.set(draft.id, (operations.current.get(draft.id) ?? 0) + 1); setOpening(value => value === draft.id ? undefined : value) }
    try {
      const input = parseSave({ ...draft, launchUrl: draft.launchUrl?.trim() || undefined })
      // The list switch owns this preference; an older edit draft must not undo it.
      delete input.autoConnect
      const row = await api.save(input)
      if (generation.current !== epoch) return
      replace(row); setDraft(undefined)
      if (row.autoConnect && row.phase === 'disconnected') enable(row, true)
    } catch (error) { if (generation.current === epoch) setDialogError(error instanceof Error ? error.message : t('failed')) }
    finally { if (generation.current === epoch) { submitting.current = false; setSaving(false); polling.current?.invalidate(); polling.current?.refresh() } }
  }
  const prepareOpen = async (row: ConnectionView, open = onOpen) => {
    const epoch = generation.current
    const version = (operations.current.get(row.id) ?? 0) + 1
    operations.current.set(row.id, version); setOpening(row.id)
    try { await open(row.id) }
    catch (error) { if (generation.current === epoch && operations.current.get(row.id) === version) setErrors(values => ({ ...values, [row.id]: error instanceof Error ? error.message : t('failed') })) }
    finally { if (generation.current === epoch && operations.current.get(row.id) === version) setOpening(value => value === row.id ? undefined : value) }
  }
  return <section className="dsh-connections" aria-label={t('title')}>
    <style>{css}</style>
    <header className="dc-page-heading"><h2>{t('title')}</h2><p>{t('subtitle')}</p></header>
    {!local && <p className="dc-note" role="status">{t('browserNote')}</p>}
    <div className="dc-heading"><h3>{t('sshFromHere')}</h3><button className="dc-primary dc-add-button" disabled={!local || rows === undefined} onClick={() => setAdding(true)}>{t('add')}</button></div>
    {rows === undefined ? <p role="status">{t('loading')}</p> : !rows.length ? <div className="dc-empty"><ConnectionsIcon size={32} /><strong>{t('empty')}</strong><p>{t('emptyHint')}</p><button className="dc-quiet" disabled={!local} onClick={() => setAdding(true)}>{t('addSsh')}</button></div> : <ul className="dc-list">
      {rows.map(row => {
        const enabled = row.autoConnect === true || row.phase === 'connected' || row.phase === 'connecting' || row.phase === 'updating'
        const available = local && row.phase === 'connected' && opening !== row.id
        const error = errors[row.id] || row.error
        const phase = (row.phase === 'connecting' || row.phase === 'updating') && row.stage ? ({ preparing: 'preparingHost', tunnel: 'openingTunnel', authenticating: 'authenticating' } as const)[row.stage] : row.phase
        const items: Action[] = [
          { id: 'edit', label: t('edit'), disabled: row.phase === 'updating', run: () => { setDraft({ id: row.id, name: row.name, target: row.target, mode: row.mode, autoConnect: row.autoConnect }); setDialogError('') } },
          ...(onManagePlugins ? [{ id: 'plugins', label: t('managePlugins'), disabled: !available, run: () => void prepareOpen(row, onManagePlugins) }] : []),
          ...(row.mode === 'managed' ? [{ id: 'update', label: t('updateRemote'), disabled: !local || !enabled || row.phase === 'updating' || row.phase === 'connecting', run: () => setUpdating(row) }] : []),
          { id: 'remove', label: t('remove'), disabled: row.phase === 'updating', run: () => setRemoving(row) },
        ]
        return <li className="dc-row" key={row.id}>
          <div className="dc-row-main">
            <button className="dc-switch" role="switch" aria-checked={enabled} aria-label={`${t('enableConnection')}: ${row.name}`} title={t('switchHint')} disabled={row.phase === 'updating' || (!local && !enabled)} onClick={() => enable(row, !enabled)}><span /></button>
            <div className="dc-identity"><div className="dc-host-title"><ConnectionsIcon size={15} /><strong>{row.name}</strong>{row.target !== row.name && <span className="dc-target">{row.target}</span>}</div><div className="dc-meta"><span className="dc-state" data-phase={row.phase} role="status">{t(phase)}</span>{row.runtime && <span>Harness {row.runtime.version}</span>}{row.phase === 'error' && <button className="dc-text-action" disabled={!local} onClick={() => void run(row.id, () => api.reconnect(row.id), { autoConnect: true, phase: 'connecting', stage: undefined, error: undefined })}>{t('retry')}</button>}</div>{error && <p className="dc-error" role="alert">{error}</p>}</div>
            <div className="dc-row-actions"><Actions label={`${t('actions')}: ${row.name}`} items={items} />{row.phase === 'connected' && <>{onAddWorkspace && <button className="dc-icon-button" disabled={!available} title={t('addWorkspace')} aria-label={`${t('addWorkspace')}: ${row.name}`} onClick={() => void prepareOpen(row, onAddWorkspace)}><IconProjectAddOutlineRegular size={18} /></button>}<button className="dc-icon-button" disabled={!available} title={t('open')} aria-label={`${t('open')}: ${row.name}`} onClick={() => void prepareOpen(row)}><IconFolderOpenRegular size={18} /></button></>}</div>
          </div>
        </li>
      })}
    </ul>}
    {refreshError && <p className="dc-error" role="alert">{refreshError}</p>}
    <p className="dc-note dc-switch-note">{t('switchHint')}</p>
    <details className="dc-setup"><summary>{t('setup')}</summary><p>{t('step1')}</p><pre>ssh devbox</pre><p>{t('step2')}</p><p className="dc-note">{t('setupNote')}</p></details>
    {adding && <AddConnectionDialog api={api} rows={rows ?? []} t={t} onAdded={added} onClose={() => setAdding(false)} />}
    {draft && <ConnectionDialog title={t('editConnection')} busy={saving} t={t} onClose={() => setDraft(undefined)}><ConnectionForm api={api} draft={draft} saving={saving} t={t} onChange={setDraft} onSave={() => void save()} onCancel={() => setDraft(undefined)} />{dialogError && <p className="dc-error" role="alert">{dialogError}</p>}</ConnectionDialog>}
    {updating && <ConnectionDialog title={t('updateRemote')} t={t} onClose={() => setUpdating(undefined)}><p className="dc-dialog-description">{updating.name}</p><div className="dc-update-target"><span>{t('latestCompatible')}</span><strong>Harness {LATEST_SUPPORTED_REMOTE_VERSION}</strong></div><p className="dc-note">{t('updateHint')}</p><div className="dc-dialog-footer"><button className="dc-quiet" onClick={() => setUpdating(undefined)}>{t('cancel')}</button><button className="dc-primary" onClick={() => { const row = updating; setUpdating(undefined); void run(row.id, () => api.update({ id: row.id }), { phase: 'updating', stage: 'preparing', error: undefined }) }}>{t('updateNow')}</button></div></ConnectionDialog>}
    {removing && <ConnectionDialog title={t('confirmRemove')} t={t} onClose={() => setRemoving(undefined)}><p className="dc-dialog-description">{removing.name}</p><p className="dc-note">{t('removeHint')}</p><div className="dc-dialog-footer"><button className="dc-quiet" onClick={() => setRemoving(undefined)}>{t('cancel')}</button><button className="dc-primary" onClick={() => { const row = removing; setRemoving(undefined); void run(row.id, () => api.remove(row.id), undefined, () => setRows(values => values?.filter(value => value.id !== row.id))) }}>{t('remove')}</button></div></ConnectionDialog>}
  </section>
}
