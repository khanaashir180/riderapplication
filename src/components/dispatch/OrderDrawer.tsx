import React, { useState, useEffect } from 'react';
import { X, Phone, MapPin, Calendar, Truck, User, DollarSign, CheckCircle2, AlertTriangle, FileText, Camera } from 'lucide-react';
import { Order, OrderStatus, Rider } from '../../types';
import { api } from '../../services/api';

interface OrderDrawerProps {
  orderId: string;
  onClose: () => void;
  onOrderUpdated?: () => void;
  riders?: Rider[];
}

export function OrderDrawer({ orderId, onClose, onOrderUpdated, riders = [] }: OrderDrawerProps) {
  const [order, setOrder] = useState<Order | null>(null);
  const [loading, setLoading] = useState(true);
  const [isUpdatingStatus, setIsUpdatingStatus] = useState(false);
  const [newStatus, setNewStatus] = useState<OrderStatus>('Out for Delivery');
  const [notes, setNotes] = useState('');
  const [collectedAmount, setCollectedAmount] = useState<number>(0);
  const [selectedRiderId, setSelectedRiderId] = useState<string>('');

  useEffect(() => {
    loadOrder();
  }, [orderId]);

  const loadOrder = async () => {
    setLoading(true);
    try {
      const res = await api.getOrderById(orderId);
      const data = (res.data as any)?.order || res.data || (res as any).order || (res.success && (res as any).id ? res : null);
      if (data && data.id) {
        setOrder(data);
        setNewStatus(data.current_status || 'Imported');
        setCollectedAmount(data.payment_method === 'COD' ? (data.cod_expected || 0) : 0);
        setSelectedRiderId(data.assigned_rider_id || '');
      } else {
        setOrder(null);
      }
    } catch (e) {
      console.error('Failed to load order drawer details:', e);
    } finally {
      setLoading(false);
    }
  };

  const handleUpdateStatus = async () => {
    if (!order) return;
    setIsUpdatingStatus(true);
    try {
      await api.updateOrderStatus(order.id, {
        status: newStatus,
        notes: notes,
        collected_amount: newStatus === 'Delivered' ? collectedAmount : undefined
      });
      await loadOrder();
      if (onOrderUpdated) onOrderUpdated();
    } catch (e) {
      console.error('Failed to update order status:', e);
    } finally {
      setIsUpdatingStatus(false);
    }
  };

  const handleAssignRider = async () => {
    if (!order || !selectedRiderId) return;
    try {
      await api.bulkAssignOrders({ order_ids: [order.id], rider_id: selectedRiderId });
      await loadOrder();
      if (onOrderUpdated) onOrderUpdated();
    } catch (e) {
      console.error('Failed to assign rider:', e);
    }
  };

  if (loading || !order) {
    return (
      <div className="fixed inset-0 z-50 bg-black/30 flex justify-end">
        <div className="w-full max-w-xl bg-white h-full shadow-2xl p-6 flex items-center justify-center">
          <div className="text-xs text-[#6D6964] animate-pulse">Loading order details drawer...</div>
        </div>
      </div>
    );
  }

  const isOverdue = order.promised_delivery_date && new Date(order.promised_delivery_date) < new Date() && !['Delivered', 'Cancelled'].includes(order.current_status);

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex justify-end transition-opacity">
      <div className="w-full max-w-xl bg-white h-full shadow-2xl flex flex-col overflow-hidden animate-in slide-in-from-right duration-200">
        
        {/* Drawer Top Bar */}
        <div className="h-16 px-6 bg-[#F5F4F2] border-b border-[#DDD9D4] flex items-center justify-between shrink-0">
          <div className="flex items-center space-x-3">
            <span className="font-mono text-sm font-bold text-[#5A2628]">{order.original_order_number}</span>
            <span className="text-[11px] font-bold px-2 py-0.5 rounded border bg-white border-[#DDD9D4] text-[#1F1F1D]">
              {order.current_status}
            </span>
            {isOverdue && (
              <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-[#B43B3B]/10 text-[#B43B3B] border border-[#B43B3B]/30">
                Overdue
              </span>
            )}
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg text-[#6D6964] hover:text-[#1F1F1D] hover:bg-stone-200">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Drawer Scrollable Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6 text-xs text-[#1F1F1D]">
          
          {/* Summary Box */}
          <div className="bg-[#F5F4F2] p-4 rounded-lg border border-[#DDD9D4] grid grid-cols-2 gap-4">
            <div>
              <span className="text-[10px] font-semibold text-[#6D6964] block">Package / Dispatch ID</span>
              <span className="font-mono font-bold text-xs">{order.dispatch_id || order.id.substring(0, 10)}</span>
            </div>
            <div>
              <span className="text-[10px] font-semibold text-[#6D6964] block">Parent Order</span>
              <span className="font-mono font-bold text-xs">{order.parent_order_number}</span>
            </div>
            <div>
              <span className="text-[10px] font-semibold text-[#6D6964] block">COD Expected</span>
              <span className="font-mono font-bold text-sm text-[#5A2628]">
                Rs. {order.cod_expected.toLocaleString()}
              </span>
            </div>
            <div>
              <span className="text-[10px] font-semibold text-[#6D6964] block">Payment Method</span>
              <span className="font-semibold text-xs">{order.payment_method}</span>
            </div>
          </div>

          {/* Customer & Address Details */}
          <div className="space-y-3">
            <h4 className="font-bold text-xs uppercase tracking-wider text-[#6D6964]">Customer & Location</h4>
            <div className="p-4 rounded-lg border border-[#DDD9D4] space-y-2.5">
              <div className="flex items-center space-x-2">
                <User className="w-4 h-4 text-[#5A2628]" />
                <span className="font-bold text-sm">{order.customer_name}</span>
              </div>
              <div className="flex items-center space-x-2 text-[#6D6964]">
                <Phone className="w-3.5 h-3.5 text-[#1F7A52]" />
                <a href={`tel:${order.contact_number}`} className="hover:underline font-mono text-xs">{order.contact_number}</a>
              </div>
              <div className="flex items-start space-x-2 text-[#6D6964]">
                <MapPin className="w-3.5 h-3.5 text-[#5A2628] shrink-0 mt-0.5" />
                <span>{order.address}, {order.city} ({order.zone || 'Central Zone'})</span>
              </div>
              {order.customer_notes && (
                <div className="p-2 bg-stone-100 rounded border border-[#DDD9D4] text-[11px] text-[#6D6964]">
                  <strong>Customer Note:</strong> {order.customer_notes}
                </div>
              )}
            </div>
          </div>

          {/* Doorstep Delivery Photo Proof if exists */}
          {order.proof_image_url && (
            <div className="space-y-2">
              <h4 className="font-bold text-xs uppercase tracking-wider text-[#1F7A52] flex items-center space-x-1">
                <CheckCircle2 className="w-4 h-4 text-[#1F7A52]" />
                <span>Verified Doorstep Delivery Proof</span>
              </h4>
              <div className="rounded-lg border border-[#1F7A52]/30 overflow-hidden bg-stone-900">
                <img src={order.proof_image_url} alt="Delivery proof" className="w-full h-48 object-cover" />
              </div>
            </div>
          )}

          {/* Rider Assignment Box */}
          <div className="space-y-3">
            <h4 className="font-bold text-xs uppercase tracking-wider text-[#6D6964]">Assigned Courier</h4>
            <div className="p-4 rounded-lg border border-[#DDD9D4] flex items-center justify-between space-x-3">
              <div className="flex items-center space-x-3">
                <Truck className="w-4 h-4 text-[#5A2628]" />
                <div>
                  <span className="font-bold block">{order.rider?.profile?.full_name || order.rider?.rider_code || 'Unassigned'}</span>
                  <span className="text-[10px] text-[#6D6964]">Vehicle: {order.rider?.vehicle_type || 'N/A'}</span>
                </div>
              </div>
              {riders.length > 0 && (
                <div className="flex items-center space-x-2">
                  <select
                    value={selectedRiderId}
                    onChange={(e) => setSelectedRiderId(e.target.value)}
                    className="py-1 px-2 border border-[#DDD9D4] rounded text-xs bg-[#F5F4F2]"
                  >
                    <option value="">Select Rider...</option>
                    {riders.map(r => (
                      <option key={r.id} value={r.id}>{r.profile?.full_name || r.rider_code}</option>
                    ))}
                  </select>
                  <button
                    onClick={handleAssignRider}
                    className="px-3 py-1 bg-[#5A2628] text-white rounded font-semibold hover:bg-[#471D1F]"
                  >
                    Reassign
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Quick Status Update Box */}
          <div className="space-y-3">
            <h4 className="font-bold text-xs uppercase tracking-wider text-[#6D6964]">Update Package Status</h4>
            <div className="p-4 rounded-lg border border-[#DDD9D4] bg-[#F5F4F2] space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-semibold text-[#6D6964] mb-1">New Status</label>
                  <select
                    value={newStatus}
                    onChange={(e) => setNewStatus(e.target.value as OrderStatus)}
                    className="w-full p-2 border border-[#DDD9D4] rounded-md bg-white text-xs font-semibold"
                  >
                    <option value="Awaiting Assignment">Awaiting Assignment</option>
                    <option value="Assigned">Assigned</option>
                    <option value="Out for Delivery">Out for Delivery</option>
                    <option value="Delivered">Delivered</option>
                    <option value="Customer Unavailable">Customer Unavailable</option>
                    <option value="Rescheduled">Rescheduled</option>
                    <option value="Refused">Refused</option>
                    <option value="Returning to Warehouse">Returning to Warehouse</option>
                    <option value="Returned to Warehouse">Returned to Warehouse</option>
                  </select>
                </div>

                {newStatus === 'Delivered' && order.payment_method === 'COD' && (
                  <div>
                    <label className="block text-[11px] font-semibold text-[#6D6964] mb-1">Collected Cash (PKR)</label>
                    <input
                      type="number"
                      value={collectedAmount}
                      onChange={(e) => setCollectedAmount(Number(e.target.value))}
                      className="w-full p-2 border border-[#DDD9D4] rounded-md bg-white font-mono text-xs font-bold"
                    />
                  </div>
                )}
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-[#6D6964] mb-1">Operational Notes</label>
                <input
                  type="text"
                  placeholder="Reason or notes..."
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  className="w-full p-2 border border-[#DDD9D4] rounded-md bg-white text-xs"
                />
              </div>

              <button
                onClick={handleUpdateStatus}
                disabled={isUpdatingStatus}
                className="w-full py-2 bg-[#5A2628] text-white rounded-md font-bold hover:bg-[#471D1F] transition shadow-xs"
              >
                {isUpdatingStatus ? 'Saving Status...' : 'Confirm Status Update'}
              </button>
            </div>
          </div>

          {/* Status History Timeline */}
          {order.status_history && order.status_history.length > 0 && (
            <div className="space-y-3">
              <h4 className="font-bold text-xs uppercase tracking-wider text-[#6D6964]">Audit Trail & History</h4>
              <div className="divide-y divide-[#DDD9D4] border border-[#DDD9D4] rounded-lg bg-white">
                {order.status_history.map((h) => (
                  <div key={h.id} className="p-3 flex justify-between items-center text-[11px]">
                    <div>
                      <span className="font-semibold text-[#1F1F1D]">{h.new_status}</span>
                      <p className="text-[#6D6964] text-[10px]">By {h.changed_by_name || h.changed_by || 'System'}</p>
                    </div>
                    <span className="font-mono text-[#6D6964] text-[10px]">{new Date(h.changed_at).toLocaleString()}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

        </div>

        {/* Drawer Bottom Action Bar */}
        <div className="p-4 bg-[#F5F4F2] border-t border-[#DDD9D4] flex justify-end shrink-0">
          <button
            onClick={onClose}
            className="px-4 py-1.5 border border-[#DDD9D4] text-[#1F1F1D] rounded-md font-semibold hover:bg-white"
          >
            Close Drawer
          </button>
        </div>

      </div>
    </div>
  );
}
