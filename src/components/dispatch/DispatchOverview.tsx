import React, { useState, useEffect } from 'react';
import { 
  Package, 
  Truck, 
  AlertTriangle, 
  Clock, 
  Users, 
  ArrowRight, 
  UserPlus, 
  CheckCircle2, 
  RotateCcw,
  DollarSign,
  Radio,
  RefreshCw,
  ShoppingBag
} from 'lucide-react';
import { collection, onSnapshot, query, limit } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { Order, Rider, normalizePackage } from '../../types';
import { api } from '../../services/api';
import { ShopifySyncModal } from './ShopifySyncModal';

interface DispatchOverviewProps {
  onNavigateToOrders: (filterStatus?: string) => void;
  onSelectOrder: (orderId: string) => void;
}

export function DispatchOverview({ onNavigateToOrders, onSelectOrder }: DispatchOverviewProps) {
  const [orders, setOrders] = useState<Order[]>([]);
  const [riders, setRiders] = useState<Rider[]>([]);
  const [loading, setLoading] = useState(true);
  const [isLiveSync, setIsLiveSync] = useState(true);
  const [lastSyncTime, setLastSyncTime] = useState<Date>(new Date());
  const [selectedRiderForAssign, setSelectedRiderForAssign] = useState<string>('');
  const [showShopifyModal, setShowShopifyModal] = useState(false);

  useEffect(() => {
    loadOverviewData();

    // Set up real-time listener for packages/orders
    let unsubscribeOrders: (() => void) | null = null;
    let unsubscribeRiders: (() => void) | null = null;

    try {
      const packagesRef = collection(db, 'packages');
      const q = query(packagesRef, limit(200));
      unsubscribeOrders = onSnapshot(q, (snapshot) => {
        if (!snapshot.empty) {
          const liveOrders: Order[] = snapshot.docs.map(doc => {
            const data = doc.data();
            return normalizePackage({
              id: doc.id,
              ...data,
              tracking_number: data.trackingNumber || data.barcode || '',
              cod_expected: Number(data.codExpected || data.cod_expected || 0),
              promised_delivery_date: data.promised_delivery_date || data.requestedDeliveryDate || '',
              rider: data.assignedRiderId ? ({ id: data.assignedRiderId, rider_code: data.assignedRiderCode || 'RIDER' } as any) : undefined,
              created_at: data.createdAt?.toDate ? data.createdAt.toDate().toISOString() : (data.createdAt || new Date().toISOString()),
              updated_at: data.updatedAt?.toDate ? data.updatedAt.toDate().toISOString() : (data.updatedAt || new Date().toISOString())
            });
          });
          setOrders(liveOrders);
          setLastSyncTime(new Date());
          setIsLiveSync(true);
        }
      }, (err) => {
        console.warn('Real-time packages snapshot fallback:', err.message);
        setIsLiveSync(false);
      });

      const ridersRef = collection(db, 'riders');
      unsubscribeRiders = onSnapshot(ridersRef, (snapshot) => {
        if (!snapshot.empty) {
          const liveRiders: Rider[] = snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
          } as Rider));
          setRiders(liveRiders);
          setLastSyncTime(new Date());
        }
      }, (err) => {
        console.warn('Real-time riders snapshot fallback:', err.message);
      });
    } catch (e) {
      console.warn('Firestore real-time subscription error, using API polling fallback:', e);
      setIsLiveSync(false);
    }

    // Background polling fallback every 30s
    const pollInterval = setInterval(() => {
      loadOverviewData(false);
    }, 30000);

    return () => {
      if (unsubscribeOrders) unsubscribeOrders();
      if (unsubscribeRiders) unsubscribeRiders();
      clearInterval(pollInterval);
    };
  }, []);

  const loadOverviewData = async (showLoadingState = true) => {
    if (showLoadingState) setLoading(true);
    try {
      const [ordRes, rdrRes] = await Promise.all([
        api.getOrders({ limit: 200 }),
        api.getRiders()
      ]);
      const rawOrders = ordRes.orders || ordRes.data?.orders || (ordRes.data as any)?.items || (Array.isArray(ordRes.data) ? ordRes.data : []);
      setOrders(Array.isArray(rawOrders) ? rawOrders : []);
      const rawRiders = rdrRes.riders || rdrRes.data || (Array.isArray(rdrRes) ? rdrRes : []);
      setRiders(Array.isArray(rawRiders) ? rawRiders : []);
      setLastSyncTime(new Date());
    } catch (e) {
      console.error('Failed to load overview data:', e);
    } finally {
      if (showLoadingState) setLoading(false);
    }
  };

  // Metric Computations
  const unassigned = orders.filter(o => o.current_status === 'Imported' || o.current_status === 'Awaiting Assignment');
  const readyHandoff = orders.filter(o => o.current_status === 'Assigned' || o.current_status === 'Picked Up');
  const outForDelivery = orders.filter(o => o.current_status === 'Out for Delivery');
  const exceptions = orders.filter(o => ['Customer Unavailable', 'Rescheduled', 'Refused', 'Incorrect Address'].includes(o.current_status));
  const codAtRisk = orders.filter(o => o.current_status === 'Out for Delivery' && o.cod_expected > 15000);

  // Overdue promised deliveries
  const todayStr = new Date().toISOString().split('T')[0];
  const overdueDeliveries = orders.filter(o => {
    if (['Delivered', 'Cancelled', 'Returned to Warehouse'].includes(o.current_status)) return false;
    return o.promised_delivery_date && o.promised_delivery_date < todayStr;
  });

  // Returned packages not received at warehouse
  const pendingWarehouseReturns = orders.filter(o => o.current_status === 'Returning to Warehouse');

  const handleQuickAssign = async (orderId: string) => {
    if (!selectedRiderForAssign) {
      alert('Please select a rider from the capacity list first.');
      return;
    }
    try {
      await api.bulkAssignOrders({ order_ids: [orderId], rider_id: selectedRiderForAssign });
      loadOverviewData();
    } catch (e) {
      console.error('Assign failed:', e);
    }
  };

  if (loading) {
    return (
      <div className="p-8 text-center text-xs text-[#6D6964] animate-pulse">
        Loading dispatch decision control center...
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6 bg-[#F5F4F2] min-h-screen">
      {/* Live Sync Status Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-white px-4 py-2.5 rounded-lg border border-[#DDD9D4] shadow-2xs">
        <div className="flex items-center space-x-3">
          <div className="flex items-center space-x-1.5">
            <span className={`relative flex h-2.5 w-2.5`}>
              {isLiveSync && (
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              )}
              <span className={`relative inline-flex rounded-full h-2.5 w-2.5 ${isLiveSync ? 'bg-emerald-500' : 'bg-amber-500'}`}></span>
            </span>
            <span className="text-xs font-bold text-[#1F1F1D]">
              {isLiveSync ? 'Real-Time Dispatch Feed' : 'Periodic Polling Mode'}
            </span>
          </div>
          <span className="text-[11px] text-[#6D6964] font-mono">
            Synced: {lastSyncTime.toLocaleTimeString()}
          </span>
        </div>

        <div className="flex items-center space-x-2">
          <button
            onClick={() => setShowShopifyModal(true)}
            className="px-2.5 py-1 text-xs font-bold text-[#1F1F1D] bg-[#95BF47]/20 hover:bg-[#95BF47]/30 border border-[#95BF47]/60 rounded-md transition flex items-center space-x-1.5 shadow-2xs cursor-pointer"
          >
            <ShoppingBag className="w-3.5 h-3.5 text-[#43682B]" />
            <span>Shopify Live Sync</span>
          </button>
          <button
            onClick={() => loadOverviewData(false)}
            className="px-2.5 py-1 text-xs font-semibold text-[#5A2628] hover:bg-[#5A2628]/10 rounded-md border border-[#DDD9D4] transition flex items-center space-x-1.5 cursor-pointer"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Refresh Now</span>
          </button>
        </div>
      </div>

      {/* Top Summary Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
        <div 
          onClick={() => onNavigateToOrders('Awaiting Assignment')}
          className="bg-white p-4 rounded-lg border border-[#DDD9D4] cursor-pointer hover:border-[#5A2628] transition shadow-xs space-y-2"
        >
          <div className="flex justify-between items-center text-[#6D6964]">
            <span className="text-xs font-semibold">Unassigned Today</span>
            <Package className="w-4 h-4 text-[#A56716]" />
          </div>
          <div className="flex items-baseline justify-between">
            <span className="text-2xl font-black text-[#1F1F1D]">{unassigned.length}</span>
            <span className="text-[10px] text-[#A56716] font-bold">Needs Action</span>
          </div>
        </div>

        <div 
          onClick={() => onNavigateToOrders('Assigned')}
          className="bg-white p-4 rounded-lg border border-[#DDD9D4] cursor-pointer hover:border-[#5A2628] transition shadow-xs space-y-2"
        >
          <div className="flex justify-between items-center text-[#6D6964]">
            <span className="text-xs font-semibold">Ready for Handoff</span>
            <CheckCircle2 className="w-4 h-4 text-[#356A8A]" />
          </div>
          <div className="flex items-baseline justify-between">
            <span className="text-2xl font-black text-[#1F1F1D]">{readyHandoff.length}</span>
            <span className="text-[10px] text-[#356A8A] font-bold">In Depot</span>
          </div>
        </div>

        <div 
          onClick={() => onNavigateToOrders('Out for Delivery')}
          className="bg-white p-4 rounded-lg border border-[#DDD9D4] cursor-pointer hover:border-[#5A2628] transition shadow-xs space-y-2"
        >
          <div className="flex justify-between items-center text-[#6D6964]">
            <span className="text-xs font-semibold">Out for Delivery</span>
            <Truck className="w-4 h-4 text-[#1F7A52]" />
          </div>
          <div className="flex items-baseline justify-between">
            <span className="text-2xl font-black text-[#1F1F1D]">{outForDelivery.length}</span>
            <span className="text-[10px] text-[#1F7A52] font-bold">On Route</span>
          </div>
        </div>

        <div 
          onClick={() => onNavigateToOrders('Customer Unavailable')}
          className="bg-white p-4 rounded-lg border border-[#DDD9D4] cursor-pointer hover:border-[#5A2628] transition shadow-xs space-y-2"
        >
          <div className="flex justify-between items-center text-[#6D6964]">
            <span className="text-xs font-semibold">Delivery Exceptions</span>
            <AlertTriangle className="w-4 h-4 text-[#B43B3B]" />
          </div>
          <div className="flex items-baseline justify-between">
            <span className="text-2xl font-black text-[#1F1F1D]">{exceptions.length}</span>
            <span className="text-[10px] text-[#B43B3B] font-bold">Failed/Pending</span>
          </div>
        </div>

        <div className="bg-white p-4 rounded-lg border border-[#DDD9D4] shadow-xs space-y-2">
          <div className="flex justify-between items-center text-[#6D6964]">
            <span className="text-xs font-semibold">COD at Risk</span>
            <DollarSign className="w-4 h-4 text-[#A56716]" />
          </div>
          <div className="flex items-baseline justify-between">
            <span className="text-2xl font-black text-[#1F1F1D]">{codAtRisk.length}</span>
            <span className="text-[10px] text-[#A56716] font-bold">&gt; Rs 15k each</span>
          </div>
        </div>
      </div>

      {/* Main Decision Workspace Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

        {/* Column 1: Orders Requiring Assignment */}
        <div className="lg:col-span-2 bg-white rounded-lg border border-[#DDD9D4] p-4 flex flex-col space-y-4">
          <div className="flex items-center justify-between border-b border-[#DDD9D4] pb-3">
            <div>
              <h2 className="text-sm font-bold text-[#1F1F1D]">Orders Requiring Rider Assignment</h2>
              <p className="text-[11px] text-[#6D6964]">Unassigned packages needing dispatch routing</p>
            </div>
            <button
              onClick={() => onNavigateToOrders('Awaiting Assignment')}
              className="text-xs font-semibold text-[#5A2628] hover:underline flex items-center space-x-1"
            >
              <span>View All ({unassigned.length})</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>

          {unassigned.length === 0 ? (
            <div className="p-8 text-center text-xs text-[#6D6964] bg-[#F5F4F2] rounded-lg border border-[#DDD9D4]">
              ✓ All orders are currently assigned to active riders.
            </div>
          ) : (
            <div className="divide-y divide-[#DDD9D4] max-h-80 overflow-y-auto">
              {unassigned.slice(0, 6).map((ord) => (
                <div key={ord.id} className="py-3 flex items-center justify-between hover:bg-[#F5F4F2]/50 px-2 rounded-md transition">
                  <div className="space-y-0.5">
                    <div className="flex items-center space-x-2">
                      <button
                        onClick={() => onSelectOrder(ord.id)}
                        className="font-mono text-xs font-bold text-[#5A2628] hover:underline"
                      >
                        {ord.original_order_number}
                      </button>
                      <span className="text-[10px] px-1.5 py-0.2 bg-stone-100 text-[#1F1F1D] border border-[#DDD9D4] rounded">
                        {ord.city}
                      </span>
                    </div>
                    <p className="text-xs text-[#1F1F1D]">{ord.customer_name} • <span className="text-[#6D6964]">{ord.address}</span></p>
                  </div>

                  <div className="flex items-center space-x-3">
                    <div className="text-right">
                      <p className="font-mono text-xs font-bold text-[#1F1F1D]">Rs. {(ord.cod_expected || 0).toLocaleString()}</p>
                      <p className="text-[10px] text-[#6D6964]">{ord.payment_method}</p>
                    </div>
                    <button
                      onClick={() => handleQuickAssign(ord.id)}
                      className="px-2.5 py-1 text-[11px] font-semibold bg-[#5A2628] text-white hover:bg-[#471D1F] rounded-md transition shadow-xs flex items-center space-x-1"
                    >
                      <UserPlus className="w-3 h-3" />
                      <span>Assign</span>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Column 2: Rider Capacity & Availability */}
        <div className="bg-white rounded-lg border border-[#DDD9D4] p-4 flex flex-col space-y-4">
          <div className="border-b border-[#DDD9D4] pb-3 flex justify-between items-center">
            <div>
              <h2 className="text-sm font-bold text-[#1F1F1D]">Rider Capacity</h2>
              <p className="text-[11px] text-[#6D6964]">Active roster & package load</p>
            </div>
            <span className="text-[10px] font-bold px-2 py-0.5 bg-[#1F7A52]/10 text-[#1F7A52] rounded border border-[#1F7A52]/30">
              {riders.filter(r => r.active).length} Active
            </span>
          </div>

          <div className="space-y-3 max-h-80 overflow-y-auto">
            {riders.map((r) => {
              const assignedCount = r.assigned_count || orders.filter(o => o.assigned_rider_id === r.id && !['Delivered', 'Cancelled'].includes(o.current_status)).length;
              const cap = r.maximum_daily_capacity || 25;
              const isSelected = selectedRiderForAssign === r.id;
              const loadPercent = Math.min(100, Math.round((assignedCount / cap) * 100));

              return (
                <div
                  key={r.id}
                  onClick={() => setSelectedRiderForAssign(r.id)}
                  className={`p-3 rounded-lg border cursor-pointer transition ${
                    isSelected
                      ? 'border-[#5A2628] bg-[#5A2628]/5 ring-1 ring-[#5A2628]'
                      : 'border-[#DDD9D4] bg-[#F5F4F2] hover:bg-white'
                  }`}
                >
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="flex items-center space-x-2">
                      <Users className="w-3.5 h-3.5 text-[#5A2628]" />
                      <span className="text-xs font-bold text-[#1F1F1D]">{r.profile?.full_name || r.rider_code}</span>
                    </div>
                    <span className="text-[10px] font-mono text-[#6D6964]">{r.assigned_zone}</span>
                  </div>

                  {/* Load bar */}
                  <div className="space-y-1">
                    <div className="flex justify-between text-[10px] font-medium text-[#6D6964]">
                      <span>Load: {assignedCount} / {cap} pkgs</span>
                      <span>{loadPercent}%</span>
                    </div>
                    <div className="w-full h-1.5 bg-[#DDD9D4] rounded-full overflow-hidden">
                      <div 
                        className={`h-full transition-all ${loadPercent >= 90 ? 'bg-[#B43B3B]' : loadPercent >= 70 ? 'bg-[#A56716]' : 'bg-[#1F7A52]'}`} 
                        style={{ width: `${loadPercent}%` }}
                      />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

      </div>

      {/* Operational Exception Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Overdue Promised Deliveries */}
        <div className="bg-white rounded-lg border border-[#DDD9D4] p-4 space-y-3">
          <div className="flex justify-between items-center border-b border-[#DDD9D4] pb-2">
            <div className="flex items-center space-x-2">
              <Clock className="w-4 h-4 text-[#B43B3B]" />
              <h3 className="text-xs font-bold text-[#1F1F1D]">Overdue Promised Deliveries</h3>
            </div>
            <span className="text-[10px] font-bold px-2 py-0.5 bg-[#B43B3B]/10 text-[#B43B3B] rounded">
              {overdueDeliveries.length} Packages
            </span>
          </div>

          {overdueDeliveries.length === 0 ? (
            <div className="p-4 text-center text-xs text-[#6D6964]">No overdue delivery promises</div>
          ) : (
            <div className="divide-y divide-[#DDD9D4] text-xs max-h-48 overflow-y-auto">
              {overdueDeliveries.map((ord) => (
                <div key={ord.id} className="py-2 flex items-center justify-between">
                  <div>
                    <button onClick={() => onSelectOrder(ord.id)} className="font-mono font-bold text-[#5A2628]">
                      {ord.original_order_number}
                    </button>
                    <p className="text-[#6D6964] text-[11px]">{ord.customer_name} • {ord.city}</p>
                  </div>
                  <div className="text-right">
                    <span className="text-[10px] font-bold text-[#B43B3B] block">
                      Promised: {ord.promised_delivery_date}
                    </span>
                    <span className="text-[10px] text-[#6D6964]">{ord.current_status}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Returned Packages Not Received at Warehouse */}
        <div className="bg-white rounded-lg border border-[#DDD9D4] p-4 space-y-3">
          <div className="flex justify-between items-center border-b border-[#DDD9D4] pb-2">
            <div className="flex items-center space-x-2">
              <RotateCcw className="w-4 h-4 text-[#A56716]" />
              <h3 className="text-xs font-bold text-[#1F1F1D]">Returned Packages Pending Receipt</h3>
            </div>
            <span className="text-[10px] font-bold px-2 py-0.5 bg-[#A56716]/10 text-[#A56716] rounded">
              {pendingWarehouseReturns.length} In Transit
            </span>
          </div>

          {pendingWarehouseReturns.length === 0 ? (
            <div className="p-4 text-center text-xs text-[#6D6964]">All returned packages checked into warehouse</div>
          ) : (
            <div className="divide-y divide-[#DDD9D4] text-xs max-h-48 overflow-y-auto">
              {pendingWarehouseReturns.map((ord) => (
                <div key={ord.id} className="py-2 flex items-center justify-between">
                  <div>
                    <button onClick={() => onSelectOrder(ord.id)} className="font-mono font-bold text-[#5A2628]">
                      {ord.original_order_number}
                    </button>
                    <p className="text-[#6D6964] text-[11px]">{ord.customer_name} • Rider: {ord.rider?.rider_code || 'Assigned'}</p>
                  </div>
                  <span className="text-[10px] font-bold px-2 py-0.5 bg-[#A56716]/10 text-[#A56716] rounded">
                    Returning to Depot
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Shopify Sync Modal */}
      <ShopifySyncModal
        isOpen={showShopifyModal}
        onClose={() => setShowShopifyModal(false)}
        onSyncSuccess={() => {
          loadOverviewData(false);
        }}
      />
    </div>
  );
}
