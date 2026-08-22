import React, { useState, useEffect } from 'react';
import { 
  Search, 
  Filter, 
  Download, 
  Upload, 
  UserPlus, 
  SlidersHorizontal, 
  ChevronDown, 
  ChevronUp, 
  AlertTriangle, 
  CheckCircle2, 
  Clock,
  RotateCw,
  ShoppingBag
} from 'lucide-react';
import { Order, Rider } from '../../types';
import { api } from '../../services/api';
import { OrderDrawer } from './OrderDrawer';
import { CSVImportDrawer } from './CSVImportDrawer';
import { ShopifySyncModal } from './ShopifySyncModal';

interface OrdersScreenProps {
  userRole?: string;
  initialFilterStatus?: string;
  onSelectOrder: (id: string) => void;
  selectedOrderId: string | null;
  onCloseDrawer: () => void;
}

export function OrdersScreen({
  userRole,
  initialFilterStatus,
  onSelectOrder,
  selectedOrderId,
  onCloseDrawer
}: OrdersScreenProps) {
  const [orders, setOrders] = useState<Order[]>([]);
  const [riders, setRiders] = useState<Rider[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState(initialFilterStatus || '');
  const [page, setPage] = useState(1);
  const [totalOrders, setTotalOrders] = useState(0);
  const [totalPages, setTotalPages] = useState(1);

  // Selection & Bulk Actions
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [bulkRiderId, setBulkRiderId] = useState<string>('');
  const [isBulkAssigning, setIsBulkAssigning] = useState(false);

  // Column Visibility State
  const [showColMenu, setShowColMenu] = useState(false);
  const [visibleCols, setVisibleCols] = useState({
    pkg: true,
    parent: true,
    customer: true,
    location: true,
    promised: true,
    cod: true,
    payment: true,
    channel: true,
    rider: true,
    status: true,
    updated: true
  });

  // Drawer Triggers
  const [showImportDrawer, setShowImportDrawer] = useState(false);
  const [showShopifySyncModal, setShowShopifySyncModal] = useState(false);

  useEffect(() => {
    loadOrdersData();
  }, [page, statusFilter, search]);

  useEffect(() => {
    api.getRiders().then(res => setRiders(res.riders || res.data || (Array.isArray(res) ? res : []))).catch(console.error);
  }, []);

  const loadOrdersData = async () => {
    setLoading(true);
    try {
      const res = await api.getOrders({
        page,
        limit: 25,
        search,
        status: statusFilter
      });
      const rawOrders = res.orders || res.data?.orders || (res.data as any)?.items || (Array.isArray(res.data) ? res.data : []);
      setOrders(Array.isArray(rawOrders) ? rawOrders : []);
      setTotalOrders(res.pagination?.total || (Array.isArray(rawOrders) ? rawOrders.length : 0));
      setTotalPages(res.pagination?.totalPages || 1);
    } catch (e) {
      console.error('Failed to load orders table:', e);
    } finally {
      setLoading(false);
    }
  };

  const handleSelectAll = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.checked) {
      setSelectedIds(orders.map(o => o.id));
    } else {
      setSelectedIds([]);
    }
  };

  const handleToggleSelect = (id: string) => {
    setSelectedIds(prev => 
      prev.includes(id) ? prev.filter(item => item !== id) : [...prev, id]
    );
  };

  const handleExecuteBulkAssign = async () => {
    if (selectedIds.length === 0 || !bulkRiderId) return;
    setIsBulkAssigning(true);
    try {
      await api.bulkAssignOrders({
        order_ids: selectedIds,
        rider_id: bulkRiderId
      });
      setSelectedIds([]);
      setBulkRiderId('');
      loadOrdersData();
    } catch (e) {
      console.error('Bulk assign failed:', e);
    } finally {
      setIsBulkAssigning(false);
    }
  };

  const handleExportCSV = () => {
    const exportData = orders.filter(o => selectedIds.length === 0 || selectedIds.includes(o.id));
    const headers = ['Package Number', 'Parent Order', 'Customer', 'Contact', 'Address', 'City', 'COD Expected', 'Payment Method', 'Status', 'Promised Date'];
    const rows = exportData.map(o => [
      o.original_order_number,
      o.parent_order_number,
      `"${o.customer_name}"`,
      o.contact_number,
      `"${o.address}"`,
      o.city,
      o.cod_expected,
      o.payment_method,
      o.current_status,
      o.promised_delivery_date
    ]);

    const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows.map(e => e.join(','))].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `gomila_orders_export_${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const presetFilters = [
    { label: 'All Orders', status: '' },
    { label: 'Unassigned', status: 'Awaiting Assignment' },
    { label: 'Out for Delivery', status: 'Out for Delivery' },
    { label: 'Delivered', status: 'Delivered' },
    { label: 'Exceptions', status: 'Customer Unavailable' }
  ];

  return (
    <div className="p-6 space-y-4 bg-[#F5F4F2] min-h-screen">
      
      {/* Top Action Header Bar */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-white p-4 rounded-lg border border-[#DDD9D4] shadow-xs">
        
        {/* Search & Saved Filters */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-64">
            <Search className="w-4 h-4 text-[#6D6964] absolute left-3 top-2.5 pointer-events-none" />
            <input
              type="text"
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
              placeholder="Filter package # or customer..."
              className="w-full pl-9 pr-3 py-1.5 text-xs bg-[#F5F4F2] border border-[#DDD9D4] rounded-lg text-[#1F1F1D] placeholder-[#6D6964] focus:outline-none focus:ring-2 focus:ring-[#5A2628]"
            />
          </div>

          <div className="flex items-center space-x-1 border-l border-[#DDD9D4] pl-2">
            {presetFilters.map((pf) => (
              <button
                key={pf.label}
                onClick={() => { setStatusFilter(pf.status); setPage(1); }}
                className={`px-2.5 py-1 text-xs font-semibold rounded-md transition ${
                  statusFilter === pf.status
                    ? 'bg-[#5A2628] text-white shadow-xs'
                    : 'text-[#6D6964] hover:bg-[#F5F4F2] hover:text-[#1F1F1D]'
                }`}
              >
                {pf.label}
              </button>
            ))}
          </div>
        </div>

        {/* Action Controls */}
        <div className="flex items-center space-x-2">
          
          {/* Column Toggle Button */}
          <div className="relative">
            <button
              onClick={() => setShowColMenu(!showColMenu)}
              className="px-3 py-1.5 text-xs font-semibold text-[#1F1F1D] bg-[#F5F4F2] border border-[#DDD9D4] rounded-lg hover:bg-white flex items-center space-x-1.5"
            >
              <SlidersHorizontal className="w-3.5 h-3.5 text-[#6D6964]" />
              <span>Columns</span>
            </button>
            {showColMenu && (
              <div className="absolute right-0 top-full mt-1.5 w-48 bg-white border border-[#DDD9D4] rounded-lg shadow-lg z-40 p-2 space-y-1">
                <span className="text-[10px] font-bold text-[#6D6964] uppercase px-1">Toggle Columns</span>
                {Object.keys(visibleCols).map((colKey) => (
                  <label key={colKey} className="flex items-center space-x-2 px-1 py-0.5 text-xs text-[#1F1F1D] hover:bg-[#F5F4F2] rounded cursor-pointer">
                    <input
                      type="checkbox"
                      checked={(visibleCols as any)[colKey]}
                      onChange={(e) => setVisibleCols({ ...visibleCols, [colKey]: e.target.checked })}
                      className="rounded text-[#5A2628]"
                    />
                    <span className="capitalize">{colKey}</span>
                  </label>
                ))}
              </div>
            )}
          </div>

          {/* Export CSV */}
          <button
            onClick={handleExportCSV}
            className="px-3 py-1.5 text-xs font-semibold text-[#1F1F1D] bg-[#F5F4F2] border border-[#DDD9D4] rounded-lg hover:bg-white flex items-center space-x-1.5"
          >
            <Download className="w-3.5 h-3.5 text-[#6D6964]" />
            <span>Export CSV</span>
          </button>

          {userRole === 'super_admin' && (
            <button
              onClick={() => setShowShopifySyncModal(true)}
              title="Recovery only. Normal Shopify order flow is webhook-driven."
              className="px-3 py-1.5 text-xs font-bold text-[#1F1F1D] bg-[#95BF47]/20 hover:bg-[#95BF47]/30 border border-[#95BF47]/60 rounded-lg shadow-2xs flex items-center space-x-1.5 transition cursor-pointer"
            >
              <ShoppingBag className="w-3.5 h-3.5 text-[#43682B]" />
              <span>Shopify Recovery Sync</span>
            </button>
          )}

          {/* CSV Import Trigger Button */}
          <button
            onClick={() => setShowImportDrawer(true)}
            className="px-3 py-1.5 text-xs font-bold text-white bg-[#5A2628] hover:bg-[#471D1F] rounded-lg shadow-xs flex items-center space-x-1.5 transition cursor-pointer"
          >
            <Upload className="w-3.5 h-3.5" />
            <span>Import CSV</span>
          </button>
        </div>

      </div>

      {/* Bulk Selection Action Bar (Appears when rows selected) */}
      {selectedIds.length > 0 && (
        <div className="bg-[#5A2628] text-white p-3 rounded-lg flex items-center justify-between shadow-md animate-in fade-in duration-150">
          <div className="flex items-center space-x-2 text-xs font-bold">
            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
            <span>{selectedIds.length} Packages Selected for Bulk Dispatch Action</span>
          </div>

          <div className="flex items-center space-x-2">
            <select
              value={bulkRiderId}
              onChange={(e) => setBulkRiderId(e.target.value)}
              className="py-1 px-2 text-xs text-[#1F1F1D] bg-white border border-[#DDD9D4] rounded font-semibold focus:outline-none"
            >
              <option value="">Select Rider for Bulk Assignment...</option>
              {riders.map(r => (
                <option key={r.id} value={r.id}>{r.profile?.full_name || r.rider_code}</option>
              ))}
            </select>

            <button
              onClick={handleExecuteBulkAssign}
              disabled={isBulkAssigning || !bulkRiderId}
              className="px-3 py-1 text-xs font-bold bg-white text-[#5A2628] hover:bg-stone-100 rounded transition disabled:opacity-50"
            >
              {isBulkAssigning ? 'Assigning...' : 'Confirm Bulk Assign'}
            </button>
          </div>
        </div>
      )}

      {/* Enterprise High-Density Orders Data Table */}
      <div className="bg-white rounded-lg border border-[#DDD9D4] shadow-xs overflow-hidden">
        <div className="overflow-x-auto max-h-[calc(100vh-280px)]">
          <table className="w-full text-left text-xs text-[#1F1F1D]">
            <thead className="bg-[#F5F4F2] border-b border-[#DDD9D4] sticky top-0 z-10 text-[11px] font-bold text-[#6D6964] uppercase tracking-wider">
              <tr>
                <th className="p-2.5 w-8">
                  <input
                    type="checkbox"
                    checked={selectedIds.length === orders.length && orders.length > 0}
                    onChange={handleSelectAll}
                    className="rounded text-[#5A2628]"
                  />
                </th>
                {visibleCols.pkg && <th className="p-2.5">Package #</th>}
                {visibleCols.parent && <th className="p-2.5">Parent Order</th>}
                {visibleCols.customer && <th className="p-2.5">Customer</th>}
                {visibleCols.location && <th className="p-2.5">City & Zone</th>}
                {visibleCols.promised && <th className="p-2.5">Promised Date</th>}
                {visibleCols.cod && <th className="p-2.5 text-right">COD</th>}
                {visibleCols.payment && <th className="p-2.5">Payment</th>}
                {visibleCols.channel && <th className="p-2.5">Channel</th>}
                {visibleCols.rider && <th className="p-2.5">Rider</th>}
                {visibleCols.status && <th className="p-2.5">Status</th>}
                {visibleCols.updated && <th className="p-2.5 text-right">Updated</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-[#DDD9D4]">
              {loading ? (
                <tr>
                  <td colSpan={12} className="p-8 text-center text-xs text-[#6D6964] animate-pulse">
                    Loading package table records...
                  </td>
                </tr>
              ) : orders.length === 0 ? (
                <tr>
                  <td colSpan={12} className="p-8 text-center text-xs text-[#6D6964]">
                    No packages match the current search or status filter.
                  </td>
                </tr>
              ) : (
                orders.map((ord) => {
                  const isSelected = selectedIds.includes(ord.id);
                  const isOverdue = ord.promised_delivery_date && new Date(ord.promised_delivery_date) < new Date() && !['Delivered', 'Cancelled'].includes(ord.current_status);

                  return (
                    <tr
                      key={ord.id}
                      onClick={() => onSelectOrder(ord.id)}
                      className={`hover:bg-[#F5F4F2]/70 cursor-pointer transition ${
                        isSelected ? 'bg-[#5A2628]/5' : ''
                      }`}
                    >
                      <td className="p-2.5" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => handleToggleSelect(ord.id)}
                          className="rounded text-[#5A2628]"
                        />
                      </td>

                      {visibleCols.pkg && (
                        <td className="p-2.5 font-mono font-bold text-[#5A2628]">
                          {ord.original_order_number}
                        </td>
                      )}

                      {visibleCols.parent && (
                        <td className="p-2.5 font-mono text-[#6D6964]">
                          {ord.parent_order_number}
                        </td>
                      )}

                      {visibleCols.customer && (
                        <td className="p-2.5 font-semibold text-[#1F1F1D]">
                          {ord.customer_name}
                        </td>
                      )}

                      {visibleCols.location && (
                        <td className="p-2.5 text-[#6D6964]">
                          {ord.city} <span className="text-[10px] text-stone-400">({ord.zone || 'Central'})</span>
                        </td>
                      )}

                      {visibleCols.promised && (
                        <td className="p-2.5">
                          <div className="flex items-center space-x-1">
                            {isOverdue && <Clock className="w-3 h-3 text-[#B43B3B]" />}
                            <span className={isOverdue ? 'text-[#B43B3B] font-bold' : 'text-[#6D6964]'}>
                              {ord.promised_delivery_date || 'N/A'}
                            </span>
                          </div>
                        </td>
                      )}

                      {visibleCols.cod && (
                        <td className="p-2.5 text-right font-mono font-bold text-[#1F1F1D]">
                          Rs. {(ord.cod_expected || 0).toLocaleString()}
                        </td>
                      )}

                      {visibleCols.payment && (
                        <td className="p-2.5 text-[#6D6964]">
                          <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                            ord.payment_method === 'COD' ? 'bg-amber-50 text-[#A56716] border border-[#A56716]/20' : 'bg-emerald-50 text-[#1F7A52] border border-[#1F7A52]/20'
                          }`}>
                            {ord.payment_method}
                          </span>
                        </td>
                      )}

                      {visibleCols.channel && (
                        <td className="p-2.5 text-[#6D6964] text-[11px]">
                          {ord.delivery_channel || 'Internal Rider'}
                        </td>
                      )}

                      {visibleCols.rider && (
                        <td className="p-2.5 font-semibold">
                          {ord.rider?.profile?.full_name || ord.rider?.rider_code || (
                            <span className="text-[#A56716] italic text-[11px]">Unassigned</span>
                          )}
                        </td>
                      )}

                      {visibleCols.status && (
                        <td className="p-2.5">
                          <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold border ${
                            ord.current_status === 'Delivered' ? 'bg-[#1F7A52]/10 text-[#1F7A52] border-[#1F7A52]/30' :
                            ord.current_status === 'Out for Delivery' ? 'bg-[#356A8A]/10 text-[#356A8A] border-[#356A8A]/30' :
                            ['Customer Unavailable', 'Refused'].includes(ord.current_status) ? 'bg-[#B43B3B]/10 text-[#B43B3B] border-[#B43B3B]/30' :
                            'bg-stone-100 text-[#6D6964] border-[#DDD9D4]'
                          }`}>
                            {ord.current_status}
                          </span>
                        </td>
                      )}

                      {visibleCols.updated && (
                        <td className="p-2.5 text-right font-mono text-[10px] text-[#6D6964]">
                          {new Date(ord.updated_at || ord.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </td>
                      )}
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Server-Side Pagination Bar */}
        <div className="p-3 bg-[#F5F4F2] border-t border-[#DDD9D4] flex justify-between items-center text-xs text-[#6D6964]">
          <span>Showing {orders.length} of {totalOrders} total packages</span>
          <div className="flex items-center space-x-2">
            <button
              disabled={page <= 1}
              onClick={() => setPage(p => Math.max(1, p - 1))}
              className="px-2.5 py-1 bg-white border border-[#DDD9D4] rounded font-semibold disabled:opacity-50 hover:bg-stone-100"
            >
              Previous
            </button>
            <span className="font-mono text-[11px]">Page {page} of {totalPages}</span>
            <button
              disabled={page >= totalPages}
              onClick={() => setPage(p => p + 1)}
              className="px-2.5 py-1 bg-white border border-[#DDD9D4] rounded font-semibold disabled:opacity-50 hover:bg-stone-100"
            >
              Next
            </button>
          </div>
        </div>
      </div>

      {/* CSV Import Drawer */}
      {showImportDrawer && (
        <CSVImportDrawer
          onClose={() => setShowImportDrawer(false)}
          onImportSuccess={() => {
            setShowImportDrawer(false);
            loadOrdersData();
          }}
        />
      )}

      {/* Shopify Direct Sync Modal */}
      <ShopifySyncModal
        isOpen={showShopifySyncModal}
        onClose={() => setShowShopifySyncModal(false)}
        onSyncSuccess={() => {
          loadOrdersData();
        }}
      />

    </div>
  );
}
