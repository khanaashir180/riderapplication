import React, { useState, useEffect } from 'react';
import { RotateCcw, AlertTriangle, RefreshCw, Box, Repeat, CheckCircle2, Phone, Calendar } from 'lucide-react';
import { Order, OrderStatus } from '../../types';
import { api } from '../../services/api';

interface ReturnsWorkspaceProps {
  activeSubTab: string;
  onSelectOrder: (id: string) => void;
}

export function ReturnsWorkspace({ activeSubTab, onSelectOrder }: ReturnsWorkspaceProps) {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadReturnsData();
  }, [activeSubTab]);

  const loadReturnsData = async () => {
    setLoading(true);
    try {
      const res = await api.getOrders({ limit: 300 });
      setOrders(res.orders || []);
    } catch (e) {
      console.error('Failed to load returns data:', e);
    } finally {
      setLoading(false);
    }
  };

  const handleWarehouseReceive = async (pkg: Order) => {
    try {
      await api.receiveWarehouseReceipt({
        packageId: pkg.id,
        scannedPackageNumber: pkg.package_number || pkg.original_order_number || pkg.id,
        packageCondition: 'good',
        restockable: true,
        conditionNotes: 'Checked into warehouse inventory by operator'
      });
      loadReturnsData();
    } catch (e) {
      console.error('Failed to receive at warehouse:', e);
    }
  };

  const handleRiderHandback = async (pkg: Order) => {
    try {
      await api.submitRiderHandback({
        packageId: pkg.id,
        scannedPackageNumber: pkg.package_number || pkg.original_order_number || pkg.id,
        returnReason: pkg.failure_reason || 'Failed delivery return to depot'
      });
      loadReturnsData();
    } catch (e) {
      console.error('Failed to submit rider handback:', e);
    }
  };

  // Subtab filtering logic
  const failedDeliveries = orders.filter(o => ['Customer Unavailable', 'Refused', 'Incorrect Address'].includes(o.current_status));
  const reattemptQueue = orders.filter(o => o.current_status === 'Rescheduled');
  const returningPackages = orders.filter(o => o.current_status === 'Returning to Warehouse');
  const warehouseReceived = orders.filter(o => o.current_status === 'Returned to Warehouse');
  const exchanges = orders.filter(o => o.current_status === 'Exchange Requested');

  const getActiveList = () => {
    switch (activeSubTab) {
      case 'failed': return failedDeliveries;
      case 'reattempt': return reattemptQueue;
      case 'returning': return returningPackages;
      case 'warehouse': return warehouseReceived;
      case 'exchanges': return exchanges;
      default: return failedDeliveries;
    }
  };

  const currentList = getActiveList();

  if (loading) {
    return (
      <div className="p-8 text-center text-xs text-[#6D6964] animate-pulse">
        Loading returns & customer service control queue...
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6 bg-[#F5F4F2] min-h-screen">
      
      {/* Top Banner */}
      <div className="bg-white p-4 rounded-lg border border-[#DDD9D4] shadow-xs flex justify-between items-center">
        <div>
          <h2 className="text-sm font-bold text-[#1F1F1D]">Reverse Logistics & Return Queue Management</h2>
          <p className="text-xs text-[#6D6964]">Track failed delivery reattempts, warehouse intake check-ins, and exchanges</p>
        </div>
        <span className="text-xs font-bold px-3 py-1 bg-[#A56716]/10 text-[#A56716] rounded border border-[#A56716]/30">
          {currentList.length} Items in Current Queue
        </span>
      </div>

      {/* Queue Table */}
      <div className="bg-white rounded-lg border border-[#DDD9D4] shadow-xs overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs text-[#1F1F1D]">
            <thead className="bg-[#F5F4F2] border-b border-[#DDD9D4] text-[11px] font-bold text-[#6D6964] uppercase tracking-wider">
              <tr>
                <th className="p-3">Package #</th>
                <th className="p-3">Customer</th>
                <th className="p-3">Contact</th>
                <th className="p-3">City & Zone</th>
                <th className="p-3">Rider Courier</th>
                <th className="p-3">Current Status</th>
                <th className="p-3 text-right">COD</th>
                <th className="p-3 text-right">Next Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#DDD9D4]">
              {currentList.length === 0 ? (
                <tr>
                  <td colSpan={8} className="p-8 text-center text-xs text-[#6D6964]">
                    No packages currently pending in this reverse logistics queue.
                  </td>
                </tr>
              ) : (
                currentList.map(ord => (
                  <tr key={ord.id} className="hover:bg-[#F5F4F2]/50 transition cursor-pointer" onClick={() => onSelectOrder(ord.id)}>
                    <td className="p-3 font-mono font-bold text-[#5A2628]">{ord.original_order_number}</td>
                    <td className="p-3 font-semibold">{ord.customer_name}</td>
                    <td className="p-3 font-mono text-[#6D6964]">{ord.contact_number}</td>
                    <td className="p-3 text-[#6D6964]">{ord.city}</td>
                    <td className="p-3">{ord.rider?.profile?.full_name || ord.rider?.rider_code || 'Assigned'}</td>
                    <td className="p-3">
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded border bg-amber-50 text-[#A56716] border-amber-200">
                        {ord.current_status}
                      </span>
                    </td>
                    <td className="p-3 text-right font-mono font-bold">Rs. {ord.cod_expected.toLocaleString()}</td>
                    <td className="p-3 text-right space-x-1.5" onClick={e => e.stopPropagation()}>
                      {activeSubTab === 'returning' ? (
                        <button
                          onClick={() => handleWarehouseReceive(ord)}
                          className="px-2.5 py-1 text-[11px] font-bold bg-[#1F7A52] text-white rounded hover:bg-emerald-800 transition"
                        >
                          Intake to Depot
                        </button>
                      ) : activeSubTab === 'failed' ? (
                        <button
                          onClick={() => handleRiderHandback(ord)}
                          className="px-2.5 py-1 text-[11px] font-bold bg-[#A56716] text-white rounded hover:bg-[#8A5410] transition"
                        >
                          Rider Handback
                        </button>
                      ) : (
                        <button
                          onClick={() => onSelectOrder(ord.id)}
                          className="px-2.5 py-1 text-[11px] font-bold bg-[#5A2628] text-white rounded hover:bg-[#471D1F] transition"
                        >
                          Manage Action
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

    </div>
  );
}
