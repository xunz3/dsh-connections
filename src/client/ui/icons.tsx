import type { SVGProps } from 'react'

/** Plugin-owned line artwork; no Harness icon module is loaded at runtime. */
type IconProps = Omit<SVGProps<SVGSVGElement>, 'width' | 'height'> & { size?: number }
const icon = (path: string, filled = false) => function Icon({ size = 16, ...props }: IconProps) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke={filled ? 'none' : 'currentColor'} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...props}><path d={path} /></svg>
}
export const IconCloseOutlineRegular = icon('M6 6l12 12M18 6L6 18')
export const IconRefreshOutlineRegular = icon('M20 10a8 8 0 10-1 7M20 4v6h-6')
export const IconEllipsisOutlineRegular = icon('M5 12h.01M12 12h.01M19 12h.01')
export const IconFolderCloseRegular = icon('M3 7h7l2 2h9v11H3zM3 7V4h7l2 3')
export const IconFolderOpenRegular = icon('M3 11V5h7l2 3h8v3M3 11h19l-4 9H2z')
export const IconProjectAddOutlineRegular = icon('M3 8V5h7l2 3h8v4M3 8v12h8M17 14v8M13 18h8')
export const IconTriangleRightFillRegular = icon('M8 4l12 8-12 8z', true)
export const IconSearchOutlineRegular = icon('M17 17l5 5M19 10a9 9 0 11-18 0 9 9 0 0118 0')
export const IconSlidersTwoOutlineRegular = icon('M5 3v4M5 13v8M2 7h6v6H2zM18 3v10M18 19v2M15 13h6v6h-6z')
export const IconNewChatOutlineRegular = icon('M12 4H4v16h16v-8M10 14l2-5 7-7 3 3-7 7z')
export const IconPinFillRegular = icon('M8 2h8l-1 7 4 4v2h-6v7h-2v-7H5v-2l4-4z', true)
export const IconGlobeOutlineRegular = icon('M21 12a9 9 0 11-18 0 9 9 0 0118 0M3 12h18M12 3c-5 5-5 13 0 18M12 3c5 5 5 13 0 18')
export const IconCheckOutlineRegular = icon('M4 12l5 5L20 6')
