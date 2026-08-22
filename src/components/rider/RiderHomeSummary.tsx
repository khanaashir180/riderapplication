import React from 'react';
import { 
  Package, 
  CheckCircle2, 
  XCircle, 
  Clock, 
  DollarSign, 
  Wallet, 
  RotateCcw, 
  AlertTriangle, 
  PhoneCall,
  ArrowRight
} from 'lucide-react';

interface RiderHomeSummaryProps {
  assignedCount: number;
  deliveredCount: number;
  failedCount: number;
  remainingCount: number;
  codToCollect: number;
  codCollected: number;
  cashInHand: number;
  returnsCount: number;
  reattemptsCount: number;
  uncontactedCount: number;
  onNavigateTab: (tab: 'route' | 'reattempts' | 'cash' | 'returns') => void;
}

export function RiderHomeSummary({
  assignedCount,
  deliveredCount,
  failedCount,
  remainingCount,
  codToCollect,
  codCollected,
  cashInHand,
  returnsCount,
  reattemptsCount,
  uncontactedCount,
  onNavigateTab
}: RiderHomeSummaryProps) {
  return (
    <div className="space-y-3">
      {/* TODAY 4-GRID STATS */}
      <div className="bg-white p-3.5 rounded-2xl border border-[#DDD9D4] shadow-xs space-y-2.5">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-extrabold uppercase text-[#6D6964] tracking-wider">
            Today's Stops
          </span>
          <span className="text-[11px] font-bold text-[#5A2628] font-mono">
            {deliveredCount}/{assignedCount} Done ({assignedCount > 0 ? Math.round((deliveredCount / assignedCount) * 100) : 0}%)
          </span>
        </div>

        <div className="grid grid-cols-4 gap-2 text-center">
          <div className="bg-[#F5F4F2] p-2 rounded-xl border border-[#DDD9D4]">
            <span className="text-[10px] font-bold text-[#6D6964] block">Assigned</span>
            <span className="text-base font-black text-[#1F1F1D] font-mono">{assignedCount}</span>
          </div>

          <div className="bg-emerald-50 p-2 rounded-xl border border-emerald-200">
            <span className="text-[10px] font-bold text-emerald-800 block">Delivered</span>
            <span className="text-base font-black text-emerald-700 font-mono">{deliveredCount}</span>
          </div>

          <div className="bg-rose-50 p-2 rounded-xl border border-rose-200">
            <span className="text-[10px] font-bold text-rose-800 block">Failed</span>
            <span className="text-base font-black text-rose-700 font-mono">{failedCount}</span>
          </div>

          <div className="bg-amber-50 p-2 rounded-xl border border-amber-200">
            <span className="text-[10px] font-bold text-amber-800 block">Remaining</span>
            <span className="text-base font-black text-amber-700 font-mono">{remainingCount}</span>
          </div>
        </div>

        {/* Progress Bar */}
        <div className="w-full h-2 bg-[#F5F4F2] rounded-full overflow-hidden border border-[#DDD9D4]">
          <div
            className="h-full bg-[#1F7A52] transition-all duration-300 rounded-full"
            style={{ width: assignedCount > 0 ? `${(deliveredCount / assignedCount) * 100}%` : '0%' }}
          />
        </div>
      </div>

      {/* FINANCIAL & RETURN TILES */}
      <div className="grid grid-cols-2 gap-2">
        {/* COD to Collect */}
        <div className="bg-white p-3 rounded-2xl border border-[#DDD9D4] shadow-xs space-y-1">
          <span className="text-[10px] font-bold uppercase text-[#6D6964] block">COD to Collect</span>
          <span className="text-base font-black text-[#5A2628] font-mono block">
            Rs. {codToCollect.toLocaleString()}
          </span>
          <span className="text-[10px] text-[#6D6964] block">On active deliveries</span>
        </div>

        {/* COD Collected */}
        <div className="bg-white p-3 rounded-2xl border border-[#DDD9D4] shadow-xs space-y-1">
          <span className="text-[10px] font-bold uppercase text-[#6D6964] block">COD Collected</span>
          <span className="text-base font-black text-[#1F7A52] font-mono block">
            Rs. {codCollected.toLocaleString()}
          </span>
          <span className="text-[10px] text-emerald-700 block">From {deliveredCount} deliveries</span>
        </div>

        {/* Cash in Hand */}
        <div 
          onClick={() => onNavigateTab('cash')}
          className="bg-stone-900 text-white p-3 rounded-2xl shadow-xs space-y-1 cursor-pointer active:scale-98 transition"
        >
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold uppercase text-stone-300">Cash in Hand</span>
            <Wallet className="w-3.5 h-3.5 text-amber-400" />
          </div>
          <span className="text-base font-black text-amber-400 font-mono block">
            Rs. {cashInHand.toLocaleString()}
          </span>
          <span className="text-[10px] text-stone-300 flex items-center justify-between">
            <span>View cash ledger</span>
            <ArrowRight className="w-3 h-3" />
          </span>
        </div>

        {/* Returns to Hub */}
        <div 
          onClick={() => onNavigateTab('returns')}
          className={`p-3 rounded-2xl border shadow-xs space-y-1 cursor-pointer active:scale-98 transition ${
            returnsCount > 0 
              ? 'bg-rose-50 border-rose-300 text-rose-900' 
              : 'bg-white border-[#DDD9D4] text-[#1F1F1D]'
          }`}
        >
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold uppercase text-[#6D6964]">Returns to Hub</span>
            <RotateCcw className={`w-3.5 h-3.5 ${returnsCount > 0 ? 'text-rose-600' : 'text-[#6D6964]'}`} />
          </div>
          <span className={`text-base font-black font-mono block ${returnsCount > 0 ? 'text-rose-700' : 'text-[#1F1F1D]'}`}>
            {returnsCount} Packages
          </span>
          <span className="text-[10px] text-[#6D6964] flex items-center justify-between">
            <span>{returnsCount > 0 ? 'Handback needed' : 'Clear'}</span>
            <ArrowRight className="w-3 h-3" />
          </span>
        </div>
      </div>

      {/* OPERATIONAL ALERTS */}
      <div className="space-y-2">
        {/* Reattempts Due Alert */}
        {reattemptsCount > 0 && (
          <button
            onClick={() => onNavigateTab('reattempts')}
            className="w-full bg-amber-50 border-2 border-amber-400/80 p-3 rounded-xl flex items-center justify-between text-left active:scale-98 transition"
          >
            <div className="flex items-center space-x-2.5">
              <div className="w-8 h-8 rounded-lg bg-amber-100 flex items-center justify-center shrink-0">
                <Clock className="w-4 h-4 text-amber-800" />
              </div>
              <div>
                <span className="text-xs font-black text-amber-900 block">
                  {reattemptsCount} Reattempt{reattemptsCount > 1 ? 's' : ''} Due Today
                </span>
                <span className="text-[11px] text-amber-700">
                  Prioritized customer delivery appointments
                </span>
              </div>
            </div>
            <ArrowRight className="w-4 h-4 text-amber-800 shrink-0" />
          </button>
        )}

        {/* Customer Not Contacted Alert */}
        {uncontactedCount > 0 && remainingCount > 0 && (
          <div className="bg-blue-50 border border-blue-200 p-3 rounded-xl flex items-center justify-between text-left">
            <div className="flex items-center space-x-2.5">
              <div className="w-8 h-8 rounded-lg bg-blue-100 flex items-center justify-center shrink-0">
                <PhoneCall className="w-4 h-4 text-blue-800" />
              </div>
              <div>
                <span className="text-xs font-black text-blue-900 block">
                  {uncontactedCount} Stops Not Yet Contacted
                </span>
                <span className="text-[11px] text-blue-700">
                  Call or WhatsApp customers ahead of arrival
                </span>
              </div>
            </div>
          </div>
        )}

        {/* Return Required Persistent Alert */}
        {returnsCount > 0 && (
          <button
            onClick={() => onNavigateTab('returns')}
            className="w-full bg-rose-600 text-white p-3 rounded-xl flex items-center justify-between text-left shadow-sm active:scale-98 transition"
          >
            <div className="flex items-center space-x-2.5">
              <div className="w-8 h-8 rounded-lg bg-white/20 flex items-center justify-center shrink-0">
                <AlertTriangle className="w-4 h-4 text-white" />
              </div>
              <div>
                <span className="text-xs font-black text-white block">
                  RETURN TO HUB — {returnsCount} PACKAGE{returnsCount > 1 ? 'S' : ''}
                </span>
                <span className="text-[11px] text-rose-100">
                  Hand back undelivered / refused packages at depot
                </span>
              </div>
            </div>
            <span className="text-xs font-extrabold bg-white text-rose-700 px-2 py-1 rounded-lg">
              View
            </span>
          </button>
        )}
      </div>
    </div>
  );
}
