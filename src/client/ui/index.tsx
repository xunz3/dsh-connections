/** Connections-owned UI compatibility entry. Runtime dependencies: React only.
 * No Harness Client module, private native factory, stylesheet, or layer map is
 * loaded. The native shortcut owner may call ownedModalClose before its resolver.
 */
export { Menu, type MenuEntry, type MenuItem, type MenuProps } from './Menu.js'
export { Modal, type ModalProps } from './Modal.js'
export { useModalLayer, ownedModalClose } from './keyboard.js'
export { Button, StateDot, Tooltip, relativeTime } from './misc.js'
export * from './icons.js'
export { UiStyles } from './UiStyles.js'
