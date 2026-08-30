import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { useVirtualizer, type VirtualItem } from '@tanstack/react-virtual';

import { NAVIGATION_SELECTORS } from '../constants/navigation';

const ESTIMATED_ROW_HEIGHT = 22;
const OVERSCAN_ROWS = 12;

export interface DiffRowVirtualizer {
  /** Attach to the element wrapping the virtualized `<table>`; used to locate this list inside the shared scroll container. */
  wrapperRef: React.RefObject<HTMLDivElement | null>;
  /** False when there is no shared scroll container to bind to — callers then render the full, non-virtualized list. */
  isVirtualized: boolean;
  /** Scrolls the shared container so `index` falls inside the rendered range. False if it can't be located. */
  scrollRowIntoView: (index: number) => boolean;
  virtualItems: VirtualItem[];
  /** Height of the spacer row standing in for the rows above the mounted range. */
  paddingTop: number;
  /** Height of the spacer row standing in for the rows below the mounted range. */
  paddingBottom: number;
}

function getSharedScrollContainer(): HTMLElement | null {
  return document.querySelector<HTMLElement>(NAVIGATION_SELECTORS.SCROLL_CONTAINER);
}

/**
 * A virtual item's `start`/`end` are absolute — they include `scrollMargin`, this
 * list's offset within the shared scroll container — while `getTotalSize()` is
 * relative to the list itself. The spacer rows live inside the list, so both
 * edges have to be converted into list-relative space before they line up.
 */
export function getSpacerHeights(
  virtualItems: VirtualItem[],
  totalSize: number,
  scrollMargin: number,
): { paddingTop: number; paddingBottom: number } {
  const first = virtualItems[0];
  const last = virtualItems[virtualItems.length - 1];
  if (!first || !last) {
    // Nothing mounted yet: still reserve the full height so the surrounding
    // layout (and every list below this one) keeps its place.
    return { paddingTop: Math.max(0, totalSize), paddingBottom: 0 };
  }

  return {
    paddingTop: Math.max(0, first.start - scrollMargin),
    paddingBottom: Math.max(0, totalSize - (last.end - scrollMargin)),
  };
}

/** Measures a row group: the line's own `<tr>` plus any comment/form rows attached beneath it. */
function measureRowGroup(element: HTMLTableRowElement): number {
  let height = element.getBoundingClientRect().height;
  let sibling = element.nextElementSibling;
  while (sibling instanceof HTMLElement && sibling.dataset.diffExtraRow === 'true') {
    height += sibling.getBoundingClientRect().height;
    sibling = sibling.nextElementSibling;
  }
  return Math.round(height);
}

/** Bound to the shared app scroll container so many chunks on one page can each virtualize their own rows. */
export function useDiffRowVirtualizer(count: number): DiffRowVirtualizer {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const scrollMarginRef = useRef(0);

  const getScrollElement = useCallback(() => getSharedScrollContainer(), []);

  const rowVirtualizer = useVirtualizer({
    count,
    getScrollElement,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    overscan: OVERSCAN_ROWS,
    scrollMargin,
    measureElement: measureRowGroup,
    // The scroll container belongs to the app, not to this list: dozens of
    // chunks share one. Seeding the live position keeps this list's first
    // computed range right instead of assuming the page is at the top.
    initialOffset: () => getSharedScrollContainer()?.scrollTop ?? 0,
    // Backstop for every write the library makes on its own initiative: the
    // container is the app's, shared by every chunk, so moving it stays the
    // app's job. `scrollRowIntoView` below is the one deliberate exception.
    scrollToFn: () => {},
  });

  // Replacing a row's estimate with its real height would normally shift the
  // scroll position by the difference. On a shared container that double-counts
  // against the browser's own scroll anchoring, which already holds the content
  // still, and the two fight each other a few pixels at a time. Declined here
  // rather than left to scrollToFn, because the virtualizer books the
  // adjustment against its own offset whether or not the write lands, and that
  // drift moves the mounted range away from the viewport.
  rowVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => false;

  // This list's offset shifts whenever anything above it changes height — a
  // lazily mounted file, a view-mode switch, an expanded chunk — and none of
  // those necessarily re-render this component, so it is re-checked after every
  // render and on scroll rather than measured once at mount.
  const syncScrollMargin = useCallback(() => {
    const wrapper = wrapperRef.current;
    const scrollContainer = getScrollElement();
    if (!wrapper || !scrollContainer) return;

    const offset =
      scrollContainer.scrollTop +
      (wrapper.getBoundingClientRect().top - scrollContainer.getBoundingClientRect().top);
    // Guarded so this can run on every render without looping.
    if (Math.abs(offset - scrollMarginRef.current) < 1) return;
    scrollMarginRef.current = offset;
    setScrollMargin(offset);
  }, [getScrollElement]);

  useLayoutEffect(syncScrollMargin);

  useLayoutEffect(() => {
    const scrollContainer = getScrollElement();
    if (!scrollContainer) return undefined;

    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        syncScrollMargin();
      });
    };

    scrollContainer.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      scrollContainer.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
    };
  }, [getScrollElement, syncScrollMargin]);

  // The single writer of measured row heights. It runs after every render and
  // reads each row's index off the committed DOM, so a row's height always
  // lands on the index it was rendered for — and it can measure the whole row
  // group, including the comment rows beneath a line, which the library's
  // per-row observer has no way to see. Sizes are only written when they
  // differ, so this settles instead of looping.
  useLayoutEffect(() => {
    const wrapper = wrapperRef.current;
    // A zero-width wrapper means layout hasn't settled; every line would look
    // wrapped into dozens of rows and that garbage would be cached for good.
    if (!wrapper || wrapper.clientWidth === 0) return;

    for (const row of wrapper.querySelectorAll<HTMLTableRowElement>('tr[data-index]')) {
      const index = Number(row.dataset.index);
      if (!Number.isInteger(index)) continue;

      const size = measureRowGroup(row);
      const prev = rowVirtualizer.itemSizeCache.get(index);
      if (size > 0 && prev !== size) {
        rowVirtualizer.resizeItem(index, size);
      }
    }
  });

  // Row heights depend on how the code wraps, so every cached height is
  // invalidated when the list's width changes. Observing the wrapper also
  // re-syncs the offset when content above this list grows or shrinks.
  const lastWidthRef = useRef(0);
  useLayoutEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper || typeof ResizeObserver === 'undefined') return undefined;

    const observer = new ResizeObserver(() => {
      syncScrollMargin();
      const width = wrapper.clientWidth;
      if (width > 0 && width !== lastWidthRef.current) {
        lastWidthRef.current = width;
        rowVirtualizer.measure();
      }
    });
    observer.observe(wrapper);
    return () => observer.disconnect();
  }, [syncScrollMargin, rowVirtualizer]);

  // Replaces the virtualizer's own scrollToIndex, which routes through the
  // suppressed scrollToFn: the offset it computes is still correct, so the
  // container is scrolled here instead.
  const scrollRowIntoView = useCallback(
    (index: number): boolean => {
      const scrollContainer = getScrollElement();
      if (!scrollContainer) return false;

      const offsetInfo = rowVirtualizer.getOffsetForIndex(index, 'center');
      if (!offsetInfo) return false;

      scrollContainer.scrollTo({ top: offsetInfo[0] });
      return true;
    },
    [getScrollElement, rowVirtualizer],
  );

  const isVirtualized = getScrollElement() !== null;
  const virtualItems = rowVirtualizer.getVirtualItems();
  const { paddingTop, paddingBottom } = getSpacerHeights(
    virtualItems,
    rowVirtualizer.getTotalSize(),
    scrollMargin,
  );

  return {
    wrapperRef,
    isVirtualized,
    scrollRowIntoView,
    virtualItems,
    paddingTop,
    paddingBottom,
  };
}
