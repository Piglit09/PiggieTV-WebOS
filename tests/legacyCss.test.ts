import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(process.cwd(), 'src', 'styles', 'global.css'), 'utf8');

describe('Chrome 68 CSS compatibility', () => {
  it('keeps the JS-managed focus class independent from focus-visible', () => {
    expect(css).toMatch(/\.ptv-focusable\.is-focused\s*\{/);
    expect(css).not.toMatch(/\.ptv-focusable\.is-focused\s*,/);
  });

  it('does not depend on unsupported flex gap spacing', () => {
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
    const flexRules = rules.filter(([, , declarations]) => /display\s*:\s*flex\s*;/.test(declarations));
    expect(flexRules.length).toBeGreaterThan(0);
    for (const [rule, selector, declarations] of flexRules) {
      expect(declarations, `flex rule ${selector.trim()} must not use gap`).not.toMatch(/(?:^|;)\s*gap\s*:/);
      expect(rule).toBeTruthy();
    }
  });

  it('uses physical offsets instead of the unsupported inset shorthand', () => {
    expect(css).not.toMatch(/(?:^|[;{])\s*inset\s*:/m);
  });

  it('uses the purple-to-pink accent fade without the retired blue accent', () => {
    expect(css).toMatch(/--ptv-purple:\s*#[0-9a-f]{6};/i);
    expect(css).toMatch(/--ptv-pink:\s*#[0-9a-f]{6};/i);
    expect(css).toMatch(/linear-gradient\(90deg,\s*var\(--ptv-purple\),\s*var\(--ptv-pink\)\)/);
    expect(css).not.toMatch(/focus-cyan|#61dcff|rgba\(97,\s*220,\s*255/i);
  });

  it('keeps the mini player in normal flow so its auto-height host cannot collapse', () => {
    const miniPlayerRule = css.match(/\.ptv-playback-mini\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(miniPlayerRule).toMatch(/position\s*:\s*relative\s*;/);
    expect(miniPlayerRule).not.toMatch(/position\s*:\s*absolute\s*;/);
  });

  it('contains Shows titles without clipping the focused artwork glow', () => {
    const cardRule = css.match(/\.ptv-browse--shows \.ptv-card--poster\s*\{([^}]*)\}/)?.[1] ?? '';
    const buttonRule = css.match(/\.ptv-browse--shows \.ptv-card-btn\s*\{([^}]*)\}/)?.[1] ?? '';
    const copyRule = css.match(/\.ptv-browse--shows \.ptv-card-copy\s*\{([^}]*)\}/)?.[1] ?? '';
    const titleRule = css.match(/\.ptv-browse--shows \.ptv-card-title\s*\{([^}]*)\}/)?.[1] ?? '';

    expect(cardRule).toMatch(/min-width\s*:\s*0\s*;/);
    expect(buttonRule).toMatch(/min-width\s*:\s*0\s*;/);
    expect(buttonRule).toMatch(/overflow\s*:\s*visible\s*;/);
    expect(buttonRule).toMatch(/grid-template-columns\s*:\s*minmax\(0,\s*1fr\)\s*;/);
    expect(copyRule).toMatch(/width\s*:\s*100%\s*;/);
    expect(copyRule).toMatch(/max-width\s*:\s*100%\s*;/);
    expect(copyRule).toMatch(/overflow\s*:\s*hidden\s*;/);
    expect(copyRule).toMatch(/grid-template-columns\s*:\s*minmax\(0,\s*1fr\)\s*;/);
    expect(titleRule).toMatch(/display\s*:\s*block\s*;/);
    expect(titleRule).toMatch(/min-width\s*:\s*0\s*;/);
    expect(titleRule).toMatch(/max-width\s*:\s*100%\s*;/);
    expect(titleRule).toMatch(/overflow\s*:\s*hidden\s*;/);
    expect(titleRule).toMatch(/text-overflow\s*:\s*ellipsis\s*;/);
    expect(titleRule).toMatch(/white-space\s*:\s*nowrap\s*;/);
  });
});
