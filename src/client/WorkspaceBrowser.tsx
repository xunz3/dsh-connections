import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type FocusEventHandler, type KeyboardEvent, type ReactElement } from 'react'
import {
  Button, Menu, Modal, StateDot, Tooltip, UiStyles, relativeTime,
  IconFolderCloseRegular, IconFolderOpenRegular, IconTriangleRightFillRegular,
  IconSearchOutlineRegular, IconSlidersTwoOutlineRegular, IconProjectAddOutlineRegular,
  IconNewChatOutlineRegular, IconPinFillRegular, IconCloseOutlineRegular, IconEllipsisOutlineRegular,
  type MenuItem,
} from './ui/index.js'
import type { CatalogSessionRow, CatalogSourcePage, WorkspaceFilter, WorkspaceSource } from './workspace-catalog.js'
import {
  WorkspaceBrowserViewModel, WORKSPACE_ADD_KEY, workspaceReconnectKey,
  moveWorkspaceFocus, resolveWorkspaceFocus, workspaceFocusRows,
  type WorkspaceBrowserModel, type WorkspaceBrowserSnapshot, type WorkspaceFocusCommand, type WorkspaceFocusRow,
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
/** Owned menu controls top-layer placement, keyboard navigation and focus return. */
function Actions({ label, items, disabled, tabIndex, connected = true, authority }: {
  label: string; items: RowAction[]; disabled: boolean; tabIndex: number; connected?: boolean; authority?: string
}) {
  const [opened, setOpened] = useState<{ authority?: string }>()
  const current = useRef({ authority, disabled })
  current.current = { authority, disabled }
  // Gate synchronously before effects: connected → connected can still replace
  // the Host. A retained native menu callback cannot acquire its new authority.
  const open = opened !== undefined && opened.authority === authority && !disabled
  useEffect(() => { setOpened(undefined) }, [disabled, connected, authority])
  return <Menu className="dcw-actions" open={open} onClose={() => { if (current.current.authority === authority) setOpened(undefined) }} portal dense align="end"
    items={items} onSelect={id => {
      if (!open || current.current.authority !== authority || current.current.disabled) return
      setOpened(undefined)
      const item = items.find(item => item.id === id)
      if (!item?.disabled) item?.run()
    }}
    anchor={<button className="dcw-action-trigger" aria-label={label} aria-haspopup="menu" aria-expanded={open}
      disabled={disabled} tabIndex={tabIndex} onClick={() => {
        if (current.current.authority === authority && !current.current.disabled) setOpened(open ? undefined : { authority })
      }}><IconEllipsisOutlineRegular size={16} /></button>} />
}

function Rename({ title, t, busy, disabled, onSave, onCancel, onFocusCapture }: {
  title: string; t: Translate; busy: boolean; disabled: boolean; onSave(title: string): void; onCancel(): void
  onFocusCapture: FocusEventHandler<HTMLFormElement>
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
  return <form className="dcw-rename" onFocusCapture={onFocusCapture} onSubmit={event => {
    event.preventDefault()
    if (!busy && !disabled && value.trim()) onSave(value.trim())
  }}>
    <input ref={input} aria-label={t('rename')} value={value} disabled={busy || disabled} maxLength={200}
      onChange={event => setValue(event.target.value)} onKeyDown={event => {
        if (!event.defaultPrevented && !event.nativeEvent.isComposing && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel() }
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

/** One clock for the visible list; owned bucketing preserves native time boundaries. */
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

interface RowNavigation {
  active?: string
  capture(key: string): FocusEventHandler<HTMLElement>
  onKeyDown(event: KeyboardEvent<HTMLButtonElement>, key: string): void
}

/** Focus belongs to this view, not the selected Host session. Arrow keys never
 * open a row or escape into menus/editors; a refresh only repairs a lost seat. */
function useRowNavigation(state: WorkspaceBrowserSnapshot, wide: boolean) {
  const list = useRef<HTMLDivElement>(null)
  const previous = useRef<WorkspaceFocusRow[]>([])
  const lastElement = useRef<HTMLElement | null>(null)
  const [focused, setFocused] = useState<string>()
  const rows = workspaceFocusRows(state.rows)
  const active = resolveWorkspaceFocus(rows, focused, previous.current, state.selected)
  const focus = (key?: string) => {
    const button = Array.from(list.current?.querySelectorAll<HTMLButtonElement>('.dcw-open[data-focus-key]') ?? [])
      .find(button => button.dataset.focusKey === key)
    if (button) { setFocused(key); button.focus() }
    else if (!key) list.current?.focus({ preventScroll: true })
  }
  // Snapshot ownership before this commit removes a row. Native modal cleanup
  // can briefly refocus another control in its disappearing portal; that must
  // not erase our repair request. A filter/input outside the row never matches.
  const restoreFocus = !!focused && active !== focused && !!lastElement.current && lastElement.current === document.activeElement
  useLayoutEffect(() => {
    previous.current = rows
    if (focused && active !== focused) {
      setFocused(active)
      if (wide && restoreFocus) {
        queueMicrotask(() => { if (list.current && document.activeElement === document.body) focus(active) })
      }
    }
  })
  const navigation: RowNavigation = {
    active,
    capture: key => event => {
      // React identifies our own portaled menu/modal without native DOM
      // selectors. Remember its seat too, in case a refresh removes the row.
      if (event.target instanceof HTMLElement) {
        lastElement.current = event.target
        setFocused(key)
      }
    },
    onKeyDown: (event, key) => {
      if (event.defaultPrevented || event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
      if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      event.stopPropagation()
      focus(moveWorkspaceFocus(rows, key, event.key as WorkspaceFocusCommand))
    },
  }
  return { list, navigation, focus }
}

interface RowViewProps {
  source: WorkspaceSource
  state: WorkspaceBrowserSnapshot
  vm: WorkspaceBrowserViewModel
  t: Translate
  now: number
  chinese: boolean
  navigation: RowNavigation
}

function SessionRow({ row, loose = false, source, state, vm, t, now, chinese, navigation }: RowViewProps & { row: CatalogSessionRow; loose?: boolean }) {
  const { session, key, pinned, archived } = row
  const tabIndex = navigation.active === key ? 0 : -1
  const busy = state.pending.has(key)
  const connected = source.phase === 'connected'
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
  return <li ref={element} className="dcw-session" onFocusCapture={archiveOpen ? navigation.capture(key) : undefined}>
    {archiveOpen && <Modal open onClose={closeArchive} closeLabel={t('close')} title={t('archiveRunning')}
      description={`${title} · ${source.name || t('title')}`} footer={<>
        <Button variant="outline" disabled={busy} onClick={closeArchive}>{t('cancel')}</Button>
        <Button variant="outline" disabled={busy || source.phase !== 'connected'} onClick={() => {
          void vm.archiveSession(source.id, session.id, true, { stopActivity: true })
        }}>{t('stopAndArchive')}</Button>
      </>}><p>{t('archiveRunningHint')}</p>{state.error !== undefined && <p role="alert">{t('failed')}</p>}</Modal>}
    {state.editing === key
      ? <Rename key={source.id === 'local' ? 'local' : source.info?.transportId ?? 'unavailable'} title={session.title} busy={busy} disabled={!connected} t={t} onFocusCapture={navigation.capture(key)}
        onCancel={() => vm.edit(undefined)} onSave={title => void vm.renameSession(source.id, session.id, title)} />
      : <div className="dcw-row dcw-session-row" data-selected={selected || undefined} data-archived={archived || undefined} onFocusCapture={navigation.capture(key)}>
        <button className="dcw-open" data-focus-key={key} tabIndex={tabIndex} aria-keyshortcuts="ArrowUp ArrowDown Home End"
          aria-label={source.id === 'local' ? title : `${title} · ${source.name}`}
          aria-current={selected ? 'page' : undefined} aria-disabled={archived || busy || undefined} title={title}
          onKeyDown={event => navigation.onKeyDown(event, key)} onClick={() => { if (!archived && !busy) void vm.openSession(source.id, session.id) }}>
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
          <div className="dcw-row-actions"><Actions label={`${t('actions')}: ${title}`} disabled={busy} connected={connected} authority={source.id === 'local' ? undefined : source.info?.transportId} tabIndex={tabIndex}
            items={[
              ...(archived
                ? [{ id: 'restore', label: t('restore'), disabled: !connected, run: () => void vm.archiveSession(source.id, session.id, false) }]
                : [
                  { id: 'rename', label: t('rename'), disabled: !connected, run: () => vm.edit(key) },
                  { id: 'pin', label: t(pinned ? 'unpin' : 'pin'), disabled: !connected, run: () => void vm.pinSession(source.id, session.id, !pinned) },
                  { id: 'archive', label: t('archive'), disabled: !connected, run: confirmArchive },
                ]),
              { id: 'copy', label: t('copySessionId'), run: () => void vm.copySessionId(source.id, session.id) },
            ]} /></div>
        </div>
      </div>}
  </li>
}

function WorkspaceRow({ row, source, state, vm, t, now, chinese, navigation }: RowViewProps & { row: CatalogSourcePage['workspaces'][number] }) {
  const regionId = useId()
  const element = useRef<HTMLLIElement>(null)
  const previouslyForgetting = useRef(false)
  const { key, workspace, sessions, sessionCount } = row
  const tabIndex = navigation.active === key ? 0 : -1
  const expanded = !state.collapsed.has(key)
  const busy = state.pending.has(key)
  const connected = source.phase === 'connected'
  const ownSelection = state.selected?.sourceId === source.id ? state.selected : undefined
  const selected = ownSelection?.workspaceId === workspace.id && !ownSelection.sessionId
  const active = selected || !!ownSelection?.sessionId && workspace.sessionIds.includes(ownSelection.sessionId)
  const title = workspace.title || workspace.path
  const forgetting = state.forgetting === key
  useEffect(() => {
    const closed = previouslyForgetting.current && !forgetting
    previouslyForgetting.current = forgetting
    if (closed && document.activeElement === document.body) {
      const control = element.current?.querySelector<HTMLButtonElement>('.dcw-action-trigger:not(:disabled)') ?? element.current?.querySelector<HTMLButtonElement>('.dcw-open')
      control?.focus({ preventScroll: true })
    }
  }, [forgetting])
  return <li ref={element} className="dcw-project">
    {state.editing === key
      ? <Rename key={source.id === 'local' ? 'local' : source.info?.transportId ?? 'unavailable'} title={workspace.title} busy={busy} disabled={!connected} t={t} onFocusCapture={navigation.capture(key)}
        onCancel={() => vm.edit(undefined)} onSave={title => void vm.renameWorkspace(source.id, workspace.id, title)} />
      : <div className="dcw-row dcw-project-row" data-selected={selected || undefined} data-active={active || undefined} onFocusCapture={navigation.capture(key)}>
        <button className="dcw-fold" tabIndex={tabIndex} aria-label={`${t(expanded ? 'collapse' : 'expand')}: ${title}`} aria-expanded={expanded}
          aria-controls={regionId} onKeyDown={event => navigation.onKeyDown(event, key)} onClick={() => vm.toggleWorkspace(key)}>
          <span className="dcw-folder">{expanded ? <IconFolderOpenRegular size={16} /> : <IconFolderCloseRegular size={16} />}</span>
          <span className="dcw-chevron" data-expanded={expanded}><IconTriangleRightFillRegular size={16} /></span>
        </button>
        <button className="dcw-open" data-focus-key={key} tabIndex={tabIndex} aria-keyshortcuts="ArrowUp ArrowDown Home End"
          aria-label={source.id === 'local' ? title : `${title} · ${source.name}`} aria-current={selected ? 'page' : undefined}
          aria-disabled={busy || undefined} title={workspace.path} onKeyDown={event => navigation.onKeyDown(event, key)}
          onClick={() => { if (!busy) void vm.openWorkspace(source.id, workspace.id) }}>
          <span className="dcw-title">{title}</span>
        </button>
        <HostLabel source={source} t={t} />
        <div className="dcw-row-end"><div className="dcw-row-actions">
          <Hint label={t('newChat')}><button className="dcw-new-session" tabIndex={tabIndex} aria-label={`${t('newChat')}: ${title}`}
            disabled={busy || !connected} onClick={() => void vm.newSession(source.id, workspace.id)}><IconNewChatOutlineRegular size={16} /></button></Hint>
          <Actions label={`${t('actions')}: ${title}`} disabled={busy || !connected} authority={source.id === 'local' ? undefined : source.info?.transportId} tabIndex={tabIndex} items={[
            { id: 'new', label: t('newChat'), run: () => void vm.newSession(source.id, workspace.id) },
            { id: 'rename', label: t('rename'), run: () => vm.edit(key) },
            { id: 'forget', label: t('forget'), run: () => vm.confirmForget(key) },
          ]} />
        </div></div>
      </div>}
    {forgetting && <div className="dcw-confirm" onFocusCapture={navigation.capture(key)}><p>{t('forgetHint')}</p><div>
      <button tabIndex={tabIndex} disabled={busy || !connected} onClick={() => void vm.forgetWorkspace(source.id, workspace.id)}>{t('remove')}</button>
      <button tabIndex={tabIndex} onClick={() => vm.confirmForget(undefined)}>{t('cancel')}</button>
    </div></div>}
    <div id={regionId} hidden={!expanded}>
      <ul className="dcw-sessions">{sessions.map(row => <SessionRow key={row.key} {...{ row, source, state, vm, t, now, chinese, navigation }} />)}</ul>
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
  const listId = useId()
  const navigationHintId = useId()
  const searchHintId = useId()
  const { list, navigation, focus } = useRowNavigation(state, wide)

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
    <UiStyles /><style>{workspaceBrowserCss}</style>
    <Hint label={t('search')}><button ref={searchToggle} className="dcw-icon" aria-label={t('search')} onClick={openSearch}><IconSearchOutlineRegular size={18} /></button></Hint>
    <Hint label={t('add')}><button className="dcw-icon" aria-label={t('add')} disabled={state.pending.has(WORKSPACE_ADD_KEY)}
      onClick={() => { props.expandSidebar?.(); void vm.addWorkspace() }}><IconProjectAddOutlineRegular size={18} /></button></Hint>
  </section>

  return <section className="dcw" aria-label={t('title')}>
    <UiStyles /><style>{workspaceBrowserCss}</style>
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
      aria-controls={listId} aria-describedby={searchHintId} value={state.query} maxLength={500} onChange={event => vm.setQuery(event.target.value)}
      onKeyDown={event => {
        if (event.defaultPrevented || event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); vm.setSearchOpen(false); searchToggle.current?.focus({ preventScroll: true }) }
        if (event.key === 'Enter' && state.rows.some(row => row.workspaces.length || row.looseSessions.length)) {
          event.preventDefault(); event.stopPropagation(); focus(workspaceFocusRows(state.rows)[0]?.key)
        }
      }} /><span id={searchHintId} className="dcw-sr-only">{t('searchHint')}</span></div>}
    {state.error !== undefined && <div className="dcw-error" role="alert">
      <span>{t('failed')}</span>
      <button className="dcw-icon" aria-label={t('dismiss')} onClick={() => vm.dismissError()}><IconCloseOutlineRegular size={16} /></button>
    </div>}
    {state.copyStatus && <div className={`dcw-copy-status${state.copyStatus === 'copyFailed' ? ' dcw-error' : ''}`} role={state.copyStatus === 'copyFailed' ? 'alert' : 'status'}>
      <span>{t(state.copyStatus)}</span>
      <button className="dcw-icon" aria-label={t('dismiss')} onClick={() => vm.dismissCopyStatus()}><IconCloseOutlineRegular size={16} /></button>
    </div>}
    <span id={navigationHintId} className="dcw-sr-only">{t('navigationHint')}</span>
    <div ref={list} id={listId} className="dcw-scroll" role="navigation" aria-label={t('title')} aria-describedby={navigationHintId} tabIndex={-1}>
      {state.totalCount === 0 && props.sources.length > 0 && props.sources.every(source => source.catalog) &&
        <p className="dcw-empty">{t(state.query.trim() ? 'noMatches' : state.filter === 'active' ? 'empty' : 'noFiltered')}</p>}
      {props.sources.length === 0 && <p className="dcw-empty" role="status">{t('loading')}</p>}
      {state.rows.map(({ source, workspaces, looseSessions }) => <div key={source.id} className="dcw-source" data-source-id={source.id}>
        <ul className="dcw-projects">{workspaces.map(row => <WorkspaceRow key={row.key} {...{ row, source, state, vm, t, now, chinese, navigation }} />)}</ul>
        {looseSessions.length > 0 && <ul className="dcw-sessions dcw-loose">{looseSessions.map(row =>
          <SessionRow key={row.key} loose {...{ row, source, state, vm, t, now, chinese, navigation }} />)}</ul>}
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
