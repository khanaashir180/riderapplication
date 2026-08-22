import React from 'react';
import { 
  Clock, 
  MapPin, 
  Phone, 
  MessageCircle, 
  Navigation, 
  CheckCircle2, 
  Calendar, 
  AlertCircle 
} from 'lucide-react';
import { Order, Package, formatOperationalStatus } from '../../types';

function formatWhatsAppNumber(phone: string): string {
  let cleaned = (phone || '').replace(/[^\d]/g, '');
  if (cleaned.startsWith('03')) {
    cleaned = '92' + cleaned.substring(1);
  } else if (cleaned.startsWith('3')) {
    cleaned = '92' + cleaned;
  }
  return cleaned;
}

interface RiderReattemptsTabProps {
  orders: (Order | Package)[];
  onRecordAttempt: (order: any) => void;
  onLogContact?: (orderId: string, channel: 'CALL' | 'WHATSAPP') => void;
}

export function RiderReattemptsTab({
  orders,
  onRecordAttempt,
  onLogContact
}: RiderReattemptsTabProps) {
  // Filter reattempt orders: any order with previous attempt history, next_attempt_date, or rescheduled status
  const reattemptOrders = orders.filter((o: any) => {
    const attempts = o.deliveryAttempts || [];
    const hasNextAttempt = o.nextAttemptDate || o.next_attempt_date;
    const isRescheduled = (o.operationalStatus || o.current_status || '').toLowerCase().includes('rescheduled');
    const isUnavailable = (o.operationalStatus || o.current_status || '').toLowerCase().includes('unavailable');
    return attempts.length > 0 || hasNextAttempt || isRescheduled || isUnavailable;
  });

  return (
    <div className="space-y-4">
      {/* Header Banner */}
      <div className="bg-amber-50 border border-amber-300 p-4 rounded-2xl shadow-xs space-y-1">
        <div className="flex items-center space-x-2">
          <Clock className="w-5 h-5 text-amber-800" />
          <h3 className="text-sm font-black text-amber-950 uppercase tracking-tight">
            Priority Reattempts ({reattemptOrders.length})
          </h3>
        </div>
        <p className="text-xs text-amber-800 leading-relaxed">
          Orders with previous delivery attempts, customer-requested appointments, or rescheduled timings.
        </p>
      </div>

      {/* Orders List */}
      {reattemptOrders.length === 0 ? (
        <div className="bg-white p-8 text-center rounded-2xl border border-[#DDD9D4] space-y-2">
          <CheckCircle2 className="w-8 h-8 text-emerald-600 mx-auto" />
          <p className="font-bold text-sm text-[#1F1F1D]">No Reattempts Pending</p>
          <p className="text-xs text-[#6D6964]">
            All assigned deliveries are on their primary route sequence.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {reattemptOrders.map((ord: any, idx: number) => {
            const pkgId = ord.original_order_number || ord.packageNumber || ord.package_number || ord.id;
            const customerName = ord.customer_name || ord.customerName || 'Customer';
            const customerPhone = ord.contact_number || ord.customerPhone || ord.primaryPhone || '';
            const address = ord.address || ord.deliveryAddress || ord.delivery_address || 'Address';
            const city = ord.city || 'Lahore';
            const attempts = ord.deliveryAttempts || [];
            const attemptCount = attempts.length + 1;
            const lastAttempt = attempts.length > 0 ? attempts[attempts.length - 1] : null;
            const failureReason = ord.failure_reason || ord.failureReason || lastAttempt?.reason || 'Customer Unavailable';
            const requestedDate = ord.next_attempt_date || ord.nextAttemptDate || lastAttempt?.newDeliveryDate;
            const codExpected = ord.cod_expected !== undefined ? ord.cod_expected : (ord.codExpected || 0);
            const isPrepaid = (ord.payment_method || ord.paymentMethod || '').toLowerCase() === 'prepaid' || codExpected === 0;

            const handleCall = () => {
              if (onLogContact) onLogContact(ord.id, 'CALL');
              window.location.href = `tel:${customerPhone}`;
            };

            const handleWhatsApp = () => {
              if (onLogContact) onLogContact(ord.id, 'WHATSAPP');
              const waNum = formatWhatsAppNumber(customerPhone);
              window.open(`https://wa.me/${waNum}?text=${encodeURIComponent(`Hello ${customerName}, this is Gomila regarding your rescheduled package ${pkgId}.`)}`, '_blank');
            };

            const handleNavigate = () => {
              const query = encodeURIComponent(`${address}, ${city}`);
              window.open(`https://maps.google.com/?q=${query}`, '_blank');
            };

            return (
              <div key={ord.id || idx} className="bg-white rounded-2xl border-2 border-amber-300 p-4 shadow-xs space-y-3">
                {/* Header Badge */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-2">
                    <span className="bg-amber-600 text-white font-mono text-xs font-black px-2 py-0.5 rounded-md">
                      ATTEMPT #{attemptCount}
                    </span>
                    <span className="font-mono text-xs font-bold text-[#5A2628]">{pkgId}</span>
                  </div>
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-stone-100 text-stone-700">
                    {formatOperationalStatus(ord.operationalStatus || ord.current_status)}
                  </span>
                </div>

                {/* Customer Details */}
                <div className="space-y-0.5">
                  <h4 className="text-base font-black text-[#1F1F1D]">{customerName}</h4>
                  <p className="text-xs font-mono text-[#6D6964]">{customerPhone}</p>
                </div>

                {/* Address */}
                <div className="flex items-start space-x-2 text-xs text-[#1F1F1D] bg-[#F5F4F2] p-2.5 rounded-xl border border-[#DDD9D4]">
                  <MapPin className="w-4 h-4 text-[#5A2628] shrink-0 mt-0.5" />
                  <span className="font-medium">{address}, {city}</span>
                </div>

                {/* Previous Failure & Customer Time Info */}
                <div className="bg-amber-50/80 p-3 rounded-xl border border-amber-200 space-y-1.5 text-xs text-amber-950">
                  <div className="flex items-start space-x-2">
                    <AlertCircle className="w-3.5 h-3.5 text-amber-800 shrink-0 mt-0.5" />
                    <div>
                      <span className="font-extrabold block">Previous Failure Reason:</span>
                      <span className="font-medium text-amber-900">{failureReason}</span>
                    </div>
                  </div>

                  {requestedDate && (
                    <div className="flex items-start space-x-2 pt-1 border-t border-amber-200/60">
                      <Calendar className="w-3.5 h-3.5 text-blue-700 shrink-0 mt-0.5" />
                      <div>
                        <span className="font-extrabold text-blue-950 block">Customer-Requested Time:</span>
                        <span className="font-bold text-blue-900 font-mono">{requestedDate}</span>
                      </div>
                    </div>
                  )}

                  {lastAttempt?.timestamp && (
                    <p className="text-[10px] text-amber-800 font-mono pt-0.5">
                      Last Attempt: {new Date(lastAttempt.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </p>
                  )}
                </div>

                {/* COD Bar */}
                <div className="flex items-center justify-between p-2.5 bg-stone-50 rounded-xl border border-[#DDD9D4]">
                  <span className="text-xs font-extrabold uppercase text-[#6D6964]">Cash Due</span>
                  {isPrepaid ? (
                    <span className="text-xs font-black text-emerald-800 font-mono">
                      PREPAID — COLLECT Rs 0
                    </span>
                  ) : (
                    <span className="text-base font-black text-[#5A2628] font-mono">
                      Rs. {codExpected.toLocaleString()}
                    </span>
                  )}
                </div>

                {/* Action Buttons */}
                <div className="grid grid-cols-3 gap-2">
                  <button
                    onClick={handleCall}
                    className="h-11 bg-white border border-[#DDD9D4] rounded-xl flex items-center justify-center space-x-1 text-xs font-bold text-[#1F1F1D] hover:bg-stone-50 active:scale-95 transition"
                  >
                    <Phone className="w-3.5 h-3.5 text-[#1F7A52]" />
                    <span>CALL</span>
                  </button>

                  <button
                    onClick={handleWhatsApp}
                    className="h-11 bg-emerald-600 text-white rounded-xl flex items-center justify-center space-x-1 text-xs font-bold hover:bg-emerald-700 active:scale-95 transition"
                  >
                    <MessageCircle className="w-3.5 h-3.5" />
                    <span>WHATSAPP</span>
                  </button>

                  <button
                    onClick={handleNavigate}
                    className="h-11 bg-blue-600 text-white rounded-xl flex items-center justify-center space-x-1 text-xs font-bold hover:bg-blue-700 active:scale-95 transition"
                  >
                    <Navigation className="w-3.5 h-3.5" />
                    <span>NAVIGATE</span>
                  </button>
                </div>

                {/* Record Reattempt Action */}
                <button
                  onClick={() => onRecordAttempt(ord)}
                  className="w-full h-12 bg-[#5A2628] hover:bg-[#471D1F] text-white rounded-xl font-bold text-xs shadow-xs flex items-center justify-center space-x-2 active:scale-98 transition"
                >
                  <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                  <span>RECORD REATTEMPT OUTCOME</span>
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
