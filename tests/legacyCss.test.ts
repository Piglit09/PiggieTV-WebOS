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

  it('gives generic landscape, poster, and episode artwork a definite non-zero height', () => {
    const rootRule = css.match(/:root\s*\{([^}]*)\}/)?.[1] ?? '';
    const landscapeCardRule = css.match(/\.ptv-card--landscape\s*\{([^}]*)\}/)?.[1] ?? '';
    const posterCardRule = css.match(/\.ptv-card--poster\s*\{([^}]*)\}/)?.[1] ?? '';
    const episodeCardRule = css.match(/\.ptv-card--episode\s*\{([^}]*)\}/)?.[1] ?? '';
    const buttonRule = css.match(/\.ptv-card-btn\s*\{([^}]*)\}/)?.[1] ?? '';
    const baseArtworkRule = css.match(/\.ptv-card-art\s*\{([^}]*)\}/)?.[1] ?? '';
    const artworkRule = css.match(
      /\.ptv-card--landscape \.ptv-card-art\s*,\s*\.ptv-card--poster \.ptv-card-art\s*\{([^}]*)\}/
    )?.[1] ?? '';
    const genericEpisodeArtworkRule = css.match(
      /\.ptv-card--episode \.ptv-card-art\s*\{([^}]*)\}/
    )?.[1] ?? '';
    const genericEpisodeButtonRule = css.match(
      /\.ptv-card--episode \.ptv-card-btn\s*\{([^}]*)\}/
    )?.[1] ?? '';
    const genericEpisodeCopyRule = css.match(
      /\.ptv-card--episode \.ptv-card-copy\s*\{([^}]*)\}/
    )?.[1] ?? '';
    const imageFillRule = css.match(
      /\.ptv-card-btn img\s*,\s*\.ptv-card-placeholder\s*\{([^}]*)\}/
    )?.[1] ?? '';
    const copyRule = css.match(/(?:^|\n)\.ptv-card-copy\s*\{([^}]*)\}/)?.[1] ?? '';
    const showsArtworkRule = css.match(/\.ptv-browse--shows \.ptv-card-art\s*\{([^}]*)\}/)?.[1] ?? '';
    const episodeArtworkRule = css.match(
      /\.ptv-details--episode \.ptv-card--episode \.ptv-card-art\s*\{([^}]*)\}/
    )?.[1] ?? '';
    const landscapeHeight = Number(rootRule.match(/--ptv-landscape-height\s*:\s*(\d+)px\s*;/)?.[1] ?? 0);
    const posterHeight = Number(rootRule.match(/--ptv-poster-height\s*:\s*(\d+)px\s*;/)?.[1] ?? 0);

    expect(landscapeCardRule).toMatch(/height\s*:\s*var\(--ptv-landscape-height\)\s*;/);
    expect(posterCardRule).toMatch(/height\s*:\s*var\(--ptv-poster-height\)\s*;/);
    expect(episodeCardRule).toMatch(/height\s*:\s*246px\s*;/);
    expect(buttonRule).toMatch(/height\s*:\s*100%\s*;/);
    expect(buttonRule).toMatch(/display\s*:\s*grid\s*;/);
    expect(buttonRule).toMatch(/grid-template-rows\s*:\s*minmax\(0,\s*1fr\)\s+auto\s*;/);
    expect(baseArtworkRule).toMatch(/position\s*:\s*relative\s*;/);
    expect(imageFillRule).toMatch(/height\s*:\s*100%\s*;/);
    expect(copyRule).toMatch(/min-height\s*:\s*58px\s*;/);
    expect(artworkRule).toMatch(/height\s*:\s*calc\(100%\s*-\s*58px\)\s*;/);
    expect(genericEpisodeButtonRule).toMatch(/grid-template-rows\s*:\s*168px\s+76px\s*;/);
    expect(genericEpisodeArtworkRule).toMatch(/height\s*:\s*168px\s*;/);
    expect(genericEpisodeCopyRule).toMatch(/min-height\s*:\s*76px\s*;/);
    expect(landscapeHeight).toBeGreaterThan(58);
    expect(posterHeight).toBeGreaterThan(58);
    expect(showsArtworkRule).toMatch(/height\s*:\s*270px\s*;/);
    expect(episodeArtworkRule).toMatch(/height\s*:\s*100%\s*;/);
    expect(css.indexOf('.ptv-card--landscape .ptv-card-art,')).toBeLessThan(
      css.indexOf('.ptv-browse--shows .ptv-card-art')
    );
  });

  it('keeps Series actions and icons at finite legacy-webOS dimensions', () => {
    const buttonRule = css.match(
      /\.ptv-details--series \.ptv-details__actions button\s*\{([^}]*)\}/
    )?.[1] ?? '';
    const iconRule = css.match(
      /\.ptv-details--series \.ptv-details__actions svg\s*\{([^}]*)\}/
    )?.[1] ?? '';

    expect(buttonRule).toMatch(/display\s*:\s*inline-flex\s*;/);
    expect(buttonRule).toMatch(/align-items\s*:\s*center\s*;/);
    expect(buttonRule).toMatch(/justify-content\s*:\s*center\s*;/);
    expect(iconRule).toMatch(/width\s*:\s*26px\s*;/);
    expect(iconRule).toMatch(/height\s*:\s*26px\s*;/);
    expect(iconRule).toMatch(/flex\s*:\s*0\s+0\s+auto\s*;/);
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
