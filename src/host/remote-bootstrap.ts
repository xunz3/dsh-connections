/** Quote fixed program text for the remote POSIX shell, never client input. */
function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'` }

// This probe must also run on an older system Node, before management starts.
const probe = `
const [major, minor] = process.versions.node.split('.').map(Number);
if (!(major >= 24 || major === 22 && minor >= 19)) process.exit(1);
`

/**
 * Use the remote account's noninteractive SSH environment. It owns its PATH;
 * Connections does not run interactive startup files or select another runtime.
 * The probe cannot consume management stdin. Existing services still use their
 * recorded runtime, preserving their installed native-module ABI.
 */
const bootstrap = `
node -e ${quote(probe)} </dev/null >/dev/null 2>&1 || {
  printf '%s\\n' '{"error":"node"}'
  exit 0
}
exec node --input-type=module -
`

/** The complete fixed remote command; all request data continues on stdin. */
export const REMOTE_BOOTSTRAP_COMMAND = `sh -c ${quote(bootstrap)}`
