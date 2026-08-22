import React, { useState, useEffect } from 'react';
import { Truck, Plus, Package, CheckCircle2, AlertTriangle, Play, ShieldAlert, BarChart, User } from 'lucide-react';
import { DispatchBatch, Rider } from '../../types';
import { api } from '../../services/api';

export function DispatchRuns() {
  const [batches, setBatches] = useState<DispatchBatch[]>([]);
  const [riders, setRiders] = useState<Rider[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [selectedRiderId, setSelectedRiderId] = useState('');
  const [shiftSelect, setShiftSelect] = useState<'Morning' | 'Evening'>('Morning');
  const [selectedOrderIds, setSelectedOrderIds] = useState<string[]>([]);
  const [unassignedOrders, setUnassignedOrders] = useState<any[]>([]);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      const [batchData, riderData, ordData] = await Promise.all([
        api.getDispatchBatches(),
        api.getRiders(),
        api.getOrders({ status: 'Awaiting Assignment', limit: 100 })
      ]);
      setBatches(batchData.data || (batchData as any).batches || (Array.isArray(batchData) ? batchData : []));
      setRiders(riderData.riders || riderData.data || (Array.isArray(riderData) ? riderData : []));
      setUnassignedOrders(ordData.orders || ordData.data?.orders || []);
    } catch (e) {
      console.error('Failed to load dispatch runs:', e);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateRun = async () => {
    if (!selectedRiderId || selectedOrderIds.length === 0) {
      alert('Please select a rider and at least one order for the dispatch run.');
      return;
    }
    try {
      await api.createDispatchBatch({
        rider_id: selectedRiderId,
        order_ids: selectedOrderIds,
        shift: shiftSelect,
        user_name: 'Dispatch Manager'
      });
      setShowCreateModal(false);
      setSelectedOrderIds([]);
      loadData();
    } catch (e) {
      console.error('Failed to create run:', e);
    }
  };

  if (loading) {
    return (
      <div className="p-8 text-center text-xs text-[#6D6964] animate-pulse">
        Loading operational dispatch runs...
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6 bg-[#F5F4F2] min-h-screen">
      
      {/* Top Header */}
      <div className="flex justify-between items-center bg-white p-4 rounded-lg border border-[#DDD9D4] shadow-xs">
        <div>
          <h2 className="text-sm font-bold text-[#1F1F1D]">Rider Operational Dispatch Runs</h2>
          <p className="text-xs text-[#6D6964]">Track batch package custody, route progress, and COD cash pending per run</p>
        </div>
        <button
          onClick={() => setShowCreateModal(true)}
          className="px-4 py-2 bg-[#5A2628] hover:bg-[#471D1F] text-white text-xs font-bold rounded-lg shadow-xs flex items-center space-x-2 transition"
        >
          <Plus className="w-4 h-4" />
          <span>Create New Dispatch Run</span>
        </button>
      </div>

      {/* Runs Table / Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {batches.length === 0 ? (
          <div className="col-span-full bg-white p-8 text-center text-xs text-[#6D6964] rounded-lg border border-[#DDD9D4]">
            No active dispatch runs found today. Click "Create New Dispatch Run" to generate a rider manifest.
          </div>
        ) : (
          batches.map((batch) => {
            return (
              <div key={batch.id} className="bg-white rounded-lg border border-[#DDD9D4] p-4 shadow-xs space-y-3">
                <div className="flex justify-between items-start border-b border-[#DDD9D4] pb-2.5">
                  <div>
                    <span className="font-mono text-xs font-bold text-[#5A2628] block">{batch.batch_number}</span>
                    <span className="text-[10px] text-[#6D6964]">{batch.shift} Shift • {batch.dispatch_date}</span>
                  </div>
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded border ${
                    batch.status === 'In Transit' ? 'bg-[#356A8A]/10 text-[#356A8A] border-[#356A8A]/30' :
                    batch.status === 'Handed Over' ? 'bg-[#1F7A52]/10 text-[#1F7A52] border-[#1F7A52]/30' :
                    'bg-stone-100 text-[#6D6964] border-[#DDD9D4]'
                  }`}>
                    {batch.status}
                  </span>
                </div>

                {/* Rider Info */}
                <div className="flex items-center space-x-2.5 text-xs text-[#1F1F1D]">
                  <User className="w-4 h-4 text-[#5A2628]" />
                  <div>
                    <span className="font-bold block">{batch.rider?.profile?.full_name || batch.rider?.rider_code || 'Rider'}</span>
                    <span className="text-[10px] text-[#6D6964]">Zone: {batch.rider?.assigned_zone || 'Central'}</span>
                  </div>
                </div>

                {/* Metrics */}
                <div className="grid grid-cols-2 gap-2 bg-[#F5F4F2] p-2.5 rounded-md border border-[#DDD9D4] text-xs">
                  <div>
                    <span className="text-[10px] text-[#6D6964] block">Package Count</span>
                    <span className="font-mono font-bold text-[#1F1F1D]">{batch.package_count} pkgs</span>
                  </div>
                  <div>
                    <span className="text-[10px] text-[#6D6964] block">Expected COD</span>
                    <span className="font-mono font-bold text-[#5A2628]">Rs. {batch.expected_cod.toLocaleString()}</span>
                  </div>
                </div>

                {/* Status & Action */}
                <div className="pt-2 flex justify-between items-center text-[11px] text-[#6D6964] border-t border-[#DDD9D4]">
                  <span>Handoff: {batch.handed_to_rider_at ? new Date(batch.handed_to_rider_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Pending'}</span>
                  <span className="font-semibold text-[#5A2628]">Scanned & Verified</span>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Create Run Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-xl border border-[#DDD9D4] w-full max-w-lg p-6 space-y-4">
            <h3 className="text-sm font-bold text-[#1F1F1D] border-b border-[#DDD9D4] pb-2">
              Create Rider Dispatch Run Batch
            </h3>

            <div className="space-y-3 text-xs">
              <div>
                <label className="block font-semibold mb-1">Select Rider</label>
                <select
                  value={selectedRiderId}
                  onChange={(e) => setSelectedRiderId(e.target.value)}
                  className="w-full p-2 border border-[#DDD9D4] rounded-md bg-[#F5F4F2]"
                >
                  <option value="">Choose active rider...</option>
                  {riders.map(r => (
                    <option key={r.id} value={r.id}>{r.profile?.full_name || r.rider_code} ({r.assigned_zone})</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block font-semibold mb-1">Shift</label>
                <select
                  value={shiftSelect}
                  onChange={(e) => setShiftSelect(e.target.value as any)}
                  className="w-full p-2 border border-[#DDD9D4] rounded-md bg-[#F5F4F2]"
                >
                  <option value="Morning">Morning Shift (09:00 - 17:00)</option>
                  <option value="Evening">Evening Shift (17:00 - 22:00)</option>
                </select>
              </div>

              <div>
                <label className="block font-semibold mb-1">Select Packages for Manifest ({selectedOrderIds.length} selected)</label>
                <div className="max-h-48 overflow-y-auto border border-[#DDD9D4] rounded-md divide-y divide-[#DDD9D4]">
                  {unassignedOrders.length === 0 ? (
                    <div className="p-3 text-center text-[#6D6964]">No unassigned orders available</div>
                  ) : (
                    unassignedOrders.map(ord => (
                      <label key={ord.id} className="flex items-center space-x-2 p-2 hover:bg-[#F5F4F2] cursor-pointer">
                        <input
                          type="checkbox"
                          checked={selectedOrderIds.includes(ord.id)}
                          onChange={(e) => {
                            if (e.target.checked) setSelectedOrderIds([...selectedOrderIds, ord.id]);
                            else setSelectedOrderIds(selectedOrderIds.filter(id => id !== ord.id));
                          }}
                          className="rounded text-[#5A2628]"
                        />
                        <span className="font-mono font-bold text-[#5A2628]">{ord.original_order_number}</span>
                        <span className="text-[#6D6964]">{ord.customer_name} • Rs. {ord.cod_expected.toLocaleString()}</span>
                      </label>
                    ))
                  )}
                </div>
              </div>
            </div>

            <div className="flex justify-end space-x-2 pt-3 border-t border-[#DDD9D4]">
              <button
                onClick={() => setShowCreateModal(false)}
                className="px-4 py-2 text-xs border border-[#DDD9D4] rounded-md font-semibold"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateRun}
                className="px-4 py-2 text-xs bg-[#5A2628] text-white rounded-md font-bold hover:bg-[#471D1F]"
              >
                Create Manifest Batch
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
