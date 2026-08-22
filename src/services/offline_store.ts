// Offline IndexedDB Queue and Sync Manager for Rider PWA

const DB_NAME = 'GomilaRiderOfflineDB';
const DB_VERSION = 1;

export interface OfflineQueueItem {
  id: string;
  order_id: string;
  action: 'UPDATE_STATUS' | 'RECORD_ATTEMPT' | 'COLLECT_COD' | 'RECORD_SCAN';
  payload: any;
  idempotency_key: string;
  created_at: string;
  synced: boolean;
  sync_attempts: number;
  last_error?: string;
}

export function openOfflineDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error('IndexedDB is not supported on this browser'));
      return;
    }

    const request = window.indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);

    request.onupgradeneeded = (event: IDBVersionChangeEvent) => {
      const db = (event.target as IDBOpenDBRequest).result;

      if (!db.objectStoreNames.contains('orders')) {
        db.createObjectStore('orders', { keyPath: 'id' });
      }

      if (!db.objectStoreNames.contains('queue')) {
        const queueStore = db.createObjectStore('queue', { keyPath: 'id' });
        queueStore.createIndex('synced', 'synced', { unique: false });
      }
    };
  });
}

// Cache rider assigned orders locally
export async function cacheRiderOrders(orders: any[]): Promise<void> {
  try {
    const db = await openOfflineDB();
    const tx = db.transaction('orders', 'readwrite');
    const store = tx.objectStore('orders');

    // Clear old cached orders
    await new Promise((resolve) => {
      const clearReq = store.clear();
      clearReq.onsuccess = resolve;
    });

    // Store fresh orders
    for (const order of orders) {
      store.put(order);
    }

    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn('Failed to cache rider orders to IndexedDB:', err);
  }
}

// Get cached rider orders
export async function getCachedRiderOrders(): Promise<any[]> {
  try {
    const db = await openOfflineDB();
    const tx = db.transaction('orders', 'readonly');
    const store = tx.objectStore('orders');

    return new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.warn('Failed to read cached rider orders:', err);
    return [];
  }
}

// Add an action to the offline queue
export async function addOfflineQueueItem(
  orderId: string,
  action: OfflineQueueItem['action'],
  payload: any
): Promise<OfflineQueueItem> {
  const idempotencyKey = `idemp-${orderId}-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
  const item: OfflineQueueItem = {
    id: `queue-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
    order_id: orderId,
    action,
    payload: {
      ...payload,
      idempotency_key: idempotencyKey,
    },
    idempotency_key: idempotencyKey,
    created_at: new Date().toISOString(),
    synced: false,
    sync_attempts: 0,
  };

  try {
    const db = await openOfflineDB();
    const tx = db.transaction('queue', 'readwrite');
    const store = tx.objectStore('queue');
    store.put(item);

    // Also update cached order status locally in IndexedDB for immediate UI feedback
    const orderTx = db.transaction('orders', 'readwrite');
    const orderStore = orderTx.objectStore('orders');
    const getReq = orderStore.get(orderId);

    getReq.onsuccess = () => {
      const existing = getReq.result;
      if (existing) {
        existing.current_status = payload.status || existing.current_status;
        if (payload.proof_image_url) existing.proof_image_url = payload.proof_image_url;
        existing.updated_at = new Date().toISOString();
        orderStore.put(existing);
      }
    };
  } catch (err) {
    console.warn('Failed to store queue item in IndexedDB:', err);
  }

  return item;
}

// Get unsynced queue items
export async function getUnsyncedQueueItems(): Promise<OfflineQueueItem[]> {
  try {
    const db = await openOfflineDB();
    const tx = db.transaction('queue', 'readonly');
    const store = tx.objectStore('queue');

    return new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => {
        const all = req.result || [];
        resolve(all.filter((q) => !q.synced));
      };
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.warn('Failed to fetch unsynced queue items:', err);
    return [];
  }
}

// Mark queue item as synced
export async function markQueueItemSynced(id: string): Promise<void> {
  try {
    const db = await openOfflineDB();
    const tx = db.transaction('queue', 'readwrite');
    const store = tx.objectStore('queue');

    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const item = getReq.result;
      if (item) {
        item.synced = true;
        store.put(item);
      }
    };
  } catch (err) {
    console.warn('Failed to mark item synced:', err);
  }
}
