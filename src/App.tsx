import React, { useState } from 'react';
import { UserRole, Profile } from './types';
import { AuthProvider, useAuth } from './context/AuthContext';
import { hasUnsyncedOfflineActions } from './services/offline_store';

import { LoginScreen } from './components/auth/LoginScreen';
import { Header } from './components/common/Header';
import { Sidebar, WorkspaceId } from './components/common/Sidebar';

import { DispatchOverview } from './components/dispatch/DispatchOverview';
import { OrdersScreen } from './components/dispatch/OrdersScreen';
import { DispatchRuns } from './components/dispatch/DispatchRuns';
import { RidersScreen } from './components/dispatch/RidersScreen';
import { ExceptionsScreen } from './components/dispatch/ExceptionsScreen';
import { OrderDrawer } from './components/dispatch/OrderDrawer';
import { ErrorBoundary } from './components/common/ErrorBoundary';

import { RiderMobileShell } from './components/rider/RiderMobileShell';
import { CODFinanceWorkspace } from './components/finance/CODFinanceWorkspace';
import { ReturnsWorkspace } from './components/returns/ReturnsWorkspace';
import { LogisticsWorkspace } from './components/logistics/LogisticsWorkspace';
import { ManagementDashboard } from './components/management/ManagementDashboard';
import { UserManagementWorkspace } from './components/admin/UserManagementWorkspace';
import { ShopifyIntegrationWorkspace } from './components/admin/ShopifyIntegrationWorkspace';
import { LogOut, Loader2, AlertCircle } from 'lucide-react';

function AppContent() {
  const { user, profile, rider, loading, error, signOut } = useAuth();
  const [activeWorkspace, setActiveWorkspace] = useState<WorkspaceId>('dispatch');
  const [activeSubTab, setActiveSubTab] = useState<string>('overview');
  
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  const [ordersFilterStatus, setOrdersFilterStatus] = useState<string>('');

  const guardedSignOut = async () => {
    if (profile?.role === 'rider' && rider?.id) {
      const hasPending = await hasUnsyncedOfflineActions({
        uid: profile.id,
        riderId: rider.id,
        profileId: profile.id,
        fullName: profile.full_name
      }).catch(() => false);
      if (hasPending) {
        alert('Logout blocked: offline rider updates are still WAITING TO SYNC.');
        return;
      }
    }
    await signOut();
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-[#F5F4F2] flex flex-col justify-center items-center p-4 text-[#1F1F1D]">
        <div className="flex items-center space-x-3 bg-white p-6 rounded-2xl shadow-md border border-[#DDD9D4]">
          <Loader2 className="w-6 h-6 animate-spin text-[#5A2628]" />
          <span className="text-sm font-semibold">Authenticating terminal session...</span>
        </div>
      </div>
    );
  }

  // 1. Show Login Screen if not authenticated or if profile/linking error
  if (!user || !profile || !profile.active || error) {
    return <LoginScreen />;
  }

  const currentRole: UserRole = profile.role;

  // 2. If role is Rider, check for linked rider profile and render RiderMobileShell
  if (currentRole === 'rider') {
    if (!rider) {
      return (
        <div className="min-h-screen bg-[#F5F4F2] flex flex-col justify-center items-center p-4">
          <div className="w-full max-w-md bg-white rounded-2xl shadow-xl border border-[#DDD9D4] p-6 space-y-4">
            <div className="p-4 bg-red-50 border border-red-200 rounded-xl flex items-start space-x-3 text-xs text-red-700">
              <AlertCircle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
              <div>
                <p className="font-bold text-sm">Account Unlinked</p>
                <p className="mt-1">No rider profile is linked to this account. Contact an administrator.</p>
              </div>
            </div>
            <button
              onClick={() => guardedSignOut()}
              className="w-full py-2.5 bg-[#5A2628] text-white rounded-xl font-bold text-xs hover:bg-[#471D1F] transition flex items-center justify-center space-x-2"
            >
              <LogOut className="w-4 h-4" />
              <span>Sign Out</span>
            </button>
          </div>
        </div>
      );
    }

    return (
      <div className="min-h-screen bg-[#F5F4F2] flex flex-col items-center justify-start p-4">
        <div className="w-full max-w-md flex justify-between items-center mb-3 px-2">
          <span className="text-xs font-bold text-[#5A2628]">Gomila Rider Mobile</span>
          <button
            onClick={() => guardedSignOut()}
            className="text-xs text-[#6D6964] hover:text-[#1F1F1D] flex items-center space-x-1 font-semibold"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span>Sign Out</span>
          </button>
        </div>

        <div className="w-full max-w-md shadow-2xl rounded-2xl overflow-hidden border border-[#DDD9D4] bg-white">
          <RiderMobileShell userProfile={profile} onLogout={guardedSignOut} />
        </div>
      </div>
    );
  }

  const getWorkspaceTitle = () => {
    switch (activeWorkspace) {
      case 'dispatch':
        switch (activeSubTab) {
          case 'overview': return { title: 'Dispatch Decision Overview', subtitle: 'Live package routing & rider allocation' };
          case 'orders': return { title: 'Logistics Orders Table', subtitle: 'High-density package management & bulk assignment' };
          case 'runs': return { title: 'Rider Dispatch Runs', subtitle: 'Batch custody manifests & shift handoffs' };
          case 'riders': return { title: 'Fleet Courier Roster', subtitle: 'Courier capacity & active zone assignments' };
          case 'exceptions': return { title: 'Dispatch Exceptions Queue', subtitle: 'SLA breaches and delivery attempt failures' };
          default: return { title: 'Dispatch Workspace', subtitle: '' };
        }
      case 'rider':
        return { title: 'Rider Operations Terminal', subtitle: 'Mobile courier route terminal' };
      case 'finance':
        return { title: 'COD & Financial Controls', subtitle: 'Cashier reconciliation, settlements, and discrepancy audits' };
      case 'returns':
        return { title: 'Returns & Reverse Logistics', subtitle: 'Failed delivery queues, warehouse intake, and exchanges' };
      case 'management':
        return { title: 'Management Executive Dashboard', subtitle: 'Key operational metrics and exception analytics' };
      case 'admin':
        return { title: activeSubTab === 'shopify' ? 'Administration / Shopify Integration' : 'Administration / User Management', subtitle: activeSubTab === 'shopify' ? 'Webhook health, recovery and continuous commerce connection' : 'Employee account creation, role management and rider linking' };
      default:
        return { title: 'Gomila Rider Control', subtitle: '' };
    }
  };

  const workspaceMeta = getWorkspaceTitle();

  return (
    <div className="min-h-screen bg-[#F5F4F2] text-[#1F1F1D] flex font-sans antialiased">
      
      {/* Left Sidebar */}
      <Sidebar
        currentRole={currentRole}
        activeWorkspace={activeWorkspace}
        setActiveWorkspace={setActiveWorkspace}
        activeSubTab={activeSubTab}
        setActiveSubTab={setActiveSubTab}
      />

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0">
        
        {/* Header */}
        <div className="flex items-center justify-between bg-white border-b border-[#DDD9D4] pr-4">
          <div className="flex-1">
            <Header
              title={workspaceMeta.title}
              subtitle={workspaceMeta.subtitle}
              currentProfile={profile}
              onSelectOrder={(id) => setSelectedOrderId(id)}
            />
          </div>
          <button
            onClick={() => guardedSignOut()}
            title="Sign Out"
            className="p-2 text-[#6D6964] hover:text-[#B43B3B] hover:bg-stone-100 rounded-lg transition text-xs font-bold flex items-center space-x-1"
          >
            <LogOut className="w-4 h-4" />
            <span className="hidden md:inline">Sign Out</span>
          </button>
        </div>

        {/* Workspace Views */}
        <main className="flex-1 pb-12">
          
          {/* WORKSPACE 1: DISPATCH */}
          {activeWorkspace === 'dispatch' && (
            <ErrorBoundary fallbackTitle="Dispatch Manager Error">
              {activeSubTab === 'overview' && (
                <DispatchOverview
                  onNavigateToOrders={(status) => {
                    setActiveSubTab('orders');
                    if (status) setOrdersFilterStatus(status);
                  }}
                  onSelectOrder={(id) => setSelectedOrderId(id)}
                />
              )}

              {activeSubTab === 'orders' && (
                <OrdersScreen
                  initialFilterStatus={ordersFilterStatus}
                  onSelectOrder={(id) => setSelectedOrderId(id)}
                  selectedOrderId={selectedOrderId}
                  onCloseDrawer={() => setSelectedOrderId(null)}
                />
              )}

              {activeSubTab === 'runs' && (
                <DispatchRuns />
              )}

              {activeSubTab === 'riders' && (
                <RidersScreen />
              )}

              {activeSubTab === 'exceptions' && (
                <ExceptionsScreen
                  onSelectOrder={(id) => setSelectedOrderId(id)}
                />
              )}
            </ErrorBoundary>
          )}

          {/* WORKSPACE 2: RIDER MOBILE APP */}
          {activeWorkspace === 'rider' && (
            <ErrorBoundary fallbackTitle="Rider App Error">
              <div className="p-4 flex justify-center bg-[#DDD9D4]/30 min-h-screen">
                <div className="w-full max-w-md shadow-2xl rounded-2xl overflow-hidden border border-[#DDD9D4] bg-[#F5F4F2]">
                  <RiderMobileShell userProfile={profile} onLogout={guardedSignOut} />
                </div>
              </div>
            </ErrorBoundary>
          )}

          {/* WORKSPACE 3: COD & FINANCE */}
          {activeWorkspace === 'finance' && (
            <ErrorBoundary fallbackTitle="Finance Workspace Error">
              <CODFinanceWorkspace activeSubTab={activeSubTab} />
            </ErrorBoundary>
          )}

          {/* WORKSPACE 4: LOGISTICS HUB */}
          {activeWorkspace === 'logistics' && (
            <ErrorBoundary fallbackTitle="Logistics Hub Error">
              <LogisticsWorkspace
                activeSubTab={activeSubTab}
                onSelectOrder={(id) => setSelectedOrderId(id)}
                userRole={profile.role}
              />
            </ErrorBoundary>
          )}

          {/* WORKSPACE 5: RETURNS & CUSTOMER SERVICE */}
          {activeWorkspace === 'returns' && (
            <ErrorBoundary fallbackTitle="Returns Workspace Error">
              <ReturnsWorkspace
                activeSubTab={activeSubTab}
                onSelectOrder={(id) => setSelectedOrderId(id)}
              />
            </ErrorBoundary>
          )}

          {/* WORKSPACE 5: MANAGEMENT DASHBOARD */}
          {activeWorkspace === 'management' && (
            <ErrorBoundary fallbackTitle="Management Dashboard Error">
              <ManagementDashboard
                onSelectOrder={(id) => setSelectedOrderId(id)}
              />
            </ErrorBoundary>
          )}

          {/* WORKSPACE 6: ADMINISTRATION USER MANAGEMENT */}
          {activeWorkspace === 'admin' && (
            <ErrorBoundary fallbackTitle="User Management Error">
              {activeSubTab === 'shopify' ? <ShopifyIntegrationWorkspace /> : <UserManagementWorkspace activeSubTab={activeSubTab} />}
            </ErrorBoundary>
          )}

        </main>
      </div>

      {/* Global Right-Side Order Drawer */}
      {selectedOrderId && (
        <OrderDrawer
          orderId={selectedOrderId}
          onClose={() => setSelectedOrderId(null)}
        />
      )}

    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  );
}
