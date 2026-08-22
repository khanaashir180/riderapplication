import React, { useState, useEffect } from 'react';
import {
  Shipment,
  ShipmentEvent,
  ImportJob,
  PhysicalReturnRecord,
  LogisticsException,
  CourierPerformanceMetrics,
  CourierMapping,
  LogisticsStatus,
  ReturnCondition,
  ReturnDisposition
} from '../../types/logistics';
import { ShipmentDetailDrawer } from './ShipmentDetailDrawer';
import {
  Package,
  Truck,
  Clock,
  RotateCcw,
  CheckCircle,
  AlertTriangle,
  DollarSign,
  UploadCloud,
  Layers,
  Search,
  Filter,
  RefreshCw,
  Download,
  Barcode,
  Building2,
  FileSpreadsheet,
  FileText,
  UserCheck,
  ChevronRight,
  ShieldCheck,
  Settings
} from 'lucide-react';

interface LogisticsWorkspaceProps {
  activeSubTab?: string;
  onSelectOrder?: (id: string) => void;
  token?: string;
  userRole?: string;
}

export function LogisticsWorkspace({ activeSubTab = 'dashboard', onSelectOrder, token, userRole = 'dispatch_manager' }: LogisticsWorkspaceProps) {
  const [currentSubTab, setCurrentSubTab] = useState<string>(activeSubTab);
  
  // Dashboard & Shipments State
  const [loading, setLoading] = useState<boolean>(true);
  const [stats, setStats] = useState<any>(null);
  const [shipments, setShipments] = useState<Shipment[]>([]);
  const [importJobs, setImportJobs] = useState<ImportJob[]>([]);
  const [exceptions, setExceptions] = useState<LogisticsException[]>([]);
  const [performanceMetrics, setPerformanceMetrics] = useState<CourierPerformanceMetrics[]>([]);
  const [statusMappings, setStatusMappings] = useState<CourierMapping[]>([]);

  // Filters State
  const [searchTerm, setSearchTerm] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [lateFilter, setLateFilter] = useState<string>('');
  const [courierFilter, setCourierFilter] = useState<string>('');
  const [cityFilter, setCityFilter] = useState<string>('');

  // Drawer / Selection
  const [selectedShipmentId, setSelectedShipmentId] = useState<string | null>(null);
  const [selectedShipment, setSelectedShipment] = useState<Shipment | null>(null);
  const [shipmentEvents, setShipmentEvents] = useState<ShipmentEvent[]>([]);
  const [physicalReturn, setPhysicalReturn] = useState<PhysicalReturnRecord | null>(null);
  const [shipmentExceptions, setShipmentExceptions] = useState<LogisticsException[]>([]);

  // Warehouse Scan Form State
  const [scanTracking, setScanTracking] = useState<string>('');
  const [scanLocation, setScanLocation] = useState<string>('Main Warehouse - Bin R-1');
  const [scanCondition, setScanCondition] = useState<ReturnCondition>('Good');
  const [scanDisposition, setScanDisposition] = useState<ReturnDisposition>('Restock');
  const [scanQtyExpected, setScanQtyExpected] = useState<number>(1);
  const [scanQtyReceived, setScanQtyReceived] = useState<number>(1);
  const [scanRemarks, setScanRemarks] = useState<string>('');
  const [scanMatchedShipment, setScanMatchedShipment] = useState<Shipment | null>(null);
  const [scanSubmitting, setScanSubmitting] = useState<boolean>(false);
  const [scanMessage, setScanMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Import Upload State
  const [importFileType, setImportFileType] = useState<'oms' | 'trax' | 'postex' | 'tcs' | 'rider' | 'other'>('oms');
  const [importCourierName, setImportCourierName] = useState<string>('TRAX');
  const [importCsvText, setImportCsvText] = useState<string>('');
  const [importFileName, setImportFileName] = useState<string>('');
  const [importSubmitting, setImportSubmitting] = useState<boolean>(false);
  const [importMessage, setImportMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    if (activeSubTab) setCurrentSubTab(activeSubTab);
  }, [activeSubTab]);

  useEffect(() => {
    fetchDashboardData();
  }, [currentSubTab, statusFilter, lateFilter, courierFilter, cityFilter]);

  const fetchDashboardData = async () => {
    setLoading(true);
    try {
      // 1. Fetch Stats
      const statsRes = await fetch('/api/logistics/dashboard', {
        headers: token ? { Authorization: `Bearer ${token}` } : {}
      });
      const statsData = await statsRes.json();
      if (statsData.success) {
        setStats(statsData.data);
      }

      // 2. Fetch Shipments with active filters
      const params = new URLSearchParams();
      if (statusFilter) params.append('status', statusFilter);
      if (lateFilter) params.append('late', lateFilter);
      if (courierFilter) params.append('courier', courierFilter);
      if (cityFilter) params.append('city', cityFilter);
      if (searchTerm) params.append('search', searchTerm);

      const shipRes = await fetch(`/api/logistics/shipments?${params.toString()}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {}
      });
      const shipData = await shipRes.json();
      if (shipData.success) {
        setShipments(shipData.data || []);
      }

      // 3. Fetch Import Jobs if in imports tab
      if (currentSubTab === 'imports') {
        const jobsRes = await fetch('/api/logistics/import-jobs', {
          headers: token ? { Authorization: `Bearer ${token}` } : {}
        });
        const jobsData = await jobsRes.json();
        if (jobsData.success) {
          setImportJobs(jobsData.data || []);
        }
      }

      // 4. Fetch Exceptions if in exceptions tab
      if (currentSubTab === 'exceptions') {
        const excRes = await fetch('/api/logistics/exceptions', {
          headers: token ? { Authorization: `Bearer ${token}` } : {}
        });
        const excData = await excRes.json();
        if (excData.success) {
          setExceptions(excData.data || []);
        }
      }

      // 5. Fetch Performance Metrics if in performance tab
      if (currentSubTab === 'performance') {
        const perfRes = await fetch('/api/logistics/reports/courier-performance', {
          headers: token ? { Authorization: `Bearer ${token}` } : {}
        });
        const perfData = await perfRes.json();
        if (perfData.success) {
          setPerformanceMetrics(perfData.data || []);
        }
      }

      // 6. Fetch Status Mappings if in status-mappings tab
      if (currentSubTab === 'status-mappings') {
        const mapRes = await fetch('/api/logistics/courier-mappings', {
          headers: token ? { Authorization: `Bearer ${token}` } : {}
        });
        const mapData = await mapRes.json();
        if (mapData.success) {
          setStatusMappings(mapData.data || []);
        }
      }
    } catch (err) {
      console.error("Error fetching logistics hub data", err);
    } finally {
      setLoading(false);
    }
  };

  const openShipmentDetail = async (id: string) => {
    setSelectedShipmentId(id);
    try {
      const res = await fetch(`/api/logistics/shipments/${id}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {}
      });
      const data = await res.json();
      if (data.success) {
        setSelectedShipment(data.data.shipment);
        setShipmentEvents(data.data.events || []);
        setPhysicalReturn(data.data.physicalReturn || null);
        setShipmentExceptions(data.data.exceptions || []);
      }
    } catch (err) {
      console.error("Error loading shipment detail", err);
    }
  };

  const handleWarehouseLookup = async () => {
    if (!scanTracking.trim()) return;
    setScanMessage(null);
    const q = scanTracking.trim().toUpperCase();
    const found = shipments.find(s =>
      s.trackingNumber.toUpperCase() === q || s.orderNumber.toUpperCase() === q
    );
    if (found) {
      setScanMatchedShipment(found);
      setScanQtyExpected(found.returnQuantityExpected || (found.items ? found.items.reduce((acc, i) => acc + i.quantity, 0) : 1));
      setScanQtyReceived(found.returnQuantityExpected || (found.items ? found.items.reduce((acc, i) => acc + i.quantity, 0) : 1));
    } else {
      setScanMatchedShipment(null);
      setScanMessage({ type: 'error', text: `No shipment found for tracking/order "${scanTracking}"` });
    }
  };

  const handleWarehouseSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!scanTracking.trim()) return;
    setScanSubmitting(true);
    setScanMessage(null);

    try {
      const res = await fetch('/api/logistics/warehouse/receive-return', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        body: JSON.stringify({
          trackingNumber: scanTracking.trim(),
          location: scanLocation,
          condition: scanCondition,
          disposition: scanDisposition,
          quantityExpected: scanQtyExpected,
          quantityReceived: scanQtyReceived,
          remarks: scanRemarks
        })
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error?.message || 'Failed to submit physical return receipt');
      }

      setScanMessage({ type: 'success', text: `Physical return confirmed for ${scanTracking.trim()}! Status updated to RETURN_PHYSICALLY_RECEIVED.` });
      setScanTracking('');
      setScanMatchedShipment(null);
      setScanRemarks('');
      fetchDashboardData();
    } catch (err: any) {
      setScanMessage({ type: 'error', text: err.message });
    } finally {
      setScanSubmitting(false);
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportFileName(file.name);
    const reader = new FileReader();
    reader.onload = (event) => {
      setImportCsvText(event.target?.result as string || '');
    };
    reader.readAsText(file);
  };

  const handleImportSubmit = async () => {
    if (!importCsvText) return;
    setImportSubmitting(true);
    setImportMessage(null);

    try {
      const res = await fetch('/api/logistics/import', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        body: JSON.stringify({
          fileType: importFileType,
          courierName: importCourierName,
          csvContent: importCsvText,
          fileName: importFileName || `${importFileType}_import.csv`
        })
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error?.message || 'Import failed');
      }

      setImportMessage({
        type: 'success',
        text: `Import completed! Total: ${data.data.importJob.totalRows}, Processed: ${data.data.processedCount}, Exceptions: ${data.data.exceptionsCount}`
      });
      setImportCsvText('');
      setImportFileName('');
      fetchDashboardData();
    } catch (err: any) {
      setImportMessage({ type: 'error', text: err.message });
    } finally {
      setImportSubmitting(false);
    }
  };

  const exportShipmentsToCsv = () => {
    if (!shipments || shipments.length === 0) return;
    const headers = ['Tracking Number', 'OMS Order Number', 'Parent Order', 'Courier', 'Logistics Status', 'Late By Courier', 'COD Expected', 'COD Received', 'Customer', 'City', 'Booked At', 'Delivered At'];
    const rows = shipments.map(s => [
      s.trackingNumber,
      s.orderNumber,
      s.parentOrderNumber,
      s.courier,
      s.logisticsStatus,
      s.lateByCourier ? 'YES' : 'NO',
      s.codExpected,
      s.codReceived,
      `"${s.customerName}"`,
      s.destinationCity,
      s.courierBookedAt || '',
      s.courierDeliveredAt || ''
    ]);
    const csvContent = "data:text/csv;charset=utf-8," + [headers.join(','), ...rows.map(e => e.join(','))].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `logistics_shipments_${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="p-6 space-y-6 bg-[#F5F4F2] min-h-screen text-[#1F1F1D]">
      
      {/* Top Header & Navigation Pills */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-white p-4 rounded-2xl shadow-xs border border-[#DDD9D4]">
        <div>
          <div className="flex items-center space-x-2">
            <span className="w-2.5 h-2.5 rounded-full bg-[#5A2628]"></span>
            <span className="text-xs font-bold uppercase tracking-wider text-[#6D6964]">Logistics Hub Control Terminal</span>
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-[#1F1F1D] font-mono">
            Gomila Logistics Hub
          </h1>
        </div>

        {/* Sub-tab Switchers */}
        <div className="flex flex-wrap gap-1 bg-[#F5F4F2] p-1.5 rounded-xl border border-[#DDD9D4]">
          {[
            { id: 'dashboard', label: 'Dashboard', icon: <Layers className="w-3.5 h-3.5" /> },
            { id: 'shipments', label: 'Shipments', icon: <Package className="w-3.5 h-3.5" /> },
            { id: 'imports', label: 'Import Terminal', icon: <UploadCloud className="w-3.5 h-3.5" /> },
            { id: 'warehouse-returns', label: 'Warehouse Returns', icon: <Barcode className="w-3.5 h-3.5" /> },
            { id: 'exceptions', label: 'Exceptions Queue', icon: <AlertTriangle className="w-3.5 h-3.5" /> },
            { id: 'performance', label: 'Courier Analytics', icon: <Building2 className="w-3.5 h-3.5" /> },
            { id: 'status-mappings', label: 'Status Mappings', icon: <Settings className="w-3.5 h-3.5" /> }
          ].map(tab => (
            <button
              key={tab.id}
              onClick={() => setCurrentSubTab(tab.id)}
              className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition ${
                currentSubTab === tab.id ? 'bg-[#5A2628] text-white shadow-xs' : 'text-[#6D6964] hover:text-[#1F1F1D] hover:bg-white'
              }`}
            >
              {tab.icon}
              <span>{tab.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* DASHBOARD TAB VIEW */}
      {currentSubTab === 'dashboard' && (
        <div className="space-y-6">
          
          {/* KPI Cards Grid */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            
            {/* 1. Total Active */}
            <div
              onClick={() => { setStatusFilter(''); setLateFilter(''); setCurrentSubTab('shipments'); }}
              className="bg-white p-4 rounded-2xl border border-[#DDD9D4] shadow-xs cursor-pointer hover:border-[#5A2628] transition space-y-2"
            >
              <span className="text-[10px] font-extrabold uppercase tracking-wider text-[#6D6964] block">Total Active Shipments</span>
              <div className="flex items-baseline justify-between">
                <span className="text-2xl font-bold font-mono text-[#1F1F1D]">{stats?.totalActiveShipments || 0}</span>
                <Package className="w-5 h-5 text-[#5A2628]" />
              </div>
              <p className="text-[10px] text-[#6D6964]">In delivery or awaiting return</p>
            </div>

            {/* 2. Pending Deliveries */}
            <div
              onClick={() => { setStatusFilter('PENDING_DELIVERY'); setCurrentSubTab('shipments'); }}
              className="bg-white p-4 rounded-2xl border border-blue-200 shadow-xs cursor-pointer hover:border-blue-500 transition space-y-2"
            >
              <span className="text-[10px] font-extrabold uppercase tracking-wider text-blue-700 block">Pending Deliveries</span>
              <div className="flex items-baseline justify-between">
                <span className="text-2xl font-bold font-mono text-blue-900">{stats?.pendingDeliveries || 0}</span>
                <Truck className="w-5 h-5 text-blue-600" />
              </div>
              <p className="text-[10px] text-blue-700">En route or out for delivery</p>
            </div>

            {/* 3. Late by Courier */}
            <div
              onClick={() => { setLateFilter('true'); setCurrentSubTab('shipments'); }}
              className="bg-red-50 p-4 rounded-2xl border border-red-200 shadow-xs cursor-pointer hover:border-red-500 transition space-y-2"
            >
              <span className="text-[10px] font-extrabold uppercase tracking-wider text-red-700 block">Late by Courier (&gt; 96h)</span>
              <div className="flex items-baseline justify-between">
                <span className="text-2xl font-bold font-mono text-red-900">{stats?.lateByCourier || 0}</span>
                <Clock className="w-5 h-5 text-red-600" />
              </div>
              <p className="text-[10px] text-red-700">Courier SLA Breached (&gt; 4 days)</p>
            </div>

            {/* 4. Awaiting Physical Receipt */}
            <div
              onClick={() => { setStatusFilter('RETURN_AWAITING_PHYSICAL_RECEIPT'); setCurrentSubTab('shipments'); }}
              className="bg-amber-50 p-4 rounded-2xl border border-amber-200 shadow-xs cursor-pointer hover:border-amber-500 transition space-y-2"
            >
              <span className="text-[10px] font-extrabold uppercase tracking-wider text-amber-800 block">Awaiting Physical Receipt</span>
              <div className="flex items-baseline justify-between">
                <span className="text-2xl font-bold font-mono text-amber-900">{stats?.awaitingPhysicalReceipt || 0}</span>
                <RotateCcw className="w-5 h-5 text-amber-600" />
              </div>
              <p className="text-[10px] text-amber-800">Return marked by courier</p>
            </div>

            {/* 5. Exceptions Count */}
            <div
              onClick={() => { setCurrentSubTab('exceptions'); }}
              className="bg-white p-4 rounded-2xl border border-[#DDD9D4] shadow-xs cursor-pointer hover:border-red-500 transition space-y-2"
            >
              <span className="text-[10px] font-extrabold uppercase tracking-wider text-[#6D6964] block">Logistics Exceptions</span>
              <div className="flex items-baseline justify-between">
                <span className="text-2xl font-bold font-mono text-[#5A2628]">{stats?.exceptions || 0}</span>
                <AlertTriangle className="w-5 h-5 text-amber-500" />
              </div>
              <p className="text-[10px] text-[#6D6964]">Unmatched & COD issues</p>
            </div>

          </div>

          {/* Quick Search & Filters Bar */}
          <div className="bg-white p-4 rounded-2xl border border-[#DDD9D4] space-y-3">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
              <div className="relative flex-1">
                <Search className="w-4 h-4 text-[#6D6964] absolute left-3 top-2.5" />
                <input
                  type="text"
                  value={searchTerm}
                  onChange={e => setSearchTerm(e.target.value)}
                  placeholder="Search tracking #, order #, customer name, phone..."
                  className="w-full pl-9 pr-3 py-2 bg-[#F5F4F2] border border-[#DDD9D4] rounded-xl text-xs font-medium focus:outline-hidden"
                />
              </div>

              <div className="flex items-center space-x-2">
                <button
                  onClick={fetchDashboardData}
                  className="p-2 bg-[#F5F4F2] border border-[#DDD9D4] text-[#6D6964] hover:text-[#1F1F1D] rounded-xl text-xs font-bold transition flex items-center space-x-1"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>Refresh</span>
                </button>
                <button
                  onClick={exportShipmentsToCsv}
                  className="p-2 bg-[#5A2628] text-white rounded-xl text-xs font-bold hover:bg-[#471D1F] transition flex items-center space-x-1"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Export CSV</span>
                </button>
              </div>
            </div>
          </div>

          {/* Recent Shipments Preview */}
          <div className="bg-white rounded-2xl border border-[#DDD9D4] overflow-hidden">
            <div className="p-4 bg-[#F5F4F2] border-b border-[#DDD9D4] flex justify-between items-center">
              <h3 className="text-xs font-bold uppercase tracking-wider text-[#1F1F1D] flex items-center space-x-2">
                <Package className="w-4 h-4 text-[#5A2628]" />
                <span>Active Logistics Records ({shipments.length})</span>
              </h3>
              <button
                onClick={() => setCurrentSubTab('shipments')}
                className="text-xs font-bold text-[#5A2628] hover:underline flex items-center space-x-1"
              >
                <span>View Full Table</span>
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-[#F5F4F2] border-b border-[#DDD9D4] text-[#6D6964] text-[10px] uppercase font-extrabold">
                  <tr>
                    <th className="py-3 px-4">Tracking #</th>
                    <th className="py-3 px-4">Order #</th>
                    <th className="py-3 px-4">Courier</th>
                    <th className="py-3 px-4">Customer</th>
                    <th className="py-3 px-4">City</th>
                    <th className="py-3 px-4">Logistics Status</th>
                    <th className="py-3 px-4">Late SLA</th>
                    <th className="py-3 px-4 text-right">COD Expected</th>
                    <th className="py-3 px-4 text-center">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#DDD9D4]">
                  {shipments && shipments.length > 0 ? (
                    shipments.slice(0, 10).map((s) => (
                      <tr key={s.id} className="hover:bg-stone-50 transition">
                        <td className="py-3 px-4 font-mono font-bold text-[#5A2628]">{s.trackingNumber}</td>
                        <td className="py-3 px-4 font-mono text-[#1F1F1D]">{s.orderNumber}</td>
                        <td className="py-3 px-4 font-semibold">{s.courier}</td>
                        <td className="py-3 px-4 font-medium">{s.customerName}</td>
                        <td className="py-3 px-4 text-[#6D6964]">{s.destinationCity}</td>
                        <td className="py-3 px-4">
                          <span className={`px-2 py-0.5 text-[10px] font-bold rounded-full border ${
                            s.logisticsStatus === 'DELIVERED' ? 'bg-emerald-50 text-emerald-800 border-emerald-200' :
                            s.logisticsStatus === 'RETURN_AWAITING_PHYSICAL_RECEIPT' ? 'bg-amber-50 text-amber-800 border-amber-200' :
                            s.logisticsStatus === 'RETURN_PHYSICALLY_RECEIVED' ? 'bg-purple-50 text-purple-800 border-purple-200' :
                            'bg-blue-50 text-blue-800 border-blue-200'
                          }`}>
                            {s.logisticsStatus}
                          </span>
                        </td>
                        <td className="py-3 px-4">
                          {s.lateByCourier ? (
                            <span className="px-2 py-0.5 text-[10px] font-extrabold bg-red-100 text-red-800 rounded-full border border-red-300">
                              LATE ({s.deliveryAgeHours}h)
                            </span>
                          ) : (
                            <span className="text-[10px] text-emerald-700 font-bold">On Time</span>
                          )}
                        </td>
                        <td className="py-3 px-4 text-right font-mono font-bold">PKR {s.codExpected.toLocaleString()}</td>
                        <td className="py-3 px-4 text-center">
                          <button
                            onClick={() => openShipmentDetail(s.id)}
                            className="px-2.5 py-1 bg-stone-100 hover:bg-[#5A2628] hover:text-white rounded-lg text-[10px] font-bold transition"
                          >
                            Inspect
                          </button>
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={9} className="py-8 text-center text-xs text-[#6D6964]">
                        No shipments found matching criteria.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

        </div>
      )}

      {/* SHIPMENTS TABLE VIEW */}
      {currentSubTab === 'shipments' && (
        <div className="space-y-4">
          
          {/* Filters Bar */}
          <div className="bg-white p-4 rounded-2xl border border-[#DDD9D4] grid grid-cols-1 md:grid-cols-5 gap-3 text-xs">
            <div>
              <label className="block text-[10px] font-bold uppercase text-[#6D6964] mb-1">Status</label>
              <select
                value={statusFilter}
                onChange={e => setStatusFilter(e.target.value)}
                className="w-full p-2 bg-[#F5F4F2] border border-[#DDD9D4] rounded-lg font-medium"
              >
                <option value="">All Statuses</option>
                <option value="UNBOOKED">UNBOOKED</option>
                <option value="PENDING_DELIVERY">PENDING_DELIVERY</option>
                <option value="DELIVERED">DELIVERED</option>
                <option value="RETURN_MARKED">RETURN_MARKED</option>
                <option value="RETURN_AWAITING_PHYSICAL_RECEIPT">RETURN_AWAITING_PHYSICAL_RECEIPT</option>
                <option value="RETURN_PHYSICALLY_RECEIVED">RETURN_PHYSICALLY_RECEIVED</option>
                <option value="EXCEPTION">EXCEPTION</option>
              </select>
            </div>

            <div>
              <label className="block text-[10px] font-bold uppercase text-[#6D6964] mb-1">Late SLA Flag</label>
              <select
                value={lateFilter}
                onChange={e => setLateFilter(e.target.value)}
                className="w-full p-2 bg-[#F5F4F2] border border-[#DDD9D4] rounded-lg font-medium"
              >
                <option value="">All SLA States</option>
                <option value="true">Late (&gt; 96h)</option>
                <option value="false">On Time (&lt;= 96h)</option>
              </select>
            </div>

            <div>
              <label className="block text-[10px] font-bold uppercase text-[#6D6964] mb-1">Courier</label>
              <select
                value={courierFilter}
                onChange={e => setCourierFilter(e.target.value)}
                className="w-full p-2 bg-[#F5F4F2] border border-[#DDD9D4] rounded-lg font-medium"
              >
                <option value="">All Couriers</option>
                <option value="TRAX">TRAX</option>
                <option value="PostEx">PostEx</option>
                <option value="TCS">TCS</option>
                <option value="Company Rider">Company Rider</option>
              </select>
            </div>

            <div>
              <label className="block text-[10px] font-bold uppercase text-[#6D6964] mb-1">Destination City</label>
              <input
                type="text"
                value={cityFilter}
                onChange={e => setCityFilter(e.target.value)}
                placeholder="e.g. Lahore"
                className="w-full p-2 bg-[#F5F4F2] border border-[#DDD9D4] rounded-lg font-medium"
              />
            </div>

            <div className="flex items-end space-x-2">
              <button
                onClick={() => { setStatusFilter(''); setLateFilter(''); setCourierFilter(''); setCityFilter(''); setSearchTerm(''); }}
                className="w-full py-2 bg-stone-200 hover:bg-stone-300 text-[#1F1F1D] font-bold rounded-lg transition"
              >
                Reset Filters
              </button>
            </div>
          </div>

          {/* Table Container */}
          <div className="bg-white rounded-2xl border border-[#DDD9D4] overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-[#F5F4F2] border-b border-[#DDD9D4] text-[#6D6964] text-[10px] uppercase font-extrabold">
                  <tr>
                    <th className="py-3 px-4">Tracking Number</th>
                    <th className="py-3 px-4">OMS Order</th>
                    <th className="py-3 px-4">Courier</th>
                    <th className="py-3 px-4">Customer</th>
                    <th className="py-3 px-4">City</th>
                    <th className="py-3 px-4">Logistics Status</th>
                    <th className="py-3 px-4">Courier Raw</th>
                    <th className="py-3 px-4">Late SLA</th>
                    <th className="py-3 px-4">COD Status</th>
                    <th className="py-3 px-4 text-right">COD Expected</th>
                    <th className="py-3 px-4 text-center">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#DDD9D4]">
                  {shipments && shipments.length > 0 ? (
                    shipments.map((s) => (
                      <tr key={s.id} className="hover:bg-stone-50 transition">
                        <td className="py-3 px-4 font-mono font-bold text-[#5A2628]">{s.trackingNumber}</td>
                        <td className="py-3 px-4 font-mono text-[#1F1F1D]">{s.orderNumber}</td>
                        <td className="py-3 px-4 font-semibold">{s.courier}</td>
                        <td className="py-3 px-4 font-medium">{s.customerName}</td>
                        <td className="py-3 px-4 text-[#6D6964]">{s.destinationCity}</td>
                        <td className="py-3 px-4">
                          <span className={`px-2 py-0.5 text-[10px] font-bold rounded-full border ${
                            s.logisticsStatus === 'DELIVERED' ? 'bg-emerald-50 text-emerald-800 border-emerald-200' :
                            s.logisticsStatus === 'RETURN_AWAITING_PHYSICAL_RECEIPT' ? 'bg-amber-50 text-amber-800 border-amber-200' :
                            s.logisticsStatus === 'RETURN_PHYSICALLY_RECEIVED' ? 'bg-purple-50 text-purple-800 border-purple-200' :
                            'bg-blue-50 text-blue-800 border-blue-200'
                          }`}>
                            {s.logisticsStatus}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-[#6D6964] text-[11px]">{s.courierStatusRaw}</td>
                        <td className="py-3 px-4">
                          {s.lateByCourier ? (
                            <span className="px-2 py-0.5 text-[10px] font-extrabold bg-red-100 text-red-800 rounded-full border border-red-300">
                              LATE ({s.deliveryAgeHours}h)
                            </span>
                          ) : (
                            <span className="text-[10px] text-emerald-700 font-bold">On Time</span>
                          )}
                        </td>
                        <td className="py-3 px-4">
                          <span className={`px-2 py-0.5 text-[10px] font-bold rounded-full border ${
                            s.codStatus === 'RECEIVED' ? 'bg-emerald-50 text-emerald-800 border-emerald-200' :
                            s.codStatus === 'PENDING' ? 'bg-amber-50 text-amber-800 border-amber-200' : 'bg-stone-100 text-stone-700'
                          }`}>
                            {s.codStatus}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-right font-mono font-bold">PKR {s.codExpected.toLocaleString()}</td>
                        <td className="py-3 px-4 text-center">
                          <button
                            onClick={() => openShipmentDetail(s.id)}
                            className="px-2.5 py-1 bg-[#5A2628] text-white rounded-lg text-[10px] font-bold hover:bg-[#471D1F] transition"
                          >
                            Inspect
                          </button>
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={11} className="py-8 text-center text-xs text-[#6D6964]">
                        No shipments found matching filters.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

        </div>
      )}

      {/* IMPORT TERMINAL VIEW */}
      {currentSubTab === 'imports' && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          
          {/* Upload Form */}
          <div className="md:col-span-1 bg-white p-5 rounded-2xl border border-[#DDD9D4] space-y-4">
            <h3 className="text-sm font-bold uppercase tracking-wider text-[#1F1F1D] flex items-center space-x-2">
              <UploadCloud className="w-4 h-4 text-[#5A2628]" />
              <span>Upload CSV Data File</span>
            </h3>

            {importMessage && (
              <div className={`p-3 rounded-xl text-xs font-medium ${
                importMessage.type === 'success' ? 'bg-emerald-50 text-emerald-800 border border-emerald-200' : 'bg-red-50 text-red-800 border border-red-200'
              }`}>
                {importMessage.text}
              </div>
            )}

            <div>
              <label className="block text-xs font-bold text-[#1F1F1D] mb-1">Import Type</label>
              <select
                value={importFileType}
                onChange={e => setImportFileType(e.target.value as any)}
                className="w-full p-2.5 bg-[#F5F4F2] border border-[#DDD9D4] rounded-xl text-xs font-bold"
              >
                <option value="oms">OMS Master File (Orders & Products)</option>
                <option value="trax">TRAX Courier File</option>
                <option value="postex">PostEx Courier File</option>
                <option value="tcs">TCS Courier File</option>
                <option value="rider">Internal Rider Manifest</option>
                <option value="other">Other Courier File</option>
              </select>
            </div>

            {importFileType !== 'oms' && (
              <div>
                <label className="block text-xs font-bold text-[#1F1F1D] mb-1">Courier Partner Name</label>
                <input
                  type="text"
                  value={importCourierName}
                  onChange={e => setImportCourierName(e.target.value)}
                  placeholder="e.g. TRAX Logistics"
                  className="w-full p-2.5 border border-[#DDD9D4] rounded-xl text-xs font-medium"
                />
              </div>
            )}

            <div>
              <label className="block text-xs font-bold text-[#1F1F1D] mb-1">CSV File</label>
              <input
                type="file"
                accept=".csv"
                onChange={handleFileUpload}
                className="w-full text-xs text-[#6D6964] file:mr-4 file:py-2 file:px-4 file:rounded-xl file:border-0 file:text-xs file:font-bold file:bg-[#5A2628] file:text-white hover:file:bg-[#471D1F]"
              />
            </div>

            <button
              onClick={handleImportSubmit}
              disabled={!importCsvText || importSubmitting}
              className="w-full py-3 bg-[#5A2628] text-white rounded-xl text-xs font-bold hover:bg-[#471D1F] transition disabled:opacity-50 flex items-center justify-center space-x-2"
            >
              <UploadCloud className="w-4 h-4" />
              <span>{importSubmitting ? 'Processing Importer...' : 'Process Import File'}</span>
            </button>
          </div>

          {/* Import Jobs History */}
          <div className="md:col-span-2 bg-white rounded-2xl border border-[#DDD9D4] overflow-hidden space-y-3 p-4">
            <h3 className="text-sm font-bold uppercase tracking-wider text-[#1F1F1D] flex items-center space-x-2 border-b border-[#DDD9D4] pb-3">
              <FileSpreadsheet className="w-4 h-4 text-[#5A2628]" />
              <span>Import Execution Log</span>
            </h3>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-[#F5F4F2] border-b border-[#DDD9D4] text-[#6D6964] text-[10px] uppercase font-extrabold">
                  <tr>
                    <th className="py-2.5 px-3">File Name</th>
                    <th className="py-2.5 px-3">Type / Courier</th>
                    <th className="py-2.5 px-3">Uploaded By</th>
                    <th className="py-2.5 px-3 text-center">Total</th>
                    <th className="py-2.5 px-3 text-center">Processed</th>
                    <th className="py-2.5 px-3 text-center">Exceptions</th>
                    <th className="py-2.5 px-3 text-right">Timestamp</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#DDD9D4]">
                  {importJobs && importJobs.length > 0 ? (
                    importJobs.map(j => (
                      <tr key={j.id} className="hover:bg-stone-50">
                        <td className="py-2.5 px-3 font-mono font-bold text-[#5A2628]">{j.fileName}</td>
                        <td className="py-2.5 px-3 uppercase font-bold text-[10px]">{j.fileType} - {j.courier}</td>
                        <td className="py-2.5 px-3 text-[#6D6964]">{j.uploadedBy}</td>
                        <td className="py-2.5 px-3 text-center font-bold">{j.totalRows}</td>
                        <td className="py-2.5 px-3 text-center font-bold text-emerald-700">{j.successfulRows}</td>
                        <td className="py-2.5 px-3 text-center font-bold text-amber-700">{j.unmatchedRows + j.failedRows}</td>
                        <td className="py-2.5 px-3 text-right text-[10px] font-mono text-[#6D6964]">
                          {new Date(j.uploadedAt).toLocaleString()}
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={7} className="py-6 text-center text-xs text-[#6D6964]">No import jobs recorded yet.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

        </div>
      )}

      {/* WAREHOUSE RETURNS RECEIVING VIEW */}
      {currentSubTab === 'warehouse-returns' && (
        <div className="max-w-3xl mx-auto bg-white p-6 rounded-2xl border border-[#DDD9D4] space-y-6 shadow-md">
          <div className="border-b border-[#DDD9D4] pb-4 flex items-center justify-between">
            <div>
              <span className="text-[10px] font-extrabold uppercase tracking-wider text-purple-700 block">Warehouse Intake Station</span>
              <h2 className="text-xl font-bold font-mono text-[#1F1F1D]">Physical Return Intake & Verification</h2>
            </div>
            <Barcode className="w-8 h-8 text-[#5A2628]" />
          </div>

          {scanMessage && (
            <div className={`p-4 rounded-xl text-xs font-semibold ${
              scanMessage.type === 'success' ? 'bg-emerald-50 text-emerald-800 border border-emerald-200' : 'bg-red-50 text-red-800 border border-red-200'
            }`}>
              {scanMessage.text}
            </div>
          )}

          <form onSubmit={handleWarehouseSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-bold text-[#1F1F1D] mb-1">Scan or Enter Tracking / Order Number</label>
              <div className="flex space-x-2">
                <input
                  type="text"
                  value={scanTracking}
                  onChange={e => setScanTracking(e.target.value)}
                  placeholder="e.g. TRX-10029384"
                  className="flex-1 px-4 py-3 bg-[#F5F4F2] border border-[#DDD9D4] rounded-xl font-mono text-sm font-bold uppercase"
                />
                <button
                  type="button"
                  onClick={handleWarehouseLookup}
                  className="px-4 py-3 bg-[#5A2628] text-white rounded-xl text-xs font-bold hover:bg-[#471D1F] transition"
                >
                  Verify Record
                </button>
              </div>
            </div>

            {scanMatchedShipment && (
              <div className="p-4 bg-stone-50 rounded-xl border border-[#DDD9D4] space-y-2 text-xs">
                <p className="font-bold text-[#5A2628]">Shipment Found: {scanMatchedShipment.trackingNumber}</p>
                <p className="text-[#6D6964]">Customer: <strong>{scanMatchedShipment.customerName}</strong> ({scanMatchedShipment.destinationCity})</p>
                <p className="text-[#6D6964]">Current Status: <strong className="text-amber-700">{scanMatchedShipment.logisticsStatus}</strong></p>
                {scanMatchedShipment.physicalReturnReceived && (
                  <p className="p-2 bg-purple-100 text-purple-900 font-extrabold rounded">
                    ⚠️ ALREADY PHYSICALLY RECEIVED ON {new Date(scanMatchedShipment.physicalReturnReceivedAt!).toLocaleString()}
                  </p>
                )}
              </div>
            )}

            <div className="grid grid-cols-2 gap-4 text-xs">
              <div>
                <label className="block font-bold text-[#1F1F1D] mb-1">Warehouse Bin / Location</label>
                <input
                  type="text"
                  value={scanLocation}
                  onChange={e => setScanLocation(e.target.value)}
                  className="w-full p-2.5 border border-[#DDD9D4] rounded-xl font-medium"
                />
              </div>

              <div>
                <label className="block font-bold text-[#1F1F1D] mb-1">Physical Condition</label>
                <select
                  value={scanCondition}
                  onChange={e => setScanCondition(e.target.value as ReturnCondition)}
                  className="w-full p-2.5 border border-[#DDD9D4] rounded-xl font-bold"
                >
                  <option value="Good">Good (Restockable)</option>
                  <option value="Used">Used / Tried</option>
                  <option value="Damaged">Damaged</option>
                  <option value="Wrong Item">Wrong Item</option>
                  <option value="Incomplete">Incomplete</option>
                  <option value="Packaging Damaged">Packaging Damaged</option>
                  <option value="Other">Other</option>
                </select>
              </div>

              <div>
                <label className="block font-bold text-[#1F1F1D] mb-1">Return Disposition</label>
                <select
                  value={scanDisposition}
                  onChange={e => setScanDisposition(e.target.value as ReturnDisposition)}
                  className="w-full p-2.5 border border-[#DDD9D4] rounded-xl font-bold"
                >
                  <option value="Restock">Restock to Inventory</option>
                  <option value="Quality Check">Quality Check Inspection</option>
                  <option value="Repair">Repair / Refurbish</option>
                  <option value="Hold">Hold / On Notice</option>
                  <option value="Reject">Reject / Write Off</option>
                  <option value="Missing Item Investigation">Missing Item Investigation</option>
                </select>
              </div>

              <div>
                <label className="block font-bold text-[#1F1F1D] mb-1">Received Quantity</label>
                <input
                  type="number"
                  value={scanQtyReceived}
                  onChange={e => setScanQtyReceived(parseInt(e.target.value || '1', 10))}
                  className="w-full p-2.5 border border-[#DDD9D4] rounded-xl font-mono font-bold"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-bold text-[#1F1F1D] mb-1">Inspection Remarks</label>
              <textarea
                value={scanRemarks}
                onChange={e => setScanRemarks(e.target.value)}
                rows={3}
                placeholder="Enter physical inspection notes..."
                className="w-full p-2.5 border border-[#DDD9D4] rounded-xl text-xs"
              ></textarea>
            </div>

            <button
              type="submit"
              disabled={scanSubmitting || !scanTracking.trim()}
              className="w-full py-3 bg-purple-700 text-white rounded-xl text-xs font-bold hover:bg-purple-800 transition disabled:opacity-50 flex items-center justify-center space-x-2"
            >
              <ShieldCheck className="w-4 h-4" />
              <span>{scanSubmitting ? 'Confirming Receipt...' : 'Confirm Physical Return Intake'}</span>
            </button>
          </form>
        </div>
      )}

      {/* EXCEPTIONS QUEUE VIEW */}
      {currentSubTab === 'exceptions' && (
        <div className="bg-white rounded-2xl border border-[#DDD9D4] overflow-hidden p-4 space-y-4">
          <h3 className="text-sm font-bold uppercase tracking-wider text-[#1F1F1D] flex items-center space-x-2 border-b border-[#DDD9D4] pb-3">
            <AlertTriangle className="w-4 h-4 text-amber-600" />
            <span>Unmatched & Exception Queue ({exceptions.length})</span>
          </h3>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-[#F5F4F2] border-b border-[#DDD9D4] text-[#6D6964] text-[10px] uppercase font-extrabold">
                <tr>
                  <th className="py-2.5 px-3">Type</th>
                  <th className="py-2.5 px-3">Tracking / Order</th>
                  <th className="py-2.5 px-3">Courier</th>
                  <th className="py-2.5 px-3">Details</th>
                  <th className="py-2.5 px-3">Status</th>
                  <th className="py-2.5 px-3 text-right">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#DDD9D4]">
                {exceptions && exceptions.length > 0 ? (
                  exceptions.map(exc => (
                    <tr key={exc.id} className="hover:bg-stone-50">
                      <td className="py-2.5 px-3 font-bold text-red-700">{exc.exceptionType}</td>
                      <td className="py-2.5 px-3 font-mono font-bold">{exc.trackingNumber || exc.orderNumber || 'N/A'}</td>
                      <td className="py-2.5 px-3 font-semibold">{exc.courier || 'N/A'}</td>
                      <td className="py-2.5 px-3 text-[#1F1F1D]">{exc.details}</td>
                      <td className="py-2.5 px-3">
                        <span className={`px-2 py-0.5 text-[10px] font-extrabold rounded-full ${
                          exc.status === 'RESOLVED' ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-800'
                        }`}>
                          {exc.status}
                        </span>
                      </td>
                      <td className="py-2.5 px-3 text-right text-[10px] font-mono text-[#6D6964]">
                        {new Date(exc.createdAt).toLocaleString()}
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={6} className="py-8 text-center text-xs text-[#6D6964]">No open exceptions found. All records matched!</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* COURIER PERFORMANCE VIEW */}
      {currentSubTab === 'performance' && (
        <div className="bg-white rounded-2xl border border-[#DDD9D4] p-5 space-y-4">
          <div className="flex justify-between items-center border-b border-[#DDD9D4] pb-3">
            <h3 className="text-sm font-bold uppercase tracking-wider text-[#1F1F1D] flex items-center space-x-2">
              <Building2 className="w-4 h-4 text-[#5A2628]" />
              <span>Courier SLA & Performance Metrics</span>
            </h3>
            <button
              onClick={exportShipmentsToCsv}
              className="px-3 py-1.5 bg-[#5A2628] text-white rounded-xl text-xs font-bold hover:bg-[#471D1F] transition flex items-center space-x-1"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Export Performance CSV</span>
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-[#F5F4F2] border-b border-[#DDD9D4] text-[#6D6964] text-[10px] uppercase font-extrabold">
                <tr>
                  <th className="py-3 px-3">Courier</th>
                  <th className="py-3 px-3 text-center">Assigned</th>
                  <th className="py-3 px-3 text-center">Delivered</th>
                  <th className="py-3 px-3 text-center">Delivery %</th>
                  <th className="py-3 px-3 text-center">Returned</th>
                  <th className="py-3 px-3 text-center">Return %</th>
                  <th className="py-3 px-3 text-center">Late SLA (&gt; 96h)</th>
                  <th className="py-3 px-3 text-center">Avg Delivery Hours</th>
                  <th className="py-3 px-3 text-right">COD Expected</th>
                  <th className="py-3 px-3 text-right">COD Received</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#DDD9D4]">
                {performanceMetrics && performanceMetrics.length > 0 ? (
                  performanceMetrics.map(m => (
                    <tr key={m.courier} className="hover:bg-stone-50">
                      <td className="py-3 px-3 font-bold text-[#5A2628]">{m.courier}</td>
                      <td className="py-3 px-3 text-center font-bold">{m.totalAssigned}</td>
                      <td className="py-3 px-3 text-center font-bold text-emerald-700">{m.deliveredCount}</td>
                      <td className="py-3 px-3 text-center font-extrabold text-emerald-800 bg-emerald-50">{m.deliveryPercentage}%</td>
                      <td className="py-3 px-3 text-center font-bold text-amber-700">{m.returnCount}</td>
                      <td className="py-3 px-3 text-center font-bold text-amber-800">{m.returnPercentage}%</td>
                      <td className="py-3 px-3 text-center font-bold text-red-700">{m.lateCount}</td>
                      <td className="py-3 px-3 text-center font-mono font-bold">{m.avgDeliveryTimeHours}h</td>
                      <td className="py-3 px-3 text-right font-mono font-bold">PKR {m.codExpected.toLocaleString()}</td>
                      <td className="py-3 px-3 text-right font-mono font-bold text-emerald-800">PKR {m.codReceived.toLocaleString()}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={10} className="py-8 text-center text-xs text-[#6D6964]">No courier metrics available.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* STATUS MAPPINGS VIEW */}
      {currentSubTab === 'status-mappings' && (
        <div className="bg-white rounded-2xl border border-[#DDD9D4] p-5 space-y-4">
          <h3 className="text-sm font-bold uppercase tracking-wider text-[#1F1F1D] flex items-center space-x-2 border-b border-[#DDD9D4] pb-3">
            <Settings className="w-4 h-4 text-[#5A2628]" />
            <span>Configurable Courier Status Mappings</span>
          </h3>
          <p className="text-xs text-[#6D6964]">
            Maps raw status strings from TRAX, PostEx, TCS, and internal riders into unified Logistics Hub statuses.
          </p>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-[#F5F4F2] border-b border-[#DDD9D4] text-[#6D6964] text-[10px] uppercase font-extrabold">
                <tr>
                  <th className="py-2.5 px-3">Courier</th>
                  <th className="py-2.5 px-3">Courier Raw Wording</th>
                  <th className="py-2.5 px-3">Unified Logistics Status</th>
                  <th className="py-2.5 px-3">Description</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#DDD9D4]">
                {statusMappings && statusMappings.length > 0 ? (
                  statusMappings.map(m => (
                    <tr key={m.id} className="hover:bg-stone-50">
                      <td className="py-2.5 px-3 font-bold text-[#5A2628]">{m.courier}</td>
                      <td className="py-2.5 px-3 font-mono font-bold">{m.courierStatusRaw}</td>
                      <td className="py-2.5 px-3 font-extrabold text-purple-900">{m.logisticsStatus}</td>
                      <td className="py-2.5 px-3 text-[#6D6964]">{m.description || 'N/A'}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={4} className="py-6 text-center text-xs text-[#6D6964]">
                      Using standard default mapping table. No custom mappings added.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Global Shipment Detail Drawer */}
      {selectedShipmentId && (
        <ShipmentDetailDrawer
          shipment={selectedShipment}
          events={shipmentEvents}
          physicalReturn={physicalReturn}
          exceptions={shipmentExceptions}
          onClose={() => { setSelectedShipmentId(null); setSelectedShipment(null); }}
          onRefresh={fetchDashboardData}
          token={token}
        />
      )}

    </div>
  );
}
