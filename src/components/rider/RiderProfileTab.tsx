import React from 'react';
import { User, Phone, MapPin, Truck, Shield, LogOut } from 'lucide-react';
import { Profile, Rider } from '../../types';

interface RiderProfileTabProps {
  userProfile: Profile;
  riderInfo: Rider | null;
  onLogout?: () => void;
}

export function RiderProfileTab({ userProfile, riderInfo, onLogout }: RiderProfileTabProps) {
  return (
    <div className="space-y-4">
      {/* Profile Header */}
      <div className="bg-white p-5 rounded-3xl border border-[#DDD9D4] shadow-xs text-center space-y-3">
        <div className="w-16 h-16 rounded-2xl bg-[#5A2628] text-white font-bold text-xl flex items-center justify-center mx-auto shadow-sm">
          {userProfile.full_name ? userProfile.full_name.substring(0, 2).toUpperCase() : 'RD'}
        </div>
        <div>
          <h3 className="text-base font-black text-[#1F1F1D]">{userProfile.full_name}</h3>
          <span className="font-mono text-xs font-bold text-[#5A2628] bg-[#5A2628]/10 px-2.5 py-0.5 rounded-full inline-block mt-1">
            {riderInfo?.rider_code || 'RD-01'}
          </span>
        </div>
      </div>

      {/* Operational Details */}
      <div className="bg-white p-4 rounded-2xl border border-[#DDD9D4] shadow-xs space-y-3 text-xs">
        <h4 className="text-[11px] font-black uppercase text-[#6D6964] tracking-wider">
          Operational Assignment
        </h4>

        <div className="space-y-2.5 divide-y divide-[#DDD9D4]">
          <div className="flex items-center justify-between pt-1">
            <span className="text-[#6D6964] flex items-center space-x-1.5">
              <MapPin className="w-3.5 h-3.5 text-[#5A2628]" />
              <span>Assigned Zone</span>
            </span>
            <span className="font-bold text-[#1F1F1D]">{riderInfo?.assigned_zone || 'Lahore Hub Zone'}</span>
          </div>

          <div className="flex items-center justify-between pt-2.5">
            <span className="text-[#6D6964] flex items-center space-x-1.5">
              <Truck className="w-3.5 h-3.5 text-[#5A2628]" />
              <span>Vehicle Type</span>
            </span>
            <span className="font-bold text-[#1F1F1D]">{riderInfo?.vehicle_type || 'Motorbike'}</span>
          </div>

          <div className="flex items-center justify-between pt-2.5">
            <span className="text-[#6D6964] flex items-center space-x-1.5">
              <Phone className="w-3.5 h-3.5 text-[#1F7A52]" />
              <span>Registered Phone</span>
            </span>
            <span className="font-mono font-bold text-[#1F1F1D]">{userProfile.phone || '0300-1234567'}</span>
          </div>

          <div className="flex items-center justify-between pt-2.5">
            <span className="text-[#6D6964] flex items-center space-x-1.5">
              <Shield className="w-3.5 h-3.5 text-[#356A8A]" />
              <span>Role & Access</span>
            </span>
            <span className="font-bold text-[#1F1F1D] capitalize">{userProfile.role || 'Rider'}</span>
          </div>
        </div>
      </div>

      {/* Logout Action */}
      {onLogout && (
        <button
          onClick={onLogout}
          className="w-full h-12 bg-white hover:bg-rose-50 border border-rose-200 text-rose-700 font-bold text-xs rounded-2xl shadow-xs flex items-center justify-center space-x-2 transition active:scale-98"
        >
          <LogOut className="w-4 h-4" />
          <span>SIGN OUT TERMINAL</span>
        </button>
      )}
    </div>
  );
}
