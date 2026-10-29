import { useEffect, useId, useRef, useState } from 'react'
import type { ConnectionsApi, SaveConnection, SshCheckResult } from '../shared/types.js'
import { parseTarget } from '../shared/validation.js'
import type { Translate } from './messages.js'

/** Manual and existing-service details share the same credential-safe editor. */
export function ConnectionForm({ api, draft, saving, t, onChange, onSave, onCancel }: {
  api: ConnectionsApi; draft: SaveConnection; saving: boolean; t: Translate
  onChange: (draft: SaveConnection) => void; onSave: () => void; onCancel: () => void
}) {
  const id = useId()
  const field = useRef<HTMLInputElement>(null)
  const [check, setCheck] = useState<{ target: string; pending?: boolean; result?: SshCheckResult; invalid?: boolean }>()
  const request = useRef(0)
  const active = useRef(true)
  const currentTarget = useRef(draft.target)
  currentTarget.current = draft.target
  const nameEdited = useRef(!!draft.id || draft.name.length > 0)
  useEffect(() => { field.current?.focus() }, [])
  useEffect(() => {
    active.current = true; setCheck(undefined)
    return () => { active.current = false; request.current++ }
  }, [api])
  const testSsh = async () => {
    const target = draft.target
    const version = ++request.current
    let parsed: string
    try { parsed = parseTarget(target) }
    catch { setCheck({ target, invalid: true }); return }
    setCheck({ target, pending: true })
    let result: SshCheckResult
    try { result = await api.checkSsh(parsed) }
    catch { result = { ok: false, code: 'SSH_FAILED' } }
    if (active.current && request.current === version && currentTarget.current === target) setCheck({ target, result })
  }
  const currentCheck = check?.target === draft.target ? check : undefined
  return <form className="dc-form" aria-label={draft.id ? t('edit') : t('addManually')} onSubmit={event => { event.preventDefault(); onSave() }}>
    <fieldset className="dc-form-fields" disabled={saving}>
      <div className="dc-host-field">
        <label htmlFor={`${id}-host`}>{t('target')}</label>
        <input ref={field} id={`${id}-host`} required maxLength={253} spellCheck={false} autoCapitalize="none" autoComplete="off" placeholder="devbox" value={draft.target} aria-describedby={`${id}-host-help`} onChange={event => {
          request.current++; setCheck(undefined)
          const target = event.target.value
          onChange({ ...draft, target, name: nameEdited.current ? draft.name : target.slice(0, 80) })
        }} />
        <div className="dc-host-tools"><small id={`${id}-host-help`}>{t('targetHint')}</small><button type="button" className="dc-text-action" disabled={saving || !draft.target.trim() || currentCheck?.pending} onClick={() => void testSsh()}>{t(currentCheck?.pending ? 'checkingSsh' : 'checkSsh')}</button></div>
        {currentCheck && <small className={currentCheck.invalid || currentCheck.result?.ok === false ? 'dc-error' : 'dc-note'} role="status">{t(currentCheck.pending ? 'checkingSsh' : currentCheck.invalid ? 'invalidSshTarget' : currentCheck.result?.ok ? 'sshCheckSuccess' : currentCheck.result?.code ?? 'SSH_FAILED')}</small>}
      </div>
      <label>{t('name')}<input required maxLength={80} autoComplete="off" value={draft.name} onChange={event => { nameEdited.current = true; onChange({ ...draft, name: event.target.value }) }} /></label>
      <label>{t('mode')}<select value={draft.mode ?? 'existing'} onChange={event => onChange({ ...draft, mode: event.target.value as 'managed' | 'existing', launchUrl: undefined })}><option value="managed">{t('managed')}</option><option value="existing">{t('existing')}</option></select><small>{t(draft.mode === 'managed' ? 'managedHint' : 'existingHint')}</small></label>
      {draft.mode !== 'managed' && <label>{t('launchUrl')}<input required={!draft.id} type="password" maxLength={1024} spellCheck={false} autoComplete="new-password" placeholder="http://127.0.0.1:…/?token=…" value={draft.launchUrl ?? ''} onChange={event => onChange({ ...draft, launchUrl: event.target.value })} /><small>{t(draft.id ? 'editHint' : 'launchHint')}</small></label>}
    </fieldset>
    <div className="dc-dialog-footer"><button type="button" className="dc-quiet" disabled={saving} onClick={onCancel}>{t(draft.id ? 'cancel' : 'back')}</button><button className="dc-primary" disabled={saving} type="submit">{t(saving ? 'saving' : draft.id ? 'save' : 'addAndConnect')}</button></div>
  </form>
}
