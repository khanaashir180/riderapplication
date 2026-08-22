import React, { useState, useEffect } from 'react';
import { AlertTriangle, Clock, RotateCcw, DollarSign, Package, ArrowRight } from 'lucide-react';
import { Order } from '../../types';
import { api } from '../../services/api';

interface ExceptionsScreenProps {
  onSelectOrder: (id: string) => void;
}

export function ExceptionsScreen({ onSelectOrder }: ExceptionsScreenProps) {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadExceptions();
  }, []);

  const loadExceptions = async () => {
    setLoading(true);
    try {
      const res = await api.getOrders({ limit: 300 });
      const rawOrders = res.orders || res.data?.orders || (res.data as any)?.items || (Array.isArray(res.data) ? res.data : []);
      setOrders(Array.isArray(rawOrders) ? rawOrders : []);
    } catch (e) {
      console.error('Failed to load exceptions queue:', e);
    } finally {
      setLoading(false);
    }
  };

  const todayStr = new Date().toISOString().split('T')[0];

  const unassignedOld = orders.filter(o => (o.current_status === 'Imported' || o.current_status === 'Awaiting Assignment'));
  const overduePromises = orders.filter(o => {
    if (['Delivered', 'Cancelled', 'Returned to Warehouse'].includes(o.current_status)) return false;
    return o.promised_delivery_date && o.promised_delivery_date < todayStr;
  });
  const failedAttempts = orders.filter(o => ['Customer Unavailable', 'Rescheduled', 'Refused', 'Incorrect Address'].includes(o.current_status));
  const codDiscrepancyPkgs = orders.filter(o => o.current_status === 'Out for Delivery' && o.cod_expected > 20000);

  if (loading) {
    return (
      <div className="p-8 text-center text-xs text-[#6D6964] animate-pulse">
        Loading operational dispatch exceptions...
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6 bg-[#F5F4F2] min-h-screen">
      
      {/* Top Banner */}
      <div className="bg-white p-4 rounded-lg border border-[#DDD9D4] shadow-xs flex items-center justify-between">
        <div>
          <h2 className="text-sm font-bold text-[#1F1F1D]">Dispatch Operational Exception Queues</h2>
          <p className="text-xs text-[#6D6964]">Targeted operational resolution queue for delivery failures and SLA breaches</p>
        </div>
        <span className="text-xs font-bold px-3 py-1 bg-[#B43B3B]/10 text-[#B43B3B] rounded border border-[#B43B3B]/30">
          {unassignedOld.length + overduePromises.length + failedAttempts.length} Total Exceptions
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        
        {/* Failed Attempt Queue */}
        <div className="bg-white rounded-lg border border-[#DDD9D4] p-4 space-y-3">
          <div className="flex justify-between items-center border-b border-[#DDD9D4] pb-2">
            <div className="flex items-center space-x-2">
              <AlertTriangle className="w-4 h-4 text-[#B43B3B]" />
              <h3 className="text-xs font-bold text-[#1F1F1D]">Delivery Failures Needing Action</h3>
            </div>
            <span className="text-[10px] font-bold px-2 py-0.5 bg-[#B43B3B]/10 text-[#B43B3B] rounded">
              {failedAttempts.length}
            </span>
          </div>

          <div className="divide-y divide-[#DDD9D4] max-h-64 overflow-y-auto text-xs">
            {failedAttempts.length === 0 ? (
              <div className="p-4 text-center text-[#6D6964]">No active delivery failures</div>
            ) : (
              failedAttempts.map(ord => (
                <div key={ord.id} className="py-2.5 flex items-center justify-between">
                  <div>
                    <button onClick={() => onSelectOrder(ord.id)} className="font-mono font-bold text-[#5A2628]">
                      {ord.original_order_number}
                    </button>
                    <p className="text-[#6D6964] text-[11px]">{ord.customer_name} • {ord.current_status}</p>
                  </div>
                  <button
                    onClick={() => onSelectOrder(ord.id)}
                    className="px-2.5 py-1 text-[11px] font-bold bg-[#5A2628] text-white rounded hover:bg-[#471D1F]"
                  >
                    Resolve
                  </button>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Overdue SLA Promises */}
        <div className="bg-white rounded-lg border border-[#DDD9D4] p-4 space-y-3">
          <div className="flex justify-between items-center border-b border-[#DDD9D4] pb-2">
            <div className="flex items-center space-x-2">
              <Clock className="w-4 h-4 text-[#A56716]" />
              <h3 className="text-xs font-bold text-[#1F1F1D]">Promised Delivery SLA Overdue</h3>
            </div>
            <span className="text-[10px] font-bold px-2 py-0.5 bg-[#A56716]/10 text-[#A56716] rounded">
              {overduePromises.length}
            </span>
          </div>

          <div className="divide-y divide-[#DDD9D4] max-h-64 overflow-y-auto text-xs">
            {overduePromises.length === 0 ? (
              <div className="p-4 text-center text-[#6D6964]">No overdue delivery promises</div>
            ) : (
              overduePromises.map(ord => (
                <div key={ord.id} className="py-2.5 flex items-center justify-between">
                  <div>
                    <button onClick={() => onSelectOrder(ord.id)} className="font-mono font-bold text-[#5A2628]">
                      {ord.original_order_number}
                    </button>
                    <p className="text-[#6D6964] text-[11px]">Promised: {ord.promised_delivery_date} • {ord.city}</p>
                  </div>
                  <button
                    onClick={() => onSelectOrder(ord.id)}
                    className="px-2.5 py-1 text-[11px] font-semibold bg-[#F5F4F2] border border-[#DDD9D4] rounded hover:bg-white"
                  >
                    View
                  </button>
                </div>
              ))
            )}
          </div>
        </div>

      </div>

    </div>
  );
}
