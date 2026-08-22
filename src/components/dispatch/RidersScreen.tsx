import React, { useState, useEffect } from 'react';
import { Users, Truck, ShieldCheck, Plus, CheckCircle2, AlertTriangle, DollarSign } from 'lucide-react';
import { Rider } from '../../types';
import { api } from '../../services/api';

export function RidersScreen() {
  const [riders, setRiders] = useState<Rider[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [newCode, setNewCode] = useState('');
  const [newName, setNewName] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [newVehicle, setNewVehicle] = useState<'Motorbike' | 'Cargo Rickshaw' | 'Van' | 'Bicycle'>('Motorbike');
  const [newReg, setNewReg] = useState('');
  const [newZone, setNewZone] = useState('Lahore Central');
  const [newCapacity, setNewCapacity] = useState(25);

  useEffect(() => {
    loadRiders();
  }, []);

  const loadRiders = async () => {
    setLoading(true);
    try {
      const data = await api.getRiders();
      setRiders(data.riders || data.data || (Array.isArray(data) ? data : []));
    } catch (e) {
      console.error('Failed to load riders roster:', e);
    } finally {
      setLoading(false);
    }
  };

  const handleSaveRider = async () => {
    if (!newCode || !newName || !newPhone) {
      alert('Please fill code, name, and phone number');
      return;
    }
    try {
      await api.saveRider({
        rider_code: newCode,
        vehicle_type: newVehicle,
        registration_number: newReg,
        maximum_daily_capacity: newCapacity,
        assigned_zone: newZone,
        active: true,
        profile: {
          id: `prof-${Date.now()}`,
          full_name: newName,
          phone: newPhone,
          role: 'rider',
          active: true,
          created_at: new Date().toISOString()
        } as any
      });
      setShowAddModal(false);
      setNewCode('');
      setNewName('');
      setNewPhone('');
      loadRiders();
    } catch (e) {
      console.error('Failed to save rider:', e);
    }
  };

  if (loading) {
    return (
      <div className="p-8 text-center text-xs text-[#6D6964] animate-pulse">
        Loading rider fleet roster...
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6 bg-[#F5F4F2] min-h-screen">
      
      {/* Top Header */}
      <div className="flex justify-between items-center bg-white p-4 rounded-lg border border-[#DDD9D4] shadow-xs">
        <div>
          <h2 className="text-sm font-bold text-[#1F1F1D]">Fleet Courier Roster & Capacity</h2>
          <p className="text-xs text-[#6D6964]">Manage delivery riders, vehicle registrations, assigned zones, and cash limits</p>
        </div>
        <button
          onClick={() => setShowAddModal(true)}
          className="px-4 py-2 bg-[#5A2628] hover:bg-[#471D1F] text-white text-xs font-bold rounded-lg shadow-xs flex items-center space-x-2 transition"
        >
          <Plus className="w-4 h-4" />
          <span>Add New Courier Rider</span>
        </button>
      </div>

      {/* Rider Fleet Roster Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {riders.map((r) => {
          return (
            <div key={r.id} className="bg-white rounded-lg border border-[#DDD9D4] p-4 shadow-xs space-y-3">
              <div className="flex justify-between items-start border-b border-[#DDD9D4] pb-2.5">
                <div className="flex items-center space-x-2.5">
                  <div className="w-8 h-8 rounded-full bg-[#5A2628] text-white font-bold text-xs flex items-center justify-center">
                    {r.profile?.full_name ? r.profile.full_name.substring(0, 2).toUpperCase() : 'RD'}
                  </div>
                  <div>
                    <span className="font-bold text-xs text-[#1F1F1D] block">{r.profile?.full_name || r.rider_code}</span>
                    <span className="font-mono text-[10px] text-[#5A2628] font-bold">{r.rider_code}</span>
                  </div>
                </div>
                <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${r.active ? 'bg-[#1F7A52]/10 text-[#1F7A52] border border-[#1F7A52]/30' : 'bg-stone-100 text-[#6D6964]'}`}>
                  {r.active ? 'Active' : 'Inactive'}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-2 text-xs text-[#6D6964] bg-[#F5F4F2] p-2.5 rounded-md border border-[#DDD9D4]">
                <div>
                  <span className="text-[10px] block">Vehicle</span>
                  <span className="font-bold text-[#1F1F1D]">{r.vehicle_type}</span>
                  {r.registration_number && <span className="text-[10px] block font-mono text-[#6D6964]">{r.registration_number}</span>}
                </div>
                <div>
                  <span className="text-[10px] block">Zone</span>
                  <span className="font-bold text-[#1F1F1D]">{r.assigned_zone}</span>
                </div>
              </div>

              <div className="flex justify-between items-center text-xs text-[#1F1F1D] pt-1">
                <span className="text-[11px] text-[#6D6964]">Max Daily Capacity:</span>
                <span className="font-mono font-bold text-[#5A2628]">{r.maximum_daily_capacity || 25} Packages</span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Add Rider Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-xl border border-[#DDD9D4] w-full max-w-md p-6 space-y-4">
            <h3 className="text-sm font-bold text-[#1F1F1D] border-b border-[#DDD9D4] pb-2">
              Register New Delivery Courier Rider
            </h3>

            <div className="space-y-3 text-xs">
              <div>
                <label className="block font-semibold mb-1">Rider Code * (e.g. RDR-05)</label>
                <input
                  type="text"
                  value={newCode}
                  onChange={(e) => setNewCode(e.target.value)}
                  placeholder="RDR-05"
                  className="w-full p-2 border border-[#DDD9D4] rounded-md bg-[#F5F4F2] font-mono"
                />
              </div>

              <div>
                <label className="block font-semibold mb-1">Full Name *</label>
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="Full name"
                  className="w-full p-2 border border-[#DDD9D4] rounded-md bg-[#F5F4F2]"
                />
              </div>

              <div>
                <label className="block font-semibold mb-1">Phone Number *</label>
                <input
                  type="text"
                  value={newPhone}
                  onChange={(e) => setNewPhone(e.target.value)}
                  placeholder="03001234567"
                  className="w-full p-2 border border-[#DDD9D4] rounded-md bg-[#F5F4F2] font-mono"
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block font-semibold mb-1">Vehicle Type</label>
                  <select
                    value={newVehicle}
                    onChange={(e) => setNewVehicle(e.target.value as any)}
                    className="w-full p-2 border border-[#DDD9D4] rounded-md bg-[#F5F4F2]"
                  >
                    <option value="Motorbike">Motorbike</option>
                    <option value="Cargo Rickshaw">Cargo Rickshaw</option>
                    <option value="Van">Van</option>
                    <option value="Bicycle">Bicycle</option>
                  </select>
                </div>
                <div>
                  <label className="block font-semibold mb-1">Registration #</label>
                  <input
                    type="text"
                    value={newReg}
                    onChange={(e) => setNewReg(e.target.value)}
                    placeholder="LEA-1234"
                    className="w-full p-2 border border-[#DDD9D4] rounded-md bg-[#F5F4F2] font-mono"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block font-semibold mb-1">Assigned Zone</label>
                  <input
                    type="text"
                    value={newZone}
                    onChange={(e) => setNewZone(e.target.value)}
                    className="w-full p-2 border border-[#DDD9D4] rounded-md bg-[#F5F4F2]"
                  />
                </div>
                <div>
                  <label className="block font-semibold mb-1">Max Daily Capacity</label>
                  <input
                    type="number"
                    value={newCapacity}
                    onChange={(e) => setNewCapacity(Number(e.target.value))}
                    className="w-full p-2 border border-[#DDD9D4] rounded-md bg-[#F5F4F2] font-mono"
                  />
                </div>
              </div>
            </div>

            <div className="flex justify-end space-x-2 pt-3 border-t border-[#DDD9D4]">
              <button
                onClick={() => setShowAddModal(false)}
                className="px-4 py-2 text-xs border border-[#DDD9D4] rounded-md font-semibold"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveRider}
                className="px-4 py-2 text-xs bg-[#5A2628] text-white rounded-md font-bold hover:bg-[#471D1F]"
              >
                Save Rider
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
