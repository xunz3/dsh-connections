import { useEffect, useId, useRef, useState } from 'react'
import type { ConnectionsApi, ConnectionView, SaveConnection } from '../shared/types.js'
import type { Translate } from './messages.js'

/** One inline draft; discovery never changes a saved connection or starts SSH. */
export function ConnectionForm({ api, draft, rows, saving, t, onChange, onSave, onCancel }: {
  api: ConnectionsApi; draft: SaveConnection; rows: ConnectionView[]; saving: boolean; t: Translate
  onChange: (draft: SaveConnection) => void; onSave: () => void; onCancel: () => void
}) {
  const id = useId()
  const [hosts, setHosts] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [manual, setManual] = useState(false)
  const request = useRef(0)
  const active = useRef(true)
  const loaded = useRef(false)
  const initialTarget = useRef(draft.target)
  const nameEdited = useRef(!!draft.id || draft.name.length > 0)
  const field = useRef<HTMLInputElement | HTMLSelectElement | null>(null)
  const focusRequested = useRef(true)
  const refresh = async () => {
    const version = ++request.current
    setLoading(true); setFailed(false)
    try {
      const next = await api.sshHosts()
      if (!active.current || request.current !== version) return
      setHosts(next)
      if (next.length === 0 || (!loaded.current && initialTarget.current && !next.includes(initialTarget.current))) setManual(true)
      loaded.current = true
    } catch {
      if (active.current && request.current === version) {
        setFailed(true)
        setManual(true)
        loaded.current = true
      }
    } finally { if (active.current && request.current === version) setLoading(false) }
  }
  useEffect(() => {
    active.current = true
    void refresh()
    return () => { active.current = false; request.current++ }
  }, [api])
  useEffect(() => {
    if (!focusRequested.current || (!manual && loading)) return
    focusRequested.current = false
    field.current?.focus()
  }, [manual, loading])
  const chooseMode = (next: boolean) => {
    focusRequested.current = true
    setManual(next)
  }
  const changeTarget = (target: string) => onChange({ ...draft, target, name: nameEdited.current ? draft.name : target.slice(0, 80) })
  const added = new Set(rows.filter(row => row.id !== draft.id).map(row => row.target))
  return <form className="dc-form" aria-label={draft.id ? t('edit') : t('add')}
    onSubmit={event => { event.preventDefault(); onSave() }}
    onFocusCapture={() => { if (document.activeElement !== field.current) focusRequested.current = false }}
    onKeyDown={event => { if (event.key === 'Escape' && !saving) { event.stopPropagation(); onCancel() } }}>
    <fieldset className="dc-form-fields" disabled={saving}>
      <div className="dc-host-field">
        <label htmlFor={`${id}-host`}>{t('target')}</label>
        {manual ? <input ref={element => { field.current = element }} id={`${id}-host`} required maxLength={253} spellCheck={false} autoCapitalize="none" autoComplete="off" placeholder="devbox" value={draft.target} aria-describedby={`${id}-host-help`} onChange={event => changeTarget(event.target.value)} />
          : <select ref={element => { field.current = element }} id={`${id}-host`} required disabled={loading || saving} value={draft.target} aria-describedby={`${id}-host-help`} onChange={event => changeTarget(event.target.value)}>
            <option value="" disabled>{t(loading ? 'hostsLoading' : 'chooseHost')}</option>
            {draft.target && !hosts.includes(draft.target) && <option value={draft.target}>{draft.target} — {t('currentHost')}</option>}
            {hosts.map(host => <option key={host} value={host}>{host}{added.has(host) ? ` — ${t('alreadyAdded')}` : ''}</option>)}
          </select>}
        <div className="dc-host-tools">
          <button type="button" className="dc-text-action" disabled={loading || saving} onClick={() => void refresh()}>{t('refreshHosts')}</button>
          <button type="button" className="dc-text-action" disabled={saving || (manual && (loading || hosts.length === 0 || failed))} onClick={() => chooseMode(!manual)}>{t(manual ? 'chooseConfig' : 'addManually')}</button>
        </div>
        <small id={`${id}-host-help`} className={failed ? 'dc-error' : undefined} role={loading || failed || hosts.length === 0 ? 'status' : undefined}>{t(loading ? 'hostsLoading' : failed ? 'hostsFailed' : hosts.length === 0 ? 'hostsEmpty' : manual ? 'targetHint' : 'hostsHint')}</small>
      </div>
      <label>{t('name')}<input required maxLength={80} autoComplete="off" value={draft.name} onChange={event => { nameEdited.current = true; onChange({ ...draft, name: event.target.value }) }} /></label>
      <div className="dc-connection-options">
        <label>{t('mode')}<select value={draft.mode ?? 'existing'} onChange={event => onChange({ ...draft, mode: event.target.value as 'managed' | 'existing', launchUrl: undefined })}><option value="managed">{t('managed')}</option><option value="existing">{t('existing')}</option></select>{draft.mode === 'managed' && <small>{t('managedHint')}</small>}</label>
        {draft.mode !== 'managed' && <label>{t('launchUrl')}<input required={!draft.id} type="password" maxLength={1024} spellCheck={false} autoComplete="new-password" placeholder="http://127.0.0.1:…/?token=…" value={draft.launchUrl ?? ''} onChange={event => onChange({ ...draft, launchUrl: event.target.value })} /><small>{t(draft.id ? 'editHint' : 'launchHint')}</small></label>}
        <label className="dc-checkbox"><input type="checkbox" checked={draft.autoConnect ?? false} onChange={event => onChange({ ...draft, autoConnect: event.target.checked })} />{t('autoConnect')}</label>
      </div>
    </fieldset>
    <div className="dc-actions"><button className="dc-primary" disabled={saving} type="submit">{t('save')}</button><button type="button" disabled={saving} onClick={onCancel}>{t('cancel')}</button></div>
  </form>
}
