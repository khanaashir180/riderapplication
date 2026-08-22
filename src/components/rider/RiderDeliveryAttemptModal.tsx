import React, { useState, useEffect } from 'react';
import { 
  X, 
  CheckCircle2, 
  XCircle, 
  Camera, 
  Upload, 
  MapPin, 
  Clock, 
  AlertTriangle, 
  Calendar, 
  User, 
  DollarSign, 
  RotateCcw,
  Loader2
} from 'lucide-react';
import { Order, Package } from '../../types';
import { api } from '../../services/api';
import { storage, auth } from '../../lib/firebase';
import { ref, uploadBytes } from 'firebase/storage';

type DeliveryOutcomeType = 
  | 'DELIVERED'
  | 'CUSTOMER_UNAVAILABLE'
  | 'RESCHEDULED'
  | 'REFUSED'
  | 'ADDRESS_ISSUE'
  | 'CUSTOMER_CANCELLED';

interface RiderDeliveryAttemptModalProps {
  order: Order | Package;
  onClose: () => void;
  onSuccess: () => void;
}

export function RiderDeliveryAttemptModal({
  order,
  onClose,
  onSuccess
}: RiderDeliveryAttemptModalProps) {
  const pkgId = order.original_order_number || (order as any).packageNumber || (order as any).package_number || order.id;
  const customerName = order.customer_name || (order as any).customerName || 'Customer';
  const codExpected = order.cod_expected !== undefined ? order.cod_expected : ((order as any).codExpected || 0);
  const isPrepaid = (order.payment_method || (order as any).paymentMethod || '').toLowerCase() === 'prepaid' || codExpected === 0;

  const [selectedOutcome, setSelectedOutcome] = useState<DeliveryOutcomeType>('DELIVERED');
  
  // Delivered fields
  const [receiverName, setReceiverName] = useState(customerName);
  const [receiverRelationship, setReceiverRelationship] = useState('Self');
  const [collectedAmount, setCollectedAmount] = useState<number>(isPrepaid ? 0 : codExpected);
  const [paymentMethod, setPaymentMethod] = useState<'Cash' | 'Prepaid' | 'JazzCash' | 'EasyPaisa'>(isPrepaid ? 'Prepaid' : 'Cash');
  const [digitalReference, setDigitalReference] = useState('');
  const [proofImage, setProofImage] = useState<string | null>(null);
  const [proofFile, setProofFile] = useState<File | null>(null);
  
  // Failure / Reschedule fields
  const [quickReason, setQuickReason] = useState<string>('');
  const [additionalNotes, setAdditionalNotes] = useState<string>('');
  const [rescheduleDate, setRescheduleDate] = useState<string>('');
  const [timeSlot, setTimeSlot] = useState<string>('Afternoon (12 PM - 4 PM)');

  // Geolocation state
  const [gpsCoords, setGpsCoords] = useState<{ lat?: number; lng?: number }>({});
  const [gpsStatus, setGpsStatus] = useState<'fetching' | 'acquired' | 'error'>('fetching');

  // Submission state
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Auto-fetch GPS on mount
  useEffect(() => {
    fetchGpsLocation();
  }, []);

  const fetchGpsLocation = () => {
    setGpsStatus('fetching');
    if ('geolocation' in navigator) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          setGpsCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude });
          setGpsStatus('acquired');
        },
        (err) => {
          console.warn('GPS capture warning:', err);
          setGpsCoords({});
          setGpsStatus('error');
        },
        { timeout: 5000 }
      );
    } else {
      setGpsCoords({});
      setGpsStatus('error');
    }
  };

  const handleImageCapture = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      setProofFile(file);
      const reader = new FileReader();
      reader.onload = () => {
        setProofImage(reader.result as string);
        setErrorMessage(null);
      };
      reader.readAsDataURL(file);
      if (gpsStatus !== 'acquired') {
        fetchGpsLocation();
      }
    }
  };

  // Quick chips logic for dates
  const setQuickDateOffset = (days: number) => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    const dateStr = d.toISOString().split('T')[0];
    setRescheduleDate(dateStr);
  };

  const handleSubmit = async () => {
    setErrorMessage(null);

    // Client-side validations for selected outcome
    if (selectedOutcome === 'DELIVERED') {
      if (!receiverName.trim()) {
        setErrorMessage('Receiver name is required for delivery completion.');
        return;
      }
      if (!receiverRelationship.trim()) {
        setErrorMessage('Receiver relationship is required.');
        return;
      }
      if (!proofImage) {
        setErrorMessage('Doorstep proof photo is required for delivery completion.');
        return;
      }
      if (!isPrepaid && collectedAmount < 0) {
        setErrorMessage('Collected cash amount cannot be negative.');
        return;
      }
      if (['JazzCash', 'EasyPaisa'].includes(paymentMethod) && !digitalReference.trim()) {
        setErrorMessage('Transaction ID / Reference is required for digital payment.');
        return;
      }
    } else if (selectedOutcome === 'RESCHEDULED') {
      if (!rescheduleDate) {
        setErrorMessage('New delivery date is required when rescheduling.');
        return;
      }
      if (!quickReason && !additionalNotes.trim()) {
        setErrorMessage('Please select or specify the reschedule reason.');
        return;
      }
    } else {
      // Failed outcomes
      if (!quickReason && !additionalNotes.trim()) {
        setErrorMessage('A reason is required for failed or refused delivery attempts.');
        return;
      }
    }

    // Begin Submission with Double-Tap / Concurrency Lock
    setIsSubmitting(true);

    const attemptId = `att_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const idempotencyKey = `DELIVERY:${order.id}:${attemptId}`;
    const effectiveReason = quickReason ? (additionalNotes.trim() ? `${quickReason} - ${additionalNotes.trim()}` : quickReason) : additionalNotes.trim();

    try {
      let proofStoragePath: string | undefined;
      if (selectedOutcome === 'DELIVERED' && proofFile) {
        const riderUid = auth.currentUser?.uid;
        if (!riderUid) {
          throw new Error('Authentication session missing for proof upload.');
        }
        const fileName = `${Date.now()}_${proofFile.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
        proofStoragePath = `deliveryProofs/${riderUid}/${attemptId}/${fileName}`;
        const storageRef = ref(storage, proofStoragePath);
        await uploadBytes(storageRef, proofFile, {
          contentType: proofFile.type || 'image/jpeg'
        });
      }

      const payload: any = {
        packageId: order.id,
        status: selectedOutcome,
        attemptId,
        idempotencyKey,
        collectedAmount: selectedOutcome === 'DELIVERED' ? (isPrepaid ? 0 : Number(collectedAmount)) : 0,
        paymentMethod: selectedOutcome === 'DELIVERED' ? (isPrepaid ? 'Prepaid' : paymentMethod) : undefined,
        digitalReference: digitalReference.trim() || undefined,
        receiverName: selectedOutcome === 'DELIVERED' ? receiverName.trim() : undefined,
        receiverRelationship: selectedOutcome === 'DELIVERED' ? receiverRelationship : undefined,
        reason: selectedOutcome !== 'DELIVERED' ? effectiveReason : undefined,
        riderNotes: additionalNotes.trim() || effectiveReason || undefined,
        newDeliveryDate: selectedOutcome === 'RESCHEDULED' ? `${rescheduleDate} (${timeSlot})` : undefined,
        proofStoragePath: selectedOutcome === 'DELIVERED' ? proofStoragePath : undefined,
        latitude: gpsCoords.lat ?? null,
        longitude: gpsCoords.lng ?? null,
        deviceTimestamp: new Date().toISOString()
      };

      const res = await api.recordDeliveryAttempt(payload);

      if (res && res.success !== false) {
        onSuccess();
      } else {
        const errStr = res?.error?.message || res?.error?.code || 'Failed to record delivery attempt.';
        setErrorMessage(errStr);
        setIsSubmitting(false);
      }
    } catch (err: any) {
      console.error('Delivery submission error:', err);
      setErrorMessage(err.message || 'Network error occurred while submitting attempt.');
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-end sm:items-center justify-center p-0 sm:p-4 backdrop-blur-xs">
      <div className="bg-white rounded-t-3xl sm:rounded-2xl border border-[#DDD9D4] w-full max-w-md max-h-[92vh] flex flex-col shadow-2xl animate-in slide-in-from-bottom duration-200">
        
        {/* Modal Header */}
        <div className="p-4 border-b border-[#DDD9D4] flex items-center justify-between shrink-0 bg-stone-50 rounded-t-3xl sm:rounded-t-2xl">
          <div>
            <div className="flex items-center space-x-2">
              <span className="font-mono text-xs font-black text-[#5A2628]">{pkgId}</span>
              <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-stone-200 text-stone-800">
                {isPrepaid ? 'Prepaid' : `COD: Rs. ${codExpected.toLocaleString()}`}
              </span>
            </div>
            <h3 className="text-base font-black text-[#1F1F1D] leading-tight mt-0.5">
              Record Delivery Attempt
            </h3>
          </div>
          <button 
            onClick={onClose} 
            disabled={isSubmitting}
            className="p-1.5 rounded-full text-[#6D6964] hover:bg-stone-200 transition disabled:opacity-50"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Scrollable Content */}
        <div className="p-4 space-y-4 overflow-y-auto flex-1">
          
          {/* Error Banner */}
          {errorMessage && (
            <div className="p-3 bg-rose-50 border border-rose-300 rounded-xl text-xs text-rose-900 flex items-start space-x-2 animate-in fade-in">
              <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
              <div className="space-y-0.5">
                <p className="font-bold">Submission Error</p>
                <p>{errorMessage}</p>
              </div>
            </div>
          )}

          {/* 1. CONTROLLED OUTCOME SELECTOR */}
          <div className="space-y-2">
            <label className="block text-[11px] font-extrabold uppercase text-[#6D6964] tracking-wider">
              Select Outcome
            </label>
            
            <div className="grid grid-cols-2 gap-2">
              {[
                { id: 'DELIVERED', label: 'Delivered', color: 'border-emerald-600 bg-emerald-50 text-emerald-950 ring-emerald-600', icon: CheckCircle2 },
                { id: 'CUSTOMER_UNAVAILABLE', label: 'Unavailable', color: 'border-amber-500 bg-amber-50 text-amber-950 ring-amber-500', icon: Clock },
                { id: 'RESCHEDULED', label: 'Reschedule', color: 'border-blue-500 bg-blue-50 text-blue-950 ring-blue-500', icon: Calendar },
                { id: 'REFUSED', label: 'Customer Refused', color: 'border-rose-600 bg-rose-50 text-rose-950 ring-rose-600', icon: XCircle },
                { id: 'ADDRESS_ISSUE', label: 'Address Issue', color: 'border-purple-500 bg-purple-50 text-purple-950 ring-purple-500', icon: MapPin },
                { id: 'CUSTOMER_CANCELLED', label: 'Cancelled', color: 'border-stone-600 bg-stone-100 text-stone-950 ring-stone-600', icon: RotateCcw }
              ].map((opt) => {
                const isSelected = selectedOutcome === opt.id;
                const IconComponent = opt.icon;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => {
                      setSelectedOutcome(opt.id as DeliveryOutcomeType);
                      setQuickReason('');
                      setErrorMessage(null);
                    }}
                    className={`h-12 rounded-xl border text-xs font-black transition flex items-center justify-center space-x-1.5 p-2 ${
                      isSelected
                        ? `${opt.color} ring-2 shadow-xs`
                        : 'border-[#DDD9D4] bg-[#F5F4F2] text-[#1F1F1D] hover:bg-stone-100'
                    }`}
                  >
                    <IconComponent className="w-4 h-4 shrink-0" />
                    <span className="truncate">{opt.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* 2. DYNAMIC FIELDS BASED ON SELECTED OUTCOME */}
          
          {/* BRANCH A: DELIVERED */}
          {selectedOutcome === 'DELIVERED' && (
            <div className="space-y-3.5 bg-[#F5F4F2] p-3.5 rounded-2xl border border-[#DDD9D4]">
              {/* Receiver Name */}
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-extrabold text-[#1F1F1D]">Receiver Name *</label>
                  <button
                    type="button"
                    onClick={() => setReceiverName(customerName)}
                    className="text-[10px] font-bold text-[#5A2628] hover:underline"
                  >
                    Self ({customerName})
                  </button>
                </div>
                <input
                  type="text"
                  value={receiverName}
                  onChange={(e) => setReceiverName(e.target.value)}
                  placeholder="Person receiving parcel"
                  className="w-full h-11 px-3 border border-[#DDD9D4] rounded-xl text-xs bg-white font-medium"
                />
              </div>

              {/* Receiver Relationship Quick Selector */}
              <div className="space-y-1.5">
                <label className="text-xs font-extrabold text-[#1F1F1D]">Receiver Relationship *</label>
                <div className="grid grid-cols-3 gap-1.5">
                  {['Self', 'Family', 'Colleague / Security', 'Neighbor'].map((rel) => (
                    <button
                      key={rel}
                      type="button"
                      onClick={() => setReceiverRelationship(rel)}
                      className={`h-9 px-2 rounded-lg text-[11px] font-bold border transition truncate ${
                        receiverRelationship === rel
                          ? 'bg-[#5A2628] text-white border-[#5A2628]'
                          : 'bg-white text-[#1F1F1D] border-[#DDD9D4] hover:bg-stone-100'
                      }`}
                    >
                      {rel}
                    </button>
                  ))}
                </div>
              </div>

              {/* Amount Collected & Payment Mode */}
              <div className="space-y-1.5">
                <label className="text-xs font-extrabold text-[#1F1F1D]">Payment Collection *</label>
                {isPrepaid ? (
                  <div className="p-3 bg-emerald-50 rounded-xl border border-emerald-300 flex items-center justify-between">
                    <div>
                      <span className="text-[10px] font-extrabold uppercase text-emerald-800 block">Prepaid Order</span>
                      <span className="text-base font-black text-emerald-700 font-mono">Collect Rs 0</span>
                    </div>
                    <span className="text-[10px] bg-emerald-700 text-white font-bold px-2 py-0.5 rounded-full">
                      Already Paid
                    </span>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <div className="flex items-center space-x-2">
                      <div className="relative flex-1">
                        <span className="absolute left-3 top-3 text-xs font-bold text-[#6D6964]">Rs.</span>
                        <input
                          type="number"
                          value={collectedAmount}
                          onChange={(e) => setCollectedAmount(Number(e.target.value))}
                          className="w-full h-11 pl-9 pr-3 border border-[#DDD9D4] rounded-xl font-mono text-base font-black bg-white"
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => setCollectedAmount(codExpected)}
                        className="h-11 px-3 bg-stone-200 text-[#1F1F1D] text-xs font-bold rounded-xl shrink-0"
                      >
                        Exact
                      </button>
                    </div>

                    {/* Payment Method Selector */}
                    <div className="grid grid-cols-3 gap-1.5">
                      {['Cash', 'JazzCash', 'EasyPaisa'].map((pm) => (
                        <button
                          key={pm}
                          type="button"
                          onClick={() => setPaymentMethod(pm as any)}
                          className={`h-9 rounded-lg text-[11px] font-bold border transition ${
                            paymentMethod === pm
                              ? 'bg-[#5A2628] text-white border-[#5A2628]'
                              : 'bg-white text-[#1F1F1D] border-[#DDD9D4]'
                          }`}
                        >
                          {pm}
                        </button>
                      ))}
                    </div>

                    {['JazzCash', 'EasyPaisa'].includes(paymentMethod) && (
                      <div>
                        <input
                          type="text"
                          value={digitalReference}
                          onChange={(e) => setDigitalReference(e.target.value)}
                          placeholder="Transaction / Reference ID *"
                          className="w-full h-10 px-3 border border-[#DDD9D4] rounded-xl text-xs bg-white font-mono"
                        />
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Proof Photograph Capture */}
              <div className="space-y-2">
                <label className="text-xs font-extrabold text-[#1F1F1D] flex items-center space-x-1.5">
                  <Camera className="w-4 h-4 text-[#5A2628]" />
                  <span>Doorstep Proof Photo *</span>
                </label>

                {proofImage ? (
                  <div className="relative rounded-xl overflow-hidden border-2 border-emerald-500 shadow-sm">
                    <img src={proofImage} alt="Delivery proof" className="w-full h-40 object-cover" />
                    <button
                      type="button"
                      onClick={() => setProofImage(null)}
                      className="absolute top-2 right-2 bg-black/80 text-white p-1.5 rounded-full shadow hover:bg-black"
                    >
                      <X className="w-4 h-4" />
                    </button>
                    <div className="absolute bottom-0 inset-x-0 bg-black/60 text-white text-[10px] font-bold p-1.5 text-center flex items-center justify-center space-x-1">
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                      <span>Proof Attached</span>
                    </div>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-2">
                    <label className="h-14 bg-white border-2 border-dashed border-[#5A2628]/40 hover:border-[#5A2628] rounded-xl flex flex-col items-center justify-center cursor-pointer transition text-center active:scale-98">
                      <Camera className="w-4 h-4 text-[#5A2628]" />
                      <span className="text-[11px] font-bold text-[#1F1F1D] mt-0.5">Take Photo</span>
                      <input
                        type="file"
                        accept="image/*"
                        capture="environment"
                        onChange={handleImageCapture}
                        className="hidden"
                      />
                    </label>

                    <label className="h-14 bg-white border-2 border-dashed border-[#DDD9D4] hover:border-stone-400 rounded-xl flex flex-col items-center justify-center cursor-pointer transition text-center active:scale-98">
                      <Upload className="w-4 h-4 text-[#356A8A]" />
                      <span className="text-[11px] font-bold text-[#1F1F1D] mt-0.5">Upload File</span>
                      <input
                        type="file"
                        accept="image/*"
                        onChange={handleImageCapture}
                        className="hidden"
                      />
                    </label>
                  </div>
                )}
              </div>

              {/* GPS Indicator */}
              <div className="flex items-center justify-between text-[11px] text-[#6D6964] bg-white p-2 rounded-lg border border-[#DDD9D4]">
                <div className="flex items-center space-x-1.5">
                  <MapPin className="w-3.5 h-3.5 text-[#5A2628]" />
                  <span>GPS Location:</span>
                </div>
                {gpsStatus === 'acquired' ? (
                  <span className="font-mono text-emerald-700 font-bold">
                    {gpsCoords.lat?.toFixed(4)}, {gpsCoords.lng?.toFixed(4)} ✓
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={fetchGpsLocation}
                    className="text-blue-600 font-bold hover:underline"
                  >
                    Acquire GPS
                  </button>
                )}
              </div>
            </div>
          )}

          {/* BRANCH B: CUSTOMER UNAVAILABLE */}
          {selectedOutcome === 'CUSTOMER_UNAVAILABLE' && (
            <div className="space-y-3 bg-[#F5F4F2] p-3.5 rounded-2xl border border-[#DDD9D4]">
              <label className="text-xs font-extrabold text-[#1F1F1D] block">Select Reason *</label>
              <div className="grid grid-cols-1 gap-1.5">
                {[
                  'Phone Switched Off / Unreachable',
                  'Doorbell / Knock Unanswered',
                  'Premises Locked / Gate Closed',
                  'Customer Out of City / Area',
                  'Security Denied Entry'
                ].map((reason) => (
                  <button
                    key={reason}
                    type="button"
                    onClick={() => setQuickReason(reason)}
                    className={`h-10 px-3 rounded-xl text-xs font-bold text-left border transition ${
                      quickReason === reason
                        ? 'bg-amber-600 text-white border-amber-600'
                        : 'bg-white text-[#1F1F1D] border-[#DDD9D4] hover:bg-stone-50'
                    }`}
                  >
                    {reason}
                  </button>
                ))}
              </div>
              <div>
                <textarea
                  value={additionalNotes}
                  onChange={(e) => setAdditionalNotes(e.target.value)}
                  placeholder="Additional notes (optional)..."
                  rows={2}
                  className="w-full p-2.5 text-xs bg-white border border-[#DDD9D4] rounded-xl"
                />
              </div>
            </div>
          )}

          {/* BRANCH C: RESCHEDULED */}
          {selectedOutcome === 'RESCHEDULED' && (
            <div className="space-y-3 bg-[#F5F4F2] p-3.5 rounded-2xl border border-[#DDD9D4]">
              {/* Quick Date Chips */}
              <div className="space-y-1.5">
                <label className="text-xs font-extrabold text-[#1F1F1D] block">Reschedule Date *</label>
                <div className="grid grid-cols-3 gap-1.5">
                  {[
                    { label: 'Tomorrow', days: 1 },
                    { label: 'In 2 Days', days: 2 },
                    { label: 'In 3 Days', days: 3 }
                  ].map((d) => (
                    <button
                      key={d.label}
                      type="button"
                      onClick={() => setQuickDateOffset(d.days)}
                      className="h-9 rounded-lg bg-white border border-[#DDD9D4] text-xs font-bold text-[#1F1F1D] hover:bg-blue-50 hover:border-blue-300"
                    >
                      {d.label}
                    </button>
                  ))}
                </div>
                <input
                  type="date"
                  value={rescheduleDate}
                  onChange={(e) => setRescheduleDate(e.target.value)}
                  className="w-full h-10 px-3 border border-[#DDD9D4] rounded-xl text-xs bg-white font-medium mt-1"
                />
              </div>

              {/* Time Slot Selector */}
              <div className="space-y-1.5">
                <label className="text-xs font-extrabold text-[#1F1F1D] block">Preferred Time Slot</label>
                <div className="grid grid-cols-1 gap-1.5">
                  {[
                    'Morning (9 AM - 12 PM)',
                    'Afternoon (12 PM - 4 PM)',
                    'Evening (4 PM - 8 PM)'
                  ].map((slot) => (
                    <button
                      key={slot}
                      type="button"
                      onClick={() => setTimeSlot(slot)}
                      className={`h-9 px-3 rounded-lg text-xs font-bold text-left border transition ${
                        timeSlot === slot
                          ? 'bg-blue-600 text-white border-blue-600'
                          : 'bg-white text-[#1F1F1D] border-[#DDD9D4]'
                      }`}
                    >
                      {slot}
                    </button>
                  ))}
                </div>
              </div>

              {/* Reason Selector */}
              <div className="space-y-1.5">
                <label className="text-xs font-extrabold text-[#1F1F1D] block">Reschedule Reason</label>
                <div className="grid grid-cols-1 gap-1.5">
                  {[
                    'Customer Requested Specific Time/Date',
                    'Cash Not Arranged / Waiting for Salary',
                    'Customer Traveling / Returning Soon'
                  ].map((reason) => (
                    <button
                      key={reason}
                      type="button"
                      onClick={() => setQuickReason(reason)}
                      className={`h-9 px-3 rounded-lg text-xs font-bold text-left border transition ${
                        quickReason === reason
                          ? 'bg-blue-600 text-white border-blue-600'
                          : 'bg-white text-[#1F1F1D] border-[#DDD9D4]'
                      }`}
                    >
                      {reason}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* BRANCH D: REFUSED */}
          {selectedOutcome === 'REFUSED' && (
            <div className="space-y-3 bg-[#F5F4F2] p-3.5 rounded-2xl border border-[#DDD9D4]">
              <label className="text-xs font-extrabold text-[#1F1F1D] block">Refusal Reason *</label>
              <div className="grid grid-cols-1 gap-1.5">
                {[
                  "Customer Didn't Order / Fake Order",
                  'Changed Mind / Too Expensive',
                  'Parcel Damaged / Open at Delivery',
                  'Delivery Delayed / Late',
                  'Wrong Item / Wrong Size'
                ].map((reason) => (
                  <button
                    key={reason}
                    type="button"
                    onClick={() => setQuickReason(reason)}
                    className={`h-10 px-3 rounded-xl text-xs font-bold text-left border transition ${
                      quickReason === reason
                        ? 'bg-rose-600 text-white border-rose-600'
                        : 'bg-white text-[#1F1F1D] border-[#DDD9D4] hover:bg-stone-50'
                    }`}
                  >
                    {reason}
                  </button>
                ))}
              </div>
              <textarea
                value={additionalNotes}
                onChange={(e) => setAdditionalNotes(e.target.value)}
                placeholder="Details of refusal (optional)..."
                rows={2}
                className="w-full p-2.5 text-xs bg-white border border-[#DDD9D4] rounded-xl"
              />
            </div>
          )}

          {/* BRANCH E: ADDRESS ISSUE */}
          {selectedOutcome === 'ADDRESS_ISSUE' && (
            <div className="space-y-3 bg-[#F5F4F2] p-3.5 rounded-2xl border border-[#DDD9D4]">
              <label className="text-xs font-extrabold text-[#1F1F1D] block">Address Issue Details *</label>
              <div className="grid grid-cols-1 gap-1.5">
                {[
                  'Incomplete Address / House # Missing',
                  'Wrong Area / Landmark Missing',
                  'Wrong City / Destination',
                  'Road Blocked / Location Unreachable'
                ].map((reason) => (
                  <button
                    key={reason}
                    type="button"
                    onClick={() => setQuickReason(reason)}
                    className={`h-10 px-3 rounded-xl text-xs font-bold text-left border transition ${
                      quickReason === reason
                        ? 'bg-purple-600 text-white border-purple-600'
                        : 'bg-white text-[#1F1F1D] border-[#DDD9D4] hover:bg-stone-50'
                    }`}
                  >
                    {reason}
                  </button>
                ))}
              </div>
              <textarea
                value={additionalNotes}
                onChange={(e) => setAdditionalNotes(e.target.value)}
                placeholder="Describe address / location problem..."
                rows={2}
                className="w-full p-2.5 text-xs bg-white border border-[#DDD9D4] rounded-xl"
              />
            </div>
          )}

          {/* BRANCH F: CUSTOMER CANCELLED */}
          {selectedOutcome === 'CUSTOMER_CANCELLED' && (
            <div className="space-y-3 bg-[#F5F4F2] p-3.5 rounded-2xl border border-[#DDD9D4]">
              <label className="text-xs font-extrabold text-[#1F1F1D] block">Cancellation Reason *</label>
              <div className="grid grid-cols-1 gap-1.5">
                {[
                  'Customer Cancelled on Phone Call',
                  'Ordered by Mistake',
                  'Purchased Elsewhere Locally',
                  'Customer Unavailable Indefinitely'
                ].map((reason) => (
                  <button
                    key={reason}
                    type="button"
                    onClick={() => setQuickReason(reason)}
                    className={`h-10 px-3 rounded-xl text-xs font-bold text-left border transition ${
                      quickReason === reason
                        ? 'bg-stone-800 text-white border-stone-800'
                        : 'bg-white text-[#1F1F1D] border-[#DDD9D4] hover:bg-stone-50'
                    }`}
                  >
                    {reason}
                  </button>
                ))}
              </div>
              <textarea
                value={additionalNotes}
                onChange={(e) => setAdditionalNotes(e.target.value)}
                placeholder="Cancellation notes (optional)..."
                rows={2}
                className="w-full p-2.5 text-xs bg-white border border-[#DDD9D4] rounded-xl"
              />
            </div>
          )}

        </div>

        {/* Modal Sticky Bottom Action */}
        <div className="p-4 border-t border-[#DDD9D4] bg-stone-50 rounded-b-3xl sm:rounded-b-2xl shrink-0">
          <button
            type="button"
            onClick={handleSubmit}
            disabled={isSubmitting}
            className={`w-full h-13 rounded-xl font-bold text-sm shadow-md flex items-center justify-center space-x-2 transition ${
              isSubmitting
                ? 'bg-stone-400 text-white cursor-not-allowed'
                : selectedOutcome === 'DELIVERED'
                ? 'bg-[#1F7A52] hover:bg-[#186141] text-white active:scale-98'
                : 'bg-[#5A2628] hover:bg-[#471D1F] text-white active:scale-98'
            }`}
          >
            {isSubmitting ? (
              <>
                <Loader2 className="w-5 h-5 animate-spin" />
                <span>Recording Attempt...</span>
              </>
            ) : (
              <>
                <CheckCircle2 className="w-5 h-5" />
                <span>
                  {selectedOutcome === 'DELIVERED'
                    ? 'Confirm Delivery & Post COD'
                    : 'Submit Attempt Outcome'}
                </span>
              </>
            )}
          </button>
        </div>

      </div>
    </div>
  );
}
