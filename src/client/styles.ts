export const css = `
.dsh-connections{max-width:660px;color:var(--dsw-alias-label-primary,#24262a);font:inherit;font-size:14px;line-height:1.5;padding:8px 0}
.dsh-connections *{box-sizing:border-box}
.dsh-connections h2{font-size:20px;font-weight:600;margin:0}
.dsh-connections h3{font-size:14px;font-weight:600;margin:0}
.dsh-connections p{margin:6px 0 0}
.dsh-connections header{margin-bottom:28px}
.dsh-connections header p,.dsh-connections .dc-note,.dsh-connections .dc-meta,.dsh-connections .dc-empty p{color:var(--dsw-alias-label-secondary,#676b73);font-size:13px}
.dsh-connections .dc-heading,.dsh-connections .dc-row-main,.dsh-connections .dc-actions{display:flex;align-items:center;justify-content:space-between;gap:12px}
.dsh-connections .dc-heading{margin-bottom:8px}
.dsh-connections .dc-actions{justify-content:flex-end;flex-wrap:wrap;gap:8px}
.dsh-connections .dc-empty{padding:30px 0 36px}
.dsh-connections .dc-empty strong{font-weight:500}
.dsh-connections .dc-list{list-style:none;padding:0;margin:0}
.dsh-connections .dc-row{padding:18px 0;border-bottom:1px solid var(--dsw-alias-border-l1,#e7e8eb)}
.dsh-connections .dc-identity{min-width:0;overflow-wrap:anywhere}
.dsh-connections .dc-identity strong{font-weight:500}
.dsh-connections .dc-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;margin-top:3px}
.dsh-connections .dc-state:before{content:'';display:inline-block;width:5px;height:5px;border-radius:50%;background:currentColor;vertical-align:middle;margin-right:5px}
.dsh-connections .dc-state[data-phase=connected]:before{background:var(--dsw-alias-state-success-primary,#2e7b59)}
.dsh-connections .dc-state[data-phase=error]{color:var(--dsw-alias-state-error-primary,#b42318)}
.dsh-connections button,.dsh-connections .dc-link{font:inherit;font-size:13px;min-height:34px;padding:6px 11px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,#d7d9de);background:var(--dsw-alias-bg-base,#fff);color:inherit;cursor:pointer;white-space:nowrap;text-decoration:none;display:inline-flex;align-items:center;justify-content:center}
.dsh-connections .dc-primary{background:var(--dsw-alias-label-primary,#24262a);color:var(--dsw-alias-bg-base,#fff);border-color:transparent}
.dsh-connections .dc-quiet{border-color:transparent;background:transparent;color:var(--dsw-alias-label-secondary,#676b73)}
.dsh-connections button:hover,.dsh-connections .dc-link:hover{filter:brightness(.94)}
.dsh-connections button:disabled{opacity:.5;cursor:default}
.dsh-connections :is(button,a,input,select,summary):focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#3663d9);outline-offset:3px}
.dsh-connections .dc-menu{position:relative}
.dsh-connections .dc-menu summary{list-style:none;cursor:pointer;padding:5px 10px;font-size:20px;line-height:24px;border-radius:6px}
.dsh-connections .dc-menu summary::-webkit-details-marker{display:none}
.dsh-connections .dc-menu-popover{position:absolute;right:0;top:36px;z-index:2;padding:5px;min-width:120px;border:1px solid var(--dsw-alias-border-l2,#d7d9de);border-radius:8px;background:var(--dsw-alias-bg-base,#fff);box-shadow:0 4px 14px #0000000c}
.dsh-connections .dc-menu-popover button{display:block;width:100%;border:0;text-align:left}
.dsh-connections .dc-form{margin:16px 0 20px;padding:20px 0;border-block:1px solid var(--dsw-alias-border-l1,#e7e8eb);display:grid;gap:16px}
.dsh-connections .dc-form-fields{border:0;padding:0;margin:0;min-width:0;display:grid;gap:16px}
.dsh-connections .dc-host-field{display:grid;gap:6px;min-width:0}
.dsh-connections .dc-host-tools{display:flex;align-items:center;gap:16px;flex-wrap:wrap}
.dsh-connections .dc-text-action{background:transparent;border:0;border-radius:3px;min-height:24px;padding:0;font-size:12px;color:var(--dsw-alias-label-secondary,#676b73)}
.dsh-connections .dc-text-action:hover{color:var(--dsw-alias-label-primary,#24262a);text-decoration:underline;filter:none}
.dsh-connections .dc-connection-options{display:grid;gap:14px;padding-top:4px}
.dsh-connections .dc-form label{display:grid;gap:6px;font-size:13px;font-weight:500}
.dsh-connections .dc-form input,.dsh-connections .dc-form select{width:100%;font:inherit;color:inherit;background:var(--dsw-alias-bg-base,#fff);border:1px solid var(--dsw-alias-border-l2,#d7d9de);border-radius:6px;padding:9px 11px;min-width:0}
.dsh-connections .dc-form .dc-checkbox{display:flex;align-items:center;gap:8px;font-weight:400}.dsh-connections .dc-checkbox input{width:16px;height:16px;padding:0;accent-color:var(--dsw-alias-label-primary,#24262a)}
.dsh-connections .dc-form small{font-size:12px;font-weight:400;color:var(--dsw-alias-label-secondary,#676b73)}
.dsh-connections .dc-form small.dc-error{color:var(--dsw-alias-state-error-primary,#b42318)}
.dsh-connections .dc-form .dc-actions{justify-content:flex-start}
.dsh-connections .dc-error{font-size:13px;color:var(--dsw-alias-state-error-primary,#b42318);overflow-wrap:anywhere}
.dsh-connections .dc-confirm{margin-top:14px;display:grid;gap:8px}
.dsh-connections .dc-confirm .dc-actions{justify-content:flex-start}
.dsh-connections .dc-setup{margin-top:24px;padding-top:16px;border-top:1px solid var(--dsw-alias-border-l1,#e7e8eb);font-size:13px}
.dsh-connections .dc-setup summary{cursor:pointer;color:var(--dsw-alias-label-secondary,#676b73)}
.dsh-connections .dc-setup p{margin-top:14px}
.dsh-connections .dc-setup pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:8px 0;font-size:12px;background:var(--dsw-alias-bg-layer-1,#f5f6f8);padding:10px 12px;border-radius:6px}
.dsh-connections footer{margin-top:20px;font-size:12px}
@media(max-width:480px){.dsh-connections .dc-row-main{align-items:flex-start;flex-direction:column;gap:12px}.dsh-connections .dc-row-main>.dc-actions{width:100%;justify-content:flex-start}.dsh-connections .dc-heading{align-items:center}.dsh-connections button,.dsh-connections .dc-link{min-height:38px}.dsh-connections .dc-menu summary{min-height:38px}}
`
