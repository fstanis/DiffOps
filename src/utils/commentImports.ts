import type {
  DiffCommentPosition,
  DiffCommentThread,
  DiffLineRange,
  DiffCommentCodeSnapshot,
  DiffCommentMessage,
} from '../types/diff.js';

function getPositionKey(position: DiffCommentPosition): string {
  if (typeof position.line === 'number') {
    return `${position.side}:${position.line}`;
  }

  return `${position.side}:${position.line.start}-${position.line.end}`;
}

function positionsMatch(left: DiffCommentPosition, right: DiffCommentPosition): boolean {
  return getPositionKey(left) === getPositionKey(right);
}

function normalizeAuthor(author: string | undefined): string {
  return author?.trim() || '';
}

function maxIsoTimestamp(left: string, right: string): string {
  return left.localeCompare(right) >= 0 ? left : right;
}

function cloneLineRange(line: DiffLineRange): DiffLineRange {
  if (typeof line === 'number') {
    return line;
  }

  return {
    start: line.start,
    end: line.end,
  };
}

function clonePosition(position: DiffCommentPosition): DiffCommentPosition {
  return {
    side: position.side,
    line: cloneLineRange(position.line),
  };
}

function cloneCodeSnapshot(
  snapshot: DiffCommentCodeSnapshot | undefined,
): DiffCommentCodeSnapshot | undefined {
  if (!snapshot) {
    return undefined;
  }

  return {
    content: snapshot.content,
    language: snapshot.language,
  };
}

function cloneMessage(message: DiffCommentMessage): DiffCommentMessage {
  return {
    id: message.id,
    body: message.body,
    author: message.author,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
  };
}

function cloneThread(thread: DiffCommentThread): DiffCommentThread {
  return {
    id: thread.id,
    filePath: thread.filePath,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    position: clonePosition(thread.position),
    codeSnapshot: cloneCodeSnapshot(thread.codeSnapshot),
    messages: thread.messages.map(cloneMessage),
  };
}

function messagesMatch(left: DiffCommentMessage, right: DiffCommentMessage): boolean {
  if (left.id === right.id) {
    return true;
  }

  if (normalizeAuthor(left.author) !== normalizeAuthor(right.author)) {
    return false;
  }

  return left.body === right.body && left.createdAt === right.createdAt;
}

function threadsMatch(left: DiffCommentThread, right: DiffCommentThread): boolean {
  if (left.id === right.id) {
    return true;
  }

  if (left.filePath !== right.filePath || !positionsMatch(left.position, right.position)) {
    return false;
  }

  const leftRoot = left.messages[0];
  const rightRoot = right.messages[0];
  if (!leftRoot || !rightRoot) {
    return false;
  }

  return messagesMatch(leftRoot, rightRoot);
}

function sortReplies(left: DiffCommentMessage, right: DiffCommentMessage): number {
  const createdAtOrder = left.createdAt.localeCompare(right.createdAt);
  if (createdAtOrder !== 0) {
    return createdAtOrder;
  }

  return left.id.localeCompare(right.id);
}

function pickNewerMessage(
  existingMessage: DiffCommentMessage,
  incomingMessage: DiffCommentMessage,
): DiffCommentMessage {
  if (incomingMessage.updatedAt.localeCompare(existingMessage.updatedAt) >= 0) {
    return cloneMessage(incomingMessage);
  }

  return cloneMessage(existingMessage);
}

function mergeThread(
  existingThread: DiffCommentThread,
  incomingThread: DiffCommentThread,
): DiffCommentThread {
  const mergedMessages = existingThread.messages.map(cloneMessage);

  for (const incomingMessage of incomingThread.messages) {
    const matchIndex = mergedMessages.findIndex((message) =>
      messagesMatch(message, incomingMessage),
    );
    if (matchIndex >= 0) {
      const existingMessage = mergedMessages[matchIndex];
      if (existingMessage) {
        mergedMessages[matchIndex] = pickNewerMessage(existingMessage, incomingMessage);
      }
      continue;
    }

    mergedMessages.push(cloneMessage(incomingMessage));
  }

  const [rootMessage, ...replyMessages] = mergedMessages;
  const orderedMessages = rootMessage
    ? [rootMessage, ...replyMessages.sort(sortReplies)]
    : replyMessages.sort(sortReplies);
  const updatedAt = orderedMessages.reduce(
    (latest, message) => maxIsoTimestamp(latest, message.updatedAt),
    maxIsoTimestamp(existingThread.updatedAt, incomingThread.updatedAt),
  );

  return {
    ...cloneThread(existingThread),
    createdAt:
      existingThread.createdAt.localeCompare(incomingThread.createdAt) <= 0
        ? existingThread.createdAt
        : incomingThread.createdAt,
    updatedAt,
    position: clonePosition(existingThread.position),
    codeSnapshot: cloneCodeSnapshot(incomingThread.codeSnapshot ?? existingThread.codeSnapshot),
    messages: orderedMessages,
  };
}

/**
 * Reconciles two writers' views of the same comment session: threads are
 * matched by id or by file, position and root message, and each side's newer
 * message edit wins. Neither input is mutated.
 */
export function mergeCommentThreads(
  existingThreads: DiffCommentThread[],
  incomingThreads: DiffCommentThread[],
): DiffCommentThread[] {
  const threads = existingThreads.map(cloneThread);

  for (const incomingThread of incomingThreads) {
    const existingIndex = threads.findIndex((thread) => threadsMatch(thread, incomingThread));
    if (existingIndex < 0) {
      threads.push(cloneThread(incomingThread));
      continue;
    }

    const existingThread = threads[existingIndex];
    if (existingThread) {
      threads[existingIndex] = mergeThread(existingThread, incomingThread);
    }
  }

  return threads;
}
