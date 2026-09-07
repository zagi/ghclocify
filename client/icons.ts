/**
 * Lucide icons as DOM elements. The CSP forbids CDN scripts and inline
 * styles, so icons are bundled (esbuild tree-shakes the unused ones) and
 * created with lucide's own `createElement`, never via innerHTML strings.
 */
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Clock,
  Code2,
  Coffee,
  Copy,
  Filter,
  Hash,
  Info,
  Plug,
  Radar,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Square,
  Upload,
  X,
  createElement,
} from 'lucide';

export const ICONS = {
  alert: AlertTriangle,
  back: ArrowLeft,
  clock: Clock,
  code: Code2,
  coffee: Coffee,
  connect: Plug,
  copy: Copy,
  filter: Filter,
  hash: Hash,
  info: Info,
  mapping: SlidersHorizontal,
  next: ArrowRight,
  scan: Radar,
  shield: ShieldCheck,
  sparkles: Sparkles,
  stop: Square,
  success: CheckCircle2,
  upload: Upload,
  x: X,
} as const;

export type IconName = keyof typeof ICONS;

export function icon(name: IconName, opts: { size?: number; className?: string } = {}): SVGElement {
  const size = opts.size ?? 16;
  const svg = createElement(ICONS[name], {
    width: String(size),
    height: String(size),
    'stroke-width': '2',
    // createElement's `class` option replaces lucide's own `lucide
    // lucide-<name>` classes entirely, so the icon keeps only our `icon`
    // class; `data-icon` restores a name-based hook for CSS/JS/debugging.
    class: `icon${opts.className ? ` ${opts.className}` : ''}`,
    'data-icon': name,
    'aria-hidden': 'true',
    focusable: 'false',
  });
  return svg;
}
