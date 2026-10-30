import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactElement } from 'react'
import {
  Button, Menu, Modal, StateDot, Tooltip, relativeTime,
  IconFolderCloseRegular, IconFolderOpenRegular, IconTriangleRightFillRegular,
  IconSearchOutlineRegular, IconSlidersTwoOutlineRegular, IconProjectAddOutlineRegular,
  IconNewChatOutlineRegular, IconPinFillRegular, IconCloseOutlineRegular, IconEllipsisOutlineRegular,
  type MenuItem,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { CatalogSessionRow, CatalogSourcePage, WorkspaceFilter, WorkspaceSource } from './workspace-catalog.js'
import {
  WorkspaceBrowserViewModel, WORKSPACE_ADD_KEY, workspaceReconnectKey,
  type WorkspaceBrowserModel, type WorkspaceBrowserSnapshot,
} from './workspace-browser-view-model.js'
import { messages, type Translate } from './workspace-browser-messages.js'
import { workspaceBrowserCss } from './workspace-browser.css.js'

export type { WorkspaceSelection, WorkspaceSource } from './workspace-catalog.js'
export interface WorkspaceBrowserProps extends WorkspaceBrowserModel {
  /** A parent command requests focus without controlling the search draft. */
  searchRequest?: number
  locale?: string
  /** Native sidebar.workspaces owner share; false renders the 36px icon rail. */
  wide?: boolean
  expandSidebar?(): void
}

function Hint({ label, children }: { label: string; children: ReactElement }) {
  return <Tooltip label={label} portal side="bottom" align="end" delayMs={500}>{children}</Tooltip>
}

interface RowAction extends MenuItem { run(): void }
/** Menu owns portal placement, keyboard navigation and focus return. */
function Actions({ label, items, disabled }: { label: string; items: RowAction[]; disabled: boolean }) {
  const [open, setOpen] = useState(false)
  useEffect(() => { if (disabled) setOpen(false) }, [disabled])
  return <Menu className="dcw-actions" open={open && !disabled} onClose={() => setOpen(false)} portal dense align="end"
    items={items} onSelect={id => { setOpen(false); if (!disabled) items.find(item => item.id === id)?.run() }}
    anchor={<button className="dcw-action-trigger" aria-label={label} aria-haspopup="menu" aria-expanded={open && !disabled}
      disabled={disabled} onClick={() => setOpen(!open)}><IconEllipsisOutlineRegular size={16} /></button>} />
}

function Rename({ title, t, busy, disabled, onSave, onCancel }: {
  title: string; t: Translate; busy: boolean; disabled: boolean; onSave(title: string): void; onCancel(): void
}) {
  // An unsaved input draft and its DOM focus belong to the editor, not the Host catalog.
  const [value, setValue] = useState(title)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const editor = input.current
    const row = editor?.closest('li')
    editor?.focus(); editor?.select()
    return () => {
      queueMicrotask(() => {
        if (document.activeElement === document.body && row?.isConnected) {
          const control = row.querySelector<HTMLButtonElement>('.dcw-action-trigger') ?? row.querySelector<HTMLButtonElement>('.dcw-open')
          control?.focus({ preventScroll: true })
        }
      })
    }
  }, [])
  return <form className="dcw-rename" onSubmit={event => {
    event.preventDefault()
    if (!busy && !disabled && value.trim()) onSave(value.trim())
  }}>
    <input ref={input} aria-label={t('rename')} value={value} disabled={busy || disabled} maxLength={200}
      onChange={event => setValue(event.target.value)} onKeyDown={event => {
        if (event.key === 'Escape') { event.stopPropagation(); onCancel() }
      }} />
    <div><button disabled={busy || disabled || !value.trim()}>{t('save')}</button>
      <button type="button" onClick={onCancel}>{t('cancel')}</button></div>
  </form>
}

function HostLabel({ source, t }: { source: WorkspaceSource; t: Translate }) {
  if (source.id === 'local') return null
  return <span className="dcw-host" title={`${source.name} · ${t(source.phase)}`}>
    <span>{source.name}</span><i className="dcw-dot" data-phase={source.phase} aria-label={t(source.phase)} />
  </span>
}

/** One clock for the visible list; bucketing is the public native implementation. */
function useListClock(visible: boolean) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!visible) return
    const refresh = () => { if (!document.hidden) setNow(Date.now()) }
    refresh()
    const timer = setInterval(refresh, 60_000)
    document.addEventListener('visibilitychange', refresh)
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', refresh) }
  }, [visible])
  return now
}

function SessionTime({ at, now, chinese }: { at: number; now: number; chinese: boolean }) {
  // Missing legacy timestamps do not acquire an invented age.
  const date = new Date(at)
  if (at <= 0 || !Number.isFinite(date.getTime())) return null
  const { unit, n } = relativeTime(at, now)
  const units = chinese
    ? { now: '刚刚', minutes: '分钟', hours: '小时', days: '天', months: '个月', years: '年' }
    : { now: 'now', minutes: 'min', hours: 'h', days: 'd', months: 'mo', years: 'y' }
  return <time dateTime={date.toISOString()} title={date.toLocaleString(chinese ? 'zh-CN' : 'en')}
    className="dcw-time">{unit === 'now' ? units.now : `${n}${units[unit]}`}</time>
}

interface RowViewProps {
  source: WorkspaceSource
  state: WorkspaceBrowserSnapshot
  vm: WorkspaceBrowserViewModel
  t: Translate
  now: number
  chinese: boolean
}

function SessionRow({ row, loose = false, source, state, vm, t, now, chinese }: RowViewProps & { row: CatalogSessionRow; loose?: boolean }) {
  const { session, key, pinned, archived } = row
  const busy = state.pending.has(key)
  const title = session.blank ? t('newChat') : session.title || t('untitled')
  const selected = state.selected?.sourceId === source.id && state.selected.sessionId === session.id
  const archiveOpen = state.archiving === key
  const element = useRef<HTMLLIElement>(null)
  const previouslyOpen = useRef(false)
  useEffect(() => {
    const closed = previouslyOpen.current && !archiveOpen
    previouslyOpen.current = archiveOpen
    // The menu item that opened the Modal has already left its portal. Restore
    // to the stable row trigger when native modal focus return has no live seat.
    if (closed && document.activeElement === document.body) element.current?.querySelector<HTMLButtonElement>('.dcw-action-trigger')?.focus({ preventScroll: true })
  }, [archiveOpen])
  const confirmArchive = () => {
    if (busy || source.phase !== 'connected') return
    if (session.running) {
      vm.confirmArchive(key)
    } else void vm.archiveSession(source.id, session.id, true)
  }
  const closeArchive = () => { if (!busy) vm.confirmArchive(undefined) }
  return <li ref={element} className="dcw-session">
    {archiveOpen && <Modal open onClose={closeArchive} closeLabel={t('close')} title={t('archiveRunning')}
      description={`${title} · ${source.name || t('title')}`} footer={<>
        <Button variant="outline" disabled={busy} onClick={closeArchive}>{t('cancel')}</Button>
        <Button variant="outline" disabled={busy || source.phase !== 'connected'} onClick={() => {
          void vm.archiveSession(source.id, session.id, true, { stopActivity: true })
        }}>{t('stopAndArchive')}</Button>
      </>}><p>{t('archiveRunningHint')}</p>{state.error !== undefined && <p role="alert">{t('failed')}</p>}</Modal>}
    {state.editing === key
      ? <Rename title={session.title} busy={busy} disabled={source.phase !== 'connected'} t={t}
        onCancel={() => vm.edit(undefined)} onSave={title => void vm.renameSession(source.id, session.id, title)} />
      : <div className="dcw-row dcw-session-row" data-selected={selected || undefined} data-archived={archived || undefined}>
        <button className="dcw-open" aria-label={source.id === 'local' ? title : `${title} · ${source.name}`}
          aria-current={selected ? 'page' : undefined} disabled={archived || busy} title={title}
          onClick={() => void vm.openSession(source.id, session.id)}>
          <span className="dcw-session-mark">
            {!session.blank && !archived && session.running && <span role="img" aria-label={t('running')}><StateDot state="ongoing" /></span>}
          </span>
          <span className="dcw-title">{title}</span>
        </button>
        {loose && <HostLabel source={source} t={t} />}
        <div className="dcw-row-end">
          <span className="dcw-metadata">
            {!session.blank && <SessionTime at={session.updatedAt} now={now} chinese={chinese} />}
            {pinned && <span className="dcw-pin" role="img" aria-label={t('pinned')}><IconPinFillRegular size={14} /></span>}
          </span>
          <div className="dcw-row-actions"><Actions label={`${t('actions')}: ${title}`} disabled={busy || source.phase !== 'connected'}
            items={archived
              ? [{ id: 'restore', label: t('restore'), run: () => void vm.archiveSession(source.id, session.id, false) }]
              : [
                { id: 'rename', label: t('rename'), run: () => vm.edit(key) },
                { id: 'pin', label: t(pinned ? 'unpin' : 'pin'), run: () => void vm.pinSession(source.id, session.id, !pinned) },
                { id: 'archive', label: t('archive'), run: confirmArchive },
              ]} /></div>
        </div>
      </div>}
  </li>
}

function WorkspaceRow({ row, source, state, vm, t, now, chinese }: RowViewProps & { row: CatalogSourcePage['workspaces'][number] }) {
  const regionId = useId()
  const { key, workspace, sessions, sessionCount } = row
  const expanded = !state.collapsed.has(key)
  const busy = state.pending.has(key)
  const connected = source.phase === 'connected'
  const ownSelection = state.selected?.sourceId === source.id ? state.selected : undefined
  const selected = ownSelection?.workspaceId === workspace.id && !ownSelection.sessionId
  const active = selected || !!ownSelection?.sessionId && workspace.sessionIds.includes(ownSelection.sessionId)
  const title = workspace.title || workspace.path
  return <li className="dcw-project">
    {state.editing === key
      ? <Rename title={workspace.title} busy={busy} disabled={!connected} t={t}
        onCancel={() => vm.edit(undefined)} onSave={title => void vm.renameWorkspace(source.id, workspace.id, title)} />
      : <div className="dcw-row dcw-project-row" data-selected={selected || undefined} data-active={active || undefined}>
        <button className="dcw-fold" aria-label={`${t(expanded ? 'collapse' : 'expand')}: ${title}`} aria-expanded={expanded}
          aria-controls={regionId} onClick={() => vm.toggleWorkspace(key)}>
          <span className="dcw-folder">{expanded ? <IconFolderOpenRegular size={16} /> : <IconFolderCloseRegular size={16} />}</span>
          <span className="dcw-chevron" data-expanded={expanded}><IconTriangleRightFillRegular size={16} /></span>
        </button>
        <button className="dcw-open" aria-label={source.id === 'local' ? title : `${title} · ${source.name}`}
          disabled={busy} title={workspace.path} onClick={() => void vm.openWorkspace(source.id, workspace.id)}>
          <span className="dcw-title">{title}</span>
        </button>
        <HostLabel source={source} t={t} />
        <div className="dcw-row-end"><div className="dcw-row-actions">
          <Hint label={t('newChat')}><button className="dcw-new-session" aria-label={`${t('newChat')}: ${title}`}
            disabled={busy || !connected} onClick={() => void vm.newSession(source.id, workspace.id)}><IconNewChatOutlineRegular size={16} /></button></Hint>
          <Actions label={`${t('actions')}: ${title}`} disabled={busy || !connected} items={[
            { id: 'new', label: t('newChat'), run: () => void vm.newSession(source.id, workspace.id) },
            { id: 'rename', label: t('rename'), run: () => vm.edit(key) },
            { id: 'forget', label: t('forget'), run: () => vm.confirmForget(key) },
          ]} />
        </div></div>
      </div>}
    {state.forgetting === key && <div className="dcw-confirm"><p>{t('forgetHint')}</p><div>
      <button disabled={busy || !connected} onClick={() => void vm.forgetWorkspace(source.id, workspace.id)}>{t('remove')}</button>
      <button onClick={() => vm.confirmForget(undefined)}>{t('cancel')}</button>
    </div></div>}
    <div id={regionId} hidden={!expanded}>
      <ul className="dcw-sessions">{sessions.map(row => <SessionRow key={row.key} {...{ row, source, state, vm, t, now, chinese }} />)}</ul>
      {sessionCount === 0 && <p className="dcw-no-chats">{t('noChats')}</p>}
    </div>
  </li>
}

/** View binds the headless ViewModel to native presentation primitives. */
export function WorkspaceBrowser(props: WorkspaceBrowserProps) {
  const [vm] = useState(() => new WorkspaceBrowserViewModel(props))
  useLayoutEffect(() => { vm.activate(); return () => vm.dispose() }, [vm])
  useLayoutEffect(() => vm.update(props))
  const state = useSyncExternalStore(vm.subscribe, vm.getSnapshot)
  const wide = props.wide !== false
  const chinese = !!props.locale?.startsWith('zh')
  const dictionary = chinese ? messages.zh : messages.en
  const t: Translate = key => dictionary[key]
  const now = useListClock(wide)
  const [filterOpen, setFilterOpen] = useState(false)
  const search = useRef<HTMLInputElement>(null)
  const searchToggle = useRef<HTMLButtonElement>(null)
  const searchId = useId()

  useEffect(() => {
    if (state.searchOpen && wide) search.current?.focus({ preventScroll: true })
  }, [state.searchOpen, wide])
  useEffect(() => {
    if (!props.searchRequest) return
    vm.setSearchOpen(true)
    if (!wide) props.expandSidebar?.()
    search.current?.focus({ preventScroll: true })
  }, [props.searchRequest])

  const openSearch = () => { vm.setSearchOpen(true); props.expandSidebar?.() }
  if (!wide) return <section className="dcw dcw-rail" aria-label={t('title')}>
    <style>{workspaceBrowserCss}</style>
    <Hint label={t('search')}><button ref={searchToggle} className="dcw-icon" aria-label={t('search')} onClick={openSearch}><IconSearchOutlineRegular size={18} /></button></Hint>
    <Hint label={t('add')}><button className="dcw-icon" aria-label={t('add')} disabled={state.pending.has(WORKSPACE_ADD_KEY)}
      onClick={() => { props.expandSidebar?.(); void vm.addWorkspace() }}><IconProjectAddOutlineRegular size={18} /></button></Hint>
  </section>

  return <section className="dcw" aria-label={t('title')}>
    <style>{workspaceBrowserCss}</style>
    <header className="dcw-header"><h2>{t('title')}</h2><div className="dcw-header-actions">
      <Hint label={t('search')}><button ref={searchToggle} className="dcw-icon" aria-label={t('search')} aria-expanded={state.searchOpen} aria-controls={state.searchOpen ? searchId : undefined}
        onClick={() => vm.setSearchOpen(!state.searchOpen)}><IconSearchOutlineRegular size={16} /></button></Hint>
      <Menu open={filterOpen} onClose={() => setFilterOpen(false)} portal dense align="end" selectedId={state.filter}
        items={(['active', 'pinned', 'archived'] as const).map(id => ({ id, label: t(id) }))}
        onSelect={id => { vm.setFilter(id as WorkspaceFilter); setFilterOpen(false) }}
        anchor={<button className="dcw-icon" aria-label={t('filter')} title={t('filter')} aria-haspopup="menu" aria-expanded={filterOpen}
          data-active={state.filter !== 'active' || undefined} onClick={() => setFilterOpen(!filterOpen)}><IconSlidersTwoOutlineRegular size={16} /></button>} />
      <Hint label={t('add')}><button className="dcw-icon" aria-label={t('add')} disabled={state.pending.has(WORKSPACE_ADD_KEY)}
        onClick={() => void vm.addWorkspace()}><IconProjectAddOutlineRegular size={16} /></button></Hint>
    </div></header>
    {state.searchOpen && <div id={searchId} className="dcw-search"><input ref={search} type="search" aria-label={t('search')} placeholder={t('search')}
      value={state.query} maxLength={500} onChange={event => vm.setQuery(event.target.value)}
      onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); vm.setSearchOpen(false); searchToggle.current?.focus({ preventScroll: true }) } }} /></div>}
    {state.error !== undefined && <div className="dcw-error" role="alert">
      <span>{t('failed')}</span>
      <button className="dcw-icon" aria-label={t('dismiss')} onClick={() => vm.dismissError()}><IconCloseOutlineRegular size={16} /></button>
    </div>}
    <div className="dcw-scroll">
      {state.totalCount === 0 && props.sources.length > 0 && props.sources.every(source => source.catalog) &&
        <p className="dcw-empty">{t(state.query.trim() ? 'noMatches' : state.filter === 'active' ? 'empty' : 'noFiltered')}</p>}
      {props.sources.length === 0 && <p className="dcw-empty" role="status">{t('loading')}</p>}
      {state.rows.map(({ source, workspaces, looseSessions }) => <div key={source.id} className="dcw-source" data-source-id={source.id}>
        <ul className="dcw-projects">{workspaces.map(row => <WorkspaceRow key={row.key} {...{ row, source, state, vm, t, now, chinese }} />)}</ul>
        {looseSessions.length > 0 && <ul className="dcw-sessions dcw-loose">{looseSessions.map(row =>
          <SessionRow key={row.key} loose {...{ row, source, state, vm, t, now, chinese }} />)}</ul>}
        {(source.phase !== 'connected' || !source.catalog || source.catalogError) && <div className="dcw-source-state" role="status">
          {workspaces.length === 0 && <IconFolderCloseRegular size={16} />}
          <span title={source.catalogError}>{source.id !== 'local' && <span>{source.name} · </span>}
            {t(source.phase === 'connected' ? source.catalogError ? 'catalogError' : 'loading' : source.phase)}</span>
          {source.phase !== 'connecting' && (source.phase !== 'connected' && source.id !== 'local' || source.catalogError) &&
            <button disabled={state.pending.has(workspaceReconnectKey(source.id))} onClick={() => void vm.reconnect(source.id)}>
              {t(source.phase === 'connected' ? 'refresh' : 'reconnect')}</button>}
        </div>}
      </div>)}
      {state.hiddenCount > 0 && <button className="dcw-more" onClick={() => vm.showMore()}>
        {t('showMore')} <span>({state.hiddenCount} {t('remaining')})</span>
      </button>}
    </div>
  </section>
}
