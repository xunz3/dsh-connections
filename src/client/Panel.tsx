import { useEffect, useRef, useState } from 'react'
import type { ConnectionsApi, ConnectionView, SaveConnection } from '../shared/types.js'
import { parseOpenResult, parseSave } from '../shared/validation.js'
import type { Translate } from './messages.js'
import { css } from './styles.js'
import { ConnectionForm } from './ConnectionForm.js'

export function isLocalPage(location: Pick<Location, 'protocol' | 'hostname'>): boolean {
  return location.protocol === 'dsh-app:' || ['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname)
}

export function Panel({ api, t, onOpen, local = isLocalPage(window.location) }: { api: ConnectionsApi; t: Translate; onOpen?: (id: string) => Promise<void>; local?: boolean }) {
  const [rows, setRows] = useState<ConnectionView[]>()
  const [error, setError] = useState('')
  const [draft, setDraft] = useState<SaveConnection>()
  const [saving, setSaving] = useState(false)
  const [removing, setRemoving] = useState<string>()
  const [opening, setOpening] = useState<string>()
  const [updating, setUpdating] = useState<{ id: string; version: string }>()
  const [links, setLinks] = useState<Record<string, string>>({})
  const alive = useRef(true)
  const generation = useRef(0)
  const mutation = useRef(0)
  const openVersions = useRef(new Map<string, number>())
  const latestRows = useRef(rows)
  latestRows.current = rows
  const invalidateOpen = (id: string) => {
    openVersions.current.set(id, (openVersions.current.get(id) ?? 0) + 1)
    setLinks(current => Object.fromEntries(Object.entries(current).filter(([key]) => key !== id)))
  }
  const refresh = async () => {
    const version = ++generation.current
    const next = await api.list()
    if (alive.current && version === generation.current) setRows(next)
  }
  useEffect(() => {
    alive.current = true
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try { await refresh() } catch { if (!stopped) setError(t('failed')) }
      if (!stopped) timer = setTimeout(poll, 2500)
    }
    void poll()
    return () => { stopped = true; alive.current = false; generation.current++; clearTimeout(timer) }
  }, [api, t])
  // A new forward gets a new authority. Never reuse a link after a disconnect.
  useEffect(() => {
    setLinks(current => Object.fromEntries(Object.entries(current).filter(([id, url]) => {
      const row = rows?.find(row => row.id === id)
      return row?.phase === 'connected' && Number(new URL(url).port) === row.localPort
    })))
  }, [rows])
  const run = async (action: () => Promise<unknown>) => {
    const operation = ++mutation.current
    generation.current++; setError('')
    try { await action(); if (alive.current && operation === mutation.current) await refresh() }
    catch (e) { if (alive.current && operation === mutation.current) setError(e instanceof Error ? e.message : t('failed')) }
  }
  const save = async () => {
    if (!draft || saving) return
    setSaving(true)
    if (draft.id) invalidateOpen(draft.id)
    await run(async () => {
      await api.save(parseSave({ ...draft, launchUrl: draft.launchUrl?.trim() || undefined }))
      if (alive.current) setDraft(undefined)
    })
    if (alive.current) setSaving(false)
  }
  const prepareOpen = async (row: ConnectionView) => {
    const version = (openVersions.current.get(row.id) ?? 0) + 1
    openVersions.current.set(row.id, version)
    const current = () => {
      const latest = latestRows.current?.find(item => item.id === row.id)
      return alive.current && openVersions.current.get(row.id) === version && latest?.phase === 'connected' && latest.localPort === row.localPort
    }
    setOpening(row.id); setError('')
    try {
      if (onOpen) { await onOpen(row.id); return }
      const { url } = parseOpenResult(await api.open(row.id))
      if (current() && Number(new URL(url).port) === row.localPort) {
        setLinks(current => ({ ...current, [row.id]: url }))
        // Native Desktop intercepts HTTP window opens. The real link remains
        // available if a browser blocks an asynchronous popup.
        window.open(url, '_blank', 'noopener,noreferrer')
      }
    } catch (e) { if (current()) setError(e instanceof Error ? e.message : t('failed')) }
    finally { if (alive.current) setOpening(value => value === row.id ? undefined : value) }
  }
  return <section className="dsh-connections" aria-label={t('title')}>
    <style>{css}</style>
    <header><h2>{t('title')}</h2><p>{t('subtitle')}</p></header>
    {!local && <p className="dc-note" role="status">{t('browserNote')}</p>}
    <div className="dc-heading"><h3>{t('ssh')}</h3><button disabled={!!draft} onClick={() => { setDraft({ name: '', target: '', mode: 'managed', autoConnect: true }); setError('') }}>{t('add')}</button></div>
    {draft && <ConnectionForm key={draft.id ?? 'new'} api={api} draft={draft} rows={rows ?? []} saving={saving} t={t} onChange={setDraft} onSave={() => void save()} onCancel={() => setDraft(undefined)} />}
    {rows === undefined ? <p role="status">{t('loading')}</p> : rows.length === 0 && !draft ? <div className="dc-empty"><strong>{t('empty')}</strong><p>{t('emptyHint')}</p></div> : <ul className="dc-list">
      {rows.map(row => <li className="dc-row" key={row.id}>
        <div className="dc-row-main"><div className="dc-identity"><strong>{row.name}</strong><div className="dc-meta"><span>{row.target}</span><span className="dc-state" data-phase={row.phase} role="status">{t(row.phase)}</span>{row.runtime && <span>Harness {row.runtime.version}</span>}</div></div>
          <div className="dc-actions">
            {row.phase === 'connected' ? <>
              {links[row.id] ? <a className="dc-link dc-primary" href={links[row.id]} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{t('open')} ↗</a> : <button className="dc-primary" disabled={!local || opening === row.id} onClick={() => void prepareOpen(row)}>{t(opening === row.id ? 'preparing' : 'open')}</button>}
              <button className="dc-quiet" onClick={() => { invalidateOpen(row.id); void run(() => api.disconnect(row.id)) }}>{t('disconnect')}</button>
            </> : row.phase === 'updating' ? <button disabled>{t('updating')}</button> : row.phase === 'connecting' ? <button onClick={() => { invalidateOpen(row.id); void run(() => api.disconnect(row.id)) }}>{t('cancel')}</button> : <button disabled={!local} onClick={() => { invalidateOpen(row.id); setRows(current => current?.map(item => item.id === row.id ? { ...item, phase: 'connecting', error: undefined } : item)); void run(() => api.connect(row.id)) }}>{t(row.phase === 'error' ? 'reconnect' : 'connect')}</button>}
            <details className="dc-menu" onKeyDown={e => { if (e.key === 'Escape') { e.currentTarget.open = false; e.currentTarget.querySelector('summary')?.focus() } }}>
              <summary aria-label={`${t('actions')}: ${row.name}`}>···</summary>
              <div className="dc-menu-popover"><button disabled={row.phase === 'updating'} onClick={e => { e.currentTarget.closest('details')!.open = false; setDraft({ id: row.id, name: row.name, target: row.target, mode: row.mode, autoConnect: row.autoConnect }); setError('') }}>{t('edit')}</button>{row.mode === 'managed' && <button disabled={row.phase === 'updating'} onClick={e => { e.currentTarget.closest('details')!.open = false; setUpdating({ id: row.id, version: '' }); setError('') }}>{t('updateRemote')}</button>}<button disabled={row.phase === 'updating'} onClick={e => { e.currentTarget.closest('details')!.open = false; setRemoving(row.id) }}>{t('remove')}</button></div>
            </details>
          </div>
        </div>
        {row.error && <p className="dc-error">{row.error}</p>}
        {links[row.id] && <p className="dc-note">{t('openHint')}</p>}
        {updating?.id === row.id && <form className="dc-form" onSubmit={e => { e.preventDefault(); const input = updating; invalidateOpen(row.id); setUpdating(undefined); setRows(current => current?.map(item => item.id === row.id ? { ...item, phase: 'updating', error: undefined } : item)); void run(() => api.update(input)) }}><label>{t('updateVersion')}<input required value={updating.version} maxLength={64} placeholder="0.2.1-rc.3" onChange={e => setUpdating({ id: row.id, version: e.target.value })} /></label><p className="dc-note">{t('updateHint')}</p><div className="dc-actions"><button type="submit">{t('updateRemote')}</button><button type="button" onClick={() => setUpdating(undefined)}>{t('cancel')}</button></div></form>}
        {removing === row.id && <div className="dc-confirm"><span>{t('confirmRemove')}</span><small className="dc-note">{t('removeHint')}</small><div className="dc-actions"><button onClick={() => { invalidateOpen(row.id); setRemoving(undefined); void run(() => api.remove(row.id)) }}>{t('remove')}</button><button onClick={() => setRemoving(undefined)}>{t('cancel')}</button></div></div>}
      </li>)}
    </ul>}
    {error && <p className="dc-error" role="alert">{error}</p>}
    <details className="dc-setup"><summary>{t('setup')}</summary><p>{t('step1')}</p><pre>ssh devbox</pre><p>{t('step2')}</p><p className="dc-note">{t('setupNote')}</p></details>
    <footer className="dc-note">{t('localNote')}</footer>
  </section>
}
