import { describe, expect, it } from 'bun:test';

import type { DiffCommentThread } from '../types/diff';

import { mergeCommentThreads } from './commentImports';

const makeThread = (overrides: Partial<DiffCommentThread> = {}): DiffCommentThread => ({
  id: 'thread-1',
  filePath: 'src/app.ts',
  createdAt: '2026-08-28T10:00:00.000Z',
  updatedAt: '2026-08-28T10:00:00.000Z',
  position: { side: 'new', line: 12 },
  messages: [
    {
      id: 'message-1',
      body: 'Why the early return?',
      author: 'Reviewer',
      createdAt: '2026-08-28T10:00:00.000Z',
      updatedAt: '2026-08-28T10:00:00.000Z',
    },
  ],
  ...overrides,
});

describe('mergeCommentThreads', () => {
  it('appends threads the existing set does not have', () => {
    const existing = makeThread();
    const incoming = makeThread({
      id: 'thread-2',
      position: { side: 'new', line: 40 },
      messages: [
        {
          id: 'message-2',
          body: 'Nit: rename this.',
          createdAt: '2026-08-28T11:00:00.000Z',
          updatedAt: '2026-08-28T11:00:00.000Z',
        },
      ],
    });

    const merged = mergeCommentThreads([existing], [incoming]);

    expect(merged.map((thread) => thread.id)).toEqual(['thread-1', 'thread-2']);
  });

  it('matches a thread by file, position and root message when ids differ', () => {
    const existing = makeThread();
    const sameThreadOtherId = makeThread({ id: 'thread-renamed' });

    const merged = mergeCommentThreads([existing], [sameThreadOtherId]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.id).toBe('thread-1');
  });

  it('adds the incoming reply and keeps replies in creation order', () => {
    const existing = makeThread();
    const withReply = makeThread({
      updatedAt: '2026-08-28T12:00:00.000Z',
      messages: [
        ...makeThread().messages,
        {
          id: 'message-reply',
          body: 'Because of the guard above.',
          createdAt: '2026-08-28T12:00:00.000Z',
          updatedAt: '2026-08-28T12:00:00.000Z',
        },
      ],
    });

    const merged = mergeCommentThreads([existing], [withReply]);

    expect(merged[0]?.messages.map((message) => message.id)).toEqual([
      'message-1',
      'message-reply',
    ]);
    expect(merged[0]?.updatedAt).toBe('2026-08-28T12:00:00.000Z');
  });

  it('keeps the newer edit of a message present on both sides', () => {
    const existing = makeThread();
    const edited = makeThread({
      messages: [
        {
          ...makeThread().messages[0]!,
          body: 'Why the early return here?',
          updatedAt: '2026-08-28T13:00:00.000Z',
        },
      ],
    });

    const merged = mergeCommentThreads([existing], [edited]);

    expect(merged[0]?.messages[0]?.body).toBe('Why the early return here?');
  });

  it('leaves both inputs untouched', () => {
    const existing = makeThread();
    const incoming = makeThread({ id: 'thread-2', position: { side: 'new', line: 40 } });

    mergeCommentThreads([existing], [incoming]);

    expect(existing).toEqual(makeThread());
    expect(incoming.messages).toHaveLength(1);
  });
});
