import React, { useState, useEffect } from 'react';
import { 
  CheckCircle2, 
  AlertTriangle, 
  RotateCcw, 
  DollarSign, 
  Wallet, 
  ArrowRight, 
  Barcode, 
  Send, 
  Loader2, 
  Lock, 
  ShieldCheck, 
  LogOut, 
  Clock, 
  Package as PackageIcon,
  ChevronRight,
  RefreshCw,
  Sparkles
} from 'lucide-react';
import { Order, Package, Profile, Rider, formatOperationalStatus } from '../../types';
import { api } from '../../services/api';
import { OfflineActor, queueHandbackPreparation } from '../../services/offline_store';

interface RiderEndOfDayFlowProps {
  orders: (Order | Package)[];
  riderInfo?: Rider | null;
  userProfile: Profile;
  activeRun?: any | null;
  offlineActor?: OfflineActor | null;
  onRefreshData: () => Promise<void>;
  onLogout?: () => void;
  onCloseFlow?: () => void;
}

export type EndOfDayStep = 'summary' | 'returns' | 'cash' | 'gate' | 'completed';

export function RiderEndOfDayFlow({
  orders,
  riderInfo,
  userProfile,
  activeRun,
  offlineActor,
  onRefreshData,
  onLogout,
  onCloseFlow
}: RiderEndOfDayFlowProps) {
  const [currentStep, setCurrentStep] = useState<EndOfDayStep>('summary');
  const [settlements, setSettlements] = useState<any[]>([]);
  const [loadingSettlements, setLoadingSettlements] = useState(false);

  // Return Scanning State
  const [selectedPkgForHandback, setSelectedPkgForHandback] = useState<any | null>(null);
  const [scannedBarcode, setScannedBarcode] = useState('');
  const [handoffEmployee, setHandoffEmployee] = useState('');
  const [handbackNotes, setHandbackNotes] = useState('');
  const [isSubmittingHandback, setIsSubmittingHandback] = useState(false);
  const [handbackSuccessMsg, setHandbackSuccessMsg] = useState<string | null>(null);
  const [handbackErrMsg, setHandbackErrMsg] = useState<string | null>(null);

  // Quick Manual Barcode Input
  const [quickBarcodeInput, setQuickBarcodeInput] = useState('');
  const [isQuickScanning, setIsQuickScanning] = useState(false);

  // Cash Handover State
  const [showHandoverModal, setShowHandoverModal] = useState(false);
  const [declaredCashAmount, setDeclaredCashAmount] = useState<number>(0);
  const [cashierNotes, setCashierNotes] = useState('');
  const [isSubmittingCash, setIsSubmittingCash] = useState(false);
  const [cashSuccessMsg, setCashSuccessMsg] = useState<string | null>(null);
  const [cashErrMsg, setCashErrMsg] = useState<string | null>(null);

  // End Shift State
  const [isEndingShift, setIsEndingShift] = useState(false);
  const [shiftCompletedData, setShiftCompletedData] = useState<any | null>(null);
  const [gateErrMsg, setGateErrMsg] = useState<string | null>(null);
  const [blockingReasons, setBlockingReasons] = useState<string[]>([]);

  // Load settlements whenever entering cash or gate step
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

  // Order categorizations
  const activeStops = orders.filter((o: any) => {
    const st = (o.operationalStatus || o.current_status || '').toLowerCase().replace(/[\s-]+/g, '_');
    return ['assigned', 'picked_up', 'out_for_delivery', 'rider_scanned', 'rider_accepted', 'ready_for_dispatch'].includes(st);
  });

  const deliveredOrders = orders.filter((o: any) => {
    const st = (o.operationalStatus || o.current_status || '').toLowerCase();
    return st === 'delivered';
  });

  const failedOrders = orders.filter((o: any) => {
    const st = (o.operationalStatus || o.current_status || '').toLowerCase().replace(/[\s-]+/g, '_');
    return ['customer_unavailable', 'rescheduled', 'refused', 'customer_refused', 'incorrect_address', 'address_issue', 'cancelled', 'customer_cancelled', 'return_required', 'returning_to_warehouse'].includes(st);
  });

  // Return packages: failed packages that must be returned to depot
  const returnPackages = failedOrders;

  // Handed back packages: returns that have been scanned & handed back to hub
  const handedBackPackages = returnPackages.filter((o: any) => {
    const st = (o.operationalStatus || o.current_status || '').toLowerCase();
    const custody = (o.custodyStage || '').toLowerCase();
    return st.includes('handback') || custody === 'return_handed_back' || st === 'returning_to_warehouse' || st === 'warehouse_received';
  });

  const pendingReturnPackages = returnPackages.filter((o: any) => {
    const st = (o.operationalStatus || o.current_status || '').toLowerCase();
    const custody = (o.custodyStage || '').toLowerCase();
    return !(st.includes('handback') || custody === 'return_handed_back' || st === 'returning_to_warehouse' || st === 'warehouse_received');
  });

  // Calculate Cash Collected (only for delivered COD orders)
  const deliveredCodOrders = deliveredOrders.filter((o: any) => {
    const isPrepaid = (o.payment_method || o.paymentMethod || '').toLowerCase() === 'prepaid' || (o.cod_expected === 0 && o.codExpected === 0);
    return !isPrepaid;
  });

  const totalCodCollected = deliveredCodOrders.reduce((sum: number, o: any) => {
    const amt = o.collectedAmount !== undefined ? o.collectedAmount : (o.cod_collection?.collected_amount || o.cod_expected || o.codExpected || 0);
    return sum + Number(amt);
  }, 0);

  // Total Cash already submitted in settlements
  const handoverSubmitted = settlements.reduce((sum: number, s: any) => {
    if (s.status !== 'rejected') {
      return sum + Number(s.declaredCashAmount || 0);
    }
    return sum;
  }, 0);
  const cashierConfirmed = settlements.reduce((sum: number, s: any) => {
    if (s.status !== 'rejected') {
      return sum + Number(s.physicallyReceivedAmount || 0);
    }
    return sum;
  }, 0);

  // Physical Cash Currently With Rider
  const cashWithRider = Math.max(0, totalCodCollected - cashierConfirmed);

  // ----------------------------------------------------
  // VALIDATION EVALUATION
  // ----------------------------------------------------
  const evaluateShiftGate = (): { canClose: boolean; reasons: string[] } => {
    const reasons: string[] = [];

    // Rule 1: No active deliveries left
    if (activeStops.length > 0) {
      reasons.push(`${activeStops.length} delivery stop${activeStops.length === 1 ? '' : 's'} still pending completion on route.`);
    }

    // Rule 2: All returns must be scanned and handed back
    if (pendingReturnPackages.length > 0) {
      reasons.push(`${pendingReturnPackages.length} return package${pendingReturnPackages.length === 1 ? '' : 's'} not yet scanned for depot return.`);
    }

    // Rule 3: All cash with rider must be handed over
    if (cashWithRider > 0) {
      reasons.push(`Rs. ${cashWithRider.toLocaleString()} cash in hand has not been handed over to the cashier.`);
    }

    return {
      canClose: reasons.length === 0,
      reasons
    };
  };

  // ----------------------------------------------------
  // RETURN HANDBACK SCANNING
  // ----------------------------------------------------
  const handleOpenHandback = (pkg: any) => {
    setSelectedPkgForHandback(pkg);
    const barcode = pkg.original_order_number || pkg.packageNumber || pkg.package_number || pkg.id;
    setScannedBarcode(barcode);
    setHandoffEmployee('');
    setHandbackNotes('');
    setHandbackErrMsg(null);
    setHandbackSuccessMsg(null);
  };

  const handleScanReturnSubmit = async (pkg: any, barcodeInput: string) => {
    if (!barcodeInput.trim()) {
      setHandbackErrMsg('Package barcode is required.');
      return;
    }

    setIsSubmittingHandback(true);
    setHandbackErrMsg(null);
    const idempotencyKey = `HANDBACK:${pkg.id}:${Date.now()}`;

    try {
      const res = await api.submitRiderHandback({
        packageId: pkg.id,
        scannedPackageNumber: barcodeInput.trim(),
        returnReason: pkg.failure_reason || pkg.failureReason || 'Failed Delivery Return',
        riderNotes: handbackNotes.trim() || undefined,
        handoffEmployee: handoffEmployee.trim() || undefined,
        idempotencyKey
      });

      if (res && res.success !== false) {
        setHandbackSuccessMsg(`Package ${barcodeInput.trim()} marked as handed back at hub depot.`);
        setSelectedPkgForHandback(null);
        setQuickBarcodeInput('');
        await onRefreshData();
      } else {
        setHandbackErrMsg(res?.error?.message || 'Failed to submit return handback.');
      }
    } catch (e: any) {
      if (offlineActor) {
        await queueHandbackPreparation({
          actor: offlineActor,
          packageId: pkg.id,
          scannedPackageNumber: barcodeInput.trim(),
          returnReason: pkg.failure_reason || pkg.failureReason || 'Failed Delivery Return',
          riderNotes: handbackNotes.trim() || undefined,
          handoffEmployee: handoffEmployee.trim() || undefined,
          observedServerRevision: pkg.updatedAt || pkg.updated_at || null,
          idempotencyKey
        });
        setHandbackSuccessMsg(`Package ${barcodeInput.trim()} saved locally. WAITING TO SYNC until the server confirms the handback.`);
        setSelectedPkgForHandback(null);
        setQuickBarcodeInput('');
        await onRefreshData();
      } else {
        setHandbackErrMsg(e.message || 'Error connecting to server.');
      }
    } finally {
      setIsSubmittingHandback(false);
    }
  };

  // Quick Barcode Match Scan
  const handleQuickBarcodeScan = async (e: React.FormEvent) => {
    e.preventDefault();
    const query = quickBarcodeInput.trim().toLowerCase();
    if (!query) return;

    setIsQuickScanning(true);
    setHandbackErrMsg(null);
    setHandbackSuccessMsg(null);

    try {
      const match = returnPackages.find((p: any) => {
        const id = (p.id || '').toLowerCase();
        const pkgNum = (p.packageNumber || p.package_number || '').toLowerCase();
        const ordNum = (p.original_order_number || '').toLowerCase();
        return id === query || pkgNum === query || ordNum === query;
      });

      if (!match) {
        setHandbackErrMsg(`No pending return package found matching barcode "${quickBarcodeInput}".`);
        return;
      }

      // Check if already handed back
      const st = (match.operationalStatus || match.current_status || '').toLowerCase();
      const custody = (match.custodyStage || '').toLowerCase();
      if (st.includes('handback') || custody === 'return_handed_back' || st === 'returning_to_warehouse' || st === 'warehouse_received') {
        setHandbackSuccessMsg(`Package ${quickBarcodeInput} was already scanned and handed back.`);
        setQuickBarcodeInput('');
        return;
      }

      const realNum = match.packageNumber || match.package_number || match.original_order_number || match.id;
      await handleScanReturnSubmit(match, realNum);
    } finally {
      setIsQuickScanning(false);
    }
  };

  // ----------------------------------------------------
  // CASH HANDOVER
  // ----------------------------------------------------
  const handleOpenCashHandover = () => {
    setDeclaredCashAmount(cashWithRider);
    setCashierNotes('');
    setCashErrMsg(null);
    setCashSuccessMsg(null);
    setShowHandoverModal(true);
  };

  const handleConfirmCashHandover = async () => {
    if (declaredCashAmount <= 0) {
      setCashErrMsg('Declared handover amount must be greater than Rs. 0.');
      return;
    }

    setIsSubmittingCash(true);
    setCashErrMsg(null);
    const idempotencyKey = `SETTLE:${riderInfo?.id || userProfile.id}:${Date.now()}`;

    try {
      const res = await api.submitRiderSettlement({
        declaredCashAmount: Number(declaredCashAmount),
        notes: cashierNotes.trim() || undefined,
        idempotencyKey
      });

      if (res && res.success !== false) {
        setCashSuccessMsg(`Cash handover of Rs. ${Number(declaredCashAmount).toLocaleString()} submitted to cashier.`);
        setShowHandoverModal(false);
        await loadSettlements();
        await onRefreshData();
      } else {
        setCashErrMsg(res?.error?.message || 'Failed to submit cash settlement.');
      }
    } catch (e: any) {
      setCashErrMsg(e.message || 'Error communicating with server.');
    } finally {
      setIsSubmittingCash(false);
    }
  };

  // ----------------------------------------------------
  // END SHIFT / CLOSE RUN
  // ----------------------------------------------------
  const handleEndShift = async () => {
    const gate = evaluateShiftGate();
    if (!gate.canClose) {
      setBlockingReasons(gate.reasons);
      setGateErrMsg('Shift cannot close until all validation requirements are fulfilled.');
      return;
    }

    setIsEndingShift(true);
    setGateErrMsg(null);

    try {
      const runId = activeRun?.id;
      let res: any;
      if (runId) {
        res = await api.endDispatchRunShift(runId);
      } else {
        // Fallback if no specific run linked
        res = {
          success: true,
          data: {
            status: 'completed',
            closedAt: new Date().toISOString(),
            summary: {
              deliveredCount: deliveredOrders.length,
              failedCount: failedOrders.length,
              returnsCount: returnPackages.length,
              cashHandedOver: totalCodCollected,
              closedAt: new Date().toISOString()
            }
          }
        };
      }

      if (res && res.success !== false) {
        setShiftCompletedData(res.data || {
          summary: {
            deliveredCount: deliveredOrders.length,
            failedCount: failedOrders.length,
            returnsCount: returnPackages.length,
            cashHandedOver: totalCodCollected,
            closedAt: new Date().toISOString()
          }
        });
        setCurrentStep('completed');
        await onRefreshData();
      } else {
        const errReasons = res?.error?.pendingReasons || [res?.error?.message || 'Failed to close shift.'];
        setBlockingReasons(errReasons);
        setGateErrMsg(res?.error?.message || 'Shift closure failed.');
      }
    } catch (e: any) {
      setGateErrMsg(e.message || 'Error closing shift.');
    } finally {
      setIsEndingShift(false);
    }
  };

  // Progress Indicators
  const totalReturnsCount = returnPackages.length;
  const scannedReturnsCount = handedBackPackages.length;
  const isAllReturnsScanned = totalReturnsCount === 0 || scannedReturnsCount >= totalReturnsCount;
  const isCashCleared = cashWithRider === 0;

  return (
    <div className="space-y-4 animate-in fade-in duration-200">

      {/* STEP INDICATOR HEADER */}
      <div className="bg-white rounded-2xl border border-[#DDD9D4] p-3 shadow-xs">
        <div className="flex items-center justify-between text-[11px] font-extrabold uppercase tracking-wider text-[#6D6964] mb-2 px-1">
          <span>End of Day Handover</span>
          <span className="text-[#5A2628] font-mono">
            {currentStep === 'summary' && 'Step 1 of 4: Route Review'}
            {currentStep === 'returns' && 'Step 2 of 4: Return Hub Scan'}
            {currentStep === 'cash' && 'Step 3 of 4: Cash Handover'}
            {currentStep === 'gate' && 'Step 4 of 4: Shift Closure'}
            {currentStep === 'completed' && 'Shift Completed'}
          </span>
        </div>

        {/* 4-Step Progress Bar */}
        <div className="grid grid-cols-4 gap-1.5">
          <div className={`h-1.5 rounded-full transition-all duration-300 ${currentStep !== 'summary' ? 'bg-emerald-600' : 'bg-[#5A2628]'}`} />
          <div className={`h-1.5 rounded-full transition-all duration-300 ${['cash', 'gate', 'completed'].includes(currentStep) ? 'bg-emerald-600' : currentStep === 'returns' ? 'bg-[#5A2628]' : 'bg-[#DDD9D4]'}`} />
          <div className={`h-1.5 rounded-full transition-all duration-300 ${['gate', 'completed'].includes(currentStep) ? 'bg-emerald-600' : currentStep === 'cash' ? 'bg-[#5A2628]' : 'bg-[#DDD9D4]'}`} />
          <div className={`h-1.5 rounded-full transition-all duration-300 ${currentStep === 'completed' ? 'bg-emerald-600' : currentStep === 'gate' ? 'bg-[#5A2628]' : 'bg-[#DDD9D4]'}`} />
        </div>
      </div>

      {/* ==================================================================== */}
      {/* STEP 1: ROUTE COMPLETE SUMMARY SCREEN */}
      {/* ==================================================================== */}
      {currentStep === 'summary' && (
        <div className="space-y-4">
          
          {/* Hero Banner */}
          <div className="bg-[#1F1F1D] text-white p-5 rounded-3xl shadow-md text-center space-y-2 border border-stone-800">
            <div className="w-12 h-12 rounded-2xl bg-emerald-500/20 text-emerald-400 flex items-center justify-center mx-auto border border-emerald-500/30">
              <CheckCircle2 className="w-7 h-7" />
            </div>
            <h2 className="text-xl font-black tracking-tight text-white uppercase">
              ROUTE COMPLETE
            </h2>
            <p className="text-xs text-stone-300 max-w-xs mx-auto">
              All delivery stops have been attempted. Review your end-of-day summary and proceed to handover.
            </p>
          </div>

          {/* 5 Operational Summary Metrics */}
          <div className="bg-white rounded-3xl border border-[#DDD9D4] p-5 shadow-xs space-y-4">
            <h3 className="text-xs font-black uppercase tracking-wider text-[#6D6964]">
              Today's Route Totals
            </h3>

            <div className="grid grid-cols-2 gap-2.5">
              {/* Delivered */}
              <div className="bg-[#F5F4F2] p-3 rounded-2xl border border-[#DDD9D4]/60 space-y-1">
                <span className="text-[11px] font-bold text-[#6D6964] block">Delivered</span>
                <span className="text-2xl font-black font-mono text-emerald-700 block">
                  {deliveredOrders.length}
                </span>
                <span className="text-[10px] text-[#6D6964]">Successful drops</span>
              </div>

              {/* Failed / Exceptions */}
              <div className="bg-[#F5F4F2] p-3 rounded-2xl border border-[#DDD9D4]/60 space-y-1">
                <span className="text-[11px] font-bold text-[#6D6964] block">Failed / Rescheduled</span>
                <span className="text-2xl font-black font-mono text-amber-700 block">
                  {failedOrders.length}
                </span>
                <span className="text-[10px] text-[#6D6964]">Delivery exceptions</span>
              </div>

              {/* Returns Required */}
              <div className="bg-rose-50 p-3 rounded-2xl border border-rose-200 space-y-1">
                <span className="text-[11px] font-bold text-rose-800 block">Return Required</span>
                <span className="text-2xl font-black font-mono text-rose-700 block">
                  {returnPackages.length}
                </span>
                <span className="text-[10px] text-rose-600 font-bold">Must return to hub</span>
              </div>

              {/* COD Collected */}
              <div className="bg-emerald-50 p-3 rounded-2xl border border-emerald-200 space-y-1">
                <span className="text-[11px] font-bold text-emerald-800 block">COD Collected</span>
                <span className="text-xl font-black font-mono text-emerald-800 block">
                  Rs. {totalCodCollected.toLocaleString()}
                </span>
                <span className="text-[10px] text-emerald-700">Gross collected</span>
              </div>
            </div>

            {/* Prominent Large Cash Figure: Cash With Rider */}
            <div className="bg-[#5A2628] text-white p-4 rounded-2xl shadow-sm text-center space-y-1">
              <span className="text-[10px] uppercase font-extrabold text-stone-300 tracking-wider">
                Physical Cash In Hand
              </span>
              <span className="text-3xl font-black font-mono text-amber-400 block">
                Rs. {cashWithRider.toLocaleString()}
              </span>
              <span className="text-[11px] text-stone-200">
                {cashWithRider > 0 ? 'Pending handover to hub cashier' : 'All cash already submitted'}
              </span>
            </div>
          </div>

          {/* Primary Action Button */}
          <button
            onClick={() => {
              if (returnPackages.length > 0) {
                setCurrentStep('returns');
              } else {
                setCurrentStep('cash');
              }
            }}
            className="w-full h-14 bg-[#5A2628] hover:bg-[#471D1F] text-white font-black text-sm rounded-2xl shadow-lg flex items-center justify-center space-x-2 transition active:scale-98"
          >
            <span>CONTINUE TO END SHIFT</span>
            <ArrowRight className="w-5 h-5" />
          </button>
        </div>
      )}

      {/* ==================================================================== */}
      {/* STEP 2: RETURN TO HUB SCREEN & SCANNING */}
      {/* ==================================================================== */}
      {currentStep === 'returns' && (
        <div className="space-y-4">
          
          {/* Header Banner with Scan Progress */}
          <div className="bg-rose-600 text-white p-4 rounded-3xl shadow-md space-y-3">
            <div className="flex items-center space-x-2.5">
              <div className="w-10 h-10 rounded-2xl bg-white/20 flex items-center justify-center shrink-0">
                <RotateCcw className="w-5 h-5 text-white" />
              </div>
              <div className="flex-1">
                <h3 className="text-base font-black uppercase tracking-tight text-white">
                  RETURN TO HUB
                </h3>
                <p className="text-xs text-rose-100">
                  {returnPackages.length} package{returnPackages.length === 1 ? '' : 's'} must be returned to hub depot
                </p>
              </div>
            </div>

            {/* Scan Progress Bar & Counter */}
            <div className="bg-white/10 p-3 rounded-2xl space-y-1.5 border border-white/10">
              <div className="flex items-center justify-between text-xs font-black">
                <span>Scan Progress</span>
                <span className="font-mono text-amber-300 text-sm">
                  {scannedReturnsCount} / {totalReturnsCount} scanned
                </span>
              </div>
              <div className="w-full bg-black/20 h-2.5 rounded-full overflow-hidden">
                <div 
                  className="bg-amber-400 h-full transition-all duration-300"
                  style={{ width: `${totalReturnsCount > 0 ? (scannedReturnsCount / totalReturnsCount) * 100 : 100}%` }}
                />
              </div>
            </div>
          </div>

          {handbackSuccessMsg && (
            <div className="p-3 bg-emerald-50 border border-emerald-300 rounded-2xl text-xs text-emerald-900 flex items-center space-x-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" />
              <span className="font-medium">{handbackSuccessMsg}</span>
            </div>
          )}

          {handbackErrMsg && (
            <div className="p-3 bg-rose-50 border border-rose-300 rounded-2xl text-xs text-rose-900 flex items-center space-x-2">
              <AlertTriangle className="w-4 h-4 text-rose-700 shrink-0" />
              <span className="font-medium">{handbackErrMsg}</span>
            </div>
          )}

          {/* Quick Barcode Scan Input Box */}
          <form onSubmit={handleQuickBarcodeScan} className="bg-white p-3.5 rounded-2xl border border-[#DDD9D4] shadow-xs space-y-2">
            <label className="text-xs font-black uppercase text-[#6D6964] flex items-center space-x-1.5">
              <Barcode className="w-4 h-4 text-[#5A2628]" />
              <span>Scan Return Package Barcode</span>
            </label>
            <div className="flex space-x-2">
              <input
                type="text"
                value={quickBarcodeInput}
                onChange={(e) => setQuickBarcodeInput(e.target.value)}
                placeholder="Scan barcode or enter package ID..."
                className="flex-1 px-3 py-2.5 bg-[#F5F4F2] border border-[#DDD9D4] rounded-xl text-xs font-mono font-bold focus:outline-none focus:ring-2 focus:ring-[#5A2628]"
              />
              <button
                type="submit"
                disabled={isQuickScanning || !quickBarcodeInput.trim()}
                className="px-4 py-2.5 bg-stone-900 hover:bg-black text-white text-xs font-black rounded-xl shrink-0 transition active:scale-95 disabled:opacity-50"
              >
                {isQuickScanning ? <Loader2 className="w-4 h-4 animate-spin" /> : 'SCAN'}
              </button>
            </div>
          </form>

          {/* List of Return Packages */}
          <div className="space-y-2.5">
            {returnPackages.map((pkg: any, idx: number) => {
              const pkgId = pkg.original_order_number || pkg.packageNumber || pkg.package_number || pkg.id;
              const customerName = pkg.customer_name || pkg.customerName || 'Customer';
              const failureReason = pkg.failure_reason || pkg.failureReason || formatOperationalStatus(pkg.operationalStatus || pkg.current_status);
              const codValue = pkg.cod_expected || pkg.codExpected || pkg.expectedCod || 0;
              
              const st = (pkg.operationalStatus || pkg.current_status || '').toLowerCase();
              const custody = (pkg.custodyStage || '').toLowerCase();
              const isHandedBack = st.includes('handback') || custody === 'return_handed_back' || st === 'returning_to_warehouse' || st === 'warehouse_received';

              return (
                <div 
                  key={pkg.id || idx}
                  className={`p-4 rounded-2xl border transition-all ${
                    isHandedBack 
                      ? 'bg-emerald-50/70 border-emerald-200 text-emerald-950' 
                      : 'bg-white border-rose-200 shadow-xs'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-xs font-black text-[#5A2628]">{pkgId}</span>
                    <span className={`text-[10px] font-black px-2 py-0.5 rounded-full ${
                      isHandedBack ? 'bg-emerald-200 text-emerald-900' : 'bg-rose-100 text-rose-800'
                    }`}>
                      {isHandedBack ? 'HANDED BACK' : 'PENDING RETURN'}
                    </span>
                  </div>

                  <div className="mt-1.5 space-y-0.5">
                    <h4 className="text-sm font-bold text-[#1F1F1D]">{customerName}</h4>
                    <p className="text-xs text-[#6D6964]">
                      Reason: <span className="font-semibold text-rose-700">{failureReason}</span>
                    </p>
                    <p className="text-xs font-mono font-bold text-stone-700">
                      COD Value: Rs. {Number(codValue).toLocaleString()}
                    </p>
                  </div>

                  <div className="mt-3">
                    {isHandedBack ? (
                      <div className="h-10 bg-emerald-100 text-emerald-900 font-bold text-xs rounded-xl flex items-center justify-center space-x-1.5">
                        <CheckCircle2 className="w-4 h-4 text-emerald-700" />
                        <span>Scanned & Handed Back to Hub</span>
                      </div>
                    ) : (
                      <button
                        onClick={() => handleOpenHandback(pkg)}
                        className="w-full h-11 bg-stone-900 hover:bg-black text-white font-black text-xs rounded-xl shadow-xs flex items-center justify-center space-x-2 transition active:scale-98"
                      >
                        <Barcode className="w-4 h-4 text-amber-400" />
                        <span>SCAN RETURN PACKAGE</span>
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Navigation Button */}
          <button
            onClick={() => setCurrentStep('cash')}
            disabled={!isAllReturnsScanned}
            className={`w-full h-14 rounded-2xl shadow-md font-black text-sm flex items-center justify-center space-x-2 transition active:scale-98 ${
              isAllReturnsScanned
                ? 'bg-[#5A2628] hover:bg-[#471D1F] text-white'
                : 'bg-stone-300 text-stone-500 cursor-not-allowed'
            }`}
          >
            <span>CONTINUE TO CASH REVIEW</span>
            <ArrowRight className="w-5 h-5" />
          </button>
        </div>
      )}

      {/* ==================================================================== */}
      {/* STEP 3: CASH REVIEW & HANDOVER SCREEN */}
      {/* ==================================================================== */}
      {currentStep === 'cash' && (
        <div className="space-y-4">
          
          {/* Main Big Cash Display */}
          <div className="bg-[#5A2628] text-white p-5 rounded-3xl shadow-md text-center space-y-3">
            <span className="text-[11px] uppercase font-extrabold text-stone-300 tracking-wider">
              CASH WITH YOU
            </span>
            <span className="text-4xl font-black font-mono text-amber-400 block tracking-tight">
              Rs. {cashWithRider.toLocaleString()}
            </span>
            <p className="text-xs text-stone-200">
              {cashWithRider > 0 
                ? 'Physical cash required to be submitted to hub cashier.' 
                : 'All collected cash has been submitted to the cashier.'}
            </p>
          </div>

          {cashSuccessMsg && (
            <div className="p-3.5 bg-emerald-50 border border-emerald-300 rounded-2xl text-xs text-emerald-900 flex items-center space-x-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" />
              <span className="font-medium">{cashSuccessMsg}</span>
            </div>
          )}

          {cashErrMsg && (
            <div className="p-3.5 bg-rose-50 border border-rose-300 rounded-2xl text-xs text-rose-900 flex items-center space-x-2">
              <AlertTriangle className="w-4 h-4 text-rose-700 shrink-0" />
              <span className="font-medium">{cashErrMsg}</span>
            </div>
          )}

          {/* Breakdown Card */}
          <div className="bg-white rounded-3xl border border-[#DDD9D4] p-5 shadow-xs space-y-3">
            <h4 className="text-xs font-black uppercase text-[#6D6964] tracking-wider">
              Cash Breakdown
            </h4>

            <div className="space-y-2.5 text-xs font-medium divide-y divide-[#DDD9D4]">
              <div className="flex items-center justify-between pt-1">
                <span className="text-[#6D6964]">COD Collected ({deliveredCodOrders.length} drops)</span>
                <span className="font-mono font-bold text-[#1F1F1D]">
                  Rs. {totalCodCollected.toLocaleString()}
                </span>
              </div>

              <div className="flex items-center justify-between pt-2">
                <span className="text-[#6D6964]">Handover Submitted</span>
                <span className="font-mono font-bold text-amber-700">
                  Rs. {handoverSubmitted.toLocaleString()}
                </span>
              </div>

              <div className="flex items-center justify-between pt-2">
                <span className="text-[#6D6964]">Cashier Confirmed</span>
                <span className="font-mono font-bold text-sky-700">
                  Rs. {cashierConfirmed.toLocaleString()}
                </span>
              </div>

              <div className="flex items-center justify-between pt-2">
                <span className="text-base font-black text-[#1F1F1D]">Outstanding Cash</span>
                <span className="font-mono text-base font-black text-[#5A2628]">
                  Rs. {cashWithRider.toLocaleString()}
                </span>
              </div>
            </div>
          </div>

          {/* Big Action: Hand Over Cash */}
          {cashWithRider > 0 ? (
            <button
              onClick={handleOpenCashHandover}
              className="w-full h-14 bg-amber-500 hover:bg-amber-400 text-stone-950 font-black text-sm rounded-2xl shadow-md flex items-center justify-center space-x-2 transition active:scale-98"
            >
              <Wallet className="w-5 h-5" />
              <span>HAND OVER CASH</span>
            </button>
          ) : (
            <div className="p-4 bg-emerald-50 border border-emerald-200 rounded-2xl text-center space-y-1">
              <CheckCircle2 className="w-6 h-6 text-emerald-600 mx-auto" />
              <p className="text-xs font-black text-emerald-900">Cash Cleared</p>
              <p className="text-[11px] text-emerald-700">No outstanding cash remaining with rider.</p>
            </div>
          )}

          {/* Continue to Gate Button */}
          <button
            onClick={() => setCurrentStep('gate')}
            className="w-full h-14 bg-[#5A2628] hover:bg-[#471D1F] text-white font-black text-sm rounded-2xl shadow-md flex items-center justify-center space-x-2 transition active:scale-98"
          >
            <span>CONTINUE TO END SHIFT</span>
            <ArrowRight className="w-5 h-5" />
          </button>
        </div>
      )}

      {/* ==================================================================== */}
      {/* STEP 4: END SHIFT VALIDATION & GATE SCREEN */}
      {/* ==================================================================== */}
      {currentStep === 'gate' && (
        <div className="space-y-4">
          
          {/* Gate Verification Summary */}
          <div className="bg-white rounded-3xl border border-[#DDD9D4] p-5 shadow-xs space-y-4">
            <div className="flex items-center space-x-3">
              <div className="w-10 h-10 rounded-2xl bg-[#5A2628]/10 text-[#5A2628] flex items-center justify-center">
                <ShieldCheck className="w-6 h-6" />
              </div>
              <div>
                <h3 className="text-base font-black text-[#1F1F1D]">End Shift Verification</h3>
                <p className="text-xs text-[#6D6964]">Mandatory checklist before closing shift</p>
              </div>
            </div>

            {/* 3 Verification Checklist Items */}
            <div className="space-y-3 pt-1">
              {/* Check 1: Stops Completed */}
              <div className="flex items-center justify-between p-3 rounded-2xl bg-[#F5F4F2] border border-[#DDD9D4]/60">
                <div className="space-y-0.5">
                  <span className="text-xs font-bold text-[#1F1F1D] block">1. Delivery Stops</span>
                  <span className="text-[11px] text-[#6D6964]">
                    {activeStops.length === 0 ? 'All stops attempted' : `${activeStops.length} stops active`}
                  </span>
                </div>
                {activeStops.length === 0 ? (
                  <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
                ) : (
                  <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0" />
                )}
              </div>

              {/* Check 2: Returns Handed Back */}
              <div className="flex items-center justify-between p-3 rounded-2xl bg-[#F5F4F2] border border-[#DDD9D4]/60">
                <div className="space-y-0.5">
                  <span className="text-xs font-bold text-[#1F1F1D] block">2. Return Packages</span>
                  <span className="text-[11px] text-[#6D6964]">
                    {pendingReturnPackages.length === 0 
                      ? (returnPackages.length === 0 ? 'No returns required' : 'All returns scanned & handed back') 
                      : `${pendingReturnPackages.length} returns pending scan`}
                  </span>
                </div>
                {pendingReturnPackages.length === 0 ? (
                  <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
                ) : (
                  <AlertTriangle className="w-5 h-5 text-rose-600 shrink-0" />
                )}
              </div>

              {/* Check 3: Cash Cleared */}
              <div className="flex items-center justify-between p-3 rounded-2xl bg-[#F5F4F2] border border-[#DDD9D4]/60">
                <div className="space-y-0.5">
                  <span className="text-xs font-bold text-[#1F1F1D] block">3. Cash Settlement</span>
                  <span className="text-[11px] text-[#6D6964]">
                    {cashWithRider === 0 ? 'All collected cash handed over' : `Rs. ${cashWithRider.toLocaleString()} pending handover`}
                  </span>
                </div>
                {cashWithRider === 0 ? (
                  <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
                ) : (
                  <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0" />
                )}
              </div>
            </div>
          </div>

          {/* Blocking Banner if Gate Fails */}
          {blockingReasons.length > 0 && (
            <div className="bg-rose-600 text-white p-4 rounded-3xl shadow-md space-y-2.5 animate-in shake">
              <div className="flex items-center space-x-2">
                <Lock className="w-5 h-5 text-white shrink-0" />
                <h4 className="text-sm font-black uppercase tracking-tight">SHIFT CANNOT CLOSE</h4>
              </div>
              <ul className="space-y-1 text-xs text-rose-100 list-disc list-inside">
                {blockingReasons.map((reason, idx) => (
                  <li key={idx} className="font-semibold">{reason}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Large End Shift Button */}
          <button
            onClick={handleEndShift}
            disabled={isEndingShift}
            className="w-full h-14 bg-stone-900 hover:bg-black text-white font-black text-sm rounded-2xl shadow-xl flex items-center justify-center space-x-2 transition active:scale-98 disabled:opacity-50"
          >
            {isEndingShift ? (
              <>
                <Loader2 className="w-5 h-5 animate-spin text-amber-400" />
                <span>Closing Shift...</span>
              </>
            ) : (
              <>
                <ShieldCheck className="w-5 h-5 text-amber-400" />
                <span>END SHIFT</span>
              </>
            )}
          </button>
        </div>
      )}

      {/* ==================================================================== */}
      {/* STEP 5: SHIFT COMPLETED SCREEN */}
      {/* ==================================================================== */}
      {currentStep === 'completed' && (
        <div className="space-y-4 text-center">
          
          <div className="bg-emerald-600 text-white p-6 rounded-3xl shadow-lg space-y-3">
            <div className="w-14 h-14 rounded-2xl bg-white/20 flex items-center justify-center mx-auto">
              <Sparkles className="w-8 h-8 text-amber-300" />
            </div>
            <h2 className="text-2xl font-black uppercase tracking-tight">
              SHIFT COMPLETE
            </h2>
            <p className="text-xs text-emerald-100 max-w-xs mx-auto">
              Your working day is officially closed. All packages, returns, and cash have been reconciled.
            </p>
          </div>

          {/* Final Summary Card */}
          <div className="bg-white rounded-3xl border border-[#DDD9D4] p-5 shadow-xs space-y-3.5 text-left">
            <h3 className="text-xs font-black uppercase tracking-wider text-[#6D6964]">
              Shift Summary Record
            </h3>

            <div className="space-y-2 text-xs font-medium divide-y divide-[#DDD9D4]">
              <div className="flex items-center justify-between pt-1">
                <span className="text-[#6D6964]">Total Delivered</span>
                <span className="font-mono font-bold text-emerald-700">
                  {shiftCompletedData?.summary?.deliveredCount ?? deliveredOrders.length} Packages
                </span>
              </div>

              <div className="flex items-center justify-between pt-2">
                <span className="text-[#6D6964]">Total Failed / Rescheduled</span>
                <span className="font-mono font-bold text-amber-700">
                  {shiftCompletedData?.summary?.failedCount ?? failedOrders.length} Packages
                </span>
              </div>

              <div className="flex items-center justify-between pt-2">
                <span className="text-[#6D6964]">Returns Handed Back</span>
                <span className="font-mono font-bold text-stone-800">
                  {shiftCompletedData?.summary?.returnsCount ?? returnPackages.length} Packages
                </span>
              </div>

              <div className="flex items-center justify-between pt-2">
                <span className="text-[#6D6964]">Cash Handed Over</span>
                <span className="font-mono font-bold text-[#1F7A52]">
                  Rs. {(shiftCompletedData?.summary?.cashHandedOver ?? totalCodCollected).toLocaleString()}
                </span>
              </div>

              <div className="flex items-center justify-between pt-2">
                <span className="text-[#6D6964]">Closed At</span>
                <span className="font-mono text-[11px] text-[#1F1F1D]">
                  {new Date(shiftCompletedData?.summary?.closedAt || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                </span>
              </div>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="space-y-2">
            <button
              onClick={() => {
                if (onCloseFlow) onCloseFlow();
              }}
              className="w-full h-12 bg-white border border-[#DDD9D4] text-[#1F1F1D] font-bold text-xs rounded-xl shadow-xs hover:bg-[#F5F4F2] transition active:scale-98"
            >
              VIEW SHIFT SUMMARY
            </button>

            {onLogout && (
              <button
                onClick={onLogout}
                className="w-full h-12 bg-stone-900 hover:bg-black text-white font-black text-xs rounded-xl shadow-md flex items-center justify-center space-x-2 transition active:scale-98"
              >
                <LogOut className="w-4 h-4 text-amber-400" />
                <span>LOG OUT</span>
              </button>
            )}
          </div>
        </div>
      )}

      {/* ==================================================================== */}
      {/* MODAL 1: RETURN HANDBACK MODAL */}
      {/* ==================================================================== */}
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

            {handbackErrMsg && (
              <div className="p-3 bg-rose-50 border border-rose-300 rounded-xl text-xs text-rose-900">
                {handbackErrMsg}
              </div>
            )}

            <div className="space-y-1">
              <label className="text-xs font-bold text-[#1F1F1D] flex items-center space-x-1">
                <Barcode className="w-4 h-4 text-[#5A2628]" />
                <span>Package Barcode *</span>
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
              <label className="text-xs font-bold text-[#1F1F1D]">Depot Receiver Name (Optional)</label>
              <input
                type="text"
                value={handoffEmployee}
                onChange={(e) => setHandoffEmployee(e.target.value)}
                placeholder="Name of hub staff receiving return"
                className="w-full h-11 px-3 border border-[#DDD9D4] rounded-xl text-xs bg-white"
              />
            </div>

            <div className="space-y-1">
              <label className="text-xs font-bold text-[#1F1F1D]">Handback Notes (Optional)</label>
              <textarea
                value={handbackNotes}
                onChange={(e) => setHandbackNotes(e.target.value)}
                placeholder="e.g. Returned sealed in original carton..."
                rows={2}
                className="w-full p-2.5 border border-[#DDD9D4] rounded-xl text-xs bg-[#F5F4F2]"
              />
            </div>

            <button
              onClick={() => handleScanReturnSubmit(selectedPkgForHandback, scannedBarcode)}
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
                  <span>CONFIRM HUB HANDBACK</span>
                </>
              )}
            </button>
          </div>
        </div>
      )}

      {/* ==================================================================== */}
      {/* MODAL 2: CASH HANDOVER CONFIRMATION MODAL */}
      {/* ==================================================================== */}
      {showHandoverModal && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-end sm:items-center justify-center p-0 sm:p-4 backdrop-blur-xs">
          <div className="bg-white rounded-t-3xl sm:rounded-2xl border border-[#DDD9D4] w-full max-w-md p-5 space-y-4 shadow-2xl animate-in slide-in-from-bottom duration-200">
            <div className="flex items-center justify-between border-b border-[#DDD9D4] pb-3">
              <div>
                <span className="text-[10px] font-black uppercase text-[#6D6964]">Cashier Settlement</span>
                <h3 className="text-base font-black text-[#1F1F1D]">Confirm Cash Handover</h3>
              </div>
              <button onClick={() => setShowHandoverModal(false)} className="text-[#6D6964] font-bold p-1">
                ✕
              </button>
            </div>

            {cashErrMsg && (
              <div className="p-3 bg-rose-50 border border-rose-300 rounded-xl text-xs text-rose-900">
                {cashErrMsg}
              </div>
            )}

            <div className="space-y-1">
              <label className="text-xs font-bold text-[#1F1F1D] flex items-center space-x-1">
                <DollarSign className="w-4 h-4 text-emerald-600" />
                <span>Declared Cash Handover Amount (PKR) *</span>
              </label>
              <input
                type="number"
                min="1"
                value={declaredCashAmount}
                onChange={(e) => setDeclaredCashAmount(Number(e.target.value))}
                className="w-full h-12 px-3 border border-[#DDD9D4] rounded-xl font-mono text-lg font-black text-[#1F7A52] bg-white"
              />
              <span className="text-[10px] text-[#6D6964]">
                Calculated physical cash obligation: Rs. {cashWithRider.toLocaleString()}
              </span>
            </div>

            <div className="space-y-1">
              <label className="text-xs font-bold text-[#1F1F1D]">Cashier Name / Notes (Optional)</label>
              <textarea
                value={cashierNotes}
                onChange={(e) => setCashierNotes(e.target.value)}
                placeholder="e.g. Handed to Cashier Ahmed at Hub Desk 1..."
                rows={2}
                className="w-full p-2.5 border border-[#DDD9D4] rounded-xl text-xs bg-[#F5F4F2]"
              />
            </div>

            <button
              onClick={handleConfirmCashHandover}
              disabled={isSubmittingCash}
              className="w-full h-12 bg-amber-500 hover:bg-amber-400 text-stone-950 font-black text-sm rounded-xl shadow flex items-center justify-center space-x-2 transition active:scale-98 disabled:opacity-50"
            >
              {isSubmittingCash ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  <span>Submitting Handover...</span>
                </>
              ) : (
                <>
                  <CheckCircle2 className="w-5 h-5 text-stone-950" />
                  <span>CONFIRM HANDOVER</span>
                </>
              )}
            </button>
          </div>
        </div>
      )}

    </div>
  );
}
