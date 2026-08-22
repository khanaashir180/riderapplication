import React, { useState } from 'react';
import { 
  RotateCcw, 
  AlertTriangle, 
  CheckCircle2, 
  MapPin, 
  Barcode, 
  Send, 
  Loader2,
  Clock
} from 'lucide-react';
import { Order, Package, formatOperationalStatus } from '../../types';
import { api } from '../../services/api';
import { OfflineActor, queueHandbackPreparation } from '../../services/offline_store';

interface RiderReturnsTabProps {
  orders: (Order | Package)[];
  offlineActor?: OfflineActor | null;
  onRefreshData?: () => void;
  onNavigateToCash?: () => void;
}

export function RiderReturnsTab({ orders, offlineActor, onRefreshData, onNavigateToCash }: RiderReturnsTabProps) {
  // Returns to Hub: packages in failed/exception states or explicit return status
  const returnPackages = orders.filter((o: any) => {
    const st = (o.operationalStatus || o.current_status || '').toLowerCase().replace(/[\s-]+/g, '_');
    return [
      'return_required',
      'returning_to_warehouse',
      'refused',
      'customer_refused',
      'cancelled',
      'customer_cancelled',
      'incorrect_address',
      'address_issue',
      'customer_unavailable'
    ].includes(st);
  });

  const handedBackCount = returnPackages.filter((p: any) => {
    const st = (p.operationalStatus || p.current_status || '').toLowerCase();
    const custody = (p.custodyStage || '').toLowerCase();
    return st.includes('handback') || custody === 'return_handed_back' || st === 'returning_to_warehouse' || st === 'warehouse_received';
  }).length;

  const [selectedPkgForHandback, setSelectedPkgForHandback] = useState<any | null>(null);
  const [scannedBarcode, setScannedBarcode] = useState('');
  const [handoffEmployee, setHandoffEmployee] = useState('');
  const [handbackNotes, setHandbackNotes] = useState('');
  const [isSubmittingHandback, setIsSubmittingHandback] = useState(false);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const handleOpenHandbackModal = (pkg: any) => {
    setSelectedPkgForHandback(pkg);
    const realNum = pkg.packageNumber || pkg.package_number || pkg.original_order_number || pkg.id;
    setScannedBarcode(realNum); // pre-populate with package barcode for swift scanning/verification
    setHandoffEmployee('');
    setHandbackNotes('');
    setSuccessMsg(null);
    setErrMsg(null);
  };

  const handleSubmitHandback = async () => {
    if (!selectedPkgForHandback) return;
    if (!scannedBarcode.trim()) {
      setErrMsg('Scanned package number is required for depot handback.');
      return;
    }

    setIsSubmittingHandback(true);
    setErrMsg(null);
    const idempotencyKey = `HANDBACK:${selectedPkgForHandback.id}:${Date.now()}`;

    try {
      const res = await api.submitRiderHandback({
        packageId: selectedPkgForHandback.id,
        scannedPackageNumber: scannedBarcode.trim(),
        returnReason: selectedPkgForHandback.failure_reason || selectedPkgForHandback.failureReason || 'Failed Delivery Return',
        riderNotes: handbackNotes.trim() || undefined,
        handoffEmployee: handoffEmployee.trim() || undefined,
        idempotencyKey
      });

      if (res && res.success !== false) {
        setSuccessMsg(`Package ${scannedBarcode} successfully handed back to hub warehouse.`);
        setSelectedPkgForHandback(null);
        if (onRefreshData) onRefreshData();
      } else {
        setErrMsg(res?.error?.message || 'Failed to submit return handback.');
      }
    } catch (e: any) {
      if (offlineActor) {
        await queueHandbackPreparation({
          actor: offlineActor,
          packageId: selectedPkgForHandback.id,
          scannedPackageNumber: scannedBarcode.trim(),
          returnReason: selectedPkgForHandback.failure_reason || selectedPkgForHandback.failureReason || 'Failed Delivery Return',
          riderNotes: handbackNotes.trim() || undefined,
          handoffEmployee: handoffEmployee.trim() || undefined,
          observedServerRevision: selectedPkgForHandback.updatedAt || selectedPkgForHandback.updated_at || null,
          idempotencyKey
        });
        setSuccessMsg(`Package ${scannedBarcode} saved locally. WAITING TO SYNC until the server confirms the handback.`);
        setSelectedPkgForHandback(null);
        if (onRefreshData) onRefreshData();
      } else {
        console.error('Handback error:', e);
        setErrMsg(e.message || 'Error connecting to server.');
      }
    } finally {
      setIsSubmittingHandback(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Top Alert Banner */}
      <div className="bg-rose-600 text-white p-4 rounded-3xl shadow-md space-y-3">
        <div className="flex items-center space-x-2.5">
          <div className="w-9 h-9 rounded-xl bg-white/20 flex items-center justify-center shrink-0">
            <AlertTriangle className="w-5 h-5 text-white" />
          </div>
          <div>
            <h3 className="text-sm font-black uppercase tracking-tight text-white">
              RETURN TO HUB — {returnPackages.length} PACKAGE{returnPackages.length === 1 ? '' : 'S'}
            </h3>
            <p className="text-xs text-rose-100">
              Must be handed back to warehouse staff upon completing delivery route.
            </p>
          </div>
        </div>

        {/* Scan Progress Bar */}
        {returnPackages.length > 0 && (
          <div className="bg-white/10 p-3 rounded-2xl space-y-1.5 border border-white/10">
            <div className="flex items-center justify-between text-xs font-black">
              <span>Depot Handback Progress</span>
              <span className="font-mono text-amber-300 text-sm">
                {handedBackCount} / {returnPackages.length} scanned
              </span>
            </div>
            <div className="w-full bg-black/20 h-2 rounded-full overflow-hidden">
              <div 
                className="bg-amber-400 h-full transition-all duration-300"
                style={{ width: `${(handedBackCount / returnPackages.length) * 100}%` }}
              />
            </div>
          </div>
        )}
      </div>

      {successMsg && (
        <div className="p-3 bg-emerald-50 border border-emerald-300 rounded-xl text-xs text-emerald-900 flex items-center space-x-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" />
          <span>{successMsg}</span>
        </div>
      )}

      {/* List of Return Packages */}
      {returnPackages.length === 0 ? (
        <div className="bg-white p-8 text-center rounded-2xl border border-[#DDD9D4] space-y-2">
          <CheckCircle2 className="w-8 h-8 text-emerald-600 mx-auto" />
          <p className="font-bold text-sm text-[#1F1F1D]">No Packages Require Return</p>
          <p className="text-xs text-[#6D6964]">
            All assigned packages are either delivered or actively out on route.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {returnPackages.map((pkg: any, idx: number) => {
            const pkgId = pkg.original_order_number || pkg.packageNumber || pkg.package_number || pkg.id;
            const customerName = pkg.customer_name || pkg.customerName || 'Customer';
            const address = pkg.address || pkg.deliveryAddress || pkg.delivery_address || 'Address';
            const city = pkg.city || 'Lahore';
            const returnReason = pkg.failure_reason || pkg.failureReason || pkg.returnReason || formatOperationalStatus(pkg.operationalStatus || pkg.current_status);
            const isHandedBack = (pkg.operationalStatus || pkg.current_status || '').toLowerCase().includes('handback') || pkg.custodyStage === 'return_handed_back';

            return (
              <div key={pkg.id || idx} className="bg-white rounded-2xl border border-rose-200 p-4 shadow-xs space-y-3">
                {/* Header */}
                <div className="flex items-center justify-between">
                  <span className="font-mono text-xs font-black text-[#5A2628]">{pkgId}</span>
                  <span className="text-[10px] font-extrabold px-2 py-0.5 rounded-full bg-rose-100 text-rose-900">
                    {formatOperationalStatus(pkg.operationalStatus || pkg.current_status)}
                  </span>
                </div>

                {/* Customer */}
                <div className="space-y-0.5">
                  <h4 className="text-sm font-black text-[#1F1F1D]">{customerName}</h4>
                  <p className="text-xs text-[#6D6964]">{address}, {city}</p>
                </div>

                {/* Return Reason Box */}
                <div className="bg-rose-50 p-2.5 rounded-xl border border-rose-200 text-xs text-rose-950 space-y-0.5">
                  <span className="text-[10px] font-extrabold uppercase text-rose-700 block">Return Reason</span>
                  <p className="font-semibold">{returnReason}</p>
                </div>

                {/* Handback Action */}
                {isHandedBack ? (
                  <div className="p-2.5 bg-emerald-50 text-emerald-800 text-xs font-bold rounded-xl border border-emerald-200 flex items-center space-x-2">
                    <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                    <span>Handed back to Hub Warehouse</span>
                  </div>
                ) : (
                  <button
                    onClick={() => handleOpenHandbackModal(pkg)}
                    className="w-full h-11 bg-stone-900 hover:bg-black text-white font-bold text-xs rounded-xl shadow-xs flex items-center justify-center space-x-2 transition active:scale-98"
                  >
                    <RotateCcw className="w-4 h-4 text-amber-400" />
                    <span>SCAN RETURN PACKAGE</span>
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Navigation to Cash review */}
      {onNavigateToCash && (
        <button
          onClick={onNavigateToCash}
          className="w-full h-13 bg-[#5A2628] hover:bg-[#471D1F] text-white font-black text-xs rounded-2xl shadow-md flex items-center justify-center space-x-2 transition active:scale-98"
        >
          <span>CONTINUE TO CASH REVIEW</span>
        </button>
      )}

      {/* HANDBACK MODAL */}
      {selectedPkgForHandback && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-end sm:items-center justify-center p-0 sm:p-4 backdrop-blur-xs">
          <div className="bg-white rounded-t-3xl sm:rounded-2xl border border-[#DDD9D4] w-full max-w-md p-5 space-y-4 shadow-2xl animate-in slide-in-from-bottom duration-200">
            <div className="flex items-center justify-between border-b border-[#DDD9D4] pb-3">
              <div>
                <span className="font-mono text-xs font-bold text-[#5A2628]">
                  {selectedPkgForHandback.original_order_number || selectedPkgForHandback.packageNumber}
                </span>
                <h3 className="text-base font-black text-[#1F1F1D]">Depot Return Handback</h3>
              </div>
              <button onClick={() => setSelectedPkgForHandback(null)} className="text-[#6D6964] font-bold p-1">
                ✕
              </button>
            </div>

            {errMsg && (
              <div className="p-3 bg-rose-50 border border-rose-300 rounded-xl text-xs text-rose-900">
                {errMsg}
              </div>
            )}

            <div className="space-y-1">
              <label className="text-xs font-bold text-[#1F1F1D] flex items-center space-x-1">
                <Barcode className="w-4 h-4 text-[#5A2628]" />
                <span>Verify Package Barcode / Number *</span>
              </label>
              <input
                type="text"
                value={scannedBarcode}
                onChange={(e) => setScannedBarcode(e.target.value)}
                placeholder="Scan or confirm package number"
                className="w-full h-11 px-3 border border-[#DDD9D4] rounded-xl font-mono text-sm font-bold bg-white"
              />
            </div>

            <div className="space-y-1">
              <label className="text-xs font-bold text-[#1F1F1D]">Receiving Warehouse Employee Name</label>
              <input
                type="text"
                value={handoffEmployee}
                onChange={(e) => setHandoffEmployee(e.target.value)}
                placeholder="Name of depot receiver"
                className="w-full h-11 px-3 border border-[#DDD9D4] rounded-xl text-xs bg-white"
              />
            </div>

            <div className="space-y-1">
              <label className="text-xs font-bold text-[#1F1F1D]">Handback Notes (Optional)</label>
              <textarea
                value={handbackNotes}
                onChange={(e) => setHandbackNotes(e.target.value)}
                placeholder="e.g. Package returned in intact original seal..."
                rows={2}
                className="w-full p-2.5 border border-[#DDD9D4] rounded-xl text-xs bg-[#F5F4F2]"
              />
            </div>

            <button
              onClick={handleSubmitHandback}
              disabled={isSubmittingHandback}
              className="w-full h-12 bg-[#5A2628] hover:bg-[#471D1F] text-white font-bold text-sm rounded-xl shadow flex items-center justify-center space-x-2 transition active:scale-98 disabled:opacity-50"
            >
              {isSubmittingHandback ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  <span>Processing Handback...</span>
                </>
              ) : (
                <>
                  <Send className="w-4 h-4" />
                  <span>Confirm Warehouse Handback</span>
                </>
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
