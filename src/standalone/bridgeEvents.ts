/** Event the local API bridge broadcasts to the mounted viewer. */
export type BridgeEvent = { type: 'reload' } | { type: 'commentsChanged' };

type BridgeEventListener = (event: BridgeEvent) => void;

const listeners = new Set<BridgeEventListener>();

/** Subscribes to bridge events; the returned function unsubscribes. */
export const subscribeToBridgeEvents = (listener: BridgeEventListener): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Delivers an event to every subscriber — the bridge's refresh and import broadcasts. */
export const broadcastBridgeEvent = (event: BridgeEvent): void => {
  for (const listener of listeners) {
    listener(event);
  }
};
