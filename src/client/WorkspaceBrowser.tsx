import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { deriveWorkspaceRows, type CatalogSessionRow, type WorkspaceFilter, type WorkspaceSelection, type WorkspaceSource } from './workspace-catalog.js'

export type { WorkspaceSelection, WorkspaceSource } from './workspace-catalog.js'
type Action = void | Promise<unknown>
export interface WorkspaceBrowserProps {
  /** A parent command requests focus without controlling the search draft. */
  searchRequest?: number
  sources: readonly WorkspaceSource[]
  selected?: WorkspaceSelection
  locale?: string
  /** Native sidebar.workspaces owner share; false renders the 36px icon rail. */
  wide?: boolean
  expandSidebar?(): void
  onOpenSession(sourceId: string, sessionId: string): Action
  onOpenWorkspace(sourceId: string, workspaceId: string): Action
  onAddWorkspace(): Action
  onReconnect(sourceId: string): Action
  onRenameWorkspace(sourceId: string, workspaceId: string, title: string): Action
  onForgetWorkspace(sourceId: string, workspaceId: string): Action
  onRenameSession(sourceId: string, sessionId: string, title: string): Action
  onArchiveSession(sourceId: string, sessionId: string, archived: boolean): Action
  onPinSession(sourceId: string, sessionId: string, pinned: boolean): Action
}

const messages = {
  en: {
    title: 'Workspaces', add: 'Add workspace', search: 'Search workspaces and chat titles', filter: 'Filter chats', active: 'Active', pinned: 'Pinned', archived: 'Archived',
    empty: 'No workspaces yet', noMatches: 'No matching workspaces or chats', noFiltered: 'No chats in this view', noChats: 'No chats yet', loading: 'Loading workspaces…',
    connected: 'Connected', connecting: 'Connecting…', disconnected: 'Disconnected', error: 'Connection failed', reconnect: 'Reconnect',
    expand: 'Expand', collapse: 'Collapse', actions: 'Actions', newChat: 'New chat', untitled: 'Untitled chat', rename: 'Rename', forget: 'Remove from Workspaces',
    forgetHint: 'Remove this workspace from the list? Files on the computer are kept.', remove: 'Remove', cancel: 'Cancel', save: 'Save',
    pin: 'Pin', unpin: 'Unpin', archive: 'Archive', restore: 'Restore', failed: 'This action could not be completed.', running: 'Running', dismiss: 'Dismiss',
  },
  zh: {
    title: '工作区', add: '添加工作区', search: '搜索工作区和会话标题', filter: '筛选会话', active: '未归档', pinned: '已置顶', archived: '已归档',
    empty: '暂无工作区', noMatches: '没有匹配的工作区或会话', noFiltered: '此视图下暂无会话', noChats: '暂无会话', loading: '正在加载工作区…',
    connected: '已连接', connecting: '正在连接…', disconnected: '未连接', error: '连接失败', reconnect: '重新连接',
    expand: '展开', collapse: '折叠', actions: '操作', newChat: '新会话', untitled: '未命名会话', rename: '重命名', forget: '从工作区移除',
    forgetHint: '从列表移除此工作区？电脑上的文件会保留。', remove: '移除', cancel: '取消', save: '保存',
    pin: '置顶', unpin: '取消置顶', archive: '归档', restore: '恢复', failed: '操作未完成。', running: '运行中', dismiss: '关闭提示',
  },
}
type Translate = (key: keyof typeof messages.en) => string
type IconName = 'folder' | 'chevron' | 'search' | 'filter' | 'add' | 'pin' | 'close' | 'computer'
function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, ReactNode> = {
    folder: <path d="M2.5 5.5h4l1.5 2h9.5v9H2.5zM2.5 5.5V3.5h5l1.5 2h8.5v2" />,
    chevron: <path d="m7 5 5 5-5 5" />,
    search: <><circle cx="8.5" cy="8.5" r="5.5" /><path d="m13 13 4 4" /></>,
    filter: <><path d="M2 6h5m4 0h7M2 14h9m4 0h3" /><circle cx="9" cy="6" r="2" /><circle cx="13" cy="14" r="2" /></>,
    add: <><path d="M2.5 6h5l1.5 2h4M2.5 6V4h5l1.5 2h4M2.5 6v10h7M15 10v8m-4-4h8" /></>,
    pin: <path d="m7 3 6 0-1 5 3 3H5l3-3zm3 8v6" />,
    close: <path d="m5 5 10 10M15 5 5 15" />,
    computer: <><rect x="3" y="3" width="14" height="10" rx="1.5" /><path d="M7 17h6m-3-4v4" /></>,
  }
  return <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>
}

function Actions({ label, children, disabled }: { label: string; children: ReactNode; disabled: boolean }) {
  const details = useRef<HTMLDetailsElement>(null)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent) => { if (details.current && !details.current.contains(event.target as Node)) details.current.open = false }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [open])
  useEffect(() => { if (disabled && details.current) details.current.open = false }, [disabled])
  return <details ref={details} className="dcw-actions" onToggle={event => setOpen(event.currentTarget.open)} onKeyDown={event => {
    if (event.key === 'Escape') { event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus() }
  }}>
    <summary aria-label={label} aria-disabled={disabled} onClick={event => { if (disabled) event.preventDefault() }}>···</summary>
    <fieldset disabled={disabled} className="dcw-menu" onClick={event => {
      if ((event.target as HTMLElement).closest('button')) event.currentTarget.closest('details')!.open = false
    }}>{children}</fieldset>
  </details>
}

function Rename({ title, t, busy, disabled, onSave, onCancel }: { title: string; t: Translate; busy: boolean; disabled?: boolean; onSave(title: string): void; onCancel(): void }) {
  const [value, setValue] = useState(title)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { input.current?.focus(); input.current?.select() }, [])
  return <form className="dcw-rename" onSubmit={event => { event.preventDefault(); if (!busy && !disabled && value.trim()) onSave(value.trim()) }}>
    <input ref={input} aria-label={t('rename')} value={value} disabled={busy || disabled} maxLength={200} onChange={event => setValue(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onCancel() } }} />
    <div><button disabled={busy || disabled || !value.trim()}>{t('save')}</button><button type="button" disabled={busy} onClick={onCancel}>{t('cancel')}</button></div>
  </form>
}

/** One navigation surface. Callbacks keep every operation attached to its owning computer. */
export function WorkspaceBrowser(props: WorkspaceBrowserProps) {
  const { sources, selected } = props
  const wide = props.wide !== false
  const dictionary = props.locale?.startsWith('zh') ? messages.zh : messages.en
  const t: Translate = key => dictionary[key]
  const [query, setQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [filterOpen, setFilterOpen] = useState(false)
  const [filter, setFilter] = useState<WorkspaceFilter>('active')
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [editing, setEditing] = useState<string>()
  const [forgetting, setForgetting] = useState<string>()
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set())
  const [error, setError] = useState('')
  const alive = useRef(true)
  const running = useRef(new Set<string>())
  const search = useRef<HTMLInputElement>(null)
  const searchFromRail = useRef(false)
  const treeId = useId()
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => {
    if (!searchOpen || !wide) return
    // Let the native sidebar finish expanding before moving document focus.
    const delay = searchFromRail.current ? 300 : 0
    const timer = setTimeout(() => { search.current?.focus({ preventScroll: true }); searchFromRail.current = false }, delay)
    return () => clearTimeout(timer)
  }, [searchOpen, wide])
  useEffect(() => { if (query.trim()) setCollapsed(new Set()) }, [query])
  useEffect(() => {
    if (!props.searchRequest) return
    if (!wide) { searchFromRail.current = true; props.expandSidebar?.() }
    setSearchOpen(true)
    search.current?.focus()
  }, [props.searchRequest])
  const rows = useMemo(() => deriveWorkspaceRows(sources, { query, filter, selected }), [sources, query, filter, selected])
  const count = rows.reduce((sum, row) => sum + row.workspaces.length + row.looseSessions.length, 0)
  const run = async (key: string, action: () => Action, done?: () => void) => {
    if (running.current.has(key)) return
    running.current.add(key); setPending(current => new Set([...current, key])); setError('')
    try { await action(); if (alive.current) done?.() }
    catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : t('failed')) }
    finally { running.current.delete(key); if (alive.current) setPending(current => { const next = new Set(current); next.delete(key); return next }) }
  }
  const reconnect = (source: WorkspaceSource) => void run(`connect:${source.id}`, () => props.onReconnect(source.id))
  const host = (source: WorkspaceSource) => source.id === 'local' ? null : <span className="dcw-host" title={`${source.name} · ${t(source.phase)}`}><span>{source.name}</span><i className="dcw-dot" data-phase={source.phase} aria-label={t(source.phase)} /></span>
  const sessionRow = (row: CatalogSessionRow, source: WorkspaceSource, loose = false) => {
    const { session, key, pinned, archived } = row
    const busy = pending.has(key)
    const title = session.blank ? t('newChat') : session.title || t('untitled')
    const isSelected = selected?.sourceId === source.id && selected.sessionId === session.id
    return <li key={key} className="dcw-session" data-loose={loose || undefined}>
      {editing === key ? <Rename title={session.title} busy={busy} disabled={source.phase !== 'connected'} t={t} onCancel={() => setEditing(undefined)} onSave={title => void run(key, () => props.onRenameSession(source.id, session.id, title), () => setEditing(undefined))} /> : <div className="dcw-row" data-selected={isSelected || undefined} data-archived={archived || undefined}>
        <button className="dcw-open" aria-label={source.id === 'local' ? title : `${title} · ${source.name}`} aria-current={isSelected ? 'page' : undefined} disabled={archived || busy} title={title} onClick={() => void run(key, () => props.onOpenSession(source.id, session.id))}>
          <span className="dcw-session-mark">{session.running ? <i className="dcw-dot" data-phase="connecting" aria-label={t('running')} /> : pinned ? <span title={t('pinned')}><Icon name="pin" /></span> : null}</span>
          <span className="dcw-title">{title}</span>
        </button>
        {loose && host(source)}
        <Actions label={`${t('actions')}: ${title}`} disabled={busy || source.phase !== 'connected'}>
          {archived ? <button onClick={() => void run(key, () => props.onArchiveSession(source.id, session.id, false))}>{t('restore')}</button> : <>
            <button onClick={() => setEditing(key)}>{t('rename')}</button>
            <button onClick={() => void run(key, () => props.onPinSession(source.id, session.id, !pinned))}>{t(pinned ? 'unpin' : 'pin')}</button>
            <button onClick={() => void run(key, () => props.onArchiveSession(source.id, session.id, true))}>{t('archive')}</button>
          </>}
        </Actions>
      </div>}
    </li>
  }
  if (!wide) return <section className="dcw dcw-rail" aria-label={t('title')}>
    <style>{workspaceBrowserCss}</style>
    <button className="dcw-icon" aria-label={t('search')} title={t('search')} onClick={() => { searchFromRail.current = true; setSearchOpen(true); props.expandSidebar?.() }}><Icon name="search" /></button>
    <button className="dcw-icon" aria-label={t('add')} title={t('add')} disabled={pending.has('add')} onClick={() => { props.expandSidebar?.(); void run('add', props.onAddWorkspace) }}><Icon name="add" /></button>
  </section>
  return <section className="dcw" aria-label={t('title')}>
    <style>{workspaceBrowserCss}</style>
    <header className="dcw-header"><h2>{t('title')}</h2><div>
      <button className="dcw-icon" aria-label={t('search')} title={t('search')} aria-expanded={searchOpen} onClick={() => { setSearchOpen(!searchOpen); if (searchOpen) setQuery('') }}><Icon name="search" /></button>
      <button className="dcw-icon" aria-label={t('filter')} title={t('filter')} aria-expanded={filterOpen} data-active={filter !== 'active' || undefined} onClick={() => setFilterOpen(!filterOpen)}><Icon name="filter" /></button>
      <button className="dcw-icon" aria-label={t('add')} title={t('add')} disabled={pending.has('add')} onClick={() => void run('add', props.onAddWorkspace)}><Icon name="add" /></button>
    </div></header>
    {searchOpen && <div className="dcw-search"><input ref={search} type="search" aria-label={t('search')} placeholder={t('search')} value={query} maxLength={500} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') { setQuery(''); setSearchOpen(false) } }} /></div>}
    {(filterOpen || filter !== 'active') && <div className="dcw-filter"><select aria-label={t('filter')} value={filter} onChange={event => setFilter(event.target.value as WorkspaceFilter)}>{(['active', 'pinned', 'archived'] as const).map(value => <option key={value} value={value}>{t(value)}</option>)}</select></div>}
    {error && <div className="dcw-error" role="alert"><span>{error}</span><button className="dcw-icon" aria-label={t('dismiss')} onClick={() => setError('')}><Icon name="close" /></button></div>}
    <div className="dcw-scroll">
      {count === 0 && sources.length > 0 && !sources.some(source => !source.catalog) && <p className="dcw-empty">{t(query.trim() ? 'noMatches' : filter === 'active' ? 'empty' : 'noFiltered')}</p>}
      {sources.length === 0 && <p className="dcw-empty" role="status">{t('loading')}</p>}
      {rows.map(({ source, workspaces, looseSessions }) => <div key={source.id} className="dcw-source" data-source-id={source.id}>
        <ul className="dcw-projects">{workspaces.map(({ key, workspace, sessions }, index) => {
          const expanded = !collapsed.has(key)
          const busy = pending.has(key)
          const regionId = `${treeId}-${encodeURIComponent(source.id)}-${index}`
          const isSelected = selected?.sourceId === source.id && selected.workspaceId === workspace.id && !selected.sessionId
          return <li key={key} className="dcw-project">
            {editing === key ? <Rename title={workspace.title} busy={busy} disabled={source.phase !== 'connected'} t={t} onCancel={() => setEditing(undefined)} onSave={title => void run(key, () => props.onRenameWorkspace(source.id, workspace.id, title), () => setEditing(undefined))} /> : <div className="dcw-row" data-selected={isSelected || undefined}>
              <button className="dcw-fold" aria-label={`${t(expanded ? 'collapse' : 'expand')}: ${workspace.title}`} aria-expanded={expanded} aria-controls={regionId} onClick={() => setCollapsed(current => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next })}><span className="dcw-folder"><Icon name="folder" /></span><span className="dcw-chevron" data-expanded={expanded}><Icon name="chevron" /></span></button>
              <button className="dcw-open" aria-label={source.id === 'local' ? workspace.title || workspace.path : `${workspace.title || workspace.path} · ${source.name}`} disabled={busy} title={workspace.path} onClick={() => void run(key, () => props.onOpenWorkspace(source.id, workspace.id))}><span className="dcw-title">{workspace.title || workspace.path}</span></button>
              {host(source)}
              <Actions label={`${t('actions')}: ${workspace.title}`} disabled={busy || source.phase !== 'connected'}><button onClick={() => void run(key, () => props.onOpenWorkspace(source.id, workspace.id))}>{t('newChat')}</button><button onClick={() => setEditing(key)}>{t('rename')}</button><button onClick={() => setForgetting(key)}>{t('forget')}</button></Actions>
            </div>}
            {forgetting === key && <div className="dcw-confirm"><p>{t('forgetHint')}</p><div><button disabled={busy || source.phase !== 'connected'} onClick={() => void run(key, () => props.onForgetWorkspace(source.id, workspace.id), () => setForgetting(undefined))}>{t('remove')}</button><button disabled={busy} onClick={() => setForgetting(undefined)}>{t('cancel')}</button></div></div>}
            <div id={regionId} hidden={!expanded}><ul className="dcw-sessions">{sessions.map(row => sessionRow(row, source))}</ul>{sessions.length === 0 && <p className="dcw-no-chats">{t('noChats')}</p>}</div>
          </li>
        })}</ul>
        {looseSessions.length > 0 && <ul className="dcw-sessions dcw-loose">{looseSessions.map(row => sessionRow(row, source, true))}</ul>}
        {(source.phase !== 'connected' || !source.catalog) && <div className="dcw-source-state" role="status">
          {workspaces.length === 0 && <Icon name="computer" />}<span title={source.error}>{source.id !== 'local' && <span>{source.name} · </span>}{t(source.phase === 'connected' ? 'loading' : source.phase)}</span>
          {source.id !== 'local' && source.phase !== 'connecting' && source.phase !== 'connected' && <button disabled={pending.has(`connect:${source.id}`)} onClick={() => reconnect(source)}>{t('reconnect')}</button>}
        </div>}
      </div>)}
    </div>
  </section>
}

export const workspaceBrowserCss = `
.dcw{display:flex;flex-direction:column;min-height:0;height:100%;color:var(--dsw-alias-label-primary,#35373c);font:inherit;font-size:13px;line-height:1.45}
.dcw *{box-sizing:border-box}.dcw button,.dcw input,.dcw select{font:inherit;color:inherit}.dcw button{border:0;background:transparent;cursor:pointer}.dcw button:disabled,.dcw summary[aria-disabled=true]{opacity:.5;cursor:default}.dcw :is(button,input,select,summary):focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4670d9);outline-offset:-2px}.dcw svg{flex:none;display:block}.dcw ul{list-style:none;margin:0;padding:0}
.dcw-header{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:40px;padding:0 12px;color:var(--dsw-alias-label-secondary,#777d87)}.dcw-header h2{font:inherit;font-weight:400;margin:0}.dcw-header>div{display:flex;gap:2px}.dcw .dcw-icon{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border-radius:5px}.dcw .dcw-icon:hover,.dcw .dcw-icon[data-active]{background:var(--dsw-alias-interactive-bg-hover,#e9ebef)}
.dcw.dcw-rail{align-items:center;gap:2px;padding-top:2px;color:var(--dsw-alias-label-secondary,#777d87)}.dcw-rail .dcw-icon{width:36px;height:36px}.dcw-rail .dcw-icon svg{width:18px;height:18px}
.dcw-search,.dcw-filter{padding:0 12px 8px}.dcw-search input,.dcw-filter select{min-width:0;width:100%;border:1px solid var(--dsw-alias-border-l2,#dfe1e6);border-radius:6px;background:var(--dsw-alias-bg-base,#fff);padding:6px 8px;outline-offset:1px}.dcw-filter select{font-size:12px}.dcw-scroll{min-height:0;overflow:auto;padding:0 6px 12px;scrollbar-width:thin}.dcw-source{min-width:0}.dcw-project{margin-bottom:10px}.dcw-row{display:flex;align-items:center;gap:3px;min-height:32px;border-radius:6px;padding:0 3px;position:relative}.dcw-row:hover,.dcw-row[data-selected]{background:var(--dsw-alias-interactive-bg-hover,#e9ebef)}.dcw-row[data-archived]{color:var(--dsw-alias-label-secondary,#777d87)}
.dcw .dcw-open{min-width:0;flex:1;display:flex;align-items:center;gap:4px;text-align:left;padding:5px 0;min-height:30px}.dcw-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dcw .dcw-fold{width:22px;height:28px;display:flex;align-items:center;justify-content:center;padding:0;flex:none;color:var(--dsw-alias-label-secondary,#777d87);border-radius:4px}.dcw-chevron{display:none}.dcw-row:hover .dcw-chevron,.dcw-fold:focus-visible .dcw-chevron{display:block}.dcw-row:hover .dcw-folder,.dcw-fold:focus-visible .dcw-folder{display:none}.dcw-chevron[data-expanded=true]{transform:rotate(90deg)}.dcw-host{display:flex;align-items:center;gap:5px;min-width:0;max-width:37%;color:var(--dsw-alias-label-tertiary,#999fa8);font-size:11px;white-space:nowrap}.dcw-host>span{overflow:hidden;text-overflow:ellipsis}.dcw-dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-tertiary,#999fa8);flex:none}.dcw-dot[data-phase=connected]{background:var(--dsw-alias-state-success-primary,#209665)}.dcw-dot[data-phase=connecting]{background:var(--dsw-alias-state-warning-primary,#ba872c)}.dcw-dot[data-phase=error]{background:var(--dsw-alias-state-error-primary,#c24d46)}
.dcw-sessions .dcw-row{padding-left:20px}.dcw-session-mark{display:flex;width:14px;flex:none;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary,#999fa8)}.dcw-session-mark svg{width:12px;height:12px}.dcw-loose .dcw-row{padding-left:4px}.dcw-actions{position:relative;flex:none;width:22px}.dcw-actions>summary{display:flex;align-items:center;justify-content:center;list-style:none;cursor:pointer;width:22px;height:26px;border-radius:4px;opacity:0;color:var(--dsw-alias-label-secondary,#777d87);font-size:16px;line-height:1}.dcw-actions>summary::-webkit-details-marker{display:none}.dcw-row:hover .dcw-actions>summary,.dcw-row:focus-within .dcw-actions>summary,.dcw-actions[open]>summary{opacity:1}.dcw-menu{margin:0;position:absolute;right:0;top:28px;z-index:5;min-width:150px;background:var(--dsw-alias-bg-base,#fff);border:1px solid var(--dsw-alias-border-l2,#dfe1e6);padding:4px;border-radius:7px;box-shadow:0 4px 18px #00000012}.dcw-menu button{display:block;padding:6px 9px;width:100%;text-align:left;border-radius:4px;white-space:nowrap}.dcw-menu button:hover{background:var(--dsw-alias-interactive-bg-hover,#e9ebef)}
.dcw-rename,.dcw-confirm{padding:6px 8px}.dcw-rename input{width:100%;min-width:0;padding:4px 6px;border:1px solid var(--dsw-alias-border-l2,#dfe1e6);border-radius:4px;background:var(--dsw-alias-bg-base,#fff)}.dcw-rename>div,.dcw-confirm>div{display:flex;gap:12px;justify-content:flex-end;margin-top:6px}.dcw-rename button,.dcw-confirm button,.dcw-source-state button{font-size:12px;padding:3px 0}.dcw-rename button:hover,.dcw-confirm button:hover,.dcw-source-state button:hover{text-decoration:underline}.dcw-confirm p{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary,#777d87)}.dcw-no-chats{margin:3px 0 9px 40px;font-size:12px;color:var(--dsw-alias-label-tertiary,#999fa8)}.dcw-empty{margin:36px 12px;text-align:center;color:var(--dsw-alias-label-secondary,#777d87);font-size:12px}.dcw-source-state{display:flex;align-items:center;gap:6px;padding:7px 8px;color:var(--dsw-alias-label-secondary,#777d87);font-size:11px}.dcw-source-state>span{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dcw-source-state button{flex:none}.dcw-error{margin:0 12px 8px;display:flex;align-items:flex-start;gap:4px;color:var(--dsw-alias-state-error-primary,#c24d46);font-size:12px}.dcw-error>span{flex:1;overflow-wrap:anywhere}.dcw-error .dcw-icon{width:22px;height:22px;flex:none}
@media(hover:none){.dcw-actions>summary{opacity:1}}
`
