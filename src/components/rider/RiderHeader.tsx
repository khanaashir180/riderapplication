import React from 'react';
import { Profile, Rider } from '../../types';
import { Truck, CheckCircle2, AlertCircle } from 'lucide-react';

interface RiderHeaderProps {
  userProfile: Profile;
  riderInfo: Rider | null;
  activeRun: any | null;
  activeCount: number;
  onAcceptShift?: () => void;
  isAcceptingShift?: boolean;
}

export function RiderHeader({
  userProfile,
  riderInfo,
  activeRun,
  activeCount,
  onAcceptShift,
  isAcceptingShift
}: RiderHeaderProps) {
  const isRunAccepted = activeRun?.status === 'accepted_by_rider' || activeRun?.status === 'in_progress';
  const hasPendingRun = activeRun && !isRunAccepted;

  return (
    <header className="bg-[#5A2628] text-white p-4 sticky top-0 z-30 shadow-sm">
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-2.5">
          <div className="w-9 h-9 rounded-xl bg-white/10 flex items-center justify-center font-bold text-sm text-white">
            {userProfile.full_name ? userProfile.full_name.substring(0, 2).toUpperCase() : 'RD'}
          </div>
          <div>
            <h1 className="text-sm font-bold tracking-tight text-white leading-tight">
              {userProfile.full_name || 'Rider Terminal'}
            </h1>
            <p className="text-[11px] text-stone-200 flex items-center space-x-1.5 font-mono">
              <span>{riderInfo?.rider_code || 'RD-01'}</span>
              <span>•</span>
              <span className="text-stone-300 capitalize">{riderInfo?.assigned_zone || 'Hub Zone'}</span>
            </p>
          </div>
        </div>

        <div className="text-right flex flex-col items-end">
          <div className="flex items-center space-x-1.5">
            <span
              className={`inline-flex items-center space-x-1 text-[10px] font-bold px-2 py-0.5 rounded-full ${
                isRunAccepted
                  ? 'bg-emerald-500/20 text-emerald-200 border border-emerald-500/40'
                  : hasPendingRun
                  ? 'bg-amber-500/20 text-amber-200 border border-amber-500/40'
                  : 'bg-white/10 text-stone-200'
              }`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${isRunAccepted ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'}`} />
              <span>{isRunAccepted ? 'Shift Active' : hasPendingRun ? 'Run Ready' : 'On Duty'}</span>
            </span>
          </div>
          <span className="text-[10px] text-stone-300 font-mono mt-0.5">
            {activeCount} Remaining Stops
          </span>
        </div>
      </div>

      {/* Start Shift / Accept Manifest Banner if run awaiting acceptance */}
      {hasPendingRun && onAcceptShift && (
        <div className="mt-3 bg-white/10 border border-white/20 rounded-xl p-3 flex items-center justify-between">
          <div className="space-y-0.5">
            <span className="text-[10px] uppercase font-extrabold text-amber-300 tracking-wider flex items-center space-x-1">
              <AlertCircle className="w-3.5 h-3.5" />
              <span>Dispatch Run Assigned</span>
            </span>
            <p className="text-xs font-bold text-white">
              {(activeRun.expectedPackages || []).length} Packages Ready for Delivery
            </p>
          </div>
          <button
            onClick={onAcceptShift}
            disabled={isAcceptingShift}
            className="h-10 px-4 bg-white text-[#5A2628] hover:bg-stone-100 font-bold text-xs rounded-lg shadow-sm transition active:scale-95 disabled:opacity-60 shrink-0 flex items-center space-x-1.5"
          >
            <CheckCircle2 className="w-4 h-4 text-emerald-700" />
            <span>{isAcceptingShift ? 'Accepting...' : 'Start Shift'}</span>
          </button>
        </div>
      )}
    </header>
  );
}
