import { cn } from '@/lib/utils'

const assetPath = (path: string) => `${import.meta.env.BASE_URL}${path.replace(/^\/+/, '')}`

// Brand badge: the chevron mark on a black tile, identical in light/dark.
// The mark is white, so the tile stays black in both themes — on a white tile
// it would vanish. Artwork is generated: scripts/generate-brand-mark.py.
// Fills the tile (softly rounded); size via className (default size-14).
export function BrandMark({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      className={cn(
        'inline-flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-md bg-black',
        className
      )}
      {...props}
    >
      <img alt="" className="size-full object-contain" src={assetPath('eternal-mark.svg')} />
    </span>
  )
}
