import { describe, expect, it } from 'bun:test';
import type { VirtualItem } from '@tanstack/react-virtual';

import { getSpacerHeights } from './useDiffRowVirtualizer';

/** Virtual item starts/ends are absolute: they already include scrollMargin. */
const item = (index: number, start: number, size: number): VirtualItem => ({
  key: index,
  index,
  start,
  end: start + size,
  size,
  lane: 0,
});

describe('getSpacerHeights', () => {
  it('converts absolute item offsets into list-relative spacer heights', () => {
    // A list sitting 5000px down the scroll container, showing rows 100-109 of
    // a 1000-row list: 100 rows above (2200px), 890 below (19580px).
    const scrollMargin = 5000;
    const items = [item(100, scrollMargin + 2200, 22), item(109, scrollMargin + 2398, 22)];

    const { paddingTop, paddingBottom } = getSpacerHeights(items, 22000, scrollMargin);

    expect(paddingTop).toBe(2200);
    expect(paddingBottom).toBe(22000 - 2420);
  });

  it('never lets scrollMargin leak into the spacers (the blank-render regression)', () => {
    // Same visible rows, same list, only the list's position on the page
    // differs. The spacers must be identical — leaking scrollMargin into
    // paddingTop is what pushed rows thousands of pixels below their file.
    const items = (scrollMargin: number) => [
      item(0, scrollMargin, 22),
      item(9, scrollMargin + 198, 22),
    ];

    const atTop = getSpacerHeights(items(0), 22000, 0);
    const farDownThePage = getSpacerHeights(items(48000), 22000, 48000);

    expect(farDownThePage).toEqual(atTop);
    expect(farDownThePage.paddingTop).toBe(0);
  });

  it('reserves the full height while nothing is mounted yet', () => {
    expect(getSpacerHeights([], 22000, 5000)).toEqual({ paddingTop: 22000, paddingBottom: 0 });
  });

  it('clamps to zero rather than emitting negative spacer heights', () => {
    // A stale scrollMargin — measured before the layout above this list
    // settled — leaves the absolute offsets ahead of the margin. Both edges
    // must clamp instead of emitting a negative height.
    const items = [item(0, 5000, 22), item(9, 5198, 22)];

    const { paddingTop, paddingBottom } = getSpacerHeights(items, 220, 0);

    expect(paddingTop).toBe(5000);
    expect(paddingBottom).toBe(0);
  });
});
