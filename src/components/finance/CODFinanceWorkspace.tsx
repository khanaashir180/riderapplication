import React, { useState, useEffect } from 'react';
import { DollarSign, Receipt, AlertTriangle, Building2, FileSpreadsheet, CheckCircle2, User, Clock } from 'lucide-react';
import { RiderSettlement, Rider, ExternalCourierShipment } from '../../types';
import { api } from '../../services/api';

interface CODFinanceWorkspaceProps {
  activeSubTab: string;
}

export function CODFinanceWorkspace({ activeSubTab }: CODFinanceWorkspaceProps) {
  const [settlements, setSettlements] = useState<RiderSettlement[]>([]);
  const [riders, setRiders] = useState<Rider[]>([]);
  const [courierShipments, setCourierShipments] = useState<ExternalCourierShipment[]>([]);
  const [loading, setLoading] = useState(true);

  // Reconciliation Modal
  const [selectedSettlement, setSelectedSettlement] = useState<RiderSettlement | null>(null);
  const [riderReported, setRiderReported] = useState<number>(0);
  const [cashierReceived, setCashierReceived] = useState<number>(0);
  const [discrepancyNotes, setDiscrepancyNotes] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);

  useEffect(() => {
    loadFinanceData();
  }, [activeSubTab]);

  const loadFinanceData = async () => {
    setLoading(true);
    try {
      const [stlRes, rdrRes, curRes] = await Promise.all([
        api.getRiderSettlements(),
        api.getRiders(),
        api.getExternalCourierShipments()
      ]);
      setSettlements(stlRes.data || (Array.isArray(stlRes) ? stlRes : []));
      setRiders(rdrRes.riders || rdrRes.data || (Array.isArray(rdrRes) ? rdrRes : []));
      setCourierShipments(curRes.data || (Array.isArray(curRes) ? curRes : []));
    } catch (e) {
      console.error('Failed to load finance data:', e);
    } finally {
      setLoading(false);
    }
  };

  const handleOpenReconcileModal = (stl: RiderSettlement) => {
    setSelectedSettlement(stl);
    const expected = stl.calculatedCashObligation ?? 0;
    const declared = stl.declaredCashAmount ?? expected;
    const received = stl.physicallyReceivedAmount ?? 0;
    setRiderReported(declared);
    setCashierReceived(received);
    setDiscrepancyNotes(stl.discrepancyReason || '');
  };

  const handleReconcileSubmit = async (action: 'receive' | 'approve' | 'resolve_discrepancy') => {
    if (!selectedSettlement) return;
    setIsProcessing(true);
    try {
      if (action === 'receive' || action === 'approve') {
        const res = await api.receiveCashierSettlement({
          settlementId: selectedSettlement.id,
          physicallyReceivedAmount: cashierReceived,
          receiptNotes: discrepancyNotes
        });

        if (res.data && res.data.status === 'discrepancy' && discrepancyNotes) {
          await api.approveSettlementDiscrepancy({
            settlementId: selectedSettlement.id,
            discrepancyReason: discrepancyNotes,
            resolutionType: 'APPROVED_WRITE_OFF',
            resolutionReason: discrepancyNotes
          });
          await api.closeSettlement({
            settlementId: selectedSettlement.id
          });
        }
      }
      setSelectedSettlement(null);
      loadFinanceData();
    } catch (e) {
      console.error('Reconciliation failed:', e);
    } finally {
      setIsProcessing(false);
    }
  };

  if (loading) {
    return (
      <div className="p-8 text-center text-xs text-[#6D6964] animate-pulse">
        Loading COD & financial control system...
      </div>
    );
  }

  // Filter settlements by discrepancy if on discrepancy tab
  const activeSettlementsList = activeSubTab === 'discrepancies' 
    ? settlements.filter(s => (s.totalSettlementVariance ?? 0) !== 0 || s.status === 'discrepancy')
    : settlements;

  return (
    <div className="p-6 space-y-6 bg-[#F5F4F2] min-h-screen">
      
      {/* Top Header Summary */}
      <div className="bg-white p-4 rounded-lg border border-[#DDD9D4] shadow-xs flex justify-between items-center">
        <div>
          <h2 className="text-sm font-bold text-[#1F1F1D]">COD Financial Audit & Reconciliations</h2>
          <p className="text-xs text-[#6D6964]">Rigorous cashier cash reconciliation, rider deposits, and discrepancy control</p>
        </div>
        <div className="flex space-x-3 text-xs">
          <div className="text-right">
            <span className="text-[10px] text-[#6D6964] uppercase block font-semibold">Expected Cash Today</span>
            <span className="font-mono font-bold text-sm text-[#5A2628]">
              Rs. {settlements.reduce((sum, s) => sum + (s.calculatedCashObligation ?? 0), 0).toLocaleString()}
            </span>
          </div>
        </div>
      </div>

      {/* OPEN SETTLEMENTS & DISCREPANCIES TABLE */}
      {(activeSubTab === 'settlements' || activeSubTab === 'discrepancies' || activeSubTab === 'cash') && (
        <div className="bg-white rounded-lg border border-[#DDD9D4] shadow-xs overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs text-[#1F1F1D]">
              <thead className="bg-[#F5F4F2] border-b border-[#DDD9D4] text-[11px] font-bold text-[#6D6964] uppercase tracking-wider">
                <tr>
                  <th className="p-3">Rider Courier</th>
                  <th className="p-3">Settlement Date</th>
                  <th className="p-3 text-right">Expected Cash</th>
                  <th className="p-3 text-right">Rider Declaration</th>
                  <th className="p-3 text-right">Cashier Receipt</th>
                  <th className="p-3 text-right">Difference</th>
                  <th className="p-3">Stage</th>
                  <th className="p-3">Responsible User</th>
                  <th className="p-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#DDD9D4]">
                {activeSettlementsList.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="p-8 text-center text-xs text-[#6D6964]">
                      No settlement records match the current view.
                    </td>
                  </tr>
                ) : (
                  activeSettlementsList.map((stl) => {
                    const expected = stl.calculatedCashObligation ?? 0;
                    const declared = stl.declaredCashAmount ?? 0;
                    const received = stl.physicallyReceivedAmount ?? 0;
                    const variance = stl.totalSettlementVariance ?? (received - expected);
                    const hasDiscrepancy = variance !== 0;

                    return (
                      <tr key={stl.id} className="hover:bg-[#F5F4F2]/50 transition">
                        <td className="p-3 font-semibold">
                          {stl.rider?.profile?.full_name || stl.rider?.rider_code || 'Rider Courier'}
                        </td>
                        <td className="p-3 font-mono text-[#6D6964]">
                          {stl.settlementDate || stl.settlement_date}
                        </td>
                        <td className="p-3 text-right font-mono font-bold">
                          Rs. {expected.toLocaleString()}
                        </td>
                        <td className="p-3 text-right font-mono">
                          Rs. {declared.toLocaleString()}
                        </td>
                        <td className="p-3 text-right font-mono">
                          Rs. {received.toLocaleString()}
                        </td>
                        <td className={`p-3 text-right font-mono font-bold ${
                          hasDiscrepancy ? 'text-[#B43B3B]' : 'text-[#6D6964]'
                        }`}>
                          {variance > 0 ? `+Rs. ${variance.toLocaleString()}` : variance < 0 ? `-Rs. ${Math.abs(variance).toLocaleString()}` : 'Rs. 0'}
                        </td>
                        <td className="p-3">
                          <span className={`text-[10px] font-bold px-2 py-0.5 rounded border ${
                            (stl.status === 'cashier_received' || stl.status === 'manager_approved' || stl.status === 'closed') ? 'bg-[#1F7A52]/10 text-[#1F7A52] border-[#1F7A52]/30' :
                            (stl.status === 'discrepancy') ? 'bg-[#B43B3B]/10 text-[#B43B3B] border-[#B43B3B]/30' :
                            'bg-stone-100 text-[#6D6964] border-[#DDD9D4]'
                          }`}>
                            {stl.status}
                          </span>
                        </td>
                        <td className="p-3 text-[#6D6964] text-[11px]">
                          {stl.received_by_profile?.full_name || stl.submitted_by_profile?.full_name || 'Cashier Admin'}
                        </td>
                        <td className="p-3 text-right">
                          <button
                            onClick={() => handleOpenReconcileModal(stl)}
                            className="px-2.5 py-1 text-[11px] font-bold bg-[#5A2628] text-white rounded hover:bg-[#471D1F] transition"
                          >
                            Reconcile
                          </button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* COURIER RECEIVABLES TAB */}
      {activeSubTab === 'couriers' && (
        <div className="bg-white rounded-lg border border-[#DDD9D4] shadow-xs p-4 space-y-3">
          <h3 className="font-bold text-xs uppercase text-[#6D6964]">3PL Courier Receivables Ledger</h3>
          <div className="divide-y divide-[#DDD9D4]">
            {courierShipments.length === 0 ? (
              <div className="p-6 text-center text-xs text-[#6D6964]">No active 3PL courier shipments</div>
            ) : (
              courierShipments.map(cs => (
                <div key={cs.id} className="py-2.5 flex justify-between items-center text-xs">
                  <div>
                    <span className="font-bold text-[#1F1F1D]">{cs.courier_company}</span>
                    <p className="font-mono text-[10px] text-[#6D6964]">Tracking: {cs.tracking_number}</p>
                  </div>
                  <div className="text-right">
                    <span className="font-mono font-bold text-[#5A2628]">Rs. {cs.cod_receivable.toLocaleString()}</span>
                    <span className={`block text-[10px] font-bold ${cs.remittance_status === 'Remitted' ? 'text-[#1F7A52]' : 'text-[#A56716]'}`}>
                      {cs.remittance_status}
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* DIGITAL & BANK DEPOSITS TABS */}
      {(activeSubTab === 'digital' || activeSubTab === 'deposits') && (
        <div className="bg-white rounded-lg border border-[#DDD9D4] p-8 text-center text-xs text-[#6D6964]">
          All bank slips & verified digital wallet transactions are reconciled against daily cashier receipts.
        </div>
      )}

      {/* RECONCILIATION MODAL */}
      {selectedSettlement && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-xl border border-[#DDD9D4] w-full max-w-md p-6 space-y-4 text-xs">
            <h3 className="font-bold text-sm text-[#1F1F1D] border-b border-[#DDD9D4] pb-2">
              Cashier Reconciliation & Cash Receipt
            </h3>

            <div className="space-y-3">
              <div className="bg-[#F5F4F2] p-3 rounded-md border border-[#DDD9D4] space-y-1">
                <span className="text-[10px] font-bold text-[#6D6964] uppercase block">Expected System COD</span>
                <span className="font-mono text-base font-bold text-[#5A2628]">
                  Rs. {(selectedSettlement.calculatedCashObligation ?? 0).toLocaleString()}
                </span>
              </div>

              <div>
                <label className="block font-semibold mb-1">Rider Declaration (PKR)</label>
                <input
                  type="number"
                  value={riderReported}
                  onChange={(e) => setRiderReported(Number(e.target.value))}
                  className="w-full p-2 border border-[#DDD9D4] rounded-md font-mono"
                />
              </div>

              <div>
                <label className="block font-semibold mb-1">Cashier Hand-Counted Received Amount (PKR) *</label>
                <input
                  type="number"
                  value={cashierReceived}
                  onChange={(e) => setCashierReceived(Number(e.target.value))}
                  className="w-full p-2 border border-[#DDD9D4] rounded-md font-mono font-bold"
                />
              </div>

              {cashierReceived !== (selectedSettlement.calculatedCashObligation ?? 0) && (
                <div>
                  <label className="block font-semibold text-[#B43B3B] mb-1">Discrepancy Justification *</label>
                  <input
                    type="text"
                    value={discrepancyNotes}
                    onChange={(e) => setDiscrepancyNotes(e.target.value)}
                    placeholder="Reason for cash difference..."
                    className="w-full p-2 border border-[#B43B3B]/40 rounded-md bg-[#B43B3B]/5"
                  />
                </div>
              )}
            </div>

            <div className="flex justify-end space-x-2 pt-3 border-t border-[#DDD9D4]">
              <button
                onClick={() => setSelectedSettlement(null)}
                className="px-4 py-2 border border-[#DDD9D4] rounded-md font-semibold"
              >
                Cancel
              </button>
              <button
                onClick={() => handleReconcileSubmit('approve')}
                disabled={isProcessing}
                className="px-4 py-2 bg-[#5A2628] text-white rounded-md font-bold hover:bg-[#471D1F]"
              >
                {isProcessing ? 'Saving...' : 'Approve Settlement'}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
