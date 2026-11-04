import { uiStyles } from './styles.js'

/** Mount once at a plugin view boundary, never once per row or low-level atom. */
export function UiStyles() { return <style data-connections-ui="">{uiStyles}</style> }
