export const css = `
.dsh-connections{--dc-border:var(--dsw-alias-border-l1,#e7e8eb);--dc-muted:var(--dsw-alias-label-secondary,#676b73);--dc-bg:var(--dsw-alias-bg-base,#fff);--dc-fg:var(--dsw-alias-label-primary,#24262a);max-width:760px;color:var(--dc-fg);font:inherit;font-size:14px;line-height:1.5;padding:8px 0}
.dsh-connections *{box-sizing:border-box}
.dsh-connections h2{font-size:22px;font-weight:600;line-height:1.3;margin:0;letter-spacing:-.02em}
.dsh-connections h3{font-size:13px;font-weight:600;margin:0;color:var(--dc-muted)}
.dsh-connections p{margin:6px 0 0}
.dsh-connections .dc-page-heading{margin-bottom:38px}
.dsh-connections .dc-page-heading p,.dsh-connections .dc-note,.dsh-connections .dc-meta,.dsh-connections .dc-empty p{color:var(--dc-muted);font-size:12px}
.dsh-connections .dc-page-heading p{font-size:13px;margin-top:8px}
.dsh-connections .dc-heading,.dsh-connections .dc-actions,.dsh-connections .dc-row-actions,.dsh-connections .dc-dialog-heading,.dsh-connections .dc-dialog-footer{display:flex;align-items:center;justify-content:space-between;gap:12px}
.dsh-connections .dc-heading{margin-bottom:12px}
.dsh-connections .dc-actions{justify-content:flex-start;gap:8px}
.dsh-connections .dc-row-actions{justify-content:flex-end;gap:2px;flex-shrink:0}
.dsh-connections button{font:inherit;font-size:13px;min-height:34px;padding:6px 12px;border-radius:7px;border:1px solid var(--dc-border);background:var(--dc-bg);color:inherit;cursor:pointer;white-space:nowrap;display:inline-flex;align-items:center;justify-content:center;gap:6px}
.dsh-connections button:hover{background:var(--dsw-alias-bg-hover,#f2f3f5)}
.dsh-connections button:disabled{opacity:.45;cursor:default}
.dsh-connections .dc-primary{background:var(--dc-fg);color:var(--dc-bg);border-color:transparent;border-radius:18px;padding-inline:17px}
.dsh-connections .dc-primary:hover{opacity:.88;background:var(--dc-fg)}
.dsh-connections .dc-add-button{min-height:28px;padding:3px 13px;font-size:12px}
.dsh-connections .dc-quiet{border-color:transparent;background:transparent;color:var(--dc-muted)}
.dsh-connections .dc-icon-button{border:0;background:transparent;padding:7px;min-height:32px;width:32px;flex-shrink:0;color:var(--dc-muted)}
.dsh-connections :is(button,a,input,select,summary):focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#3663d9);outline-offset:3px}
.dsh-connections .dc-list{list-style:none;margin:0;padding:2px 16px;border:1px solid var(--dc-border);border-radius:14px}
.dsh-connections .dc-row{padding:15px 0}
.dsh-connections .dc-row+.dc-row{border-top:1px solid var(--dc-border)}
.dsh-connections .dc-row-main{display:flex;align-items:center;gap:14px;min-width:0}
.dsh-connections .dc-identity{flex:1;min-width:0;overflow-wrap:anywhere}
.dsh-connections .dc-host-title{display:flex;align-items:center;gap:7px;flex-wrap:wrap;line-height:1.4}
.dsh-connections .dc-host-title svg{color:var(--dc-muted);flex-shrink:0}
.dsh-connections .dc-identity strong{font-weight:500;font-size:13px}
.dsh-connections .dc-target{color:var(--dc-muted);font-size:11px}
.dsh-connections .dc-meta{display:flex;align-items:center;gap:9px;flex-wrap:wrap;font-size:11px;margin-top:4px}
.dsh-connections .dc-state:before{content:'';display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--dc-muted);vertical-align:middle;margin-right:6px}
.dsh-connections .dc-state[data-phase=connected]:before{background:var(--dsw-alias-state-success-primary,#288451)}
.dsh-connections .dc-state[data-phase=error]:before{background:var(--dsw-alias-state-error-primary,#c23d32)}
.dsh-connections .dc-state:is([data-phase=connecting],[data-phase=updating]):before{background:var(--dsw-alias-brand-primary,#4c6ac5)}
.dsh-connections .dc-switch{position:relative;width:34px;min-width:34px;height:32px;min-height:32px;border:0;border-radius:8px;background:transparent;padding:0;justify-content:flex-start}
.dsh-connections .dc-switch:before{content:'';position:absolute;left:2px;top:7px;width:30px;height:18px;border-radius:10px;background:var(--dsw-alias-label-tertiary,#b7bbc2)}
.dsh-connections .dc-switch span{position:absolute;left:5px;top:10px;width:12px;height:12px;border-radius:50%;background:#fff;box-shadow:0 1px 2px #0002;transition:transform .12s ease}
.dsh-connections .dc-switch[aria-checked=true]:before{background:var(--dsw-alias-state-success-primary,#288451)}
.dsh-connections .dc-switch[aria-checked=true] span{transform:translateX(12px)}
.dsh-connections .dc-switch:hover{filter:brightness(.95);background:transparent}
.dsh-connections .dc-switch-note{margin-top:14px;line-height:1.6}
.dsh-connections .dc-empty{border:1px solid var(--dc-border);border-radius:14px;padding:36px 20px;display:flex;flex-direction:column;align-items:center;text-align:center;gap:10px}
.dsh-connections .dc-empty>svg{color:var(--dc-muted);margin-bottom:3px}
.dsh-connections .dc-empty strong{font-weight:500}
.dsh-connections .dc-empty p{max-width:320px;margin:0}
.dsh-connections .dc-error{font-size:12px;color:var(--dsw-alias-state-error-primary,#b42318);overflow-wrap:anywhere}
.dsh-connections .dc-setup{margin-top:24px;font-size:12px;color:var(--dc-muted)}
.dsh-connections .dc-setup summary{cursor:pointer}
.dsh-connections .dc-setup p{margin-top:12px}
.dsh-connections .dc-setup pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:8px 0;font-size:12px;background:var(--dsw-alias-bg-layer-1,#f5f6f8);padding:10px 12px;border-radius:6px}
.dsh-connections .dc-dialog{color:var(--dc-fg);background:var(--dc-bg);border:1px solid var(--dc-border);border-radius:18px;box-shadow:0 16px 64px #0003;padding:22px;width:min(520px,calc(100vw - 32px));max-height:calc(100dvh - 48px);overflow:auto}
.dsh-connections .dc-dialog::backdrop{background:#0005}
.dsh-connections .dc-dialog-heading{margin-bottom:20px;gap:18px}
.dsh-connections .dc-dialog-heading h2{font-size:20px}
.dsh-connections .dc-dialog-heading .dc-icon-button{align-self:flex-start}
.dsh-connections .dc-discovery{min-height:280px;display:flex;flex-direction:column;gap:14px}
.dsh-connections .dc-host-choices{list-style:none;padding:0 14px;margin:0;border:1px solid var(--dc-border);border-radius:12px;max-height:280px;overflow-y:auto}
.dsh-connections .dc-host-choices li+li{border-top:1px solid var(--dc-border)}
.dsh-connections .dc-host-choices label{display:flex;align-items:center;gap:12px;padding:13px 0;cursor:pointer;min-width:0;font-size:13px}
.dsh-connections .dc-host-choices label span{flex:1;overflow-wrap:anywhere}
.dsh-connections .dc-host-choices svg{flex-shrink:0;color:var(--dc-muted)}
.dsh-connections input[type=checkbox]{width:16px;height:16px;accent-color:var(--dc-fg);flex-shrink:0}
.dsh-connections .dc-host-choices .dc-error{padding-bottom:10px}
.dsh-connections .dc-picker-empty{color:var(--dc-muted);display:flex;flex-direction:column;align-items:center;text-align:center;padding:34px 16px;gap:10px}
.dsh-connections .dc-add-hint{line-height:1.6;margin-top:auto;padding:14px 0 4px;font-size:11px}
.dsh-connections .dc-dialog-footer{margin-top:24px;gap:16px}
.dsh-connections .dc-dialog-footer>.dc-primary{margin-left:auto}
.dsh-connections .dc-form{display:grid;gap:18px;margin:0}
.dsh-connections .dc-form-fields{border:0;padding:0;margin:0;min-width:0;display:grid;gap:18px}
.dsh-connections .dc-form label,.dsh-connections .dc-host-field{display:grid;gap:7px;font-size:13px;font-weight:500}
.dsh-connections .dc-form input,.dsh-connections .dc-form select,.dsh-connections .dc-search{width:100%;font:inherit;color:inherit;background:var(--dc-bg);border:1px solid var(--dsw-alias-border-l2,#d7d9de);border-radius:7px;padding:9px 11px;min-width:0}
.dsh-connections .dc-form small{font-size:12px;font-weight:400;color:var(--dc-muted)}
.dsh-connections .dc-form small.dc-error{color:var(--dsw-alias-state-error-primary,#b42318)}
.dsh-connections .dc-host-tools{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
.dsh-connections .dc-text-action{background:transparent;border:0;border-radius:3px;min-height:20px;padding:0;font-size:12px;color:var(--dc-muted)}
.dsh-connections .dc-text-action:hover{color:var(--dc-fg);text-decoration:underline;background:transparent}
.dsh-connections .dc-dialog-description{color:var(--dc-muted);margin-bottom:16px;font-size:13px;overflow-wrap:anywhere}
.dsh-connections .dc-update-target{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:16px 0;margin-bottom:12px;border-block:1px solid var(--dc-border);font-size:13px}
.dsh-connections .dc-update-target span{color:var(--dc-muted)}
.dsh-connections .dc-update-target strong{font-weight:500}
@media(max-width:480px){.dsh-connections .dc-row-main{gap:10px;align-items:flex-start}.dsh-connections .dc-switch{margin-top:-3px}.dsh-connections .dc-row-actions{gap:0;flex-wrap:wrap;max-width:64px}.dsh-connections .dc-list{padding-inline:12px}.dsh-connections .dc-target{display:none}.dsh-connections .dc-dialog{padding:18px}.dsh-connections .dc-dialog-heading h2{font-size:18px}.dsh-connections .dc-discovery{min-height:240px}.dsh-connections .dc-dialog-footer{gap:8px}.dsh-connections .dc-row-actions .dc-icon-button{height:32px;min-height:32px}.dsh-connections .dc-page-heading{margin-bottom:28px}}
@media(prefers-reduced-motion:reduce){.dsh-connections .dc-switch span{transition:none}}
`
