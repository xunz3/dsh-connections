import type { Context, Fiber } from '@deepseek-ai/cordis'
import type { UiWorkspace } from '@deepseek-ai/dsh-client-ui-workspace/client'
// The build inlines this installed package's ModuleLoader factory: a disabled
// sidebar deployment is absent from Harness's runtime module table. Its native
// dependencies stay external and are supplied by the main manifest's inject list.
import { apply as applySidebar, inject as sidebarInject } from '@deepseek-ai/dsh-client-ui-sidebar/client'

export interface NativeSidebarRouting {
  /** Explicit user navigation, shared with the source-aware New Session command. */
  startSession: UiWorkspace['startSession']
  /** True only while the successfully installed native sidebar owns its slot. */
  onReady?(ready: boolean): void
}

/**
 * Reuse the complete native sidebar in a profile with its separate deployment disabled.
 * Only this child scope sees routed session creation; all other UI keeps native navigation.
 * Native apply owns its original components, injected props, child slots, and disposal.
 */
export function installNativeSidebar(ctx: Context, routing: NativeSidebarRouting): (Fiber & PromiseLike<Fiber>) | undefined {
  routing.onReady?.(false)
  if (ctx.slots.entries('sidebar').length !== 0) {
    // Another composition owns the shell. Preserve it and leave remote opening
    // unavailable; its New Session action cannot safely target a remote source.
    return undefined
  }
  const native = ctx.uiWorkspace
  const methods = new WeakMap<Function, Function>()
  const startSession: UiWorkspace['startSession'] = (...args) => routing.startSession(...args)
  // A Proxy over the native Cordis Service inherits its tracker and method
  // descriptors. ctx.get() then wraps it again and reads the native prototype's
  // startSession descriptor, bypassing the routing get trap. This facade owns
  // its method and forwards only the public string-keyed navigation interface.
  const navigation = new Proxy({ startSession }, {
    get(target, property) {
      if (property === 'startSession') return target.startSession
      if (typeof property !== 'string') return undefined
      // Preserve receivers for native methods and getters, including future additions.
      const value: unknown = Reflect.get(native, property, native)
      if (typeof value !== 'function') return value
      let bound = methods.get(value)
      if (bound === undefined) { bound = value.bind(native) as Function; methods.set(value, bound) }
      return bound
    },
  }) as UiWorkspace
  return ctx.isolate('uiWorkspace').plugin({
    name: 'connections-native-sidebar',
    apply(scope: Context) {
      scope.provide('uiWorkspace', navigation)
      scope.plugin({ name: 'connections-native-sidebar-content', inject: sidebarInject, apply(content: Context) {
        applySidebar(content)
        // Returning a Fiber is not evidence that its native apply succeeded.
        // The layout service already declares this slot; retain the installed
        // entry identity so a later conflicting occupant also disables routing.
        let installed = content.slots.entries('sidebar')[0]
        const sync = () => {
          const entries = content.slots.entries('sidebar')
          if (!installed && entries.length === 1) installed = entries[0]
          routing.onReady?.(installed !== undefined && entries.length === 1 && entries[0] === installed)
        }
        content.effect(() => {
          const off = content.slots.subscribe('sidebar', sync)
          sync()
          return () => { off(); routing.onReady?.(false) }
        })
      } })
    },
  })
}
