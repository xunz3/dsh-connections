import { createSnapshotStore } from '../snapshot-store.js'
import type { LoginHost, PendingLoginWindow } from '../login-host.js'
import type { AccountSnapshot } from '@deepseek-ai/dsh-client-ui-settings-account/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'

type View = NonNullable<AccountSnapshot['view']>
type Attempt = NonNullable<View['attempt']>
export interface AccountLoginState { open: boolean; busy: boolean; failed: boolean; copied: boolean; copyFailed?: boolean; attempt?: Attempt }
export interface AccountLoginOptions {
  account: HostObservable<AccountSnapshot>
  host: LoginHost
  start(): Promise<View>
  cancel(id: Attempt['id']): Promise<void>
  destination(url: string): string
}
/** Own only browser presentation. Native Account keeps its stream, credentials,
 * profile, balance, bonuses, expiry notifications and sign-out operations. */
export class AccountLoginPresenter {
  readonly state = createSnapshotStore<AccountLoginState>({ open: false, busy: false, failed: false, copied: false })
  private popup?: PendingLoginWindow
  private attempt?: Attempt['id']
  private generation = 0
  private navigated = false
  private disposed = false
  private starting?: number
  private readonly staleAttempts = new Set<Attempt['id']>()
  private readonly off: () => void
  constructor(private readonly options: AccountLoginOptions) {
    this.off = options.account.subscribe(() => this.update(options.account.getSnapshot().view))
  }
  async start(): Promise<void> {
    if (this.disposed) throw new DOMException('Sign-in view is closed', 'AbortError')
    const generation = ++this.generation
    const baseline = this.options.account.getSnapshot()
    this.starting = generation
    this.popup?.close()
    this.popup = undefined
    this.attempt = undefined
    this.navigated = false
    this.state.set({ open: true, busy: true, failed: false, copied: false })
    try {
      this.popup = this.options.host.prepare()
      const view = await this.options.start()
      if (this.disposed || generation !== this.generation) {
        if (view.attempt?.id) this.staleAttempts.add(view.attempt.id)
        await this.drainStale()
        return
      }
      this.attempt = view.attempt?.id
      if (this.attempt) this.staleAttempts.delete(this.attempt)
      this.update(view)
      const latest = this.options.account.getSnapshot()
      if (latest !== baseline && latest.view?.attempt?.id === this.attempt) this.update(latest.view)
    } catch {
      if (!this.disposed && generation === this.generation) {
        this.popup?.close(); this.popup = undefined
        this.state.set({ ...this.state.getSnapshot(), failed: true })
      }
    } finally {
      if (this.starting === generation) this.starting = undefined
      await this.drainStale()
      if (!this.disposed && generation === this.generation) this.state.set({ ...this.state.getSnapshot(), busy: false })
    }
  }
  private async drainStale(): Promise<void> {
    if (this.starting !== undefined && this.state.getSnapshot().open) return
    for (const id of [...this.staleAttempts]) {
      this.staleAttempts.delete(id)
      if (id !== this.attempt) await this.options.cancel(id).catch(() => {})
    }
  }
  private update(view: View | undefined): void {
    if (this.disposed) return
    const attempt = view?.attempt
    if (!attempt || !this.attempt || attempt.id !== this.attempt) return
    if (view?.status === 'credential-stored' || attempt.phase === 'succeeded') {
      this.popup?.close(); this.popup = undefined; this.attempt = undefined
      this.state.set({ open: false, busy: false, failed: false, copied: false })
      return
    }
    const ended = ['failed', 'expired', 'cancelled'].includes(attempt.phase)
    if (ended) { this.popup?.close(); this.popup = undefined }
    if (attempt.phase === 'waiting-browser' && attempt.authorizeUrl && this.popup && !this.popup.closed && !this.navigated) {
      try { this.popup.location.replace(this.options.destination(attempt.authorizeUrl)); this.navigated = true }
      catch { this.popup.close(); this.popup = undefined; this.state.set({ ...this.state.getSnapshot(), attempt, failed: true }); return }
    }
    this.state.set({ ...this.state.getSnapshot(), attempt, failed: ended })
  }
  show(): void { if (!this.disposed) this.state.set({ ...this.state.getSnapshot(), open: true }) }
  async copy(): Promise<void> {
    const attempt = this.state.getSnapshot().attempt
    if (this.disposed || !attempt?.authorizeUrl || attempt.id !== this.attempt) return
    const generation = this.generation
    try {
      await this.options.host.copy(this.options.destination(attempt.authorizeUrl))
      if (!this.disposed && generation === this.generation && this.attempt === attempt.id) this.state.set({ ...this.state.getSnapshot(), copied: true, copyFailed: false })
    } catch {
      if (!this.disposed && generation === this.generation && this.attempt === attempt.id) this.state.set({ ...this.state.getSnapshot(), copyFailed: true, copied: false })
    }
  }
  async close(): Promise<void> {
    const attempt = this.attempt
    ++this.generation
    this.attempt = undefined
    this.popup?.close(); this.popup = undefined
    this.state.set({ open: false, busy: false, failed: false, copied: false })
    if (attempt) await this.options.cancel(attempt)
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true; ++this.generation; this.off()
    this.popup?.close(); this.popup = undefined
  }
}
