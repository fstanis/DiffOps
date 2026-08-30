import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { registerChunkRowVirtualizer } from '../diffRowVirtualizerRegistry';

import { createScrollToElement } from './scrollUtils';

const flushRaf = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

describe('createScrollToElement', () => {
  let main: HTMLElement;

  beforeEach(() => {
    main = document.createElement('main');
    main.className = 'overflow-y-auto';
    document.body.appendChild(main);
  });

  afterEach(() => {
    main.remove();
  });

  it('throws when the shared scroll container is missing', () => {
    main.remove();
    const scrollToElement = createScrollToElement();
    expect(() => scrollToElement('file-0-chunk-0-line-0')).toThrow();
  });

  it('scrolls an already-mounted element directly, without touching the registry', () => {
    const row = document.createElement('div');
    row.id = 'file-0-chunk-0-line-0';
    main.appendChild(row);

    let wasRegistryCalled = false;
    registerChunkRowVirtualizer(0, 0, () => {
      wasRegistryCalled = true;
      return true;
    });

    expect(() => createScrollToElement()('file-0-chunk-0-line-0')).not.toThrow();
    expect(wasRegistryCalled).toBe(false);

    registerChunkRowVirtualizer(0, 0, null);
  });

  it('does nothing for an id that is missing and unparseable', () => {
    expect(() => createScrollToElement()('not-a-line-id')).not.toThrow();
  });

  it('does nothing for a parseable id when no chunk virtualizer is registered', () => {
    expect(() => createScrollToElement()('file-9-chunk-9-line-9')).not.toThrow();
  });

  it('asks the chunk virtualizer to bring an unmounted line into range, then scrolls it once it mounts', async () => {
    const requestedIndexes: number[] = [];
    registerChunkRowVirtualizer(1, 2, (originalLineIndex) => {
      requestedIndexes.push(originalLineIndex);
      // Simulates the chunk mounting the row a frame after scrollToIndex commits.
      queueMicrotask(() => {
        const row = document.createElement('div');
        row.id = 'file-1-chunk-2-line-42';
        main.appendChild(row);
      });
      return true;
    });

    createScrollToElement()('file-1-chunk-2-line-42');
    expect(requestedIndexes).toEqual([42]);

    // Give the queued microtask (and the retry's rAF) a chance to run.
    await flushRaf();
    await flushRaf();

    expect(document.getElementById('file-1-chunk-2-line-42')).not.toBeNull();

    registerChunkRowVirtualizer(1, 2, null);
  });

  it('gives up after enough retries when the chunk never mounts the row', async () => {
    let callCount = 0;
    registerChunkRowVirtualizer(3, 0, () => {
      callCount++;
      return true;
    });

    expect(() => createScrollToElement()('file-3-chunk-0-line-1')).not.toThrow();

    for (let i = 0; i < 25; i++) {
      await flushRaf();
    }

    // The chunk is asked once; retries just re-check getElementById without asking again.
    expect(callCount).toBe(1);
    expect(document.getElementById('file-3-chunk-0-line-1')).toBeNull();

    registerChunkRowVirtualizer(3, 0, null);
  });
});
