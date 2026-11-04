import { useState } from 'react'
import { createRoot } from 'react-dom/client'
// Dev-only real rc.5 comparison, never imported by the production UI entry.
import { Modal as NativeModal, Menu as NativeMenu, closeTopModal, observeComposition } from '@deepseek-ai/dsh-client-ui-primitives'
import { Modal, Menu, Button, Tooltip, UiStyles, ownedModalClose } from '../../src/client/ui/index.js'
import { WorkspaceBrowser } from '../../src/client/WorkspaceBrowser.js'
import { ConnectionDialog } from '../../src/client/ConnectionDialog.js'

let pageClose = () => {}, captureClose = () => {}, runCaptured = () => {}
function App() {
  const [native, setNative] = useState(true), [owned, setOwned] = useState(false), [child, setChild] = useState(false)
  const [menu, setMenu] = useState(false), [nativeMenu, setNativeMenu] = useState(false), [selected, setSelected] = useState('')
  const [browser, setBrowser] = useState(false), [browserMenu, setBrowserMenu] = useState(false), [browserClosed, setBrowserClosed] = useState(0)
  const [closed, setClosed] = useState({ native: 0, owned: 0, child: 0 })
  const closeNative = () => { setNative(false); setClosed(value => ({ ...value, native: value.native + 1 })) }
  const closeOwned = () => { setOwned(false); setClosed(value => ({ ...value, owned: value.owned + 1 })) }
  const closeChild = () => { setChild(false); setClosed(value => ({ ...value, child: value.child + 1 })) }
  let captured: (() => void) | undefined
  pageClose = () => { const close = ownedModalClose(document); if (close) close(); else closeTopModal(document) }
  captureClose = () => { captured = ownedModalClose(document); runCaptured = () => captured?.() }
  return <><UiStyles />
    <output data-testid="closed">{JSON.stringify(closed)}</output><output data-testid="selected">{selected}</output><output data-testid="browser-closed">{browserClosed}</output>
    <NativeModal open={native} title="Native settings" closeLabel="Close native settings" onClose={closeNative}>
      <button onClick={() => setOwned(true)}>Open owned dialog</button>
      <button onClick={() => setBrowser(true)}>Open browser dialog</button>
      {browser && <ConnectionDialog title="Browser dialog" t={key => key} onClose={() => { setBrowser(false); setBrowserMenu(false); setBrowserClosed(value => value + 1) }}>
        <input aria-label="Browser input" /><button>Last browser action</button>
        <Menu open={browserMenu} onClose={() => setBrowserMenu(false)} items={[{ id: 'item', label: 'Browser menu item' }]} onSelect={() => setBrowserMenu(false)}
          anchor={<button onClick={() => setBrowserMenu(!browserMenu)}>Browser menu</button>} />
      </ConnectionDialog>}
      <Modal open={owned} title="Owned dialog" closeLabel="Close owned dialog" onClose={closeOwned} footer={<Button onClick={() => setSelected('last')}>Last owned action</Button>}>
        <input aria-label="Owned input" data-modal-autofocus />
        <Button onClick={() => setChild(true)}>Open native above</Button>
        <Menu open={menu} onClose={() => setMenu(false)} portal dense align="end" items={[
          { id: 'label', type: 'label', text: 'Owned commands' },
          { id: 'disabled', label: 'Disabled action', disabled: true },
          { id: 'first', label: 'First action' }, { id: 'second', label: 'Second action' },
        ]} onSelect={id => { setSelected(id); setMenu(false) }}
          anchor={<button aria-label="Owned menu" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>Owned menu</button>} />
        <NativeMenu open={nativeMenu} onClose={() => setNativeMenu(false)} portal items={[{ id: 'native', label: 'Native action' }]}
          onSelect={() => setNativeMenu(false)} anchor={<button onClick={() => setNativeMenu(!nativeMenu)}>Native menu</button>} />
        <Tooltip label="Owned help" portal delayMs={25}><button>Tooltip anchor</button></Tooltip>
      </Modal>
    </NativeModal>
    <NativeModal open={child} title="Native above owned" closeLabel="Close native child" onClose={closeChild}><button>Native child action</button></NativeModal>
  </>
}
const composition = observeComposition(document)
// The exact rc.5 ordering: registry bookkeeping in window capture, local modal
// document handlers, then page.close resolution at window bubble. The callable
// closeTopModal below is the real module, not a stubbed layer implementation.
const shortcut = (event: KeyboardEvent) => {
  if (composition.guards(event) || event.defaultPrevented || event.key !== 'Escape' || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return
  event.preventDefault(); if (!event.repeat) pageClose()
}
window.addEventListener('keydown', shortcut)
Object.assign(window, { clientUiFixture: {
  pageClose: () => pageClose(), captureClose: () => captureClose(), runCaptured: () => runCaptured(),
  owned: () => ownedModalClose(document) !== undefined,
} })
window.addEventListener('pagehide', () => { composition.dispose(); window.removeEventListener('keydown', shortcut) }, { once: true })
const sessions = Array.from({ length: 120 }, (_, i) => ({ id: `row-${i}`, title: `Discussion ${i}`, blank: false, running: true, updatedAt: Date.now() }))
createRoot(document.getElementById('root')!).render(new URL(location.href).searchParams.has('rows')
  ? <WorkspaceBrowser sources={[{ id: 'local', name: 'Local', phase: 'connected', catalog: { workspaces: [], sessions, archivedSessionIds: [], pinnedSessionIds: [] } }]}
    onOpenSession={() => {}} onOpenWorkspace={() => {}} onNewSession={() => {}} onAddWorkspace={() => {}} onReconnect={() => {}}
    onRenameWorkspace={() => {}} onForgetWorkspace={() => {}} onRenameSession={() => {}} onArchiveSession={() => {}} onPinSession={() => {}} />
  : <App />)
