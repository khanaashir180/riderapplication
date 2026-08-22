import { api, ApiError } from './api';

export const OFFLINE_DB_NAME = 'GomilaRiderOfflineDB';
export const OFFLINE_DB_VERSION = 3;
const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 60_000;

export type OfflineSyncStatus = 'PENDING' | 'SYNCING' | 'SYNCED' | 'CONFLICT' | 'FAILED';
export type OfflineOperationType =
  | 'CONTACT_EVENT'
  | 'DELIVERY_ATTEMPT'
  | 'DELIVERY_PROOF_PREPARED'
  | 'HANDBACK_PREPARATION';

export interface OfflineActor {
  uid: string;
  riderId: string;
  profileId?: string;
  fullName?: string;
}

export interface CachedRoutePackage {
  id: string;
  packageNumber: string;
  customerName: string;
  customerPhone?: string;
  deliveryAddress: string;
  city?: string;
  zone?: string;
  codExpected: number;
  paymentMethod: string;
  operationalStatus: string;
  routeSequence?: number;
  updatedAt?: string;
  assignedRiderId?: string | null;
  proofPendingSync?: boolean;
  handbackPendingSync?: boolean;
  waitingToSync?: boolean;
  offlineConflict?: boolean;
  offlineConflictMessage?: string;
}

export interface RiderRouteSnapshot {
  actorKey: string;
  riderId: string;
  routePackages: CachedRoutePackage[];
  activeRun: {
    id?: string;
    status?: string;
    dispatchDate?: string;
    expectedPackageIds?: string[];
  } | null;
  riderInfo: {
    id: string;
    riderCode?: string;
    assignedZone?: string;
    vehicleType?: string;
    maximumDailyCapacity?: number;
    maximumCodExposure?: number;
    activeShift?: string | null;
    allowedZones?: string[];
  } | null;
  cachedAt: string;
}

export interface LocalProofRecord {
  proofId: string;
  actorKey: string;
  packageId: string;
  attemptId: string;
  fileName: string;
  fileType: string;
  fileSize: number;
  imageDataUrl: string;
  createdAt: string;
  latitude?: number | null;
  longitude?: number | null;
}

export interface OfflineQueueItem {
  operationId: string;
  idempotencyKey: string;
  packageId: string;
  actor: OfflineActor;
  operationType: OfflineOperationType;
  payload: Record<string, any>;
  createdAt: string;
  retryCount: number;
  syncStatus: OfflineSyncStatus;
  observedServerRevision: string | null;
  localProofId?: string | null;
  lastError?: string | null;
  nextRetryAt?: string | null;
  syncedAt?: string | null;
  conflictMessage?: string | null;
}

interface OfflineMetaRecord {
  key: string;
  value: any;
}

interface SyncListenerPayload {
  isOnline: boolean;
  pendingCount: number;
  lastSyncAt?: string | null;
  syncing: boolean;
  conflictCount: number;
  failedCount: number;
}

type SyncListener = (payload: SyncListenerPayload) => void;

type DbStoreName = 'routes' | 'queue' | 'proofs' | 'meta';

const syncListeners = new Set<SyncListener>();
let syncInFlight: Promise<void> | null = null;
let networkListenerBound = false;
let lastKnownActorKey: string | null = null;
let lastSyncAt: string | null = null;

function actorKey(actor: OfflineActor) {
  return `${actor.uid}::${actor.riderId}`;
}

function randomSuffix(length = 6) {
  return Math.random().toString(36).slice(2, 2 + length);
}

function nowIso() {
  return new Date().toISOString();
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getNavigatorOnline() {
  return typeof navigator === 'undefined' ? true : navigator.onLine;
}

function requestToPromise<T = unknown>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export function openOfflineDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined' || !window.indexedDB) {
      reject(new Error('IndexedDB is not supported on this browser'));
      return;
    }

    const request = window.indexedDB.open(OFFLINE_DB_NAME, OFFLINE_DB_VERSION);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (event: IDBVersionChangeEvent) => {
      const db = (event.target as IDBOpenDBRequest).result;

      if (!db.objectStoreNames.contains('routes')) {
        db.createObjectStore('routes', { keyPath: 'actorKey' });
      }

      if (!db.objectStoreNames.contains('queue')) {
        const queueStore = db.createObjectStore('queue', { keyPath: 'operationId' });
        queueStore.createIndex('by_actor_status', ['actorKey', 'syncStatus'], { unique: false });
        queueStore.createIndex('by_actor_created', ['actorKey', 'createdAt'], { unique: false });
      }

      if (!db.objectStoreNames.contains('proofs')) {
        const proofStore = db.createObjectStore('proofs', { keyPath: 'proofId' });
        proofStore.createIndex('by_actor', 'actorKey', { unique: false });
      }

      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
    };
  });
}

async function getAllFromStore<T>(storeName: DbStoreName): Promise<T[]> {
  const db = await openOfflineDB();
  const tx = db.transaction(storeName, 'readonly');
  const store = tx.objectStore(storeName);
  const result = await requestToPromise<any[]>(store.getAll());
  await transactionDone(tx);
  return (result || []) as T[];
}

async function putInStore<T>(storeName: DbStoreName, value: T): Promise<void> {
  const db = await openOfflineDB();
  const tx = db.transaction(storeName, 'readwrite');
  tx.objectStore(storeName).put(value as any);
  await transactionDone(tx);
}

async function deleteFromStore(storeName: DbStoreName, key: IDBValidKey): Promise<void> {
  const db = await openOfflineDB();
  const tx = db.transaction(storeName, 'readwrite');
  tx.objectStore(storeName).delete(key);
  await transactionDone(tx);
}

async function readMeta<T>(key: string, fallback: T): Promise<T> {
  try {
    const db = await openOfflineDB();
    const tx = db.transaction('meta', 'readonly');
    const store = tx.objectStore('meta');
    const record = await requestToPromise<OfflineMetaRecord | undefined>(store.get(key));
    await transactionDone(tx);
    return (record?.value ?? fallback) as T;
  } catch {
    return fallback;
  }
}

async function writeMeta(key: string, value: any): Promise<void> {
  await putInStore<OfflineMetaRecord>('meta', { key, value });
}

function minimalRoutePackage(order: any): CachedRoutePackage {
  return {
    id: order.id,
    packageNumber: order.packageNumber || order.package_number || order.original_order_number || order.id,
    customerName: order.customerName || order.customer_name || 'Customer',
    customerPhone: order.customerPhone || order.contact_number || order.primaryPhone || undefined,
    deliveryAddress: order.deliveryAddress || order.delivery_address || order.address || '',
    city: order.city || undefined,
    zone: order.zone || order.assignedZone || undefined,
    codExpected: Number(order.codExpected ?? order.cod_expected ?? order.expectedCod ?? 0) || 0,
    paymentMethod: order.paymentMethod || order.payment_method || 'COD',
    operationalStatus: order.operationalStatus || order.current_status || order.currentStatus || 'ASSIGNED',
    routeSequence: Number.isFinite(Number(order.routeSequence)) ? Number(order.routeSequence) : undefined,
    updatedAt: order.updatedAt || order.updated_at || null,
    assignedRiderId: order.assignedRiderId || order.assigned_rider_id || null,
    proofPendingSync: Boolean(order.proofPendingSync),
    handbackPendingSync: Boolean(order.handbackPendingSync),
    waitingToSync: Boolean(order.waitingToSync),
    offlineConflict: Boolean(order.offlineConflict),
    offlineConflictMessage: order.offlineConflictMessage || undefined
  };
}

export function buildRouteSnapshot(params: {
  actor: OfflineActor;
  orders: any[];
  activeRun?: any | null;
  riderInfo?: any | null;
}): RiderRouteSnapshot {
  const { actor, orders, activeRun, riderInfo } = params;
  return {
    actorKey: actorKey(actor),
    riderId: actor.riderId,
    routePackages: (orders || []).map(minimalRoutePackage),
    activeRun: activeRun
      ? {
          id: activeRun.id,
          status: activeRun.status,
          dispatchDate: activeRun.dispatchDate || activeRun.dispatch_date,
          expectedPackageIds: activeRun.expectedPackages || activeRun.expectedPackageIds || []
        }
      : null,
    riderInfo: riderInfo
      ? {
          id: riderInfo.id,
          riderCode: riderInfo.rider_code || riderInfo.riderCode,
          assignedZone: riderInfo.assigned_zone || riderInfo.assignedZone,
          vehicleType: riderInfo.vehicle_type || riderInfo.vehicleType,
          maximumDailyCapacity: riderInfo.maximum_daily_capacity || riderInfo.maximumDailyCapacity,
          maximumCodExposure: riderInfo.maximum_cod_exposure || riderInfo.maximumCodExposure,
          activeShift: riderInfo.active_shift || riderInfo.activeShift || null,
          allowedZones: riderInfo.allowed_zones || riderInfo.allowedZones || []
        }
      : null,
    cachedAt: nowIso()
  };
}

export async function cacheActiveRoute(params: {
  actor: OfflineActor;
  orders: any[];
  activeRun?: any | null;
  riderInfo?: any | null;
}): Promise<void> {
  const snapshot = buildRouteSnapshot(params);
  await enforceExclusiveRiderSession(params.actor);
  await putInStore<RiderRouteSnapshot>('routes', snapshot);
  await writeMeta('activeActorKey', snapshot.actorKey);
  lastKnownActorKey = snapshot.actorKey;
}

export async function getCachedActiveRoute(actor: OfflineActor): Promise<RiderRouteSnapshot | null> {
  try {
    const db = await openOfflineDB();
    const tx = db.transaction('routes', 'readonly');
    const route = await requestToPromise<RiderRouteSnapshot | undefined>(tx.objectStore('routes').get(actorKey(actor)));
    await transactionDone(tx);
    return route || null;
  } catch {
    return null;
  }
}

export async function getLatestCachedRouteForUid(uid: string): Promise<RiderRouteSnapshot | null> {
  const routes = await getAllFromStore<RiderRouteSnapshot>('routes');
  const matches = routes.filter((route) => route.actorKey.startsWith(`${uid}::`));
  if (matches.length === 0) return null;
  matches.sort((a, b) => Date.parse(b.cachedAt) - Date.parse(a.cachedAt));
  return matches[0];
}

export async function cacheRiderOrders(actor: OfflineActor, orders: any[], activeRun?: any | null, riderInfo?: any | null): Promise<void> {
  await cacheActiveRoute({ actor, orders, activeRun, riderInfo });
}

export async function getCachedRiderOrders(actor: OfflineActor): Promise<any[]> {
  const route = await getCachedActiveRoute(actor);
  return route?.routePackages || [];
}

export async function enforceExclusiveRiderSession(actor: OfflineActor): Promise<void> {
  const currentActorKey = actorKey(actor);
  const previousActiveKey = await readMeta<string | null>('activeActorKey', null);
  if (previousActiveKey && previousActiveKey !== currentActorKey) {
    const [routes, proofs, queue] = await Promise.all([
      getAllFromStore<RiderRouteSnapshot>('routes'),
      getAllFromStore<LocalProofRecord>('proofs'),
      getAllFromStore<(OfflineQueueItem & { actorKey?: string })>('queue')
    ]);

    await Promise.all(routes.filter((route) => route.actorKey !== currentActorKey).map((route) => deleteFromStore('routes', route.actorKey)));
    await Promise.all(proofs.filter((proof) => proof.actorKey !== currentActorKey).map((proof) => deleteFromStore('proofs', proof.proofId)));
    await Promise.all(
      queue
        .filter((item) => (item.actorKey || actorKey(item.actor)) !== currentActorKey)
        .map((item) => deleteFromStore('queue', item.operationId))
    );
  }

  await writeMeta('activeActorKey', currentActorKey);
  lastKnownActorKey = currentActorKey;
}

export async function saveLocalProof(params: {
  actor: OfflineActor;
  packageId: string;
  attemptId: string;
  fileName: string;
  fileType: string;
  fileSize: number;
  imageDataUrl: string;
  latitude?: number | null;
  longitude?: number | null;
}): Promise<LocalProofRecord> {
  const proof: LocalProofRecord = {
    proofId: `proof_${params.packageId}_${params.attemptId}`,
    actorKey: actorKey(params.actor),
    packageId: params.packageId,
    attemptId: params.attemptId,
    fileName: params.fileName,
    fileType: params.fileType,
    fileSize: params.fileSize,
    imageDataUrl: params.imageDataUrl,
    createdAt: nowIso(),
    latitude: params.latitude ?? null,
    longitude: params.longitude ?? null
  };
  await putInStore<LocalProofRecord>('proofs', proof);
  return proof;
}

export async function getLocalProof(proofId: string): Promise<LocalProofRecord | null> {
  try {
    const db = await openOfflineDB();
    const tx = db.transaction('proofs', 'readonly');
    const record = await requestToPromise<LocalProofRecord | undefined>(tx.objectStore('proofs').get(proofId));
    await transactionDone(tx);
    return record || null;
  } catch {
    return null;
  }
}

export async function clearLocalProof(proofId: string): Promise<void> {
  await deleteFromStore('proofs', proofId);
}

export function buildOfflineQueueItem(params: {
  actor: OfflineActor;
  packageId: string;
  operationType: OfflineOperationType;
  payload: Record<string, any>;
  observedServerRevision?: string | null;
  idempotencyKey?: string;
  localProofId?: string | null;
}): OfflineQueueItem {
  const operationId = params.payload.operationId || `op_${params.packageId}_${Date.now()}_${randomSuffix(8)}`;
  return {
    operationId,
    idempotencyKey: params.idempotencyKey || params.payload.idempotencyKey || `${params.operationType}:${params.packageId}:${operationId}`,
    packageId: params.packageId,
    actor: params.actor,
    operationType: params.operationType,
    payload: { ...params.payload, operationId },
    createdAt: nowIso(),
    retryCount: 0,
    syncStatus: 'PENDING',
    observedServerRevision: params.observedServerRevision || null,
    localProofId: params.localProofId || null,
    lastError: null,
    nextRetryAt: null,
    syncedAt: null,
    conflictMessage: null
  };
}

async function applyQueueImpactToRoute(item: OfflineQueueItem): Promise<void> {
  const route = await getCachedActiveRoute(item.actor);
  if (!route) return;
  const updatedPackages = route.routePackages.map((pkg) => {
    if (pkg.id !== item.packageId) return pkg;
    const nextPkg = { ...pkg, waitingToSync: true };
    if (item.operationType === 'DELIVERY_ATTEMPT') {
      nextPkg.operationalStatus = item.payload.status || pkg.operationalStatus;
      nextPkg.proofPendingSync = Boolean(item.localProofId);
    }
    if (item.operationType === 'HANDBACK_PREPARATION') {
      nextPkg.handbackPendingSync = true;
    }
    return nextPkg;
  });
  await putInStore<RiderRouteSnapshot>('routes', { ...route, routePackages: updatedPackages, cachedAt: nowIso() });
}

async function markRoutePackageConflict(item: OfflineQueueItem, message: string): Promise<void> {
  const route = await getCachedActiveRoute(item.actor);
  if (!route) return;
  const updatedPackages = route.routePackages.map((pkg) =>
    pkg.id === item.packageId
      ? { ...pkg, waitingToSync: false, offlineConflict: true, offlineConflictMessage: message }
      : pkg
  );
  await putInStore<RiderRouteSnapshot>('routes', { ...route, routePackages: updatedPackages, cachedAt: nowIso() });
}

async function clearRoutePackageSyncFlags(item: OfflineQueueItem): Promise<void> {
  const route = await getCachedActiveRoute(item.actor);
  if (!route) return;
  const updatedPackages = route.routePackages.map((pkg) =>
    pkg.id === item.packageId
      ? {
          ...pkg,
          waitingToSync: false,
          proofPendingSync: false,
          handbackPendingSync: false,
          offlineConflict: false,
          offlineConflictMessage: undefined
        }
      : pkg
  );
  await putInStore<RiderRouteSnapshot>('routes', { ...route, routePackages: updatedPackages, cachedAt: nowIso() });
}

export async function queueOfflineAction(item: OfflineQueueItem): Promise<OfflineQueueItem> {
  await enforceExclusiveRiderSession(item.actor);
  await putInStore<OfflineQueueItem & { actorKey: string }>('queue', { ...item, actorKey: actorKey(item.actor) });
  await applyQueueImpactToRoute(item);
  await notifySyncListeners();
  return item;
}

export async function getUnsyncedQueueItems(actor?: OfflineActor): Promise<OfflineQueueItem[]> {
  const all = await getAllFromStore<(OfflineQueueItem & { actorKey?: string })>('queue');
  const pending = all.filter((item) => item.syncStatus !== 'SYNCED');
  if (!actor) return pending;
  const key = actorKey(actor);
  return pending.filter((item) => (item.actorKey || actorKey(item.actor)) === key);
}

export async function getQueueCounts(actor?: OfflineActor): Promise<{ pending: number; conflict: number; failed: number }> {
  const items = await getUnsyncedQueueItems(actor);
  return {
    pending: items.filter((item) => item.syncStatus === 'PENDING' || item.syncStatus === 'SYNCING').length,
    conflict: items.filter((item) => item.syncStatus === 'CONFLICT').length,
    failed: items.filter((item) => item.syncStatus === 'FAILED').length
  };
}

export async function hasUnsyncedOfflineActions(actor: OfflineActor): Promise<boolean> {
  const items = await getUnsyncedQueueItems(actor);
  return items.some((item) => item.syncStatus !== 'SYNCED');
}

export async function deleteQueuedAction(operationId: string): Promise<void> {
  await deleteFromStore('queue', operationId);
  await notifySyncListeners();
}

export async function markQueueItemSynced(operationId: string): Promise<void> {
  const db = await openOfflineDB();
  const tx = db.transaction('queue', 'readwrite');
  const store = tx.objectStore('queue');
  const item = await requestToPromise<OfflineQueueItem | undefined>(store.get(operationId));
  if (item) {
    store.put({ ...item, syncStatus: 'SYNCED', syncedAt: nowIso(), lastError: null, nextRetryAt: null, retryCount: item.retryCount });
  }
  await transactionDone(tx);
}

export function computeRetryDelay(retryCount: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, retryCount));
}

function isPermanentError(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  return error.status >= 400 && error.status < 500 && ![408, 409, 429].includes(error.status);
}

function isConflictError(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  return error.status === 409 || error.code === 'INVALID_STATE_TRANSITION' || error.code === 'PACKAGE_ALREADY_ASSIGNED';
}

export async function updateQueueItemStatus(operationId: string, mutate: (current: OfflineQueueItem) => OfflineQueueItem): Promise<OfflineQueueItem | null> {
  const db = await openOfflineDB();
  const tx = db.transaction('queue', 'readwrite');
  const store = tx.objectStore('queue');
  const current = await requestToPromise<OfflineQueueItem | undefined>(store.get(operationId));
  if (!current) {
    await transactionDone(tx);
    return null;
  }
  const next = mutate(current);
  store.put({ ...next, actorKey: actorKey(next.actor) } as any);
  await transactionDone(tx);
  return next;
}

export async function notifySyncListeners(): Promise<void> {
  const counts = await getQueueCounts(lastKnownActorKey ? { uid: lastKnownActorKey.split('::')[0], riderId: lastKnownActorKey.split('::')[1] } : undefined);
  const payload: SyncListenerPayload = {
    isOnline: getNavigatorOnline(),
    pendingCount: counts.pending,
    lastSyncAt,
    syncing: Boolean(syncInFlight),
    conflictCount: counts.conflict,
    failedCount: counts.failed
  };
  syncListeners.forEach((listener) => listener(payload));
}

export function subscribeToSyncStatus(listener: SyncListener): () => void {
  syncListeners.add(listener);
  void notifySyncListeners();
  return () => {
    syncListeners.delete(listener);
  };
}

function dataUrlToBlob(dataUrl: string): Blob {
  const [meta, body] = dataUrl.split(',');
  const mime = /data:(.*?);base64/.exec(meta || '')?.[1] || 'image/jpeg';
  const binary = atob(body || '');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mime });
}

async function uploadOfflineProof(item: OfflineQueueItem): Promise<string | undefined> {
  if (!item.localProofId) return item.payload.proofStoragePath;
  const record = await getLocalProof(item.localProofId);
  if (!record) {
    throw new Error('Offline proof file missing from local storage.');
  }
  const { storage, auth } = await import('../lib/firebase');
  const { ref, uploadBytes } = await import('firebase/storage');
  const riderUid = auth.currentUser?.uid || item.actor.uid;
  const fileName = `${Date.now()}_${record.fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  const storagePath = `deliveryProofs/${riderUid}/${record.attemptId}/${fileName}`;
  const storageRef = ref(storage, storagePath);
  await uploadBytes(storageRef, dataUrlToBlob(record.imageDataUrl), { contentType: record.fileType || 'image/jpeg' });
  return storagePath;
}

async function fetchServerRevision(packageId: string): Promise<string | null> {
  try {
    const response = await api.getOrderById(packageId);
    const data: any = response.data;
    return data?.updatedAt || data?.updated_at || null;
  } catch {
    return null;
  }
}

async function syncQueuedAction(item: OfflineQueueItem): Promise<void> {
  const observedRevision = item.observedServerRevision;
  if (observedRevision) {
    const latestRevision = await fetchServerRevision(item.packageId);
    if (latestRevision && latestRevision !== observedRevision) {
      throw new ApiError('ORDER CHANGED WHILE OFFLINE', 409, 'ORDER_CHANGED_WHILE_OFFLINE');
    }
  }

  if (item.operationType === 'CONTACT_EVENT') {
    await api.recordDeliveryContactEvent({
      packageId: item.packageId,
      method: item.payload.method,
      outcome: item.payload.outcome,
      attemptId: item.payload.attemptId,
      notes: item.payload.notes
    });
    return;
  }

  if (item.operationType === 'HANDBACK_PREPARATION') {
    await api.submitRiderHandback({
      packageId: item.packageId,
      scannedPackageNumber: item.payload.scannedPackageNumber,
      returnReason: item.payload.returnReason,
      riderNotes: item.payload.riderNotes,
      handoffEmployee: item.payload.handoffEmployee,
      idempotencyKey: item.idempotencyKey
    });
    return;
  }

  if (item.operationType === 'DELIVERY_ATTEMPT' || item.operationType === 'DELIVERY_PROOF_PREPARED') {
    const proofStoragePath = await uploadOfflineProof(item);
    await api.recordDeliveryAttempt({
      ...item.payload,
      packageId: item.packageId,
      idempotencyKey: item.idempotencyKey,
      proofStoragePath
    } as any);
    return;
  }
}

export async function syncOfflineQueue(actor?: OfflineActor): Promise<void> {
  if (!getNavigatorOnline()) {
    await notifySyncListeners();
    return;
  }
  if (syncInFlight) {
    return syncInFlight;
  }

  syncInFlight = (async () => {
    const items = await getUnsyncedQueueItems(actor);
    const ordered = [...items].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));

    for (const item of ordered) {
      if (item.nextRetryAt && Date.parse(item.nextRetryAt) > Date.now()) {
        continue;
      }

      await updateQueueItemStatus(item.operationId, (current) => ({
        ...current,
        syncStatus: 'SYNCING',
        lastError: null
      }));
      await notifySyncListeners();

      try {
        await syncQueuedAction(item);
        await markQueueItemSynced(item.operationId);
        await clearRoutePackageSyncFlags(item);
        if (item.localProofId) {
          await clearLocalProof(item.localProofId);
        }
        lastSyncAt = nowIso();
      } catch (error: any) {
        if (isConflictError(error)) {
          await updateQueueItemStatus(item.operationId, (current) => ({
            ...current,
            syncStatus: 'CONFLICT',
            lastError: error.message || 'Conflict while syncing offline action.',
            conflictMessage: error.message || 'ORDER CHANGED WHILE OFFLINE',
            nextRetryAt: null
          }));
          await markRoutePackageConflict(item, error.message || 'ORDER CHANGED WHILE OFFLINE');
          continue;
        }

        if (isPermanentError(error)) {
          await updateQueueItemStatus(item.operationId, (current) => ({
            ...current,
            syncStatus: 'FAILED',
            lastError: error.message || 'Permanent sync failure.',
            nextRetryAt: null,
            retryCount: current.retryCount + 1
          }));
          continue;
        }

        const retryCount = item.retryCount + 1;
        const retryDelay = computeRetryDelay(retryCount);
        await updateQueueItemStatus(item.operationId, (current) => ({
          ...current,
          syncStatus: 'PENDING',
          retryCount,
          lastError: error?.message || 'Temporary sync failure.',
          nextRetryAt: new Date(Date.now() + retryDelay).toISOString()
        }));
        await wait(Math.min(retryDelay, 250));
      }
    }
  })()
    .finally(async () => {
      syncInFlight = null;
      await notifySyncListeners();
    });

  await notifySyncListeners();
  return syncInFlight;
}

export function initializeOfflineSync(actor?: OfflineActor): void {
  if (networkListenerBound || typeof window === 'undefined') {
    if (actor) {
      lastKnownActorKey = actorKey(actor);
    }
    return;
  }

  if (actor) {
    lastKnownActorKey = actorKey(actor);
  }

  const trigger = () => {
    void syncOfflineQueue(actor);
  };

  window.addEventListener('online', trigger);
  networkListenerBound = true;
  void notifySyncListeners();
}

export async function flushOfflineQueueOnReconnect(actor?: OfflineActor): Promise<void> {
  await syncOfflineQueue(actor);
}

export async function queueContactEvent(params: {
  actor: OfflineActor;
  packageId: string;
  method: 'CALL' | 'WHATSAPP';
  outcome: 'ATTEMPTED' | 'ANSWERED' | 'NO_ANSWER' | 'PHONE_OFF' | 'INVALID_NUMBER' | 'CALLBACK_REQUESTED';
  attemptId?: string;
  notes?: string;
  observedServerRevision?: string | null;
}): Promise<OfflineQueueItem> {
  return queueOfflineAction(
    buildOfflineQueueItem({
      actor: params.actor,
      packageId: params.packageId,
      operationType: 'CONTACT_EVENT',
      payload: {
        method: params.method,
        outcome: params.outcome,
        attemptId: params.attemptId,
        notes: params.notes
      },
      observedServerRevision: params.observedServerRevision,
      idempotencyKey: `CONTACT:${params.packageId}:${params.method}:${Date.now()}`
    })
  );
}

export async function queueHandbackPreparation(params: {
  actor: OfflineActor;
  packageId: string;
  scannedPackageNumber: string;
  returnReason?: string;
  riderNotes?: string;
  handoffEmployee?: string;
  observedServerRevision?: string | null;
  idempotencyKey?: string;
}): Promise<OfflineQueueItem> {
  return queueOfflineAction(
    buildOfflineQueueItem({
      actor: params.actor,
      packageId: params.packageId,
      operationType: 'HANDBACK_PREPARATION',
      payload: {
        scannedPackageNumber: params.scannedPackageNumber,
        returnReason: params.returnReason,
        riderNotes: params.riderNotes,
        handoffEmployee: params.handoffEmployee
      },
      observedServerRevision: params.observedServerRevision,
      idempotencyKey: params.idempotencyKey || `HANDBACK:${params.packageId}:${Date.now()}`
    })
  );
}

export async function queueDeliveryAttempt(params: {
  actor: OfflineActor;
  packageId: string;
  payload: Record<string, any>;
  observedServerRevision?: string | null;
  localProof?: {
    attemptId: string;
    fileName: string;
    fileType: string;
    fileSize: number;
    imageDataUrl: string;
    latitude?: number | null;
    longitude?: number | null;
  } | null;
  idempotencyKey: string;
}): Promise<OfflineQueueItem> {
  let localProofId: string | null = null;
  if (params.localProof) {
    const proof = await saveLocalProof({
      actor: params.actor,
      packageId: params.packageId,
      attemptId: params.localProof.attemptId,
      fileName: params.localProof.fileName,
      fileType: params.localProof.fileType,
      fileSize: params.localProof.fileSize,
      imageDataUrl: params.localProof.imageDataUrl,
      latitude: params.localProof.latitude,
      longitude: params.localProof.longitude
    });
    localProofId = proof.proofId;
  }

  return queueOfflineAction(
    buildOfflineQueueItem({
      actor: params.actor,
      packageId: params.packageId,
      operationType: 'DELIVERY_ATTEMPT',
      payload: params.payload,
      observedServerRevision: params.observedServerRevision,
      idempotencyKey: params.idempotencyKey,
      localProofId
    })
  );
}

export function buildOfflineBannerText(params: { isOnline: boolean; pendingCount: number }): string {
  if (params.isOnline && params.pendingCount === 0) return 'ONLINE';
  if (!params.isOnline) return `OFFLINE — ${params.pendingCount} UPDATES WAITING`;
  return `ONLINE — ${params.pendingCount} UPDATES WAITING`;
}
