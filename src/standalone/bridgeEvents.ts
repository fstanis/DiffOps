/** Event the local API bridge broadcasts to the mounted viewer. */
export type BridgeEvent = { type: 'reload' } | { type: 'commentsChanged' };

type BridgeEventListener = (event: BridgeEvent) => void;

const listeners = new Set<BridgeEventListener>();

/** The returned function unsubscribes. */
export const subscribeToBridgeEvents = (listener: BridgeEventListener): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const broadcastBridgeEvent = (event: BridgeEvent): void => {
  for (const listener of listeners) {
    listener(event);
  }
};
