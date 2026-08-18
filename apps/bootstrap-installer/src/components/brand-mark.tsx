import { cn } from '../lib/utils'

const assetPath = (path: string) => `${import.meta.env.BASE_URL}${path.replace(/^\/+/, '')}`

// Brand badge: the chevron mark on a black tile, identical in light/dark.
// Ported from apps/desktop's BrandMark; asset lives in this app's public/.
export function BrandMark({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span className={cn('inline-flex size-14 shrink-0 items-center justify-center bg-black', className)} {...props}>
      <img alt="" className="size-full object-contain" src={assetPath('eternal-mark.svg')} />
    </span>
  )
}
