import React from 'react';
import { 
  MapPin, 
  Phone, 
  MessageCircle, 
  Navigation, 
  CheckCircle2, 
  Clock, 
  AlertCircle,
  Tag
} from 'lucide-react';
import { Package, Order } from '../../types';

function formatWhatsAppNumber(phone: string): string {
  let cleaned = (phone || '').replace(/[^\d]/g, '');
  if (cleaned.startsWith('03')) {
    cleaned = '92' + cleaned.substring(1);
  } else if (cleaned.startsWith('3')) {
    cleaned = '92' + cleaned;
  }
  return cleaned;
}

interface RiderNextStopCardProps {
  order: Order | Package;
  stopNumber: number;
  onRecordAttempt: (order: any) => void;
  onLogContact?: (orderId: string, channel: 'CALL' | 'WHATSAPP') => void;
}

export function RiderNextStopCard({
  order,
  stopNumber,
  onRecordAttempt,
  onLogContact
}: RiderNextStopCardProps) {
  const pkgId = order.original_order_number || (order as any).packageNumber || (order as any).package_number || order.id;
  const customerName = order.customer_name || (order as any).customerName || 'Customer';
  const customerPhone = order.contact_number || (order as any).customerPhone || (order as any).primaryPhone || '';
  const address = order.address || (order as any).deliveryAddress || (order as any).delivery_address || 'Address';
  const city = order.city || 'Lahore';
  const zone = (order as any).zone || '';
  const customerNotes = order.customer_notes || (order as any).customerNotes || (order as any).deliveryInstructions;
  
  // Safe COD check: never determine COD from text/case-sensitive payment gateway names
  const codExpected = order.cod_expected !== undefined ? order.cod_expected : ((order as any).codExpected || 0);
  const isPrepaid = (order.payment_method || (order as any).paymentMethod || '').toLowerCase() === 'prepaid' || codExpected === 0;

  // Attempt count
  const attemptCount = ((order as any).deliveryAttempts || []).length + 1;
  const isReattempt = attemptCount > 1 || (order as any).nextAttemptDate || (order as any).next_attempt_date;

  const handleCall = () => {
    if (onLogContact) onLogContact(order.id, 'CALL');
    window.location.href = `tel:${customerPhone}`;
  };

  const handleWhatsApp = () => {
    if (onLogContact) onLogContact(order.id, 'WHATSAPP');
    const waNum = formatWhatsAppNumber(customerPhone);
    window.open(`https://wa.me/${waNum}?text=${encodeURIComponent(`Hello ${customerName}, this is your Gomila courier regarding package ${pkgId}.`)}`, '_blank');
  };

  const handleNavigate = () => {
    const query = encodeURIComponent(`${address}, ${city}`);
    window.open(`https://maps.google.com/?q=${query}`, '_blank');
  };

  return (
    <div className="bg-white rounded-2xl border-2 border-[#5A2628] p-4 shadow-md space-y-3.5 relative overflow-hidden">
      {/* Top Header Badge */}
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-2">
          <span className="bg-[#5A2628] text-white text-[11px] font-black uppercase px-2.5 py-1 rounded-lg tracking-wider">
            NEXT STOP #{stopNumber}
          </span>
          {isReattempt && (
            <span className="bg-amber-100 text-amber-900 border border-amber-300 text-[10px] font-extrabold px-2 py-0.5 rounded-md flex items-center space-x-1">
              <Clock className="w-3 h-3" />
              <span>Attempt #{attemptCount}</span>
            </span>
          )}
        </div>
        <span className="font-mono text-xs font-bold text-[#5A2628]">{pkgId}</span>
      </div>

      {/* Customer Info */}
      <div className="space-y-1">
        <h3 className="text-lg font-black text-[#1F1F1D] leading-snug">{customerName}</h3>
        <p className="text-xs font-mono text-[#6D6964]">{customerPhone}</p>
      </div>

      {/* Address Block */}
      <div className="bg-[#F5F4F2] p-3 rounded-xl border border-[#DDD9D4] flex items-start space-x-2.5 text-xs text-[#1F1F1D]">
        <MapPin className="w-4 h-4 text-[#5A2628] shrink-0 mt-0.5" />
        <div className="space-y-0.5">
          <p className="font-semibold leading-relaxed">{address}</p>
          <p className="text-[11px] text-[#6D6964]">
            {zone ? `${zone}, ` : ''}{city}
          </p>
        </div>
      </div>

      {/* Prominent Financial / COD Banner */}
      <div className="p-3.5 rounded-xl border flex items-center justify-between bg-stone-50 border-[#DDD9D4]">
        <div>
          <span className="text-[10px] font-extrabold uppercase text-[#6D6964] block">
            Payment Due at Doorstep
          </span>
          {isPrepaid ? (
            <span className="text-base font-black text-emerald-800 font-mono flex items-center space-x-1 mt-0.5">
              <span>PREPAID — COLLECT Rs 0</span>
            </span>
          ) : (
            <span className="text-2xl font-black text-[#5A2628] font-mono block mt-0.5">
              Rs. {codExpected.toLocaleString()}
            </span>
          )}
        </div>
        <span
          className={`text-xs px-2.5 py-1 rounded-full font-black border ${
            isPrepaid
              ? 'bg-emerald-100 text-emerald-800 border-emerald-300'
              : 'bg-amber-100 text-amber-900 border-amber-300'
          }`}
        >
          {isPrepaid ? 'PREPAID' : 'CASH ON DELIVERY'}
        </span>
      </div>

      {/* Customer Delivery Notes if any */}
      {customerNotes && (
        <div className="text-xs text-[#6D6964] bg-amber-50/70 p-2.5 rounded-xl border border-amber-200/80 flex items-start space-x-2">
          <AlertCircle className="w-3.5 h-3.5 text-amber-700 shrink-0 mt-0.5" />
          <span className="text-[11px] leading-tight text-amber-900">
            <strong>Note:</strong> {customerNotes}
          </span>
        </div>
      )}

      {/* Large Actions (Min 44px touch targets) */}
      <div className="grid grid-cols-3 gap-2 pt-1">
        <button
          onClick={handleCall}
          className="h-12 bg-white border border-[#DDD9D4] rounded-xl flex items-center justify-center space-x-1.5 text-xs font-bold text-[#1F1F1D] shadow-xs hover:bg-stone-50 active:scale-95 transition"
        >
          <Phone className="w-4 h-4 text-[#1F7A52]" />
          <span>CALL</span>
        </button>

        <button
          onClick={handleWhatsApp}
          className="h-12 bg-emerald-600 text-white rounded-xl flex items-center justify-center space-x-1.5 text-xs font-bold shadow-xs hover:bg-emerald-700 active:scale-95 transition"
        >
          <MessageCircle className="w-4 h-4" />
          <span>WHATSAPP</span>
        </button>

        <button
          onClick={handleNavigate}
          className="h-12 bg-blue-600 text-white rounded-xl flex items-center justify-center space-x-1.5 text-xs font-bold shadow-xs hover:bg-blue-700 active:scale-95 transition"
        >
          <Navigation className="w-4 h-4" />
          <span>NAVIGATE</span>
        </button>
      </div>

      {/* Large Primary Action Button */}
      <button
        onClick={() => onRecordAttempt(order)}
        className="w-full h-13 bg-[#5A2628] hover:bg-[#471D1F] text-white rounded-xl font-bold text-sm shadow-md flex items-center justify-center space-x-2 active:scale-98 transition mt-2"
      >
        <CheckCircle2 className="w-5 h-5 text-emerald-400" />
        <span>RECORD ATTEMPT / COMPLETE</span>
      </button>
    </div>
  );
}
