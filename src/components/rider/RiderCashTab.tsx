import React, { useState, useEffect } from 'react';
import { 
  DollarSign, 
  Wallet, 
  ArrowUpRight, 
  CheckCircle2, 
  Clock, 
  AlertTriangle, 
  FileText,
  Send,
  Loader2
} from 'lucide-react';
import { Order, Package } from '../../types';
import { api } from '../../services/api';

interface RiderCashTabProps {
  orders: (Order | Package)[];
  riderId?: string;
  onRefreshData?: () => void;
}

export function RiderCashTab({ orders, riderId, onRefreshData }: RiderCashTabProps) {
  const [settlements, setSettlements] = useState<any[]>([]);
  const [loadingSettlements, setLoadingSettlements] = useState(false);
  const [isSubmittingCash, setIsSubmittingCash] = useState(false);
  const [showHandoverModal, setShowHandoverModal] = useState(false);
  const [handoverAmount, setHandoverAmount] = useState<number>(0);
  const [handoverNotes, setHandoverNotes] = useState('');
  const [settlementSuccessMsg, setSettlementSuccessMsg] = useState<string | null>(null);
  const [settlementErrMsg, setSettlementErrMsg] = useState<string | null>(null);

  // Delivered packages
  const deliveredOrders = orders.filter((o: any) => {
    const st = (o.operationalStatus || o.current_status || '').toLowerCase();
    return st === 'delivered';
  });

  const deliveredCodOrders = deliveredOrders.filter((o: any) => {
    const isPrepaid = (o.payment_method || o.paymentMethod || '').toLowerCase() === 'prepaid' || (o.cod_expected === 0 && o.codExpected === 0);
    return !isPrepaid;
  });

  const deliveredPrepaidOrders = deliveredOrders.filter((o: any) => {
    const isPrepaid = (o.payment_method || o.paymentMethod || '').toLowerCase() === 'prepaid' || (o.cod_expected === 0 && o.codExpected === 0);
    return isPrepaid;
  });

  // Calculate Cash Collected (from cash COD deliveries)
  const cashCollected = deliveredCodOrders.reduce((sum: number, o: any) => {
    const amt = o.collectedAmount !== undefined ? o.collectedAmount : (o.cod_collection?.collected_amount || o.cod_expected || o.codExpected || 0);
    return sum + Number(amt);
  }, 0);

  // Load settlements from server
  useEffect(() => {
    loadSettlements();
  }, []);

  const loadSettlements = async () => {
    setLoadingSettlements(true);
    try {
      const res: any = await api.getMySettlements();
      if (res) {
        const list = Array.isArray(res) ? res : (res.data || res.settlements || []);
        setSettlements(Array.isArray(list) ? list : []);
      }
    } catch (e) {
      console.warn('Failed to load settlements:', e);
    } finally {
      setLoadingSettlements(false);
    }
  };

  // Cash Already Submitted to Cashier (sum of declared or received amounts in submitted/received/closed settlements)
  const cashAlreadySubmitted = settlements.reduce((sum: number, s: any) => {
    if (s.status !== 'rejected') {
      const val = s.physicallyReceivedAmount > 0 ? s.physicallyReceivedAmount : (s.declaredCashAmount || 0);
      return sum + Number(val);
    }
    return sum;
  }, 0);

  // Cash Currently With You
  const cashCurrentlyWithYou = Math.max(0, cashCollected - cashAlreadySubmitted);

  const handleOpenHandover = () => {
    setHandoverAmount(cashCurrentlyWithYou);
    setHandoverNotes('');
    setSettlementSuccessMsg(null);
    setSettlementErrMsg(null);
    setShowHandoverModal(true);
  };

  const handleSubmitHandover = async () => {
    if (handoverAmount <= 0) {
      setSettlementErrMsg('Handover amount must be greater than Rs 0.');
      return;
    }

    setIsSubmittingCash(true);
    setSettlementErrMsg(null);
    const idempotencyKey = `SETTLE:${riderId || 'rider'}:${Date.now()}`;

    try {
      const res = await api.submitRiderSettlement({
        declaredCashAmount: Number(handoverAmount),
        notes: handoverNotes.trim() || undefined,
        idempotencyKey
      });

      if (res && res.success !== false) {
        setSettlementSuccessMsg(`Cash settlement of Rs. ${Number(handoverAmount).toLocaleString()} submitted to cashier.`);
        setShowHandoverModal(false);
        await loadSettlements();
        if (onRefreshData) onRefreshData();
      } else {
        setSettlementErrMsg(res?.error?.message || 'Failed to submit cash settlement.');
      }
    } catch (e: any) {
      console.error('Settlement error:', e);
      setSettlementErrMsg(e.message || 'Error communicating with server.');
    } finally {
      setIsSubmittingCash(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* CURRENT SHIFT SUMMARY CARD */}
      <div className="bg-[#5A2628] text-white p-4 rounded-3xl shadow-md space-y-3.5">
        <div className="flex items-center justify-between border-b border-white/20 pb-3">
          <div>
            <span className="text-[10px] uppercase font-extrabold text-stone-300 tracking-wider">
              Current Shift Cash Status
            </span>
            <h3 className="text-sm font-black text-white">Cash In Hand</h3>
          </div>
          <Wallet className="w-6 h-6 text-amber-400" />
        </div>

        {/* Primary Big Figure */}
        <div className="text-center py-2 space-y-0.5">
          <span className="text-3xl font-black font-mono text-amber-400 block">
            Rs. {cashCurrentlyWithYou.toLocaleString()}
          </span>
          <span className="text-[11px] text-stone-200">
            Physical cash currently held by rider
          </span>
        </div>

        {/* 4 Financial Breakdown Metrics */}
        <div className="grid grid-cols-2 gap-2 text-xs pt-1">
          <div className="bg-white/10 p-2.5 rounded-xl border border-white/10 space-y-0.5">
            <span className="text-[10px] text-stone-300 block">COD Delivered</span>
            <span className="font-bold text-white font-mono">{deliveredCodOrders.length} Packages</span>
          </div>

          <div className="bg-white/10 p-2.5 rounded-xl border border-white/10 space-y-0.5">
            <span className="text-[10px] text-stone-300 block">Prepaid Delivered</span>
            <span className="font-bold text-white font-mono">{deliveredPrepaidOrders.length} Packages</span>
          </div>

          <div className="bg-white/10 p-2.5 rounded-xl border border-white/10 space-y-0.5">
            <span className="text-[10px] text-stone-300 block">Total Cash Collected</span>
            <span className="font-bold text-emerald-300 font-mono">Rs. {cashCollected.toLocaleString()}</span>
          </div>

          <div className="bg-white/10 p-2.5 rounded-xl border border-white/10 space-y-0.5">
            <span className="text-[10px] text-stone-300 block">Already Submitted</span>
            <span className="font-bold text-amber-300 font-mono">Rs. {cashAlreadySubmitted.toLocaleString()}</span>
          </div>
        </div>

        {/* Handover Cash to Cashier Button */}
        <button
          onClick={handleOpenHandover}
          disabled={cashCurrentlyWithYou <= 0}
          className="w-full h-12 bg-amber-500 hover:bg-amber-400 text-stone-950 font-black text-xs rounded-xl shadow flex items-center justify-center space-x-1.5 transition active:scale-98 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <ArrowUpRight className="w-4 h-4" />
          <span>HAND OVER CASH TO CASHIER</span>
        </button>
      </div>

      {settlementSuccessMsg && (
        <div className="p-3 bg-emerald-50 border border-emerald-300 rounded-xl text-xs text-emerald-900 flex items-center space-x-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" />
          <span>{settlementSuccessMsg}</span>
        </div>
      )}

      {/* INDIVIDUAL COD DELIVERIES BREAKDOWN */}
      <div className="bg-white rounded-2xl border border-[#DDD9D4] p-4 shadow-xs space-y-3">
        <div className="flex items-center justify-between">
          <h4 className="text-xs font-black uppercase text-[#6D6964] tracking-wider">
            Shift Deliveries ({deliveredOrders.length})
          </h4>
          <span className="text-xs font-bold font-mono text-[#5A2628]">
            Rs. {cashCollected.toLocaleString()}
          </span>
        </div>

        {deliveredOrders.length === 0 ? (
          <div className="p-6 text-center text-xs text-[#6D6964] space-y-1">
            <Clock className="w-6 h-6 text-stone-400 mx-auto" />
            <p className="font-semibold text-stone-700">No completed deliveries yet today</p>
            <p>Completed orders will automatically post here with exact collected amounts.</p>
          </div>
        ) : (
          <div className="divide-y divide-[#DDD9D4] max-h-72 overflow-y-auto">
            {deliveredOrders.map((ord: any, idx: number) => {
              const pkgId = ord.original_order_number || ord.packageNumber || ord.package_number || ord.id;
              const customerName = ord.customer_name || ord.customerName || 'Customer';
              const isPrepaid = (ord.payment_method || ord.paymentMethod || '').toLowerCase() === 'prepaid' || (ord.cod_expected === 0 && ord.codExpected === 0);
              const collected = ord.collectedAmount !== undefined ? ord.collectedAmount : (ord.cod_collection?.collected_amount || ord.cod_expected || ord.codExpected || 0);

              return (
                <div key={ord.id || idx} className="py-2.5 flex items-center justify-between text-xs">
                  <div className="space-y-0.5">
                    <div className="flex items-center space-x-1.5">
                      <span className="font-mono font-bold text-[#5A2628]">{pkgId}</span>
                      <span className={`text-[10px] px-1.5 py-0.2 rounded font-bold ${isPrepaid ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-900'}`}>
                        {isPrepaid ? 'Prepaid' : 'COD'}
                      </span>
                    </div>
                    <p className="text-[#1F1F1D] font-medium">{customerName}</p>
                  </div>

                  <div className="text-right font-mono">
                    <span className={`font-black text-sm block ${isPrepaid ? 'text-emerald-700' : 'text-[#1F7A52]'}`}>
                      {isPrepaid ? 'Rs 0' : `+ Rs. ${Number(collected).toLocaleString()}`}
                    </span>
                    <span className="text-[10px] text-[#6D6964]">
                      {ord.deliveredAt ? new Date(ord.deliveredAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Delivered'}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* SETTLEMENT SUBMISSIONS HISTORY */}
      <div className="bg-white rounded-2xl border border-[#DDD9D4] p-4 shadow-xs space-y-3">
        <h4 className="text-xs font-black uppercase text-[#6D6964] tracking-wider">
          Settlement Handover History
        </h4>

        {settlements.length === 0 ? (
          <div className="p-4 text-center text-xs text-[#6D6964]">
            No cash handover settlements submitted yet for this shift.
          </div>
        ) : (
          <div className="space-y-2">
            {settlements.map((s: any, idx: number) => {
              const status = s.status || 'rider_submitted';
              return (
                <div key={s.id || idx} className="p-3 bg-[#F5F4F2] rounded-xl border border-[#DDD9D4] flex items-center justify-between text-xs">
                  <div className="space-y-0.5">
                    <span className="font-mono font-bold text-[#5A2628]">{s.settlementNumber || s.id}</span>
                    <p className="text-[11px] text-[#6D6964]">
                      Declared: <strong className="font-mono text-[#1F1F1D]">Rs. {Number(s.declaredCashAmount || 0).toLocaleString()}</strong>
                    </p>
                  </div>

                  <div className="text-right space-y-0.5">
                    <span className={`text-[10px] font-extrabold px-2 py-0.5 rounded-full ${
                      status === 'closed' || status === 'cashier_received'
                        ? 'bg-emerald-100 text-emerald-800'
                        : status === 'discrepancy'
                        ? 'bg-rose-100 text-rose-800'
                        : 'bg-amber-100 text-amber-900'
                    }`}>
                      {status.replace(/_/g, ' ').toUpperCase()}
                    </span>
                    <p className="text-[10px] text-[#6D6964] font-mono">
                      {s.submittedAt ? new Date(s.submittedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* HANDOVER SUBMISSION MODAL */}
      {showHandoverModal && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-end sm:items-center justify-center p-0 sm:p-4 backdrop-blur-xs">
          <div className="bg-white rounded-t-3xl sm:rounded-2xl border border-[#DDD9D4] w-full max-w-md p-5 space-y-4 shadow-2xl animate-in slide-in-from-bottom duration-200">
            <div className="flex items-center justify-between border-b border-[#DDD9D4] pb-3">
              <h3 className="text-base font-black text-[#1F1F1D]">Submit Cash to Cashier</h3>
              <button onClick={() => setShowHandoverModal(false)} className="text-[#6D6964] font-bold p-1">
                ✕
              </button>
            </div>

            {settlementErrMsg && (
              <div className="p-3 bg-rose-50 border border-rose-300 rounded-xl text-xs text-rose-900">
                {settlementErrMsg}
              </div>
            )}

            <div className="space-y-1">
              <label className="text-xs font-bold text-[#1F1F1D]">Declared Handover Amount (PKR) *</label>
              <input
                type="number"
                value={handoverAmount}
                onChange={(e) => setHandoverAmount(Number(e.target.value))}
                className="w-full h-12 px-3 border border-[#DDD9D4] rounded-xl font-mono text-xl font-black bg-white"
              />
              <p className="text-[11px] text-[#6D6964]">
                Calculated physical cash obligation: <strong className="font-mono">Rs. {cashCurrentlyWithYou.toLocaleString()}</strong>
              </p>
            </div>

            <div className="space-y-1">
              <label className="text-xs font-bold text-[#1F1F1D]">Notes / Remarks (Optional)</label>
              <textarea
                value={handoverNotes}
                onChange={(e) => setHandoverNotes(e.target.value)}
                placeholder="e.g. Mid-day cash drop at hub..."
                rows={2}
                className="w-full p-2.5 border border-[#DDD9D4] rounded-xl text-xs bg-[#F5F4F2]"
              />
            </div>

            <button
              onClick={handleSubmitHandover}
              disabled={isSubmittingCash}
              className="w-full h-12 bg-[#5A2628] hover:bg-[#471D1F] text-white font-bold text-sm rounded-xl shadow flex items-center justify-center space-x-2 transition active:scale-98 disabled:opacity-50"
            >
              {isSubmittingCash ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  <span>Submitting to Cashier...</span>
                </>
              ) : (
                <>
                  <Send className="w-4 h-4" />
                  <span>Confirm Handover Submission</span>
                </>
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
