export const SHOWS_RENDER_WINDOW_ROWS = 12;
export const SHOWS_RENDER_GUARD_ROWS = 3;

export interface ShowsGridGeometry {
  columns: number;
  rowHeight: number;
  rowGap: number;
  rowPitch: number;
}

export interface ShowsRenderWindow {
  bottomSpacerHeight: number;
  endIndex: number;
  endRow: number;
  startIndex: number;
  startRow: number;
  topSpacerHeight: number;
}

export function showsGridGeometryForWidth(width: number): ShowsGridGeometry {
  if (width >= 1800) return { columns: 8, rowHeight: 322, rowGap: 30, rowPitch: 352 };
  if (width >= 1600) return { columns: 8, rowHeight: 310, rowGap: 30, rowPitch: 340 };
  if (width >= 1300) return { columns: 7, rowHeight: 301, rowGap: 30, rowPitch: 331 };
  if (width >= 1100) return { columns: 6, rowHeight: 292, rowGap: 30, rowPitch: 322 };
  return { columns: 5, rowHeight: 277, rowGap: 30, rowPitch: 307 };
}

function maximumStartRow(itemCount: number, columns: number) {
  const totalRows = Math.ceil(Math.max(0, itemCount) / columns);
  return Math.max(0, totalRows - SHOWS_RENDER_WINDOW_ROWS);
}

function clampStartRow(itemCount: number, columns: number, startRow: number) {
  return Math.max(0, Math.min(maximumStartRow(itemCount, columns), Math.floor(startRow)));
}

export function centeredShowsWindowStartRow(
  itemCount: number,
  columns: number,
  anchorIndex: number
) {
  const anchorRow = Math.floor(Math.max(0, anchorIndex) / columns);
  return clampStartRow(itemCount, columns, anchorRow - 5);
}

export function guardedShowsWindowStartRow(
  itemCount: number,
  columns: number,
  currentStartRow: number,
  anchorIndex: number
) {
  const safeStartRow = clampStartRow(itemCount, columns, currentStartRow);
  const anchorRow = Math.floor(Math.max(0, anchorIndex) / columns);
  const relativeRow = anchorRow - safeStartRow;

  if (relativeRow < SHOWS_RENDER_GUARD_ROWS) {
    return clampStartRow(itemCount, columns, anchorRow - SHOWS_RENDER_GUARD_ROWS);
  }
  if (relativeRow >= SHOWS_RENDER_WINDOW_ROWS - SHOWS_RENDER_GUARD_ROWS) {
    return clampStartRow(
      itemCount,
      columns,
      anchorRow - (SHOWS_RENDER_WINDOW_ROWS - SHOWS_RENDER_GUARD_ROWS - 1)
    );
  }
  return safeStartRow;
}

export function calculateShowsRenderWindow(
  itemCount: number,
  geometry: ShowsGridGeometry,
  requestedStartRow: number
): ShowsRenderWindow {
  const totalRows = Math.ceil(Math.max(0, itemCount) / geometry.columns);
  const startRow = clampStartRow(itemCount, geometry.columns, requestedStartRow);
  const endRow = Math.min(totalRows, startRow + SHOWS_RENDER_WINDOW_ROWS);

  return {
    bottomSpacerHeight: Math.max(0, totalRows - endRow) * geometry.rowPitch,
    endIndex: Math.min(itemCount, endRow * geometry.columns),
    endRow,
    startIndex: startRow * geometry.columns,
    startRow,
    topSpacerHeight: startRow * geometry.rowPitch
  };
}
