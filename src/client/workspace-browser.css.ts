/**
 * Source-aware browser layout using the native sidebar's public theme tokens.
 * Keep the small row/header layout here; icons, state indicators, menus and
 * tooltips come from ui-primitives and retain their own styling.
 */
export const workspaceBrowserCss = `
.dcw {
  --dcw-edge-inset: var(--dsh-sidebar-inline-padding, 12px);
  --dcw-scrollbar-width: 5px;
  --dcw-scrollbar-offset: 2px;
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  height: 100%;
  padding-right: var(--dcw-edge-inset);
  color: var(--dsw-alias-label-primary, #35373c);
  font: inherit;
  font-size: 14px;
  line-height: 20px;
}
.dcw, .dcw * { box-sizing: border-box; }
.dcw button, .dcw input { font: inherit; color: inherit; }
.dcw button { border: 0; background: transparent; cursor: pointer; }
.dcw button:disabled { opacity: .5; cursor: default; }
.dcw :is(button, input):focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #4670d9));
  outline-offset: -2px;
}
.dcw svg { display: block; flex: none; }
.dcw ul { list-style: none; margin: 0; padding: 0; }

.dcw-header {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
  height: 36px;
  margin: 2px -4px 4px 0;
  padding-left: 4px;
  color: var(--dsw-alias-label-tertiary, #999fa8);
}
.dcw-header h2 {
  min-width: 0;
  margin: 0;
  overflow: hidden;
  font: inherit;
  font-weight: 400;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dcw-header-actions { display: flex; flex: none; align-items: center; gap: 4px; }
.dcw .dcw-icon {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border-radius: var(--dsw-radius-sm, 6px);
  color: var(--dsw-alias-label-secondary, #777d87);
}
.dcw .dcw-icon:hover, .dcw .dcw-icon[data-active] {
  background: var(--dsw-alias-interactive-bg-hover, #e9ebef);
}

.dcw.dcw-rail { align-items: center; gap: 12px; padding: 0; }
.dcw-rail .dcw-icon { width: 36px; height: 36px; border-radius: var(--dsw-radius-md, 8px); }
.dcw-rail .dcw-icon svg { width: 18px; height: 18px; }
.dcw-search { flex: none; padding: 0 4px 8px; }
.dcw-search input {
  width: 100%;
  min-width: 0;
  height: 30px;
  padding: 4px 8px;
  border: .5px solid var(--dsw-alias-border-l4, #dfe1e6);
  border-radius: var(--dsw-radius-md, 8px);
  background: transparent;
  font-size: 13px;
  line-height: 18px;
}
.dcw-search input::placeholder { color: var(--dsw-alias-label-tertiary, #999fa8); }

/* The shell already supplies the left inset. Only reserve its right edge for
   the scrollbar, as the native workspace browser does. */
.dcw-scroll {
  flex: 1;
  min-height: 0;
  margin-left: -4px;
  margin-right: calc(var(--dcw-scrollbar-offset) - var(--dcw-edge-inset));
  padding: 0 calc(var(--dcw-edge-inset) - var(--dcw-scrollbar-width) - var(--dcw-scrollbar-offset)) 16px 4px;
  overflow-y: auto;
  scrollbar-gutter: stable;
  scrollbar-width: thin;
}
.dcw-scroll::-webkit-scrollbar { width: var(--dcw-scrollbar-width); }
.dcw-source { min-width: 0; }
.dcw-source + .dcw-source, .dcw-project + .dcw-project { margin-top: 4px; }
.dcw-project .dcw-sessions { margin-top: 2px; }
.dcw-session + .dcw-session { margin-top: 2px; }
.dcw .dcw-loose { margin-top: 4px; }
.dcw-row {
  position: relative;
  display: flex;
  align-items: center;
  min-width: 0;
  padding: 0 8px;
  border-radius: var(--dsw-radius-md, 8px);
}
.dcw-row:hover, .dcw-row[data-selected], .dcw-row:has(.dcw-action-trigger[aria-expanded=true]) {
  background: var(--dsw-alias-interactive-bg-hover, #e9ebef);
}
.dcw-project-row { height: 34px; gap: 6px; }
.dcw-session-row { height: 32px; gap: 0; }
.dcw-row[data-archived] .dcw-title { color: var(--dsw-alias-label-caption, #999fa8); }
.dcw .dcw-open {
  display: flex;
  flex: 1;
  align-items: center;
  min-width: 0;
  height: 100%;
  padding: 0;
  text-align: left;
}
.dcw-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  font-size: 14px;
  line-height: 20px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dcw-session-row .dcw-title { margin: 0 6px 0 4px; }
.dcw .dcw-fold {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 20px;
  padding: 0;
  border-radius: var(--dsw-radius-xs, 4px);
  color: var(--dsw-alias-label-tertiary, #999fa8);
}
.dcw-project-row[data-active] .dcw-folder { color: var(--dsw-alias-state-business-primary, #4670d9); }
.dcw-chevron { display: none; color: var(--dsw-alias-label-caption, #999fa8); }
.dcw-project-row:is(:hover, :focus-within) .dcw-chevron { display: inline-flex; }
.dcw-project-row:is(:hover, :focus-within) .dcw-folder { display: none; }
.dcw-chevron svg { transition: transform .15s var(--ds-ease-in-out, ease-in-out); }
.dcw-chevron[data-expanded=true] svg { transform: rotate(90deg); }
.dcw-session-mark {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 20px;
  color: var(--dsw-alias-label-tertiary, #999fa8);
}

/* Both alternatives size this cell so revealing actions never shifts a title.
   Opacity keeps commands in the keyboard tab order; focus-within reveals them. */
.dcw-row-end { display: grid; flex: none; align-items: center; justify-items: end; }
.dcw-metadata, .dcw-row-actions { grid-area: 1 / 1; display: flex; align-items: center; }
.dcw-metadata {
  gap: 6px;
  color: var(--dsw-alias-label-tertiary, #999fa8);
  font-size: 10px;
  line-height: 16px;
  white-space: nowrap;
  pointer-events: none;
}
.dcw-metadata svg { color: var(--dsw-alias-label-caption, #999fa8); }
.dcw-row-actions { gap: 15px; opacity: 0; }
.dcw-actions { display: inline-flex; flex: none; align-items: center; }
.dcw .dcw-action-trigger, .dcw .dcw-new-session {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  padding: 0;
  border-radius: var(--dsw-radius-xs, 4px);
  color: var(--dsw-alias-label-tertiary, #999fa8);
}
.dcw .dcw-action-trigger:hover, .dcw .dcw-new-session:hover { color: var(--dsw-alias-label-primary, #35373c); }
.dcw-row:where(:hover, :focus-within, :has(.dcw-action-trigger[aria-expanded=true])) .dcw-row-actions { opacity: 1; }
.dcw-row:where(:hover, :focus-within, :has(.dcw-action-trigger[aria-expanded=true])) .dcw-metadata { opacity: 0; }

.dcw-host {
  display: flex;
  flex: 0 1 auto;
  align-items: center;
  gap: 5px;
  min-width: 0;
  max-width: 37%;
  color: var(--dsw-alias-label-tertiary, #999fa8);
  font-size: 11px;
  white-space: nowrap;
}
.dcw-session-row .dcw-host { margin-right: 6px; }
.dcw-host > span { overflow: hidden; text-overflow: ellipsis; }
.dcw-dot {
  display: inline-block;
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--dsw-alias-label-tertiary, #999fa8);
}
.dcw-dot[data-phase=connected] { background: var(--dsw-alias-state-success-primary, #209665); }
.dcw-dot[data-phase=connecting] { background: var(--dsw-alias-state-warning-primary, #ba872c); }
.dcw-dot[data-phase=error] { background: var(--dsw-alias-state-error-primary, #c24d46); }


.dcw-rename, .dcw-confirm { padding: 6px 8px; }
.dcw-rename input {
  width: 100%;
  min-width: 0;
  padding: 4px 6px;
  border: .5px solid var(--dsw-alias-border-l4, #dfe1e6);
  border-radius: var(--dsw-radius-sm, 6px);
  color: var(--dsw-alias-label-primary, #35373c);
  background: var(--dsw-alias-button-elevated-fill, #fff);
}
.dcw-rename > div, .dcw-confirm > div { display: flex; justify-content: flex-end; gap: 12px; margin-top: 6px; }
.dcw-rename button, .dcw-confirm button, .dcw-source-state button { padding: 3px 0; font-size: 12px; }
.dcw-rename button:hover, .dcw-confirm button:hover, .dcw-source-state button:hover { text-decoration: underline; }
.dcw-confirm p { margin: 0; color: var(--dsw-alias-label-secondary, #777d87); font-size: 12px; }
.dcw-no-chats { margin: 2px 0 4px; padding: 0 28px; color: var(--dsw-alias-label-tertiary, #999fa8); font-size: 12px; }
.dcw-empty { margin: 36px 12px; color: var(--dsw-alias-label-tertiary, #999fa8); font-size: 13px; text-align: center; }
.dcw-source-state { display: flex; align-items: center; gap: 6px; padding: 7px 8px; color: var(--dsw-alias-label-secondary, #777d87); font-size: 11px; }
.dcw-source-state > span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dcw-source-state button { flex: none; }
.dcw-error { display: flex; flex: none; align-items: flex-start; gap: 4px; margin: 0 4px 8px; color: var(--dsw-alias-state-error-primary, #c24d46); font-size: 12px; }
.dcw-error > span { flex: 1; overflow-wrap: anywhere; }
.dcw-error .dcw-icon { width: 22px; height: 22px; }
.dcw .dcw-more { display: block; width: 100%; padding: 4px 8px 4px 28px; border-radius: var(--dsw-radius-sm, 6px); color: var(--dsw-alias-label-tertiary, #999fa8); font-size: 12px; text-align: left; }
.dcw .dcw-more:hover { color: var(--dsw-alias-label-secondary, #777d87); }

@media (hover: none) {
  .dcw-row-end { display: flex; gap: 8px; }
  .dcw-row .dcw-row-end .dcw-row-actions,
  .dcw-row .dcw-row-end .dcw-metadata { opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .dcw-chevron svg { transition: none; }
}
`
