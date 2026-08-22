import React from 'react';
import { 
  MapPin, 
  Phone, 
  MessageCircle, 
  Navigation, 
  CheckCircle2, 
  Clock, 
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

interface RiderPackageCardProps {
  order: Order | Package;
  sequenceIndex?: number;
  onRecordAttempt: (order: any) => void;
  onLogContact?: (orderId: string, channel: 'CALL' | 'WHATSAPP') => void;
}

export function RiderPackageCard({
  order,
  sequenceIndex,
  onRecordAttempt,
  onLogContact
}: RiderPackageCardProps) {
  const pkgId = order.original_order_number || (order as any).packageNumber || (order as any).package_number || order.id;
  const customerName = order.customer_name || (order as any).customerName || 'Customer';
  const customerPhone = order.contact_number || (order as any).customerPhone || (order as any).primaryPhone || '';
  const address = order.address || (order as any).deliveryAddress || (order as any).delivery_address || 'Address';
  const city = order.city || 'Lahore';
  const zone = (order as any).zone || '';
  const status = ((order as any).operational_status || (order as any).operationalStatus || order.current_status || 'OUT_FOR_DELIVERY');
  const stopDelivery = Boolean((order as any).stopDeliveryInstruction || (order as any).operationalExceptionCode === 'STOP_DELIVERY');

  // Safe COD check: canonical codExpected or cod_expected
  const codExpected = order.cod_expected !== undefined ? order.cod_expected : ((order as any).codExpected || 0);
  const isPrepaid = (order.payment_method || (order as any).paymentMethod || '').toLowerCase() === 'prepaid' || codExpected === 0;

  const attemptCount = ((order as any).deliveryAttempts || []).length + 1;
  const isReattempt = attemptCount > 1 || (order as any).nextAttemptDate || (order as any).next_attempt_date;

  const handleCall = () => {
    if (onLogContact) onLogContact(order.id, 'CALL');
    window.location.href = `tel:${customerPhone}`;
  };

  const handleWhatsApp = () => {
    if (onLogContact) onLogContact(order.id, 'WHATSAPP');
    const waNum = formatWhatsAppNumber(customerPhone);
    window.open(`https://wa.me/${waNum}?text=${encodeURIComponent(`Hello ${customerName}, this is Gomila courier regarding package ${pkgId}.`)}`, '_blank');
  };

  const handleNavigate = () => {
    const query = encodeURIComponent(`${address}, ${city}`);
    window.open(`https://maps.google.com/?q=${query}`, '_blank');
  };

  return (
    <div className="bg-white rounded-2xl border border-[#DDD9D4] p-3.5 shadow-xs space-y-3">
      {/* Top Header Row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-2">
          {sequenceIndex !== undefined && (
            <span className="w-5 h-5 rounded-md bg-[#F5F4F2] text-[#6D6964] font-bold text-[10px] flex items-center justify-center">
              #{sequenceIndex + 1}
            </span>
          )}
          <span className="font-mono text-xs font-bold text-[#5A2628]">{pkgId}</span>
        </div>

        <div className="flex items-center space-x-1.5">
          {isReattempt && (
            <span className="bg-amber-100 text-amber-900 border border-amber-300 text-[10px] font-extrabold px-1.5 py-0.5 rounded flex items-center space-x-1">
              <Clock className="w-3 h-3" />
              <span>Att #{attemptCount}</span>
            </span>
          )}
          <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-stone-100 text-stone-700">
            {formatOperationalStatus(status)}
          </span>
        </div>
      </div>

      {stopDelivery && (
        <div className="rounded-xl border-2 border-red-500 bg-red-50 p-3 text-center text-xs font-black text-red-800">
          DO NOT DELIVER — SHOPIFY ORDER CANCELLED
          <div className="mt-1 text-[10px] font-bold">RETURN TO HUB</div>
        </div>
      )}

      {/* Customer Info */}
      <div className="space-y-0.5">
        <h4 className="text-sm font-black text-[#1F1F1D]">{customerName}</h4>
        <div className="flex items-start space-x-1.5 text-xs text-[#6D6964]">
          <MapPin className="w-3.5 h-3.5 text-[#5A2628] shrink-0 mt-0.5" />
          <span className="line-clamp-2">{address}, {zone ? `${zone}, ` : ''}{city}</span>
        </div>
      </div>

      {/* Financial & COD Highlight */}
      <div className="flex items-center justify-between p-2.5 bg-[#F5F4F2] rounded-xl border border-[#DDD9D4]">
        <div>
          <span className="text-[10px] font-bold text-[#6D6964] uppercase block">Cash to Collect</span>
          {isPrepaid ? (
            <span className="text-xs font-extrabold text-emerald-800 font-mono">
              PREPAID — COLLECT Rs 0
            </span>
          ) : (
            <span className="text-base font-black text-[#5A2628] font-mono">
              Rs. {codExpected.toLocaleString()}
            </span>
          )}
        </div>
        <span
          className={`text-[10px] font-bold px-2 py-0.5 rounded-md ${
            isPrepaid ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-900'
          }`}
        >
          {isPrepaid ? 'Prepaid' : 'COD'}
        </span>
      </div>

      {/* Large Actions (Min 44px) */}
      {!stopDelivery && <div className="grid grid-cols-3 gap-2">
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
      </div>}

      {/* Primary Action */}
      {!stopDelivery && <button
        onClick={() => onRecordAttempt(order)}
        className="w-full h-11 bg-[#5A2628] hover:bg-[#471D1F] text-white rounded-xl font-bold text-xs shadow-xs flex items-center justify-center space-x-2 active:scale-98 transition"
      >
        <CheckCircle2 className="w-4 h-4 text-emerald-400" />
        <span>RECORD ATTEMPT</span>
      </button>}
    </div>
  );
}
