import { getDshRuntimeVersion } from '@deepseek-ai/dsh-app-boot'
import type { Context } from '@deepseek-ai/cordis'
import { installWorkspaceEndpoint } from './workspace-endpoint.js'

export const name = 'connections'
export function apply(ctx: Context): void {
  installWorkspaceEndpoint(ctx, { embedded: true, nativeVersion: getDshRuntimeVersion() })
}
