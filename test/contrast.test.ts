import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Guards the palette in public/style.css against silent contrast regressions.
 * Text pairs need 4.5:1 (WCAG 1.4.3), control boundaries 3:1 (WCAG 1.4.11).
 */
const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');

function tokens(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/--([a-z-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) out[m[1]!] = m[2]!;
  return out;
}

const rootStart = css.indexOf(':root {');
const darkMediaStart = css.indexOf('@media (prefers-color-scheme: dark)');
const light = tokens(css.slice(rootStart, darkMediaStart));

// Find the `:root {` block nested inside the dark media query and slice to
// its matching closing brace. A fixed-offset `indexOf('}', ...)` is fragile
// against edits that grow or shrink the block; matching braces is not.
const darkRootStart = css.indexOf(':root {', darkMediaStart);
const darkBraceOpen = css.indexOf('{', darkRootStart);
let depth = 1;
let darkBraceClose = darkBraceOpen + 1;
while (depth > 0) {
  const ch = css[darkBraceClose];
  if (ch === '{') depth++;
  else if (ch === '}') depth--;
  darkBraceClose++;
}
const dark = tokens(css.slice(darkRootStart, darkBraceClose));

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const TEXT_PAIRS: [string, string][] = [
  ['color-text', 'color-surface'],
  ['color-text-muted', 'color-surface'],
  ['color-text-muted', 'color-surface-alt'],
  ['color-accent-contrast', 'color-accent'],
  ['color-accent', 'color-surface'],
  ['color-positive', 'color-positive-bg'],
  ['color-danger', 'color-danger-bg'],
  ['color-warning', 'color-warning-bg'],
  ['color-warning', 'color-surface'],
];
const BOUNDARY_PAIRS: [string, string][] = [['color-border-strong', 'color-surface']];

describe.each([
  ['light', light],
  ['dark', dark],
])('%s palette', (_name, palette) => {
  it('defines every token the pairs use', () => {
    for (const [a, b] of [...TEXT_PAIRS, ...BOUNDARY_PAIRS]) {
      expect(palette[a], a).toBeDefined();
      expect(palette[b], b).toBeDefined();
    }
  });

  it.each(TEXT_PAIRS)('%s on %s reaches 4.5:1', (fg, bg) => {
    expect(ratio(palette[fg]!, palette[bg]!)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(BOUNDARY_PAIRS)('%s on %s reaches 3:1', (fg, bg) => {
    expect(ratio(palette[fg]!, palette[bg]!)).toBeGreaterThanOrEqual(3);
  });
});
