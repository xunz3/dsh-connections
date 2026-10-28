import type { Context } from '@deepseek-ai/cordis'
import { applyEmbedded } from './embedded.js'

// The remote surface depends only on native workspace/session contracts. It
// never imports the local sidebar factory or installs connection management.
export const inject = ['slots', 'locale', 'theme']
export function apply(ctx: Context): void { applyEmbedded(ctx) }
