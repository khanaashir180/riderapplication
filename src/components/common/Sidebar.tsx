import React from 'react';
import { 
  Truck, 
  Package, 
  Layers, 
  Users, 
  AlertTriangle, 
  DollarSign, 
  RotateCcw, 
  BarChart3, 
  Smartphone,
  CheckSquare,
  Building2,
  Receipt,
  FileSpreadsheet,
  RefreshCw,
  Box,
  Repeat,
  ShieldCheck,
  ShoppingBag
} from 'lucide-react';
import { UserRole } from '../../types';

export type WorkspaceId = 'dispatch' | 'logistics' | 'rider' | 'finance' | 'returns' | 'management' | 'admin';

interface SidebarProps {
  currentRole: UserRole;
  activeWorkspace: WorkspaceId;
  setActiveWorkspace: (ws: WorkspaceId) => void;
  activeSubTab: string;
  setActiveSubTab: (tab: string) => void;
}

export function Sidebar({
  currentRole,
  activeWorkspace,
  setActiveWorkspace,
  activeSubTab,
  setActiveSubTab
}: SidebarProps) {

  // Role visibility checks
  const canAccessWorkspace = (ws: WorkspaceId): boolean => {
    if (ws === 'admin') return currentRole === 'super_admin';
    if (currentRole === 'super_admin') return true;
    if (currentRole === 'rider') return ws === 'rider';
    if (currentRole === 'dispatch_manager') return true;
    if (currentRole === 'cashier') return ws === 'finance';
    if (currentRole === 'customer_service') return ws === 'returns';
    if (currentRole === 'warehouse_staff') return ws === 'returns';
    if (currentRole === 'management_viewer') return ws === 'management';
    return true;
  };

  const workspaces: Array<{ id: WorkspaceId; label: string; icon: React.ReactNode }> = [
    { id: 'dispatch', label: 'Dispatch', icon: <Truck className="w-4 h-4" /> },
    { id: 'logistics', label: 'Logistics Hub', icon: <Building2 className="w-4 h-4" /> },
    { id: 'rider', label: 'Rider App', icon: <Smartphone className="w-4 h-4" /> },
    { id: 'finance', label: 'COD & Finance', icon: <DollarSign className="w-4 h-4" /> },
    { id: 'returns', label: 'Returns & CS', icon: <RotateCcw className="w-4 h-4" /> },
    { id: 'management', label: 'Management', icon: <BarChart3 className="w-4 h-4" /> },
    { id: 'admin', label: 'Administration', icon: <ShieldCheck className="w-4 h-4" /> }
  ];

  // Subtabs per workspace
  const getSubTabs = (ws: WorkspaceId) => {
    switch (ws) {
      case 'dispatch':
        return [
          { id: 'overview', label: 'Overview', icon: <Layers className="w-3.5 h-3.5" /> },
          { id: 'orders', label: 'Orders', icon: <Package className="w-3.5 h-3.5" /> },
          { id: 'runs', label: 'Dispatch Runs', icon: <Truck className="w-3.5 h-3.5" /> },
          { id: 'riders', label: 'Riders', icon: <Users className="w-3.5 h-3.5" /> },
          { id: 'exceptions', label: 'Exceptions', icon: <AlertTriangle className="w-3.5 h-3.5" /> }
        ];
      case 'logistics':
        return [
          { id: 'dashboard', label: 'Dashboard', icon: <Layers className="w-3.5 h-3.5" /> },
          { id: 'shipments', label: 'Shipments', icon: <Package className="w-3.5 h-3.5" /> },
          { id: 'imports', label: 'Import Terminal', icon: <FileSpreadsheet className="w-3.5 h-3.5" /> },
          { id: 'warehouse-returns', label: 'Warehouse Returns', icon: <Box className="w-3.5 h-3.5" /> },
          { id: 'exceptions', label: 'Exceptions Queue', icon: <AlertTriangle className="w-3.5 h-3.5" /> },
          { id: 'performance', label: 'Courier Analytics', icon: <Building2 className="w-3.5 h-3.5" /> },
          { id: 'status-mappings', label: 'Status Mappings', icon: <BarChart3 className="w-3.5 h-3.5" /> }
        ];
      case 'finance':
        return [
          { id: 'settlements', label: 'Open Settlements', icon: <Receipt className="w-3.5 h-3.5" /> },
          { id: 'cash', label: 'Rider Cash', icon: <DollarSign className="w-3.5 h-3.5" /> },
          { id: 'digital', label: 'Digital Collections', icon: <CheckSquare className="w-3.5 h-3.5" /> },
          { id: 'couriers', label: 'Courier Receivables', icon: <Building2 className="w-3.5 h-3.5" /> },
          { id: 'deposits', label: 'Bank Deposits', icon: <FileSpreadsheet className="w-3.5 h-3.5" /> },
          { id: 'discrepancies', label: 'Discrepancies', icon: <AlertTriangle className="w-3.5 h-3.5" /> }
        ];
      case 'returns':
        return [
          { id: 'failed', label: 'Failed Deliveries', icon: <AlertTriangle className="w-3.5 h-3.5" /> },
          { id: 'reattempt', label: 'Reattempt Queue', icon: <RefreshCw className="w-3.5 h-3.5" /> },
          { id: 'returning', label: 'Returning Packages', icon: <RotateCcw className="w-3.5 h-3.5" /> },
          { id: 'warehouse', label: 'Warehouse Received', icon: <Box className="w-3.5 h-3.5" /> },
          { id: 'exchanges', label: 'Exchanges', icon: <Repeat className="w-3.5 h-3.5" /> }
        ];
      case 'management':
        return [
          { id: 'dashboard', label: 'Executive Dashboard', icon: <BarChart3 className="w-3.5 h-3.5" /> }
        ];
      case 'admin':
        return [
          { id: 'users', label: 'User Management', icon: <Users className="w-3.5 h-3.5" /> },
          { id: 'shopify', label: 'Shopify Integration', icon: <ShoppingBag className="w-3.5 h-3.5" /> }
        ];
      case 'rider':
        return [];
      default:
        return [];
    }
  };

  const subTabs = getSubTabs(activeWorkspace);

  return (
    <aside className="w-64 bg-white border-r border-[#DDD9D4] flex flex-col shrink-0 h-screen sticky top-0">
      {/* Brand Header */}
      <div className="h-16 px-5 border-b border-[#DDD9D4] flex items-center space-x-3 bg-white">
        <div className="w-8 h-8 rounded-lg bg-[#5A2628] flex items-center justify-center font-bold text-white text-sm tracking-wider shadow-xs">
          G
        </div>
        <div>
          <span className="font-bold text-sm tracking-tight text-[#1F1F1D] block">GOMILA</span>
          <span className="text-[10px] text-[#6D6964] block font-mono">LMS Control • v2.4</span>
        </div>
      </div>

      {/* Primary Workspaces List */}
      <div className="p-3 border-b border-[#DDD9D4]">
        <p className="px-2 pb-2 text-[10px] font-extrabold uppercase tracking-wider text-[#6D6964]">Workspaces</p>
        <div className="space-y-1">
          {workspaces.map((ws) => {
            const allowed = canAccessWorkspace(ws.id);
            if (!allowed) return null;
            const isActive = activeWorkspace === ws.id;

            return (
              <button
                key={ws.id}
                onClick={() => {
                  setActiveWorkspace(ws.id);
                  const firstSub = getSubTabs(ws.id)[0]?.id;
                  if (firstSub) setActiveSubTab(firstSub);
                }}
                className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-semibold transition ${
                  isActive
                    ? 'bg-[#5A2628] text-white shadow-xs'
                    : 'text-[#1F1F1D] hover:bg-[#F5F4F2]'
                }`}
              >
                <div className="flex items-center space-x-2.5">
                  {ws.icon}
                  <span>{ws.label}</span>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Sub-Navigation (if active workspace has sub-tabs) */}
      {subTabs.length > 0 && (
        <div className="p-3 flex-1 overflow-y-auto">
          <p className="px-2 pb-2 text-[10px] font-extrabold uppercase tracking-wider text-[#6D6964]">
            {workspaces.find(w => w.id === activeWorkspace)?.label} Navigation
          </p>
          <div className="space-y-1">
            {subTabs.map((tab) => {
              const isSubActive = activeSubTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveSubTab(tab.id)}
                  className={`w-full flex items-center space-x-2.5 px-3 py-2 rounded-lg text-xs font-medium transition ${
                    isSubActive
                      ? 'bg-[#F5F4F2] text-[#5A2628] font-bold border-l-2 border-[#5A2628]'
                      : 'text-[#6D6964] hover:text-[#1F1F1D] hover:bg-[#F5F4F2]/60'
                  }`}
                >
                  {tab.icon}
                  <span>{tab.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Operational Footer info */}
      <div className="p-4 border-t border-[#DDD9D4] bg-[#F5F4F2] text-[11px] text-[#6D6964]">
        <div className="flex justify-between items-center mb-1">
          <span className="font-semibold text-[#1F1F1D]">Server Ingress</span>
          <span className="text-[10px] font-bold text-[#1F7A52] flex items-center space-x-1">
            <span className="w-1.5 h-1.5 rounded-full bg-[#1F7A52] inline-block"></span>
            <span>Online</span>
          </span>
        </div>
        <p className="text-[10px]">Zone: Lahore / Islamabad Hub</p>
      </div>
    </aside>
  );
}
