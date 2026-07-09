/**
 * cn — class name merger for the CDZ chat components.
 *
 * AFFiNE does not use Tailwind, so this is a thin `clsx` wrapper rather than
 * the shadcn `twMerge(clsx(...))` pattern. The shadcn components we integrate
 * only rely on `cn()` for conditional + deduplicated class strings; without
 * Tailwind utilities there are no conflicting classes for `tailwind-merge` to
 * resolve, so `clsx` alone is correct and avoids an extra dependency.
 *
 * Components that ship with their own Tailwind v4 scoped layer (see
 * `cdz-tokens.css`) keep their utility classes inside that layer, so the
 * global `clsx`-based `cn()` is all that is needed at the call site.
 */
import { clsx, type ClassValue } from 'clsx';

export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}
