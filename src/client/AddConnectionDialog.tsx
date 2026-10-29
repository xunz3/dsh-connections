import { useEffect, useRef, useState } from 'react'
import { IconRefreshOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConnectionsApi, ConnectionView, SaveConnection } from '../shared/types.js'
import { parseSave } from '../shared/validation.js'
import type { Translate } from './messages.js'
import { ConnectionDialog } from './ConnectionDialog.js'
import { ConnectionForm } from './ConnectionForm.js'
import { ConnectionsIcon } from './ConnectionsIcon.js'

export function AddConnectionDialog({ api, rows, t, onAdded, onClose }: {
  api: ConnectionsApi; rows: ConnectionView[]; t: Translate; onAdded(row: ConnectionView): void; onClose(): void
}) {
  const [hosts, setHosts] = useState<string[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [saving, setSaving] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [draft, setDraft] = useState<SaveConnection>()
  const lifetime = useRef(0)
  const discovery = useRef(0)
  const submitting = useRef(false)
  const added = useRef(new Set<string>())
  const latestRows = useRef(rows); latestRows.current = rows
  const refresh = async () => {
    const version = ++discovery.current
    setLoading(true); setFailed(false)
    try {
      const next = await api.sshHosts()
      if (version !== discovery.current) return
      setHosts(next); setSelected(values => values.filter(value => next.includes(value)))
    } catch { if (version === discovery.current) setFailed(true) }
    finally { if (version === discovery.current) setLoading(false) }
  }
  useEffect(() => {
    lifetime.current++; setSaving(false); submitting.current = false; setErrors({}); void refresh()
    return () => { lifetime.current++; discovery.current++ }
  }, [api])
  const candidates = hosts.filter(host => !added.current.has(host) && !rows.some(row => row.target === host))
  const visible = candidates.filter(host => host.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
  const selection = selected.filter(host => candidates.includes(host))
  const save = async (inputs: SaveConnection[]) => {
    if (submitting.current) return
    submitting.current = true; setSaving(true); setErrors({})
    const version = lifetime.current
    const failures: Record<string, string> = Object.create(null)
    for (const input of inputs) {
      if (version !== lifetime.current) return
      if (!draft && (added.current.has(input.target) || latestRows.current.some(row => row.target === input.target))) continue
      try {
        const row = await api.save(parseSave(input))
        if (version !== lifetime.current) return
        added.current.add(row.target)
        setSelected(values => values.filter(value => value !== row.target))
        onAdded(row)
      } catch (error) { failures[input.target] = error instanceof Error ? error.message : t('failed') }
    }
    if (version !== lifetime.current) return
    submitting.current = false; setSaving(false); setErrors(failures)
    if (!Object.keys(failures).length) onClose()
  }
  return <ConnectionDialog title={t(draft ? 'addManually' : 'addSsh')} busy={saving} onClose={onClose} t={t}>
    {draft ? <ConnectionForm api={api} draft={draft} saving={saving} t={t} onChange={setDraft} onSave={() => void save([{ ...draft, autoConnect: true }])} onCancel={() => { setDraft(undefined); setErrors({}) }} /> : <>
      <div className="dc-discovery">
        {(candidates.length > 6 || query.length > 0) && <input className="dc-search" type="search" aria-label={t('searchHosts')} placeholder={t('searchHosts')} value={query} onChange={event => setQuery(event.target.value)} />}
        {loading ? <p className="dc-note" role="status">{t('hostsLoading')}</p> : failed ? <p className="dc-error" role="status">{t('hostsFailed')}</p> : !candidates.length ? <div className="dc-picker-empty"><ConnectionsIcon size={28} /><p>{t(hosts.length ? 'allHostsAdded' : 'hostsEmpty')}</p></div> : <ul className="dc-host-choices" aria-label={t('availableHosts')}>
          {visible.map(host => <li key={host}><label><ConnectionsIcon size={17} /><span>{host}</span><input type="checkbox" disabled={saving} checked={selected.includes(host)} onChange={event => setSelected(values => event.target.checked ? [...values, host] : values.filter(value => value !== host))} /></label>{Object.hasOwn(errors, host) && <p className="dc-error" role="alert">{errors[host]}</p>}</li>)}
          {!visible.length && <li className="dc-note">{t('noHostsMatch')}</li>}
        </ul>}
        <p className="dc-note dc-add-hint">{t('quickAddHint')}</p>
      </div>
      <div className="dc-dialog-footer"><div className="dc-actions"><button type="button" className="dc-icon-button" disabled={loading || saving} onClick={() => void refresh()} aria-label={t('refreshHosts')} title={t('refreshHosts')}><IconRefreshOutlineRegular size={18} /></button><button type="button" className="dc-quiet" disabled={saving} onClick={() => { setDraft({ name: '', target: '', mode: 'managed', autoConnect: true }); setErrors({}) }}>{t('addManually')}</button></div><button className="dc-primary" disabled={loading || failed || saving || !selection.length} onClick={() => void save(selection.map(target => ({ target, name: target.slice(0, 80), mode: 'managed', autoConnect: true })))}>{t(saving ? 'saving' : 'addSelected')}{selection.length > 0 && ` (${selection.length})`}</button></div>
    </>}
    {draft && Object.values(errors).map((error, index) => <p key={index} className="dc-error" role="alert">{error}</p>)}
  </ConnectionDialog>
}
