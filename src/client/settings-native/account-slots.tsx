import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-account-controller/remote'
import type {} from '@deepseek-ai/dsh-client-ui-settings-models/client'
import { createElement, useEffect, type ComponentType } from 'react'
import type { AccountSectionInjected, AccountSnapshot } from '@deepseek-ai/dsh-client-ui-settings-account/client'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import type { LoginHost } from '../login-host.js'
import { Modal, Button } from '../ui/index.js'
import { AccountLoginPresenter, type AccountLoginState } from './account-login.js'

type Select<T> = <R>(selector: (value: T) => R) => R
interface BridgeProps {
  useAccount: Select<AccountSnapshot>
  useLogin: Select<AccountLoginState>
  loginPresenter: AccountLoginPresenter
  localLanguage(): string
  complete?(): void
  useApiKey?(): void
  openOnboarding?(id: string): void
  [key: string]: unknown
}
const copy = (zh: boolean) => zh ? {
  title: '登录 DeepSeek', start: '登录', retry: '重试', cancel: '取消', close: '关闭', api: '使用 API Key',
  waiting: '请在本机浏览器完成授权。', ready: '在本机浏览器登录远端 Host 的账户。', loading: '正在准备登录…', failed: '登录未完成，请重试或复制链接。', copied: '已复制链接', copy: '复制登录链接', copyFailed: '无法复制登录链接，请重试。',
} : { title: 'Sign in to DeepSeek', start: 'Sign in', retry: 'Retry', cancel: 'Cancel', close: 'Close', api: 'Use API key',
  waiting: 'Complete authorization in your computer’s browser.', ready: 'Sign in to the remote Host account in your computer’s browser.', loading: 'Preparing sign-in…', failed: 'Sign-in did not complete. Retry or copy the link.', copied: 'Link copied', copy: 'Copy sign-in link', copyFailed: 'Unable to copy the sign-in link. Try again.' }
function LoginDialog(props: BridgeProps & { onboarding?: boolean }) {
  const state = props.useLogin(value => value), account = props.useAccount(value => value)
  const text = copy(props.localLanguage().startsWith('zh'))
  const open = props.onboarding ? account.view !== undefined && account.view.status !== 'credential-stored' : state.open && !account.onboarding
  const close = () => { void props.loginPresenter.close().catch(() => {}).finally(() => props.onboarding && props.complete?.()) }
  const active = state.attempt && ['initializing', 'waiting-browser', 'exchanging', 'committing'].includes(state.attempt.phase)
  return <Modal open={open} title={text.title} closeLabel={text.close} onClose={close} footer={<div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'flex-end' }}>
    {props.onboarding && props.useApiKey && <Button onClick={() => { void props.loginPresenter.close().catch(() => {}).finally(() => props.useApiKey?.()) }}>{text.api}</Button>}
    <Button onClick={close}>{text.cancel}</Button>
    {state.attempt?.authorizeUrl && <Button onClick={() => { void props.loginPresenter.copy().catch(() => {}) }}>{state.copied ? text.copied : text.copy}</Button>}
    <Button variant="primary" data-modal-autofocus disabled={state.busy || !!active && !state.failed || !account.view} onClick={() => { void props.loginPresenter.start() }}>{state.failed ? text.retry : text.start}</Button>
  </div>}>
    <p role={state.failed || state.copyFailed || account.failed ? 'alert' : 'status'}>{state.copyFailed ? text.copyFailed : state.failed || account.failed ? text.failed : state.busy ? text.loading : active ? text.waiting : text.ready}</p>
  </Modal>
}
function Onboarding(props: BridgeProps) {
  const account = props.useAccount(value => value)
  const set = props.setOnboarding as AccountSectionInjected['setOnboarding']
  useEffect(() => { set(true); return () => set(false) }, [set])
  useEffect(() => { if (account.view?.status === 'credential-stored') props.complete?.() }, [account.view?.status, props.complete])
  return <LoginDialog {...props} onboarding />
}
/** Public slot delegation only. The native Account plugin stays activated and
 * owns its original operations/subscriptions. We replace just the browser login
 * presenter, because rc.5 has no public popup/clipboard capability injection. */
export function installAccountLoginSlots(ctx: Context, host: LoginHost, version: string): void {
  ctx.inject(['slots', 'remote', 'remote.account', 'theme', 'locale'], scope => {
    const presenters = new Set<AccountLoginPresenter>()
    const cache = new WeakMap<object, AccountLoginPresenter>()
    const controllers = (operations: AccountSectionInjected) => {
      const account = operations.hooks?.account
      if (!account || typeof account.getSnapshot !== 'function' || typeof account.subscribe !== 'function' || typeof operations.cancel !== 'function') throw new Error('Native Account login contract is unavailable')
      let login = cache.get(account)
      if (!login) {
        login = new AccountLoginPresenter({ account, host, cancel: id => operations.cancel(id),
          destination: value => { const url = new URL(value); url.searchParams.set('theme', scope.theme.getTheme().active.colorScheme); return url.href },
          start: async () => {
            const result = await scope.remote.account.startSignIn({ version, locale: scope.locale.getSnapshot().active, timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60 }, window.location.origin, 'web')
            if (!result.ok) throw new Error('Remote sign-in could not start')
            return result.value
          } })
        cache.set(account, login); presenters.add(login)
      }
      return login
    }
    for (const name of ['settings.launcher', 'settings.models.sign-in'] as const) {
      const id = `connections.account.${name}`
      let current: StoredEntry | undefined, remove = () => {}
      const sync = () => {
        const entries = scope.slots.entries(name)
        const candidate = entries.filter(entry => entry.options.id !== id && entry.locale === 'settings.account')
        const foreign = entries.some(entry => entry.options.id !== id && (entry.options.priority ?? 0) < 0)
        const entry = !foreign && candidate.length === 1 ? candidate[0] : undefined
        if (entry === current) return
        remove(); remove = () => {}; current = entry
        if (!entry?.inject) return
        const Native = entry.component as ComponentType<BridgeProps>
        const Component = name === 'settings.models.sign-in' ? Onboarding : (props: BridgeProps) => {
          const useAccount: Select<AccountSnapshot> = selector => props.useAccount(value => selector(value.loginVisible ? { ...value, loginVisible: false } : value))
          return <>{createElement(Native, { ...props, useAccount })}<LoginDialog {...props} /></>
        }
        remove = scope.slots.register({ name, id, priority: -1, locale: entry.locale, store: entry.store,
          inject: (...args: never[]) => {
            const operations = entry.inject!(...args) as unknown as AccountSectionInjected
            const login = controllers(operations)
            return { ...operations, hooks: { ...operations.hooks, login: login.state }, loginPresenter: login,
              localLanguage: () => scope.locale.getSnapshot().active, start: () => login.start(),
              showLogin: (visible: boolean) => { if (visible) login.show(); else void login.close().catch(() => {}) } }
          },
        } as never, Component as never)
      }
      scope.effect(() => { const off = scope.slots.subscribe(name, sync); sync(); return () => { off(); remove() } })
    }
    scope.effect(() => () => { for (const presenter of presenters) presenter.dispose(); presenters.clear() })
  })
}
