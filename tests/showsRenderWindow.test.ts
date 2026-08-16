import { describe, expect, it } from 'vitest';
import {
  SHOWS_RENDER_GUARD_ROWS,
  SHOWS_RENDER_WINDOW_ROWS,
  calculateShowsRenderWindow,
  centeredShowsWindowStartRow,
  guardedShowsWindowStartRow,
  showsGridGeometryForWidth
} from '../src/screens/browse/showsRenderWindow';

describe('Shows render-window geometry', () => {
  it.each([
    [1800, { columns: 8, rowHeight: 322, rowGap: 30, rowPitch: 352 }],
    [1799, { columns: 8, rowHeight: 310, rowGap: 30, rowPitch: 340 }],
    [1600, { columns: 8, rowHeight: 310, rowGap: 30, rowPitch: 340 }],
    [1599, { columns: 7, rowHeight: 301, rowGap: 30, rowPitch: 331 }],
    [1300, { columns: 7, rowHeight: 301, rowGap: 30, rowPitch: 331 }],
    [1299, { columns: 6, rowHeight: 292, rowGap: 30, rowPitch: 322 }],
    [1100, { columns: 6, rowHeight: 292, rowGap: 30, rowPitch: 322 }],
    [1099, { columns: 5, rowHeight: 277, rowGap: 30, rowPitch: 307 }]
  ])('uses the expected grid geometry at width %i', (width, expected) => {
    expect(showsGridGeometryForWidth(width)).toEqual(expected);
  });

  it.each([1920, 1700, 1400, 1200, 900])(
    'caps a full render window at 12 rows for width %i',
    width => {
      const geometry = showsGridGeometryForWidth(width);
      const window = calculateShowsRenderWindow(1_000, geometry, 4);

      expect(window.endRow - window.startRow).toBe(SHOWS_RENDER_WINDOW_ROWS);
      expect(window.endIndex - window.startIndex).toBe(
        geometry.columns * SHOWS_RENDER_WINDOW_ROWS
      );
    }
  );

  it('calculates top and bottom spacers from hidden rows and row pitch', () => {
    const geometry = showsGridGeometryForWidth(1920);
    const window = calculateShowsRenderWindow(200, geometry, 5);

    expect(window).toEqual({
      bottomSpacerHeight: 8 * geometry.rowPitch,
      endIndex: 136,
      endRow: 17,
      startIndex: 40,
      startRow: 5,
      topSpacerHeight: 5 * geometry.rowPitch
    });
  });

  it('clamps the final window while preserving a partial final row', () => {
    const geometry = showsGridGeometryForWidth(1920);

    expect(calculateShowsRenderWindow(101, geometry, 999)).toEqual({
      bottomSpacerHeight: 0,
      endIndex: 101,
      endRow: 13,
      startIndex: 8,
      startRow: 1,
      topSpacerHeight: geometry.rowPitch
    });
    expect(calculateShowsRenderWindow(0, geometry, -20)).toEqual({
      bottomSpacerHeight: 0,
      endIndex: 0,
      endRow: 0,
      startIndex: 0,
      startRow: 0,
      topSpacerHeight: 0
    });
  });

  it('centers an anchor when possible and clamps at both collection edges', () => {
    expect(centeredShowsWindowStartRow(200, 8, 0)).toBe(0);
    expect(centeredShowsWindowStartRow(200, 8, 80)).toBe(5);
    expect(centeredShowsWindowStartRow(200, 8, 199)).toBe(13);
  });

  it('moves only after an anchor crosses the leading or trailing guard rows', () => {
    expect(SHOWS_RENDER_GUARD_ROWS).toBe(3);

    expect(guardedShowsWindowStartRow(200, 8, 5, 7 * 8)).toBe(4);
    expect(guardedShowsWindowStartRow(200, 8, 5, 8 * 8)).toBe(5);
    expect(guardedShowsWindowStartRow(200, 8, 5, 13 * 8)).toBe(5);
    expect(guardedShowsWindowStartRow(200, 8, 5, 14 * 8)).toBe(6);
  });

  it('clamps guarded starts when the current row or anchor is outside the collection', () => {
    expect(guardedShowsWindowStartRow(40, 8, -10, -1)).toBe(0);
    expect(guardedShowsWindowStartRow(200, 8, 999, 199)).toBe(13);
  });
});
