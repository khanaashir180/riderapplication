import React, { useEffect, useState } from 'react';
import {
  Navigation,
  DollarSign,
  Clock,
  RotateCcw,
  User,
  Search,
  AlertTriangle,
  RefreshCw
} from 'lucide-react';
import { Profile, Rider } from '../../types';
import { api } from '../../services/api';
import {
  OfflineActor,
  buildOfflineBannerText,
  cacheActiveRoute,
  flushOfflineQueueOnReconnect,
  getLatestCachedRouteForUid,
  getUnsyncedQueueItems,
  initializeOfflineSync,
  queueContactEvent,
  subscribeToSyncStatus
} from '../../services/offline_store';
import { RiderHeader } from './RiderHeader';
import { RiderHomeSummary } from './RiderHomeSummary';
import { RiderNextStopCard } from './RiderNextStopCard';
import { RiderPackageCard } from './RiderPackageCard';
import { RiderDeliveryAttemptModal } from './RiderDeliveryAttemptModal';
import { RiderReattemptsTab } from './RiderReattemptsTab';
import { RiderCashTab } from './RiderCashTab';
import { RiderReturnsTab } from './RiderReturnsTab';
import { RiderProfileTab } from './RiderProfileTab';
import { RiderEndOfDayFlow } from './RiderEndOfDayFlow';

interface RiderMobileShellProps {
  userProfile: Profile;
  onLogout?: () => void;
}

export function RiderMobileShell({ userProfile, onLogout }: RiderMobileShellProps) {
  const [activeTab, setActiveTab] = useState<'route' | 'reattempts' | 'cash' | 'returns' | 'profile' | 'end-of-day'>('route');
  const [orders, setOrders] = useState<any[]>([]);
  const [riderInfo, setRiderInfo] = useState<Rider | null>(null);
  const [activeRun, setActiveRun] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [search, setSearch] = useState('');
  const [isAcceptingShift, setIsAcceptingShift] = useState(false);
  const [selectedOrderForAttempt, setSelectedOrderForAttempt] = useState<any | null>(null);
  const [contactedOrderIds, setContactedOrderIds] = useState<Set<string>>(new Set());
  const [contactOutcomeDraft, setContactOutcomeDraft] = useState<{ orderId: string; channel: 'CALL' | 'WHATSAPP' } | null>(null);
  const [isOffline, setIsOffline] = useState<boolean>(typeof navigator !== 'undefined' ? !navigator.onLine : false);
  const [unsyncedCount, setUnsyncedCount] = useState(0);
  const [syncConflictCount, setSyncConflictCount] = useState(0);
  const [syncFailedCount, setSyncFailedCount] = useState(0);
  const [offlineNotice, setOfflineNotice] = useState<string | null>(null);

  const offlineActor: OfflineActor | null = riderInfo?.id
    ? {
        uid: userProfile.id,
        riderId: riderInfo.id,
        profileId: userProfile.id,
        fullName: userProfile.full_name
      }
    : null;

  useEffect(() => {
    void loadAllRiderData();
  }, []);

  useEffect(() => {
    const onOnline = () => {
      setIsOffline(false);
      void flushOfflineQueueOnReconnect(offlineActor || undefined);
    };
    const onOffline = () => setIsOffline(true);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    const unsubscribe = subscribeToSyncStatus((payload) => {
      setIsOffline(!payload.isOnline);
      setUnsyncedCount(payload.pendingCount + payload.conflictCount + payload.failedCount);
      setSyncConflictCount(payload.conflictCount);
      setSyncFailedCount(payload.failedCount);
    });
    if (offlineActor) {
      initializeOfflineSync(offlineActor);
      void flushOfflineQueueOnReconnect(offlineActor);
    }
    void refreshOfflineState();
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      unsubscribe();
    };
  }, [offlineActor?.uid, offlineActor?.riderId]);

  const refreshOfflineState = async () => {
    const pending = await getUnsyncedQueueItems(offlineActor || undefined).catch(() => []);
    const items = Array.isArray(pending) ? pending : [];
    setUnsyncedCount(items.length);
    setSyncConflictCount(items.filter((item) => item.syncStatus === 'CONFLICT').length);
    setSyncFailedCount(items.filter((item) => item.syncStatus === 'FAILED').length);
  };

  const loadAllRiderData = async () => {
    setLoading(true);
    try {
      const riderRes: any = await api.getRiderMe();
      if (riderRes?.data) {
        setRiderInfo(riderRes.data);
      }

      const ordRes: any = await api.getMyRiderOrders();
      const rawOrders = Array.isArray(ordRes) ? ordRes : (ordRes?.orders || ordRes?.data?.orders || ordRes?.data || []);
      const normalizedOrders = Array.isArray(rawOrders) ? rawOrders : [];
      setOrders(normalizedOrders);

      let runData: any | null = null;
      try {
        const runRes = await api.getMyDispatchRun();
        if (runRes?.data) {
          setActiveRun(runRes.data);
          runData = runRes.data;
        }
      } catch (err) {
        console.warn('No active dispatch run linked:', err);
      }

      if (riderRes?.data) {
        await cacheActiveRoute({
          actor: {
            uid: userProfile.id,
            riderId: riderRes.data.id,
            profileId: userProfile.id,
            fullName: userProfile.full_name
          },
          orders: normalizedOrders,
          activeRun: runData,
          riderInfo: riderRes.data
        });
      }

      setOfflineNotice(null);
    } catch (e) {
      console.error('Failed to load rider route data:', e);
      const cachedRoute = await getLatestCachedRouteForUid(userProfile.id).catch(() => null);
      if (cachedRoute) {
        setOrders(cachedRoute.routePackages);
        setActiveRun(cachedRoute.activeRun);
        setRiderInfo((prev) => prev || ({
          id: cachedRoute.riderId,
          rider_code: cachedRoute.riderInfo?.riderCode,
          assigned_zone: cachedRoute.riderInfo?.assignedZone,
          vehicle_type: cachedRoute.riderInfo?.vehicleType,
          maximum_daily_capacity: cachedRoute.riderInfo?.maximumDailyCapacity
        } as Rider));
        setOfflineNotice('Showing cached route. WAITING TO SYNC remains until the server confirms each update.');
      }
    } finally {
      await refreshOfflineState();
      setLoading(false);
      setIsRefreshing(false);
    }
  };

  const handleRefresh = async () => {
    setIsRefreshing(true);
    await loadAllRiderData();
  };

  const handleAcceptShift = async () => {
    if (!activeRun?.id) return;
    setIsAcceptingShift(true);
    try {
      const res = await api.acceptDispatchRun(activeRun.id);
      if (res && res.success !== false) {
        await loadAllRiderData();
      } else {
        alert(res?.error?.message || 'Failed to accept dispatch run');
      }
    } catch (err: any) {
      alert(err.message || 'Error accepting shift manifest');
    } finally {
      setIsAcceptingShift(false);
    }
  };

  const handleLogContact = async (orderId: string, channel: 'CALL' | 'WHATSAPP') => {
    setContactedOrderIds((prev) => new Set([...prev, orderId]));
    try {
      await api.recordDeliveryContactEvent({
        packageId: orderId,
        method: channel,
        outcome: 'ATTEMPTED'
      });
      setContactOutcomeDraft({ orderId, channel });
    } catch (error) {
      if (!offlineActor) {
        console.warn('Failed to record contact event', error);
        return;
      }
      await queueContactEvent({
        actor: offlineActor,
        packageId: orderId,
        method: channel,
        outcome: 'ATTEMPTED',
        observedServerRevision: orders.find((order: any) => order.id === orderId)?.updatedAt || orders.find((order: any) => order.id === orderId)?.updated_at || null
      });
      setContactOutcomeDraft({ orderId, channel });
      setOfflineNotice('Contact event saved locally. WAITING TO SYNC until the server confirms it.');
      await refreshOfflineState();
    }
  };

  const handleContactOutcome = async (outcome: 'ANSWERED' | 'NO_ANSWER' | 'PHONE_OFF' | 'INVALID_NUMBER' | 'CALLBACK_REQUESTED') => {
    if (!contactOutcomeDraft) return;
    try {
      await api.recordDeliveryContactEvent({
        packageId: contactOutcomeDraft.orderId,
        method: contactOutcomeDraft.channel,
        outcome
      });
    } catch (error) {
      if (offlineActor) {
        await queueContactEvent({
          actor: offlineActor,
          packageId: contactOutcomeDraft.orderId,
          method: contactOutcomeDraft.channel,
          outcome,
          observedServerRevision: orders.find((order: any) => order.id === contactOutcomeDraft.orderId)?.updatedAt || orders.find((order: any) => order.id === contactOutcomeDraft.orderId)?.updated_at || null
        });
        setOfflineNotice('Contact outcome saved locally. WAITING TO SYNC until the server confirms it.');
        await refreshOfflineState();
      } else {
        console.warn('Failed to record contact outcome', error);
      }
    } finally {
      setContactOutcomeDraft(null);
    }
  };

  const activeRouteOrders = orders.filter((o: any) => {
    const st = (o.operationalStatus || o.operational_status || o.current_status || '').toLowerCase().replace(/[\s-]+/g, '_');
    return ['assigned', 'picked_up', 'out_for_delivery', 'rider_scanned', 'rider_accepted', 'ready_for_dispatch'].includes(st);
  }).sort((a: any, b: any) => {
    const aSeq = Number.isFinite(Number(a.routeSequence)) ? Number(a.routeSequence) : Number.MAX_SAFE_INTEGER;
    const bSeq = Number.isFinite(Number(b.routeSequence)) ? Number(b.routeSequence) : Number.MAX_SAFE_INTEGER;
    if (aSeq !== bSeq) return aSeq - bSeq;
    return String(a.packageNumber || a.package_number || a.id).localeCompare(String(b.packageNumber || b.package_number || b.id));
  });

  const completedOrders = orders.filter((o: any) => {
    const st = (o.operationalStatus || o.operational_status || o.current_status || '').toLowerCase().replace(/[\s-]+/g, '_');
    return st === 'delivered';
  });

  const failedOrders = orders.filter((o: any) => {
    const st = (o.operationalStatus || o.operational_status || o.current_status || '').toLowerCase().replace(/[\s-]+/g, '_');
    return ['customer_unavailable', 'rescheduled', 'refused', 'customer_refused', 'incorrect_address', 'address_issue', 'cancelled', 'customer_cancelled', 'return_required', 'returning_to_warehouse'].includes(st);
  });

  const returnPackages = orders.filter((o: any) => {
    const st = (o.operationalStatus || o.operational_status || o.current_status || '').toLowerCase().replace(/[\s-]+/g, '_');
    return ['return_required', 'returning_to_warehouse', 'refused', 'customer_refused', 'cancelled', 'customer_cancelled', 'incorrect_address', 'address_issue', 'customer_unavailable'].includes(st);
  });

  const reattemptOrders = orders.filter((o: any) => {
    const attempts = o.deliveryAttempts || [];
    const hasNextAttempt = o.nextAttemptDate || o.next_attempt_date;
    const isRescheduled = (o.operationalStatus || o.current_status || '').toLowerCase().includes('rescheduled');
    const isUnavailable = (o.operationalStatus || o.current_status || '').toLowerCase().includes('unavailable');
    return attempts.length > 0 || hasNextAttempt || isRescheduled || isUnavailable;
  });

  const codToCollect = activeRouteOrders.reduce((sum: number, o: any) => {
    const cod = o.cod_expected !== undefined ? o.cod_expected : (o.codExpected || 0);
    const isPrepaid = (o.payment_method || o.paymentMethod || '').toLowerCase() === 'prepaid' || cod === 0;
    return isPrepaid ? sum : sum + Number(cod);
  }, 0);

  const codCollected = completedOrders.reduce((sum: number, o: any) => {
    const amt = o.collectedAmount !== undefined ? o.collectedAmount : (o.cod_collection?.collected_amount || o.cod_expected || o.codExpected || 0);
    return sum + Number(amt);
  }, 0);

  const uncontactedCount = activeRouteOrders.filter((o: any) => !contactedOrderIds.has(o.id)).length;

  const filteredActiveOrders = activeRouteOrders.filter((o: any) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    const pkgId = (o.original_order_number || o.packageNumber || o.package_number || o.id || '').toLowerCase();
    const cust = (o.customer_name || o.customerName || '').toLowerCase();
    const addr = (o.address || o.deliveryAddress || o.delivery_address || '').toLowerCase();
    return pkgId.includes(q) || cust.includes(q) || addr.includes(q);
  });

  const nextDelivery = filteredActiveOrders.length > 0 ? filteredActiveOrders[0] : null;
  const remainingDeliveries = filteredActiveOrders.length > 1 ? filteredActiveOrders.slice(1) : [];
  const syncStatusLabel = syncConflictCount > 0
    ? 'ORDER CHANGED WHILE OFFLINE'
    : syncFailedCount > 0
    ? `ONLINE — ${syncFailedCount} UPDATES FAILED`
    : buildOfflineBannerText({ isOnline: !isOffline, pendingCount: unsyncedCount });
  const syncAlertTone = syncConflictCount > 0 ? 'warning' : isOffline || unsyncedCount > 0 ? 'offline' : 'online';

  if (loading) {
    return (
      <div className="min-h-screen bg-[#F5F4F2] flex flex-col items-center justify-center p-4 text-xs text-[#6D6964] space-y-3">
        <div className="w-8 h-8 border-3 border-[#5A2628] border-t-transparent rounded-full animate-spin" />
        <span className="font-bold text-stone-800">Loading Gomila Rider Terminal...</span>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F5F4F2] text-[#1F1F1D] flex flex-col font-sans max-w-md mx-auto border-x border-[#DDD9D4] shadow-xl relative pb-20 select-none">
      <RiderHeader
        userProfile={userProfile}
        riderInfo={riderInfo}
        activeRun={activeRun}
        activeCount={activeRouteOrders.length}
        syncStatusLabel={syncStatusLabel}
        syncAlertTone={syncAlertTone}
        onAcceptShift={handleAcceptShift}
        isAcceptingShift={isAcceptingShift}
      />

      {(offlineNotice || isOffline || unsyncedCount > 0) && (
        <div className="bg-amber-100 border-b border-amber-300 px-4 py-2 text-[11px] font-bold text-amber-900">
          {offlineNotice || (isOffline ? 'Offline mode: showing cached route data.' : 'WAITING TO SYNC')}
          {unsyncedCount > 0 ? ` ${unsyncedCount} update${unsyncedCount === 1 ? '' : 's'} waiting.` : ''}
        </div>
      )}

      {returnPackages.length > 0 && activeTab !== 'returns' && (
        <div
          onClick={() => setActiveTab('returns')}
          className="bg-rose-600 text-white px-4 py-2.5 flex items-center justify-between text-xs font-black cursor-pointer shadow-xs active:opacity-90 transition sticky top-[68px] z-20"
        >
          <div className="flex items-center space-x-2">
            <AlertTriangle className="w-4 h-4 animate-bounce" />
            <span>RETURN TO HUB â€” {returnPackages.length} PACKAGE{returnPackages.length === 1 ? '' : 'S'}</span>
          </div>
          <span className="bg-white text-rose-800 text-[10px] uppercase font-black px-2 py-0.5 rounded-md">View</span>
        </div>
      )}

      <main className="p-4 space-y-4 flex-1">
        {activeTab === 'route' && (
          <div className="space-y-4">
            <RiderHomeSummary
              assignedCount={orders.length}
              deliveredCount={completedOrders.length}
              failedCount={failedOrders.length}
              remainingCount={activeRouteOrders.length}
              codToCollect={codToCollect}
              codCollected={codCollected}
              cashInHand={codCollected}
              returnsCount={returnPackages.length}
              reattemptsCount={reattemptOrders.length}
              uncontactedCount={uncontactedCount}
              onNavigateTab={(tab) => setActiveTab(tab)}
            />

            <div className="flex items-center space-x-2">
              <div className="relative flex-1">
                <Search className="w-4 h-4 text-[#6D6964] absolute left-3 top-3" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search customer, address, or ID..."
                  className="w-full pl-9 pr-3 py-2.5 text-xs bg-white border border-[#DDD9D4] rounded-xl focus:outline-none focus:ring-2 focus:ring-[#5A2628]"
                />
              </div>
              <button
                onClick={handleRefresh}
                disabled={isRefreshing}
                className="h-10 w-10 bg-white border border-[#DDD9D4] rounded-xl flex items-center justify-center text-[#6D6964] hover:text-[#1F1F1D] active:scale-95 transition shrink-0"
                title="Refresh Route"
              >
                <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin text-[#5A2628]' : ''}`} />
              </button>
            </div>

            {nextDelivery ? (
              <RiderNextStopCard
                order={nextDelivery}
                stopNumber={1}
                onRecordAttempt={(ord) => setSelectedOrderForAttempt(ord)}
                onLogContact={handleLogContact}
              />
            ) : (
              <RiderEndOfDayFlow
                orders={orders}
                riderInfo={riderInfo}
                userProfile={userProfile}
                activeRun={activeRun}
                offlineActor={offlineActor}
                onRefreshData={loadAllRiderData}
                onLogout={onLogout}
                onCloseFlow={() => setActiveTab('route')}
              />
            )}

            {remainingDeliveries.length > 0 && (
              <div className="space-y-2.5 pt-2">
                <div className="flex items-center justify-between px-1">
                  <h4 className="text-[11px] font-extrabold uppercase text-[#6D6964] tracking-wider">
                    Upcoming Deliveries ({remainingDeliveries.length})
                  </h4>
                  <span className="text-[11px] text-[#6D6964] font-mono">{remainingDeliveries.length} Stops Left</span>
                </div>
                <div className="space-y-2.5">
                  {remainingDeliveries.map((ord: any, idx: number) => (
                    <RiderPackageCard
                      key={ord.id || idx}
                      order={ord}
                      sequenceIndex={idx + 1}
                      onRecordAttempt={(o) => setSelectedOrderForAttempt(o)}
                      onLogContact={handleLogContact}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {activeTab === 'reattempts' && (
          <RiderReattemptsTab
            orders={orders}
            onRecordAttempt={(ord) => setSelectedOrderForAttempt(ord)}
            onLogContact={handleLogContact}
          />
        )}

        {activeTab === 'cash' && (
          <RiderCashTab
            orders={orders}
            riderId={riderInfo?.id || userProfile.id}
            onRefreshData={handleRefresh}
          />
        )}

        {activeTab === 'returns' && (
          <RiderReturnsTab
            orders={orders}
            offlineActor={offlineActor}
            onRefreshData={handleRefresh}
            onNavigateToCash={() => setActiveTab('cash')}
          />
        )}

        {activeTab === 'profile' && (
          <RiderProfileTab
            userProfile={userProfile}
            riderInfo={riderInfo}
            onLogout={onLogout}
            unsyncedCount={unsyncedCount}
          />
        )}

        {activeTab === 'end-of-day' && (
          <RiderEndOfDayFlow
            orders={orders}
            riderInfo={riderInfo}
            userProfile={userProfile}
            activeRun={activeRun}
            offlineActor={offlineActor}
            onRefreshData={loadAllRiderData}
            onLogout={onLogout}
            onCloseFlow={() => setActiveTab('route')}
          />
        )}
      </main>

      {selectedOrderForAttempt && (
        <RiderDeliveryAttemptModal
          order={selectedOrderForAttempt}
          offlineActor={offlineActor}
          observedServerRevision={selectedOrderForAttempt.updatedAt || selectedOrderForAttempt.updated_at || null}
          onClose={() => setSelectedOrderForAttempt(null)}
          onSuccess={async () => {
            setSelectedOrderForAttempt(null);
            await loadAllRiderData();
          }}
        />
      )}

      {contactOutcomeDraft && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-end justify-center p-4">
          <div className="w-full max-w-md bg-white rounded-2xl border border-[#DDD9D4] p-4 space-y-3 shadow-2xl">
            <div>
              <p className="text-xs font-black uppercase tracking-wider text-[#6D6964]">Contact Outcome</p>
              <h3 className="text-sm font-black text-[#1F1F1D] mt-1">Record the real result of this {contactOutcomeDraft.channel.toLowerCase()} attempt</h3>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {(['ANSWERED', 'NO_ANSWER', 'PHONE_OFF', 'INVALID_NUMBER', 'CALLBACK_REQUESTED'] as const).map((outcome) => (
                <button
                  key={outcome}
                  onClick={() => handleContactOutcome(outcome)}
                  className="rounded-xl border border-[#DDD9D4] px-3 py-3 text-xs font-bold text-[#1F1F1D] hover:bg-[#F5F4F2]"
                >
                  {outcome.replace(/_/g, ' ')}
                </button>
              ))}
            </div>
            <button
              onClick={() => setContactOutcomeDraft(null)}
              className="w-full rounded-xl bg-[#5A2628] px-3 py-3 text-xs font-bold text-white"
            >
              Record Later
            </button>
          </div>
        </div>
      )}

      <nav className="fixed bottom-0 left-0 right-0 max-w-md mx-auto bg-white border-t border-[#DDD9D4] h-16 flex items-center justify-around z-40 shadow-xl">
        <button
          onClick={() => setActiveTab('route')}
          className={`flex-1 h-full flex flex-col items-center justify-center space-y-1 transition active:scale-95 ${
            activeTab === 'route' ? 'text-[#5A2628] font-black' : 'text-[#6D6964] font-medium'
          }`}
        >
          <Navigation className={`w-5 h-5 ${activeTab === 'route' ? 'stroke-[2.5]' : ''}`} />
          <span className="text-[10px]">Route</span>
        </button>

        <button
          onClick={() => setActiveTab('reattempts')}
          className={`flex-1 h-full flex flex-col items-center justify-center space-y-1 relative transition active:scale-95 ${
            activeTab === 'reattempts' ? 'text-[#5A2628] font-black' : 'text-[#6D6964] font-medium'
          }`}
        >
          <div className="relative">
            <Clock className={`w-5 h-5 ${activeTab === 'reattempts' ? 'stroke-[2.5]' : ''}`} />
            {reattemptOrders.length > 0 && (
              <span className="absolute -top-1 -right-2 bg-amber-500 text-white font-mono text-[9px] font-black w-4 h-4 rounded-full flex items-center justify-center">
                {reattemptOrders.length}
              </span>
            )}
          </div>
          <span className="text-[10px]">Reattempts</span>
        </button>

        <button
          onClick={() => setActiveTab('cash')}
          className={`flex-1 h-full flex flex-col items-center justify-center space-y-1 transition active:scale-95 ${
            activeTab === 'cash' ? 'text-[#5A2628] font-black' : 'text-[#6D6964] font-medium'
          }`}
        >
          <DollarSign className={`w-5 h-5 ${activeTab === 'cash' ? 'stroke-[2.5]' : ''}`} />
          <span className="text-[10px]">Cash</span>
        </button>

        <button
          onClick={() => setActiveTab('returns')}
          className={`flex-1 h-full flex flex-col items-center justify-center space-y-1 relative transition active:scale-95 ${
            activeTab === 'returns' ? 'text-[#5A2628] font-black' : 'text-[#6D6964] font-medium'
          }`}
        >
          <div className="relative">
            <RotateCcw className={`w-5 h-5 ${activeTab === 'returns' ? 'stroke-[2.5]' : ''}`} />
            {returnPackages.length > 0 && (
              <span className="absolute -top-1 -right-2 bg-rose-600 text-white font-mono text-[9px] font-black w-4 h-4 rounded-full flex items-center justify-center">
                {returnPackages.length}
              </span>
            )}
          </div>
          <span className="text-[10px]">Returns</span>
        </button>

        <button
          onClick={() => setActiveTab('profile')}
          className={`flex-1 h-full flex flex-col items-center justify-center space-y-1 transition active:scale-95 ${
            activeTab === 'profile' ? 'text-[#5A2628] font-black' : 'text-[#6D6964] font-medium'
          }`}
        >
          <User className={`w-5 h-5 ${activeTab === 'profile' ? 'stroke-[2.5]' : ''}`} />
          <span className="text-[10px]">Profile</span>
        </button>
      </nav>
    </div>
  );
}
