import { getDshRuntimeVersion } from '@deepseek-ai/dsh-app-boot'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { installWorkspaceEndpoint } from './workspace-endpoint.js'

export const name = 'connections'
export interface Config { embedded?: true }
export const Config: Schema<Config> = Schema.object({ embedded: Schema.const(true).default(true).hidden() })
export function apply(ctx: Context): void {
  installWorkspaceEndpoint(ctx, { embedded: true, nativeVersion: getDshRuntimeVersion() })
}
