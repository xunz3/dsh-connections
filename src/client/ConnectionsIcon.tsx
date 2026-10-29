import type { SVGProps } from 'react'
import { connectionsLogoPaths } from './logo.js'

/** Decorative when paired with a visible label; callers can supply an aria-label. */
export function ConnectionsIcon({ size = 24, ...props }: SVGProps<SVGSVGElement> & { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden={props['aria-label'] ? undefined : true} focusable="false" {...props}>
    {connectionsLogoPaths.map(d => <path key={d} d={d} />)}
  </svg>
}
