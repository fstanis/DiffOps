/** Event the local API bridge broadcasts to the mounted viewer. */
export type BridgeEvent = { type: 'reload' } | { type: 'commentsChanged' };

type BridgeEventListener = (event: BridgeEvent) => void | Promise<void>;

const listeners = new Set<BridgeEventListener>();

/** The returned function unsubscribes. */
export const subscribeToBridgeEvents = (listener: BridgeEventListener): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Resolves once every listener has finished handling the event. */
export const broadcastBridgeEvent = async (event: BridgeEvent): Promise<void> => {
  await Promise.all([...listeners].map(async (listener) => listener(event)));
};
