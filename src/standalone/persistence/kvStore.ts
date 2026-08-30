// Minimal key-value wrapper over IndexedDB in place of a dependency like idb.

interface KVEntry<T> {
  key: string;
  value: T;
}

/** Key-value storage with one named store per record kind. */
export interface KVStore {
  get<T>(storeName: string, key: string): Promise<T | undefined>;
  put<T>(storeName: string, key: string, value: T): Promise<void>;
  getAll<T>(storeName: string): Promise<KVEntry<T>[]>;
  delete(storeName: string, key: string): Promise<void>;
}

/** An in-memory KVStore for environments without IndexedDB: persistence degrades to session-only. */
export const createMemoryKvStore = (): KVStore => {
  const stores = new Map<string, Map<string, unknown>>();

  const getStore = (storeName: string): Map<string, unknown> => {
    let store = stores.get(storeName);
    if (!store) {
      store = new Map();
      stores.set(storeName, store);
    }
    return store;
  };

  return {
    get<T>(storeName: string, key: string): Promise<T | undefined> {
      return Promise.resolve(getStore(storeName).get(key) as T | undefined);
    },
    put<T>(storeName: string, key: string, value: T): Promise<void> {
      getStore(storeName).set(key, value);
      return Promise.resolve();
    },
    getAll<T>(storeName: string): Promise<KVEntry<T>[]> {
      return Promise.resolve(
        Array.from(getStore(storeName).entries(), ([key, value]) => ({
          key,
          value: value as T,
        })),
      );
    },
    delete(storeName: string, key: string): Promise<void> {
      getStore(storeName).delete(key);
      return Promise.resolve();
    },
  };
};

const requestToPromise = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const transactionToPromise = (transaction: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });

export interface OpenKvStoreOptions {
  /**
   * Database version; raise it when the set of stores changes so
   * onupgradeneeded runs, creating the missing stores and dropping — with
   * their records — the ones no longer listed. Defaults to 1.
   */
  version?: number;
}

// Without this timeout, a tab that never releases the old DB version would wedge every operation forever.
const OPEN_BLOCKED_TIMEOUT_MS = 5_000;

/** Opens (creating on first use) an IndexedDB database exposing the given stores as a KVStore. */
export const openIndexedDbKvStore = (
  databaseName: string,
  storeNames: string[],
  options: OpenKvStoreOptions = {},
): KVStore => {
  // Cache the connection so a broken open doesn't spawn unbounded connections.
  let database: IDBDatabase | null = null;
  let opening: Promise<IDBDatabase> | null = null;

  const getDatabase = (): Promise<IDBDatabase> => {
    if (database) {
      return Promise.resolve(database);
    }
    opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName, options.version ?? 1);
      request.onupgradeneeded = () => {
        for (const storeName of Array.from(request.result.objectStoreNames)) {
          if (!storeNames.includes(storeName)) {
            request.result.deleteObjectStore(storeName);
          }
        }
        for (const storeName of storeNames) {
          if (!request.result.objectStoreNames.contains(storeName)) {
            request.result.createObjectStore(storeName);
          }
        }
      };
      request.onblocked = () => {
        console.warn(
          `diffops: upgrading IndexedDB "${databaseName}" is blocked by another tab; close it to continue`,
        );
      };
      const timeoutId = setTimeout(() => {
        opening = null;
        reject(
          new Error(
            `opening IndexedDB "${databaseName}" timed out — another tab may hold an older version; close it and retry`,
          ),
        );
      }, OPEN_BLOCKED_TIMEOUT_MS);
      const settleOpen = () => {
        clearTimeout(timeoutId);
        const db = request.result;
        // Closing promptly unblocks the other tab's upgrade; the next operation here reopens transparently.
        db.onversionchange = () => {
          db.close();
          if (database === db) {
            database = null;
            opening = null;
          }
        };
        database = db;
        resolve(db);
      };
      request.onsuccess = settleOpen;
      request.onerror = () => {
        clearTimeout(timeoutId);
        opening = null;
        reject(request.error);
      };
    });
    return opening;
  };

  const run = async <T>(
    storeName: string,
    mode: IDBTransactionMode,
    operate: (objectStore: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> => {
    const db = await getDatabase();
    const transaction = db.transaction(storeName, mode);
    const request = operate(transaction.objectStore(storeName));
    const result = await requestToPromise(request);
    await transactionToPromise(transaction);
    return result;
  };

  return {
    async get<T>(storeName: string, key: string): Promise<T | undefined> {
      return run<T | undefined>(
        storeName,
        'readonly',
        (store) => store.get(key) as IDBRequest<T | undefined>,
      );
    },
    async put<T>(storeName: string, key: string, value: T): Promise<void> {
      await run(storeName, 'readwrite', (store) => store.put(value, key));
    },
    async getAll<T>(storeName: string): Promise<KVEntry<T>[]> {
      const db = await getDatabase();
      const transaction = db.transaction(storeName, 'readonly');
      const objectStore = transaction.objectStore(storeName);
      const keys = await requestToPromise(objectStore.getAllKeys());
      const values = await requestToPromise(objectStore.getAll());
      await transactionToPromise(transaction);
      return keys.map((key, index) => ({
        key: String(key),
        value: values[index] as T,
      }));
    },
    async delete(storeName: string, key: string): Promise<void> {
      await run(storeName, 'readwrite', (store) => store.delete(key));
    },
  };
};
