import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Button, Modal, UiStyles } from '../../src/client/ui/index.js'
import { SettingsHostMenu } from '../../src/client/settings-host-menu.js'

function App() {
  const [open, setOpen] = useState(false)
  return <><UiStyles />
    <Button variant="primary" onClick={() => setOpen(true)}>Sign in</Button>
    <SettingsHostMenu locale="en" onSelect={() => {}} snapshot={{ selectedId: 'local', choices: [
      { id: 'local', name: 'This computer', phase: 'connected' },
      { id: 'connecting', name: 'Connecting computer', phase: 'connecting' },
      { id: 'updating', name: 'Updating computer', phase: 'updating' },
    ] }} />
    <Modal open={open} onClose={() => setOpen(false)} title="Sign in to remote Host" closeLabel="Close"
      footer={<Button variant="primary" onClick={() => setOpen(false)}>Continue</Button>}>
      <p>Complete authorization in your computer’s browser.</p>
      <input aria-label="Account name" />
    </Modal>
  </>
}
createRoot(document.getElementById('root')!).render(<App />)
