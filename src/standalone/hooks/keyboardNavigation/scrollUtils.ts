import { NAVIGATION_SELECTORS } from '../../constants/navigation';
import { scrollChunkOriginalIndexIntoRange } from '../diffRowVirtualizerRegistry';
import { parseElementId } from '../../utils/navigation/domHelpers';

import { SCROLL_CONSTANTS } from './types';

// A virtualized row's chunk needs a few frames to mount it after scrollToIndex commits.
const SCROLL_INTO_RANGE_MAX_ATTEMPTS = 20;

function scrollElementIntoContainer(element: HTMLElement, scrollContainer: HTMLElement): void {
  const rect = element.getBoundingClientRect();
  const containerRect = scrollContainer.getBoundingClientRect();
  const viewportHeight = scrollContainer.clientHeight;
  const scrollTop = scrollContainer.scrollTop;

  const visibleTop = Math.max(containerRect.top, 0);
  const visibleBottom = Math.min(containerRect.bottom, window.innerHeight);
  const isVisible = rect.top >= visibleTop && rect.bottom <= visibleBottom;

  if (!isVisible) {
    const offsetTop = calculateOffsetTop(element, scrollContainer);
    const targetScrollTop = offsetTop - viewportHeight * SCROLL_CONSTANTS.VIEWPORT_OFFSET_RATIO;
    scrollContainer.scrollTop = Math.max(0, targetScrollTop);
    return;
  }

  // Element is visible - only scroll if bottom edge is hidden AND we would scroll down
  const isBottomHidden = rect.bottom > Math.min(containerRect.bottom, window.innerHeight);
  const elementPosInContainer = element.offsetTop - scrollContainer.offsetTop;
  const targetScrollTop =
    elementPosInContainer - viewportHeight * SCROLL_CONSTANTS.VIEWPORT_OFFSET_RATIO;
  const wouldScrollDown = targetScrollTop > scrollTop;

  if (isBottomHidden && wouldScrollDown) {
    scrollContainer.scrollTop = Math.max(0, targetScrollTop);
  }
}

/**
 * Only scrolls if the element isn't already fully visible in the container.
 */
export function createScrollToElement() {
  return (elementId: string): void => {
    // The main scrollable container is always the same in this app
    const scrollContainer = document.querySelector(
      NAVIGATION_SELECTORS.SCROLL_CONTAINER,
    ) as HTMLElement | null;
    if (!scrollContainer) {
      throw new Error(`Scrollable container (${NAVIGATION_SELECTORS.SCROLL_CONTAINER}) not found`);
    }

    const element = document.getElementById(elementId);
    if (element) {
      scrollElementIntoContainer(element, scrollContainer);
      return;
    }

    // Not mounted: it's likely a virtualized row that's off-screen. Ask its
    // chunk to bring it into range, then retry once it mounts.
    const parsed = parseElementId(elementId);
    if (!parsed) return;

    const wasRequested = scrollChunkOriginalIndexIntoRange(
      parsed.fileIndex,
      parsed.chunkIndex,
      parsed.lineIndex,
    );
    if (!wasRequested) return;

    let attempts = 0;
    const retry = () => {
      const mounted = document.getElementById(elementId);
      if (mounted) {
        scrollElementIntoContainer(mounted, scrollContainer);
        return;
      }
      attempts++;
      if (attempts < SCROLL_INTO_RANGE_MAX_ATTEMPTS) {
        requestAnimationFrame(retry);
      }
    };
    requestAnimationFrame(retry);
  };
}

function calculateOffsetTop(element: HTMLElement, container: HTMLElement): number {
  let currentElement: HTMLElement | null = element;
  let offsetTop = 0;

  while (currentElement && currentElement !== container && currentElement.offsetParent) {
    offsetTop += currentElement.offsetTop;
    currentElement = currentElement.offsetParent as HTMLElement;
  }

  if (currentElement && currentElement !== container) {
    offsetTop += currentElement.offsetTop;
  }

  return offsetTop;
}
