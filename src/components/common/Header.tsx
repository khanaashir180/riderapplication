import React, { useState, useEffect } from 'react';
import { Search, Bell, X, Package, ShieldCheck } from 'lucide-react';
import { Order, Profile } from '../../types';
import { api } from '../../services/api';

interface HeaderProps {
  title: string;
  subtitle?: string;
  currentProfile: Profile;
  onSelectOrder: (orderId: string) => void;
}

export function Header({ title, subtitle, currentProfile, onSelectOrder }: HeaderProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Order[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [showSearchResults, setShowSearchResults] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);
  const [alerts, setAlerts] = useState<Array<{ id: string; title: string; desc: string; orderId?: string; type: 'warning' | 'danger' | 'info' }>>([]);

  // Load live system alerts for notifications menu
  useEffect(() => {
    loadAlerts();
  }, []);

  const loadAlerts = async () => {
    try {
      const res = await api.getOrders({ limit: 50 });
      const orders = res.orders || [];
      const newAlerts: Array<{ id: string; title: string; desc: string; orderId?: string; type: 'warning' | 'danger' | 'info' }> = [];

      const unassigned = orders.filter(o => o.current_status === 'Awaiting Assignment' || o.current_status === 'Imported');
      if (unassigned.length > 0) {
        newAlerts.push({
          id: 'alt-1',
          title: 'Unassigned Packages',
          desc: `${unassigned.length} orders awaiting rider assignment today`,
          orderId: unassigned[0]?.id,
          type: 'warning'
        });
      }

      const overdue = orders.filter(o => {
        if (['Delivered', 'Cancelled', 'Returned to Warehouse'].includes(o.current_status)) return false;
        return Boolean(o.promised_delivery_date && new Date(o.promised_delivery_date) < new Date());
      });
      if (overdue.length > 0) {
        newAlerts.push({
          id: 'alt-2',
          title: 'Promised Date Overdue',
          desc: `${overdue.length} orders passed promised delivery cutoff date`,
          orderId: overdue[0]?.id,
          type: 'danger'
        });
      }

      const codRisk = orders.filter(o => o.current_status === 'Out for Delivery' && o.cod_expected > 15000);
      if (codRisk.length > 0) {
        newAlerts.push({
          id: 'alt-3',
          title: 'High-Value COD Out in Transit',
          desc: `${codRisk.length} high-value packages (COD > Rs. 15,000) active on route`,
          orderId: codRisk[0]?.id,
          type: 'info'
        });
      }

      setAlerts(newAlerts);
    } catch (e) {
      console.error('Failed to load notifications alerts:', e);
    }
  };

  const handleSearchChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const query = e.target.value;
    setSearchQuery(query);
    if (!query.trim()) {
      setSearchResults([]);
      setShowSearchResults(false);
      return;
    }

    setIsSearching(true);
    setShowSearchResults(true);
    try {
      const res = await api.getOrders({ search: query, limit: 8 });
      setSearchResults(res.orders || []);
    } catch (err) {
      console.error('Failed to search orders:', err);
    } finally {
      setIsSearching(false);
    }
  };

  const getRoleLabel = (role: string) => {
    switch (role) {
      case 'super_admin': return 'Super Administrator';
      case 'dispatch_manager': return 'Dispatch Manager';
      case 'cashier': return 'Finance & Cashier';
      case 'rider': return 'Delivery Courier';
      case 'customer_service': return 'Customer Service';
      case 'warehouse_staff': return 'Warehouse Officer';
      case 'management_viewer': return 'Executive Viewer';
      default: return role;
    }
  };

  return (
    <header className="h-16 bg-white border-b border-[#DDD9D4] px-6 flex items-center justify-between sticky top-0 z-30">
      {/* Title & Context */}
      <div>
        <h1 className="text-lg font-bold text-[#1F1F1D] tracking-tight">{title}</h1>
        {subtitle && <p className="text-xs text-[#6D6964]">{subtitle}</p>}
      </div>

      {/* Center Search & Right Controls */}
      <div className="flex items-center space-x-4">
        {/* Global Order Search */}
        <div className="relative w-72 md:w-96">
          <div className="relative flex items-center">
            <Search className="w-4 h-4 text-[#6D6964] absolute left-3 pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={handleSearchChange}
              onFocus={() => searchQuery && setShowSearchResults(true)}
              placeholder="Search package #, customer, phone..."
              className="w-full pl-9 pr-8 py-1.5 text-xs bg-[#F5F4F2] border border-[#DDD9D4] rounded-lg text-[#1F1F1D] placeholder-[#6D6964] focus:outline-none focus:ring-2 focus:ring-[#5A2628] focus:border-transparent transition"
            />
            {searchQuery && (
              <button
                onClick={() => {
                  setSearchQuery('');
                  setSearchResults([]);
                  setShowSearchResults(false);
                }}
                className="absolute right-2.5 text-[#6D6964] hover:text-[#1F1F1D]"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {/* Search Results Dropdown */}
          {showSearchResults && (
            <div className="absolute left-0 right-0 top-full mt-1.5 bg-white border border-[#DDD9D4] rounded-lg shadow-lg z-50 max-h-80 overflow-y-auto">
              <div className="p-2 border-b border-[#DDD9D4] text-[11px] font-semibold text-[#6D6964] flex justify-between items-center">
                <span>Search Results</span>
                {isSearching && <span className="text-[10px] animate-pulse">Searching...</span>}
              </div>
              {searchResults.length === 0 && !isSearching ? (
                <div className="p-4 text-center text-xs text-[#6D6964]">No matching orders found</div>
              ) : (
                <div className="divide-y divide-[#DDD9D4]">
                  {searchResults.map((ord) => (
                    <button
                      key={ord.id}
                      onClick={() => {
                        onSelectOrder(ord.id);
                        setShowSearchResults(false);
                      }}
                      className="w-full text-left p-2.5 hover:bg-[#F5F4F2] transition flex items-center justify-between group"
                    >
                      <div>
                        <div className="flex items-center space-x-2">
                          <span className="font-mono text-xs font-bold text-[#5A2628]">{ord.original_order_number}</span>
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-stone-100 text-[#1F1F1D] font-medium border border-[#DDD9D4]">
                            {ord.current_status}
                          </span>
                        </div>
                        <p className="text-xs text-[#1F1F1D] font-medium mt-0.5">{ord.customer_name} • {ord.city}</p>
                      </div>
                      <div className="text-right">
                        <p className="text-xs font-mono font-bold text-[#1F1F1D]">Rs. {ord.cod_expected.toLocaleString()}</p>
                        <p className="text-[10px] text-[#6D6964]">{ord.payment_method}</p>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Notifications Bell */}
        <div className="relative">
          <button
            onClick={() => setShowNotifications(!showNotifications)}
            className="p-2 rounded-lg text-[#6D6964] hover:text-[#1F1F1D] hover:bg-[#F5F4F2] relative transition"
            title="System Alerts & Notifications"
          >
            <Bell className="w-4 h-4" />
            {alerts.length > 0 && (
              <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-[#B43B3B]" />
            )}
          </button>

          {showNotifications && (
            <div className="absolute right-0 top-full mt-1.5 w-80 bg-white border border-[#DDD9D4] rounded-lg shadow-lg z-50 overflow-hidden">
              <div className="p-3 bg-[#F5F4F2] border-b border-[#DDD9D4] flex items-center justify-between">
                <span className="text-xs font-bold text-[#1F1F1D]">System Exception Alerts</span>
                <span className="text-[10px] font-bold px-2 py-0.5 bg-[#5A2628] text-white rounded-full">
                  {alerts.length} Active
                </span>
              </div>
              <div className="divide-y divide-[#DDD9D4] max-h-72 overflow-y-auto">
                {alerts.length === 0 ? (
                  <div className="p-4 text-center text-xs text-[#6D6964]">No active exception alerts</div>
                ) : (
                  alerts.map((alt) => (
                    <div
                      key={alt.id}
                      onClick={() => {
                        if (alt.orderId) onSelectOrder(alt.orderId);
                        setShowNotifications(false);
                      }}
                      className="p-3 hover:bg-[#F5F4F2] cursor-pointer transition flex space-x-2.5 items-start"
                    >
                      <div className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${
                        alt.type === 'danger' ? 'bg-[#B43B3B]' : alt.type === 'warning' ? 'bg-[#A56716]' : 'bg-[#356A8A]'
                      }`} />
                      <div>
                        <p className="text-xs font-bold text-[#1F1F1D]">{alt.title}</p>
                        <p className="text-[11px] text-[#6D6964] mt-0.5">{alt.desc}</p>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>

        {/* Authenticated User Profile Badge (NO Role Switcher Dropdown!) */}
        <div className="flex items-center space-x-2.5 pl-2 border-l border-[#DDD9D4]">
          <div className="w-8 h-8 rounded-lg bg-[#5A2628] text-white flex items-center justify-center font-bold text-xs shadow-xs">
            {currentProfile.full_name ? currentProfile.full_name.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase() : 'G'}
          </div>
          <div className="hidden sm:block text-left">
            <p className="text-xs font-bold text-[#1F1F1D] leading-tight">{currentProfile.full_name}</p>
            <div className="flex items-center space-x-1 mt-0.5">
              <ShieldCheck className="w-3 h-3 text-[#1F7A52]" />
              <span className="text-[10px] font-medium text-[#6D6964]">{getRoleLabel(currentProfile.role)}</span>
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}
