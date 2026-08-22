import React, { useState } from 'react';
import {
  Shipment,
  ShipmentEvent,
  PhysicalReturnRecord,
  LogisticsException
} from '../../types/logistics';
import {
  X,
  Package,
  Clock,
  Truck,
  DollarSign,
  AlertTriangle,
  RotateCcw,
  CheckCircle,
  FileText,
  User,
  MapPin,
  Calendar,
  Edit,
  ShieldAlert
} from 'lucide-react';

interface ShipmentDetailDrawerProps {
  shipment: Shipment | null;
  events: ShipmentEvent[];
  physicalReturn: PhysicalReturnRecord | null;
  exceptions: LogisticsException[];
  onClose: () => void;
  onRefresh: () => void;
  token?: string;
}

export function ShipmentDetailDrawer({
  shipment,
  events,
  physicalReturn,
  exceptions,
  onClose,
  onRefresh,
  token
}: ShipmentDetailDrawerProps) {
  const [activeTab, setActiveTab] = useState<'details' | 'timeline' | 'returns' | 'cod' | 'actions'>('details');
  const [actionType, setActionType] = useState<string>('');
  const [actionInput, setActionInput] = useState<string>('');
  const [actionNotes, setActionNotes] = useState<string>('');
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  if (!shipment) return null;

  const handleManualAction = async () => {
    if (!actionType) return;
    setSubmitting(true);
    setMessage(null);

    try {
      const payload: any = {
        action: actionType,
        notes: actionNotes
      };
      if (actionType === 'CORRECT_TRACKING') payload.trackingNumber = actionInput;
      if (actionType === 'REASSIGN_COURIER') payload.courier = actionInput;
      if (actionType === 'RECORD_COD_RECEIVED') payload.codReceived = actionInput;

      const res = await fetch(`/api/logistics/shipments/${shipment.id}/manual-action`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error?.message || 'Action failed');
      }

      setMessage({ type: 'success', text: `Action "${actionType}" executed successfully!` });
      setActionType('');
      setActionInput('');
      setActionNotes('');
      onRefresh();
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setSubmitting(false);
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'DELIVERED':
        return <span className="px-2.5 py-1 text-xs font-bold bg-emerald-100 text-emerald-800 rounded-full border border-emerald-300">Delivered</span>;
      case 'RETURN_AWAITING_PHYSICAL_RECEIPT':
        return <span className="px-2.5 py-1 text-xs font-bold bg-amber-100 text-amber-800 rounded-full border border-amber-300">Return Awaiting Receipt</span>;
      case 'RETURN_PHYSICALLY_RECEIVED':
        return <span className="px-2.5 py-1 text-xs font-bold bg-purple-100 text-purple-800 rounded-full border border-purple-300">Return Physically Received</span>;
      case 'PENDING_DELIVERY':
        return <span className="px-2.5 py-1 text-xs font-bold bg-blue-100 text-blue-800 rounded-full border border-blue-300">Pending Delivery</span>;
      case 'UNBOOKED':
        return <span className="px-2.5 py-1 text-xs font-bold bg-stone-100 text-stone-700 rounded-full border border-stone-300">Unbooked</span>;
      default:
        return <span className="px-2.5 py-1 text-xs font-bold bg-red-100 text-red-800 rounded-full border border-red-300">Exception</span>;
    }
  };

  return (
    <div className="fixed inset-0 z-50 overflow-hidden bg-black/40 backdrop-blur-xs flex justify-end">
      <div className="w-full max-w-2xl bg-white h-full shadow-2xl flex flex-col animate-in slide-in-from-right duration-200">
        
        {/* Drawer Header */}
        <div className="p-5 border-b border-[#DDD9D4] bg-[#5A2628] text-white flex justify-between items-center">
          <div>
            <div className="flex items-center space-x-2">
              <span className="text-xs uppercase font-mono tracking-wider opacity-80">Shipment Details</span>
              {shipment.lateByCourier && (
                <span className="px-2 py-0.5 text-[10px] font-extrabold bg-red-500 text-white rounded-md tracking-wider">
                  LATE ({shipment.deliveryAgeHours}h &gt; 96h)
                </span>
              )}
            </div>
            <h2 className="text-xl font-bold font-mono tracking-tight text-white mt-0.5">
              {shipment.trackingNumber}
            </h2>
            <p className="text-xs text-stone-200">
              Order: <span className="font-semibold text-white">{shipment.orderNumber}</span> (Parent: {shipment.parentOrderNumber})
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-stone-200 hover:text-white hover:bg-white/10 rounded-lg transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Status Bar */}
        <div className="p-4 bg-[#F5F4F2] border-b border-[#DDD9D4] flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <span className="text-xs font-semibold text-[#6D6964]">Status:</span>
            {getStatusBadge(shipment.logisticsStatus)}
          </div>
          <div className="flex items-center space-x-3 text-xs">
            <span className="font-semibold text-[#6D6964]">Courier: <strong className="text-[#1F1F1D]">{shipment.courier}</strong></span>
            <span className="text-[#DDD9D4]">|</span>
            <span className="font-semibold text-[#6D6964]">COD: <strong className="text-[#5A2628]">PKR {shipment.codExpected.toLocaleString()}</strong></span>
          </div>
        </div>

        {/* Drawer Tabs */}
        <div className="flex border-b border-[#DDD9D4] bg-white px-4">
          <button
            onClick={() => setActiveTab('details')}
            className={`px-4 py-3 text-xs font-bold transition border-b-2 ${
              activeTab === 'details' ? 'border-[#5A2628] text-[#5A2628]' : 'border-transparent text-[#6D6964] hover:text-[#1F1F1D]'
            }`}
          >
            Overview & Items
          </button>
          <button
            onClick={() => setActiveTab('timeline')}
            className={`px-4 py-3 text-xs font-bold transition border-b-2 ${
              activeTab === 'timeline' ? 'border-[#5A2628] text-[#5A2628]' : 'border-transparent text-[#6D6964] hover:text-[#1F1F1D]'
            }`}
          >
            Timeline ({events.length})
          </button>
          <button
            onClick={() => setActiveTab('returns')}
            className={`px-4 py-3 text-xs font-bold transition border-b-2 ${
              activeTab === 'returns' ? 'border-[#5A2628] text-[#5A2628]' : 'border-transparent text-[#6D6964] hover:text-[#1F1F1D]'
            }`}
          >
            Returns Audit
          </button>
          <button
            onClick={() => setActiveTab('cod')}
            className={`px-4 py-3 text-xs font-bold transition border-b-2 ${
              activeTab === 'cod' ? 'border-[#5A2628] text-[#5A2628]' : 'border-transparent text-[#6D6964] hover:text-[#1F1F1D]'
            }`}
          >
            COD & Financials
          </button>
          <button
            onClick={() => setActiveTab('actions')}
            className={`px-4 py-3 text-xs font-bold transition border-b-2 ${
              activeTab === 'actions' ? 'border-[#5A2628] text-[#5A2628]' : 'border-transparent text-[#6D6964] hover:text-[#1F1F1D]'
            }`}
          >
            Manual Actions
          </button>
        </div>

        {/* Drawer Content Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-6">

          {message && (
            <div className={`p-3 rounded-lg text-xs font-medium flex items-center space-x-2 ${
              message.type === 'success' ? 'bg-emerald-50 text-emerald-800 border border-emerald-200' : 'bg-red-50 text-red-800 border border-red-200'
            }`}>
              {message.type === 'success' ? <CheckCircle className="w-4 h-4 text-emerald-600 shrink-0" /> : <AlertTriangle className="w-4 h-4 text-red-600 shrink-0" />}
              <span>{message.text}</span>
            </div>
          )}

          {/* TAB 1: OVERVIEW & ITEMS */}
          {activeTab === 'details' && (
            <div className="space-y-6">
              
              {/* Customer Info Card */}
              <div className="bg-[#F5F4F2] p-4 rounded-xl border border-[#DDD9D4] space-y-3">
                <h3 className="text-xs font-bold uppercase tracking-wider text-[#6D6964] flex items-center space-x-1.5">
                  <User className="w-3.5 h-3.5" />
                  <span>Customer & Shipping Info</span>
                </h3>
                <div className="grid grid-cols-2 gap-4 text-xs">
                  <div>
                    <span className="text-[#6D6964] block text-[11px]">Customer Name</span>
                    <span className="font-bold text-[#1F1F1D]">{shipment.customerName}</span>
                  </div>
                  <div>
                    <span className="text-[#6D6964] block text-[11px]">Contact Phone</span>
                    <span className="font-bold font-mono text-[#1F1F1D]">{shipment.customerPhone || 'N/A'}</span>
                  </div>
                  <div>
                    <span className="text-[#6D6964] block text-[11px]">Destination City</span>
                    <span className="font-bold text-[#1F1F1D] flex items-center space-x-1">
                      <MapPin className="w-3 h-3 text-[#5A2628]" />
                      <span>{shipment.destinationCity}</span>
                    </span>
                  </div>
                  <div>
                    <span className="text-[#6D6964] block text-[11px]">Courier Assigned</span>
                    <span className="font-bold text-[#1F1F1D]">{shipment.courier}</span>
                  </div>
                </div>
                <div>
                  <span className="text-[#6D6964] block text-[11px]">Shipping Address</span>
                  <p className="text-xs text-[#1F1F1D] font-medium mt-0.5 bg-white p-2.5 rounded-lg border border-[#DDD9D4]">
                    {shipment.shippingAddress || 'No address specified'}
                  </p>
                </div>
              </div>

              {/* Product Line Items Table */}
              <div>
                <h3 className="text-xs font-bold uppercase tracking-wider text-[#6D6964] mb-2 flex items-center space-x-1.5">
                  <Package className="w-3.5 h-3.5" />
                  <span>Shipment Product Lines ({shipment.items?.length || 0})</span>
                </h3>
                <div className="border border-[#DDD9D4] rounded-xl overflow-hidden bg-white">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-[#F5F4F2] border-b border-[#DDD9D4] text-[#6D6964] uppercase text-[10px] font-extrabold">
                      <tr>
                        <th className="py-2.5 px-3">SKU</th>
                        <th className="py-2.5 px-3">Title</th>
                        <th className="py-2.5 px-3 text-center">Qty</th>
                        <th className="py-2.5 px-3 text-right">Unit Price</th>
                        <th className="py-2.5 px-3 text-right">Total</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#DDD9D4]">
                      {shipment.items && shipment.items.length > 0 ? (
                        shipment.items.map((item, idx) => (
                          <tr key={idx} className="hover:bg-stone-50">
                            <td className="py-2.5 px-3 font-mono font-bold text-[#5A2628]">{item.sku}</td>
                            <td className="py-2.5 px-3 font-medium text-[#1F1F1D]">{item.title}</td>
                            <td className="py-2.5 px-3 text-center font-bold">{item.quantity}</td>
                            <td className="py-2.5 px-3 text-right text-[#6D6964]">PKR {item.unitPrice.toLocaleString()}</td>
                            <td className="py-2.5 px-3 text-right font-bold text-[#1F1F1D]">
                              PKR {((item.totalAmount || item.unitPrice * item.quantity)).toLocaleString()}
                            </td>
                          </tr>
                        ))
                      ) : (
                        <tr>
                          <td colSpan={5} className="py-4 text-center text-xs text-[#6D6964]">No items recorded</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Key Timestamps Grid */}
              <div className="bg-white p-4 rounded-xl border border-[#DDD9D4] space-y-3">
                <h3 className="text-xs font-bold uppercase tracking-wider text-[#6D6964] flex items-center space-x-1.5">
                  <Calendar className="w-3.5 h-3.5" />
                  <span>Lifecycle Milestones</span>
                </h3>
                <div className="grid grid-cols-2 gap-3 text-xs">
                  <div className="p-2.5 bg-[#F5F4F2] rounded-lg">
                    <span className="text-[#6D6964] block text-[10px]">OMS Order Date</span>
                    <span className="font-mono font-bold">{shipment.omsOrderDate ? new Date(shipment.omsOrderDate).toLocaleString() : 'N/A'}</span>
                  </div>
                  <div className="p-2.5 bg-[#F5F4F2] rounded-lg">
                    <span className="text-[#6D6964] block text-[10px]">Courier Booked At</span>
                    <span className="font-mono font-bold">{shipment.courierBookedAt ? new Date(shipment.courierBookedAt).toLocaleString() : 'Not Booked'}</span>
                  </div>
                  <div className="p-2.5 bg-[#F5F4F2] rounded-lg">
                    <span className="text-[#6D6964] block text-[10px]">Courier Delivered At</span>
                    <span className="font-mono font-bold">{shipment.courierDeliveredAt ? new Date(shipment.courierDeliveredAt).toLocaleString() : 'Not Delivered'}</span>
                  </div>
                  <div className="p-2.5 bg-[#F5F4F2] rounded-lg">
                    <span className="text-[#6D6964] block text-[10px]">Return Marked At</span>
                    <span className="font-mono font-bold">{shipment.courierReturnMarkedAt ? new Date(shipment.courierReturnMarkedAt).toLocaleString() : 'N/A'}</span>
                  </div>
                </div>
              </div>

            </div>
          )}

          {/* TAB 2: TIMELINE / AUDIT TRAIL */}
          {activeTab === 'timeline' && (
            <div className="space-y-4">
              <h3 className="text-xs font-bold uppercase tracking-wider text-[#6D6964] flex items-center space-x-1.5">
                <Clock className="w-3.5 h-3.5" />
                <span>Status Change Audit Trail ({events.length})</span>
              </h3>
              
              <div className="space-y-3 relative pl-4 border-l-2 border-[#DDD9D4]">
                {events && events.length > 0 ? (
                  events.map((evt) => (
                    <div key={evt.id} className="bg-white p-3.5 rounded-xl border border-[#DDD9D4] space-y-1 text-xs relative">
                      <div className="w-2.5 h-2.5 rounded-full bg-[#5A2628] absolute -left-[21px] top-4"></div>
                      <div className="flex justify-between items-start">
                        <span className="font-bold text-[#5A2628]">{evt.eventType}</span>
                        <span className="text-[10px] text-[#6D6964] font-mono">{new Date(evt.eventTimestamp).toLocaleString()}</span>
                      </div>
                      <p className="text-[#1F1F1D] font-medium">{evt.notes || `Status updated to ${evt.newStatus}`}</p>
                      <div className="flex items-center space-x-2 text-[10px] text-[#6D6964] pt-1 border-t border-stone-100">
                        <span>Source: <strong>{evt.source}</strong></span>
                        <span>•</span>
                        <span>By: <strong>{evt.performedBy}</strong></span>
                      </div>
                    </div>
                  ))
                ) : (
                  <p className="text-xs text-[#6D6964]">No events recorded yet.</p>
                )}
              </div>
            </div>
          )}

          {/* TAB 3: RETURNS AUDIT */}
          {activeTab === 'returns' && (
            <div className="space-y-5">
              <div className="p-4 rounded-xl bg-purple-50 border border-purple-200 text-xs text-purple-900 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-bold uppercase tracking-wider text-[11px] flex items-center space-x-1.5">
                    <RotateCcw className="w-4 h-4 text-purple-700" />
                    <span>Physical Return Audit Status</span>
                  </span>
                  {shipment.physicalReturnReceived ? (
                    <span className="px-2.5 py-1 font-bold bg-purple-600 text-white rounded-full text-[10px]">
                      CONFIRMED RECEIVED
                    </span>
                  ) : (
                    <span className="px-2.5 py-1 font-bold bg-amber-500 text-white rounded-full text-[10px]">
                      AWAITING PHYSICAL RECEIPT
                    </span>
                  )}
                </div>
                <p className="text-purple-800 text-[11px]">
                  Rule: Courier status "Returned" only marks package as awaiting physical receipt. Warehouse staff must physically scan & inspect the item to confirm receipt.
                </p>
              </div>

              {physicalReturn ? (
                <div className="bg-white p-4 rounded-xl border border-[#DDD9D4] space-y-3 text-xs">
                  <h4 className="font-bold text-[#1F1F1D] text-sm border-b border-[#DDD9D4] pb-2">
                    Physical Warehouse Receipt Record
                  </h4>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <span className="text-[#6D6964] block text-[10px]">Received By</span>
                      <span className="font-bold">{physicalReturn.receivedBy}</span>
                    </div>
                    <div>
                      <span className="text-[#6D6964] block text-[10px]">Received Timestamp</span>
                      <span className="font-mono font-bold">{new Date(physicalReturn.receivedAt).toLocaleString()}</span>
                    </div>
                    <div>
                      <span className="text-[#6D6964] block text-[10px]">Warehouse Location</span>
                      <span className="font-bold text-[#5A2628]">{physicalReturn.location}</span>
                    </div>
                    <div>
                      <span className="text-[#6D6964] block text-[10px]">Product Condition</span>
                      <span className="font-bold text-amber-800 bg-amber-50 px-2 py-0.5 rounded border border-amber-200">
                        {physicalReturn.condition}
                      </span>
                    </div>
                    <div>
                      <span className="text-[#6D6964] block text-[10px]">Return Disposition</span>
                      <span className="font-bold text-purple-800 bg-purple-50 px-2 py-0.5 rounded border border-purple-200">
                        {physicalReturn.disposition}
                      </span>
                    </div>
                    <div>
                      <span className="text-[#6D6964] block text-[10px]">Qty Expected / Received</span>
                      <span className="font-bold font-mono">{physicalReturn.quantityExpected} / {physicalReturn.quantityReceived}</span>
                    </div>
                  </div>
                  {physicalReturn.remarks && (
                    <div className="pt-2 border-t border-[#DDD9D4]">
                      <span className="text-[#6D6964] block text-[10px]">Warehouse Staff Remarks</span>
                      <p className="text-xs italic text-[#1F1F1D]">{physicalReturn.remarks}</p>
                    </div>
                  )}
                </div>
              ) : (
                <div className="p-8 text-center bg-[#F5F4F2] rounded-xl border border-dashed border-[#DDD9D4] text-[#6D6964] text-xs space-y-2">
                  <Package className="w-8 h-8 text-[#6D6964] mx-auto opacity-40" />
                  <p className="font-bold">No Physical Warehouse Receipt On Record</p>
                  <p className="text-[11px]">This return parcel has not been physically scanned by warehouse intake staff.</p>
                </div>
              )}
            </div>
          )}

          {/* TAB 4: COD & FINANCIALS */}
          {activeTab === 'cod' && (
            <div className="space-y-5">
              <div className="bg-white p-4 rounded-xl border border-[#DDD9D4] space-y-3 text-xs">
                <h4 className="font-bold text-[#1F1F1D] text-sm flex items-center justify-between border-b border-[#DDD9D4] pb-2">
                  <span>Cash On Delivery Breakdown</span>
                  <span className={`px-2.5 py-0.5 rounded-full text-[10px] font-extrabold ${
                    shipment.codStatus === 'RECEIVED' ? 'bg-emerald-100 text-emerald-800' :
                    shipment.codStatus === 'PENDING' ? 'bg-amber-100 text-amber-800' : 'bg-stone-100 text-stone-800'
                  }`}>
                    {shipment.codStatus}
                  </span>
                </h4>

                <div className="grid grid-cols-3 gap-3 text-center">
                  <div className="p-3 bg-[#F5F4F2] rounded-xl border border-[#DDD9D4]">
                    <span className="text-[10px] text-[#6D6964] uppercase font-bold block">COD Expected</span>
                    <span className="text-sm font-bold font-mono text-[#5A2628]">PKR {shipment.codExpected.toLocaleString()}</span>
                  </div>
                  <div className="p-3 bg-emerald-50 rounded-xl border border-emerald-200">
                    <span className="text-[10px] text-emerald-800 uppercase font-bold block">COD Received</span>
                    <span className="text-sm font-bold font-mono text-emerald-900">PKR {shipment.codReceived.toLocaleString()}</span>
                  </div>
                  <div className="p-3 bg-amber-50 rounded-xl border border-amber-200">
                    <span className="text-[10px] text-amber-800 uppercase font-bold block">COD Pending</span>
                    <span className="text-sm font-bold font-mono text-amber-900">PKR {shipment.codPending.toLocaleString()}</span>
                  </div>
                </div>

                <div className="pt-2 text-[11px] text-[#6D6964] space-y-1">
                  <p>• Rule 9: Delivered orders are not automatically treated as COD received.</p>
                  <p>• Rule 10: Courier status updates do not overwrite accounts settlement data.</p>
                </div>
              </div>
            </div>
          )}

          {/* TAB 5: MANUAL ACTIONS */}
          {activeTab === 'actions' && (
            <div className="space-y-4">
              <div className="p-4 bg-amber-50 border border-amber-200 rounded-xl text-xs text-amber-900 space-y-1">
                <p className="font-bold flex items-center space-x-1">
                  <ShieldAlert className="w-4 h-4 text-amber-700" />
                  <span>Controlled Operator Actions</span>
                </p>
                <p className="text-[11px]">All manual overrides are logged into the audit trail with operator identity.</p>
              </div>

              <div className="bg-white p-4 rounded-xl border border-[#DDD9D4] space-y-4">
                <label className="block text-xs font-bold text-[#1F1F1D]">Select Action</label>
                <select
                  value={actionType}
                  onChange={e => {
                    setActionType(e.target.value);
                    setActionInput('');
                  }}
                  className="w-full px-3 py-2 bg-[#F5F4F2] border border-[#DDD9D4] rounded-lg text-xs font-medium focus:outline-hidden"
                >
                  <option value="">-- Choose Controlled Action --</option>
                  <option value="CORRECT_TRACKING">Correct Tracking Number</option>
                  <option value="REASSIGN_COURIER">Reassign Courier Company</option>
                  <option value="RECORD_COD_RECEIVED">Record COD Remittance Received</option>
                  <option value="RECALCULATE_STATUS">Recalculate Late SLA Status</option>
                </select>

                {actionType === 'CORRECT_TRACKING' && (
                  <div>
                    <label className="block text-[11px] font-semibold text-[#6D6964] mb-1">New Tracking Number</label>
                    <input
                      type="text"
                      value={actionInput}
                      onChange={e => setActionInput(e.target.value)}
                      placeholder="e.g. TRX-99887766"
                      className="w-full px-3 py-2 border border-[#DDD9D4] rounded-lg text-xs font-mono"
                    />
                  </div>
                )}

                {actionType === 'REASSIGN_COURIER' && (
                  <div>
                    <label className="block text-[11px] font-semibold text-[#6D6964] mb-1">New Courier Company</label>
                    <select
                      value={actionInput}
                      onChange={e => setActionInput(e.target.value)}
                      className="w-full px-3 py-2 border border-[#DDD9D4] rounded-lg text-xs"
                    >
                      <option value="">Select Courier</option>
                      <option value="TRAX">TRAX</option>
                      <option value="PostEx">PostEx</option>
                      <option value="TCS">TCS</option>
                      <option value="Company Rider">Company Rider</option>
                    </select>
                  </div>
                )}

                {actionType === 'RECORD_COD_RECEIVED' && (
                  <div>
                    <label className="block text-[11px] font-semibold text-[#6D6964] mb-1">Amount Received (PKR)</label>
                    <input
                      type="number"
                      value={actionInput}
                      onChange={e => setActionInput(e.target.value)}
                      placeholder="e.g. 4500"
                      className="w-full px-3 py-2 border border-[#DDD9D4] rounded-lg text-xs font-mono"
                    />
                  </div>
                )}

                <div>
                  <label className="block text-[11px] font-semibold text-[#6D6964] mb-1">Reason / Operator Notes</label>
                  <textarea
                    value={actionNotes}
                    onChange={e => setActionNotes(e.target.value)}
                    rows={3}
                    placeholder="Enter explicit reason for audit log..."
                    className="w-full px-3 py-2 border border-[#DDD9D4] rounded-lg text-xs"
                  ></textarea>
                </div>

                <button
                  onClick={handleManualAction}
                  disabled={!actionType || submitting}
                  className="w-full py-2.5 bg-[#5A2628] text-white rounded-lg text-xs font-bold hover:bg-[#471D1F] transition disabled:opacity-50"
                >
                  {submitting ? 'Executing Action...' : 'Confirm & Log Manual Override'}
                </button>
              </div>
            </div>
          )}

        </div>

      </div>
    </div>
  );
}
