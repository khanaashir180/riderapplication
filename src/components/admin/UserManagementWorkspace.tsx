import React, { useState, useEffect } from 'react';
import { 
  Users, 
  UserPlus, 
  Search, 
  Filter, 
  Loader2, 
  Edit3, 
  UserCheck, 
  UserX, 
  KeyRound, 
  History, 
  Copy, 
  Check, 
  AlertTriangle, 
  X, 
  ChevronLeft, 
  ChevronRight,
  ShieldCheck,
  CheckCircle2,
  Phone,
  Mail,
  Truck,
  Building2,
  Calendar,
  RefreshCw
} from 'lucide-react';
import { UserRole } from '../../types';
import { useAuth } from '../../context/AuthContext';

interface UserListItem {
  uid: string;
  fullName: string;
  email: string;
  phone: string;
  employeeCode: string;
  role: UserRole;
  active: boolean;
  riderId: string | null;
  riderCode: string | null;
  vehicleType?: string | null;
  vehicleNumber?: string | null;
  city?: string | null;
  assignedZone?: string | null;
  maximumDailyCapacity?: number | null;
  createdAt: string | null;
  updatedAt: string | null;
}

interface UserManagementWorkspaceProps {
  activeSubTab?: string;
}

const ROLE_LABELS: Record<UserRole, { label: string; color: string }> = {
  super_admin: { label: 'Super Admin', color: 'bg-purple-100 text-purple-800 border-purple-200' },
  dispatch_manager: { label: 'Dispatch Manager', color: 'bg-blue-100 text-blue-800 border-blue-200' },
  rider: { label: 'Rider', color: 'bg-amber-100 text-amber-800 border-amber-200' },
  cashier: { label: 'Cashier', color: 'bg-emerald-100 text-emerald-800 border-emerald-200' },
  customer_service: { label: 'Customer Service', color: 'bg-cyan-100 text-cyan-800 border-cyan-200' },
  warehouse_staff: { label: 'Warehouse Staff', color: 'bg-stone-100 text-stone-800 border-stone-200' },
  management_viewer: { label: 'Management Viewer', color: 'bg-indigo-100 text-indigo-800 border-indigo-200' }
};

export function UserManagementWorkspace({ activeSubTab }: UserManagementWorkspaceProps) {
  const { user, profile } = useAuth();

  // State
  const [users, setUsers] = useState<UserListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Search and Filter
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [activeFilter, setActiveFilter] = useState('');

  // Pagination
  const [cursorHistory, setCursorHistory] = useState<string[]>([]);
  const [currentCursor, setCurrentCursor] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const pageSize = 15;

  // Modals
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingUser, setEditingUser] = useState<UserListItem | null>(null);
  const [deactivatingUser, setDeactivatingUser] = useState<UserListItem | null>(null);
  const [auditUser, setAuditUser] = useState<UserListItem | null>(null);
  const [setupLinkUser, setSetupLinkUser] = useState<{
    user: UserListItem;
    link: string | null;
    setupLinkStatus: 'generated' | 'failed';
    warningMessage: string | null;
  } | null>(null);
  const [retryingSetupLink, setRetryingSetupLink] = useState(false);
  const [retrySetupLinkError, setRetrySetupLinkError] = useState<string | null>(null);

  // Form State
  const [formData, setFormData] = useState({
    fullName: '',
    email: '',
    phone: '',
    employeeCode: '',
    role: 'dispatch_manager' as UserRole,
    active: true,
    riderCode: '',
    vehicleType: 'Motorbike',
    vehicleNumber: '',
    city: 'Lahore',
    assignedZone: 'Gulberg III',
    maximumDailyCapacity: 25
  });
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [formSubmitError, setFormSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Setup Link Modal State
  const [copiedLink, setCopiedLink] = useState(false);
  const [generatedLinkSuccess, setGeneratedLinkSuccess] = useState<string | null>(null);

  // Audit Logs State
  const [auditLogs, setAuditLogs] = useState<any[]>([]);
  const [loadingAudit, setLoadingAudit] = useState(false);

  // Load Users
  const fetchUsers = async (cursorToken: string | null = null) => {
    setLoading(true);
    setError(null);
    try {
      if (!user) return;
      const token = await user.getIdToken();
      const params = new URLSearchParams();
      if (search) params.append('search', search);
      if (roleFilter) params.append('role', roleFilter);
      if (activeFilter) params.append('active', activeFilter);
      params.append('pageSize', String(pageSize));
      if (cursorToken) params.append('cursor', cursorToken);

      const res = await fetch(`/api/admin/users?${params.toString()}`, {
        headers: {
          Authorization: `Bearer ${token}`
        }
      });
      const data = await res.json();
      if (data.success) {
        setUsers(data.items || []);
        setNextCursor(data.nextCursor || null);
        setHasMore(Boolean(data.hasMore));
      } else {
        setError(data.error?.message || 'Failed to fetch users');
      }
    } catch (err: any) {
      setError(err.message || 'Error fetching user accounts');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setCursorHistory([]);
    setCurrentCursor(null);
    fetchUsers(null);
  }, [search, roleFilter, activeFilter]);

  const handleNextPage = () => {
    if (nextCursor) {
      setCursorHistory(prev => [...prev, currentCursor || '']);
      setCurrentCursor(nextCursor);
      fetchUsers(nextCursor);
    }
  };

  const handlePrevPage = () => {
    if (cursorHistory.length > 0) {
      const prevCursor = cursorHistory[cursorHistory.length - 1];
      setCursorHistory(prev => prev.slice(0, prev.length - 1));
      setCurrentCursor(prevCursor || null);
      fetchUsers(prevCursor || null);
    }
  };

  // Open Create Modal
  const openCreateModal = () => {
    setFormData({
      fullName: '',
      email: '',
      phone: '',
      employeeCode: '',
      role: 'dispatch_manager',
      active: true,
      riderCode: '',
      vehicleType: 'Motorbike',
      vehicleNumber: '',
      city: 'Lahore',
      assignedZone: 'Gulberg III',
      maximumDailyCapacity: 25
    });
    setFormErrors({});
    setFormSubmitError(null);
    setEditingUser(null);
    setShowCreateModal(true);
  };

  // Open Edit Modal
  const openEditModal = (u: UserListItem) => {
    setEditingUser(u);
    setFormData({
      fullName: u.fullName,
      email: u.email,
      phone: u.phone,
      employeeCode: u.employeeCode,
      role: u.role,
      active: u.active,
      riderCode: u.riderCode || '',
      vehicleType: u.vehicleType || 'Motorbike',
      vehicleNumber: u.vehicleNumber || '',
      city: u.city || 'Lahore',
      assignedZone: u.assignedZone || 'Gulberg III',
      maximumDailyCapacity: u.maximumDailyCapacity || 25
    });
    setFormErrors({});
    setFormSubmitError(null);
    setShowCreateModal(true);
  };

  // Validate Form
  const validateForm = () => {
    const errs: Record<string, string> = {};
    if (!formData.fullName.trim()) errs.fullName = 'Full name is required';
    if (!formData.email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email.trim())) {
      errs.email = 'Valid email is required';
    }
    if (!formData.phone.trim()) errs.phone = 'Phone number is required';
    if (!formData.employeeCode.trim()) errs.employeeCode = 'Employee code is required';

    if (formData.role === 'rider') {
      if (!formData.riderCode.trim()) errs.riderCode = 'Rider code is required';
      if (!formData.vehicleType.trim()) errs.vehicleType = 'Vehicle type is required';
      if (!formData.vehicleNumber.trim()) errs.vehicleNumber = 'Vehicle number is required';
      if (!formData.city.trim()) errs.city = 'City is required';
      if (!formData.assignedZone.trim()) errs.assignedZone = 'Assigned zone is required';
      if (!formData.maximumDailyCapacity || Number(formData.maximumDailyCapacity) <= 0) {
        errs.maximumDailyCapacity = 'Must be a positive integer';
      }
    }

    setFormErrors(errs);
    return Object.keys(errs).length === 0;
  };

  // Submit Create or Edit Form
  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validateForm() || !user) return;

    setSubmitting(true);
    setFormSubmitError(null);

    try {
      const token = await user.getIdToken();
      const endpoint = editingUser ? `/api/admin/users/${editingUser.uid}` : '/api/admin/users';
      const method = editingUser ? 'PATCH' : 'POST';

      const res = await fetch(endpoint, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify(formData)
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        let msg = data.error?.message || 'Failed to save employee account';
        if (data.error?.details) {
          const d = data.error.details;
          const openLines: string[] = [];
          if (d.activeAssignmentCount > 0) openLines.push(`• Active Assignments: ${d.activeAssignmentCount}`);
          if (d.openDispatchRunCount > 0) openLines.push(`• Open Dispatch Runs: ${d.openDispatchRunCount}`);
          if (d.openSettlementCount > 0) openLines.push(`• Open Settlements: ${d.openSettlementCount}`);
          if (d.unreturnedPackageCount > 0) openLines.push(`• Unreturned Packages: ${d.unreturnedPackageCount}`);
          if (d.pendingReturnCount > 0) openLines.push(`• Pending Returns: ${d.pendingReturnCount}`);
          if (d.pendingOfflineActionCount > 0) openLines.push(`• Pending Offline Actions: ${d.pendingOfflineActionCount}`);
          if (openLines.length > 0) {
            msg += '\n\n' + openLines.join('\n');
          }
        }
        setFormSubmitError(msg);
        setSubmitting(false);
        return;
      }

      // Success
      setSubmitting(false);

      if (!editingUser) {
        setShowCreateModal(false);
        const isFailed = data.data?.setupLinkStatus === 'failed' || !data.data?.passwordSetupLink;
        setSetupLinkUser({
          user: {
            uid: data.data.uid,
            fullName: formData.fullName,
            email: formData.email,
            phone: formData.phone,
            employeeCode: formData.employeeCode,
            role: formData.role,
            active: formData.active,
            riderId: data.data.riderId,
            riderCode: formData.riderCode || null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          },
          link: data.data?.passwordSetupLink || null,
          setupLinkStatus: isFailed ? 'failed' : 'generated',
          warningMessage: isFailed ? (data.warning?.message || 'Password setup link generation failed.') : null
        });
      } else {
        setShowCreateModal(false);
      }

      fetchUsers(currentCursor);
    } catch (err: any) {
      setFormSubmitError(err.message || 'Error communicating with server');
      setSubmitting(false);
    }
  };

  // Retry Password Setup Link
  const handleRetrySetupLink = async () => {
    if (!setupLinkUser || !user) return;
    setRetryingSetupLink(true);
    setRetrySetupLinkError(null);
    try {
      const token = await user.getIdToken();
      const res = await fetch(`/api/admin/users/${setupLinkUser.user.uid}/password-setup-link`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      if (!res.ok || !data.success || !data.data?.passwordSetupLink) {
        setRetrySetupLinkError(data.error?.message || 'Failed to generate password setup link. Please try again.');
      } else {
        setSetupLinkUser({
          ...setupLinkUser,
          link: data.data.passwordSetupLink,
          setupLinkStatus: 'generated',
          warningMessage: null
        });
      }
    } catch (err: any) {
      setRetrySetupLinkError(err.message || 'Network error while retrying setup link.');
    } finally {
      setRetryingSetupLink(false);
    }
  };

  // Toggle Activation
  const handleToggleActivate = async (u: UserListItem) => {
    if (!user) return;
    setSubmitting(true);
    try {
      const token = await user.getIdToken();
      const endpoint = u.active ? `/api/admin/users/${u.uid}/deactivate` : `/api/admin/users/${u.uid}/activate`;

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();

      if (!res.ok || !data.success) {
        let msg = data.error?.message || 'Operation failed';
        if (data.error?.details) {
          const d = data.error.details;
          const openLines: string[] = [];
          if (d.activeAssignmentCount > 0) openLines.push(`• Active Assignments: ${d.activeAssignmentCount}`);
          if (d.openDispatchRunCount > 0) openLines.push(`• Open Dispatch Runs: ${d.openDispatchRunCount}`);
          if (d.openSettlementCount > 0) openLines.push(`• Open Settlements: ${d.openSettlementCount}`);
          if (d.unreturnedPackageCount > 0) openLines.push(`• Unreturned Packages: ${d.unreturnedPackageCount}`);
          if (d.pendingReturnCount > 0) openLines.push(`• Pending Returns: ${d.pendingReturnCount}`);
          if (d.pendingOfflineActionCount > 0) openLines.push(`• Pending Offline Actions: ${d.pendingOfflineActionCount}`);
          if (openLines.length > 0) {
            msg += '\n\n' + openLines.join('\n');
          }
        }
        alert(msg);
      } else {
        setDeactivatingUser(null);
        fetchUsers(currentCursor);
      }
    } catch (err: any) {
      alert(err.message || 'Network error');
    } finally {
      setSubmitting(false);
    }
  };

  // Generate Password Link
  const handleGeneratePasswordLink = async (u: UserListItem) => {
    if (!user) return;
    setLoading(true);
    try {
      const token = await user.getIdToken();
      const res = await fetch(`/api/admin/users/${u.uid}/password-setup-link`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      if (data.success && data.data?.passwordSetupLink) {
        setSetupLinkUser({
          user: u,
          link: data.data.passwordSetupLink,
          setupLinkStatus: 'generated',
          warningMessage: null
        });
      } else {
        alert(data.error?.message || 'Failed to generate password setup link');
      }
    } catch (err: any) {
      alert(err.message || 'Error generating setup link');
    } finally {
      setLoading(false);
    }
  };

  // Fetch Audit History
  const fetchAuditHistory = async (u: UserListItem) => {
    if (!user) return;
    setAuditUser(u);
    setLoadingAudit(true);
    try {
      const token = await user.getIdToken();
      const res = await fetch(`/api/admin/users/${u.uid}/audit`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      if (data.success) {
        setAuditLogs(data.items || []);
      } else {
        setAuditLogs([]);
      }
    } catch (err) {
      setAuditLogs([]);
    } finally {
      setLoadingAudit(false);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 2500);
  };

  // Access Control Guard
  if (profile?.role !== 'super_admin') {
    return (
      <div className="p-8 max-w-lg mx-auto text-center mt-12 bg-white rounded-2xl shadow-sm border border-red-200">
        <ShieldCheck className="w-12 h-12 text-red-500 mx-auto mb-3" />
        <h2 className="text-lg font-bold text-gray-900">Access Restricted</h2>
        <p className="text-xs text-gray-600 mt-1">
          User Management is exclusively restricted to Super Admin accounts.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Top Banner */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-white p-6 rounded-2xl border border-[#DDD9D4] shadow-xs">
        <div>
          <div className="flex items-center space-x-2">
            <ShieldCheck className="w-5 h-5 text-[#5A2628]" />
            <h1 className="text-lg font-bold text-[#1F1F1D]">Administration • User Management</h1>
          </div>
          <p className="text-xs text-[#6D6964] mt-0.5">
            Create employee accounts, link rider profiles, and manage system permissions securely.
          </p>
        </div>

        <button
          onClick={openCreateModal}
          className="inline-flex items-center justify-center space-x-2 bg-[#5A2628] hover:bg-[#471D1F] text-white px-4 py-2.5 rounded-xl text-xs font-bold transition shadow-sm shrink-0"
        >
          <UserPlus className="w-4 h-4" />
          <span>Create Employee Account</span>
        </button>
      </div>

      {/* Filters & Search */}
      <div className="bg-white p-4 rounded-2xl border border-[#DDD9D4] flex flex-wrap items-center gap-3 shadow-xs">
        {/* Search */}
        <div className="relative flex-1 min-w-[240px]">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name, email, employee code, rider code..."
            className="w-full pl-9 pr-3 py-2 bg-[#F5F4F2] text-xs text-[#1F1F1D] rounded-xl border border-transparent focus:border-[#5A2628] focus:bg-white outline-none transition"
          />
          {search && (
            <button onClick={() => setSearch('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* Role Filter */}
        <div className="flex items-center space-x-2 shrink-0">
          <Filter className="w-3.5 h-3.5 text-gray-500" />
          <select
            value={roleFilter}
            onChange={(e) => setRoleFilter(e.target.value)}
            className="bg-[#F5F4F2] text-xs font-semibold text-[#1F1F1D] px-3 py-2 rounded-xl border border-transparent focus:border-[#5A2628] focus:bg-white outline-none"
          >
            <option value="">All Roles</option>
            {Object.entries(ROLE_LABELS).map(([rKey, rMeta]) => (
              <option key={rKey} value={rKey}>{rMeta.label}</option>
            ))}
          </select>
        </div>

        {/* Active Filter */}
        <div className="shrink-0">
          <select
            value={activeFilter}
            onChange={(e) => setActiveFilter(e.target.value)}
            className="bg-[#F5F4F2] text-xs font-semibold text-[#1F1F1D] px-3 py-2 rounded-xl border border-transparent focus:border-[#5A2628] focus:bg-white outline-none"
          >
            <option value="">All Statuses</option>
            <option value="true">Active Only</option>
            <option value="false">Inactive Only</option>
          </select>
        </div>
      </div>

      {/* Main Table */}
      <div className="bg-white rounded-2xl border border-[#DDD9D4] overflow-hidden shadow-xs">
        {loading ? (
          <div className="p-12 text-center text-[#6D6964]">
            <Loader2 className="w-8 h-8 animate-spin mx-auto text-[#5A2628] mb-2" />
            <p className="text-xs font-semibold">Loading user accounts...</p>
          </div>
        ) : error ? (
          <div className="p-8 text-center text-red-600 bg-red-50/50">
            <AlertTriangle className="w-8 h-8 mx-auto mb-2 text-red-500" />
            <p className="text-xs font-bold">{error}</p>
          </div>
        ) : users.length === 0 ? (
          <div className="p-12 text-center text-[#6D6964]">
            <Users className="w-10 h-10 mx-auto text-gray-300 mb-2" />
            <p className="text-sm font-bold text-gray-700">No user accounts found</p>
            <p className="text-xs text-gray-500 mt-1">Try adjusting your filters or create a new employee account.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-[#F5F4F2] border-b border-[#DDD9D4] text-[11px] font-extrabold text-[#6D6964] uppercase tracking-wider">
                  <th className="py-3 px-4">Employee</th>
                  <th className="py-3 px-4">Role</th>
                  <th className="py-3 px-4">Codes</th>
                  <th className="py-3 px-4">Contact</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#DDD9D4] text-xs">
                {users.map((u) => {
                  const roleMeta = ROLE_LABELS[u.role] || { label: u.role, color: 'bg-gray-100 text-gray-800' };
                  return (
                    <tr key={u.uid} className="hover:bg-gray-50/80 transition">
                      {/* Name & Email */}
                      <td className="py-3.5 px-4">
                        <div className="font-bold text-[#1F1F1D]">{u.fullName}</div>
                        <div className="text-[11px] text-gray-500 font-mono">{u.email}</div>
                      </td>

                      {/* Role Badge */}
                      <td className="py-3.5 px-4">
                        <span className={`inline-flex items-center px-2.5 py-1 rounded-md text-[10px] font-bold border ${roleMeta.color}`}>
                          {roleMeta.label}
                        </span>
                      </td>

                      {/* Codes */}
                      <td className="py-3.5 px-4">
                        <div className="text-xs font-mono font-semibold text-gray-800">
                          Emp: <span className="text-[#5A2628]">{u.employeeCode}</span>
                        </div>
                        {u.role === 'rider' && (
                          <div className="text-[11px] font-mono text-amber-700">
                            Rider: <span className="font-bold">{u.riderCode || 'Unlinked'}</span>
                          </div>
                        )}
                      </td>

                      {/* Contact */}
                      <td className="py-3.5 px-4">
                        <div className="text-xs text-gray-700 flex items-center space-x-1">
                          <Phone className="w-3 h-3 text-gray-400 shrink-0" />
                          <span>{u.phone}</span>
                        </div>
                      </td>

                      {/* Status */}
                      <td className="py-3.5 px-4">
                        {u.active ? (
                          <span className="inline-flex items-center space-x-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
                            <span>Active</span>
                          </span>
                        ) : (
                          <span className="inline-flex items-center space-x-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-gray-100 text-gray-600 border border-gray-200">
                            <span className="w-1.5 h-1.5 rounded-full bg-gray-400"></span>
                            <span>Inactive</span>
                          </span>
                        )}
                      </td>

                      {/* Actions */}
                      <td className="py-3.5 px-4 text-right">
                        <div className="flex items-center justify-end space-x-1">
                          {/* Edit */}
                          <button
                            onClick={() => openEditModal(u)}
                            title="Edit User Details & Roles"
                            className="p-1.5 text-gray-600 hover:text-[#5A2628] hover:bg-gray-100 rounded-lg transition"
                          >
                            <Edit3 className="w-4 h-4" />
                          </button>

                          {/* Password Setup Link */}
                          <button
                            onClick={() => handleGeneratePasswordLink(u)}
                            title="Generate Password Setup Link"
                            className="p-1.5 text-gray-600 hover:text-indigo-600 hover:bg-gray-100 rounded-lg transition"
                          >
                            <KeyRound className="w-4 h-4" />
                          </button>

                          {/* Activate / Deactivate */}
                          <button
                            onClick={() => setDeactivatingUser(u)}
                            title={u.active ? 'Deactivate Account' : 'Activate Account'}
                            className={`p-1.5 rounded-lg transition ${
                              u.active 
                                ? 'text-gray-600 hover:text-red-600 hover:bg-red-50' 
                                : 'text-gray-600 hover:text-emerald-600 hover:bg-emerald-50'
                            }`}
                          >
                            {u.active ? <UserX className="w-4 h-4" /> : <UserCheck className="w-4 h-4" />}
                          </button>

                          {/* Audit History */}
                          <button
                            onClick={() => fetchAuditHistory(u)}
                            title="View Audit History"
                            className="p-1.5 text-gray-600 hover:text-purple-600 hover:bg-gray-100 rounded-lg transition"
                          >
                            <History className="w-4 h-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination Footer */}
        <div className="p-4 border-t border-[#DDD9D4] flex items-center justify-between bg-[#F5F4F2]">
          <span className="text-xs text-[#6D6964]">
            Showing page {cursorHistory.length + 1}
          </span>
          <div className="flex items-center space-x-2">
            <button
              onClick={handlePrevPage}
              disabled={cursorHistory.length === 0}
              className="inline-flex items-center space-x-1 px-3 py-1.5 bg-white border border-[#DDD9D4] rounded-lg text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
              <span>Previous</span>
            </button>

            <button
              onClick={handleNextPage}
              disabled={!hasMore}
              className="inline-flex items-center space-x-1 px-3 py-1.5 bg-white border border-[#DDD9D4] rounded-lg text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition"
            >
              <span>Next</span>
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* CREATE / EDIT MODAL */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-2xl max-w-xl w-full border border-[#DDD9D4] shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
            <div className="p-5 border-b border-[#DDD9D4] flex items-center justify-between bg-[#F5F4F2]">
              <div className="flex items-center space-x-2">
                <UserPlus className="w-5 h-5 text-[#5A2628]" />
                <h3 className="font-bold text-sm text-[#1F1F1D]">
                  {editingUser ? 'Edit Employee Account' : 'Create Employee Account'}
                </h3>
              </div>
              <button onClick={() => setShowCreateModal(false)} className="text-gray-400 hover:text-gray-600">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleFormSubmit} className="p-6 overflow-y-auto space-y-4 text-xs">
              {formSubmitError && (
                <div className="p-3.5 bg-red-50 border border-red-200 rounded-xl text-red-700 text-xs font-medium flex items-start space-x-2">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-red-600" />
                  <span>{formSubmitError}</span>
                </div>
              )}

              {/* Common Fields */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block font-bold text-gray-700 mb-1">Full Name *</label>
                  <input
                    type="text"
                    value={formData.fullName}
                    onChange={e => setFormData({ ...formData, fullName: e.target.value })}
                    placeholder="e.g. Zahid Ali Khan"
                    className="w-full px-3 py-2 bg-[#F5F4F2] rounded-xl border border-gray-200 focus:border-[#5A2628] focus:bg-white outline-none"
                  />
                  {formErrors.fullName && <p className="text-[11px] text-red-600 mt-1">{formErrors.fullName}</p>}
                </div>

                <div>
                  <label className="block font-bold text-gray-700 mb-1">Email Address *</label>
                  <input
                    type="email"
                    value={formData.email}
                    onChange={e => setFormData({ ...formData, email: e.target.value })}
                    placeholder="zahid@gomila.pk"
                    className="w-full px-3 py-2 bg-[#F5F4F2] rounded-xl border border-gray-200 focus:border-[#5A2628] focus:bg-white outline-none"
                  />
                  {formErrors.email && <p className="text-[11px] text-red-600 mt-1">{formErrors.email}</p>}
                </div>

                <div>
                  <label className="block font-bold text-gray-700 mb-1">Phone Number *</label>
                  <input
                    type="text"
                    value={formData.phone}
                    onChange={e => setFormData({ ...formData, phone: e.target.value })}
                    placeholder="03001234567"
                    className="w-full px-3 py-2 bg-[#F5F4F2] rounded-xl border border-gray-200 focus:border-[#5A2628] focus:bg-white outline-none"
                  />
                  {formErrors.phone && <p className="text-[11px] text-red-600 mt-1">{formErrors.phone}</p>}
                </div>

                <div>
                  <label className="block font-bold text-gray-700 mb-1">Employee Code *</label>
                  <input
                    type="text"
                    value={formData.employeeCode}
                    onChange={e => setFormData({ ...formData, employeeCode: e.target.value })}
                    placeholder="EMP-1002"
                    className="w-full px-3 py-2 bg-[#F5F4F2] rounded-xl border border-gray-200 focus:border-[#5A2628] focus:bg-white outline-none"
                  />
                  {formErrors.employeeCode && <p className="text-[11px] text-red-600 mt-1">{formErrors.employeeCode}</p>}
                </div>

                <div>
                  <label className="block font-bold text-gray-700 mb-1">Role *</label>
                  <select
                    value={formData.role}
                    onChange={e => setFormData({ ...formData, role: e.target.value as UserRole })}
                    className="w-full px-3 py-2 bg-[#F5F4F2] rounded-xl border border-gray-200 focus:border-[#5A2628] focus:bg-white outline-none font-semibold"
                  >
                    {Object.entries(ROLE_LABELS).map(([rKey, rMeta]) => (
                      <option key={rKey} value={rKey}>{rMeta.label}</option>
                    ))}
                  </select>
                </div>

                {!editingUser && (
                  <div>
                    <label className="block font-bold text-gray-700 mb-1">Account Status</label>
                    <select
                      value={formData.active ? 'true' : 'false'}
                      onChange={e => setFormData({ ...formData, active: e.target.value === 'true' })}
                      className="w-full px-3 py-2 bg-[#F5F4F2] rounded-xl border border-gray-200 focus:border-[#5A2628] focus:bg-white outline-none font-semibold"
                    >
                      <option value="true">Active</option>
                      <option value="false">Inactive</option>
                    </select>
                  </div>
                )}
              </div>

              {/* Rider Specific Section */}
              {formData.role === 'rider' && (
                <div className="pt-4 border-t border-gray-200 space-y-3">
                  <div className="flex items-center space-x-2 text-[#5A2628]">
                    <Truck className="w-4 h-4" />
                    <span className="font-bold text-xs uppercase tracking-wider">Rider Profile & Logistics Details</span>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className="block font-bold text-gray-700 mb-1">Rider Code *</label>
                      <input
                        type="text"
                        value={formData.riderCode}
                        onChange={e => setFormData({ ...formData, riderCode: e.target.value })}
                        placeholder="RIDER-005"
                        className="w-full px-3 py-2 bg-[#F5F4F2] rounded-xl border border-gray-200 focus:border-[#5A2628] focus:bg-white outline-none font-mono"
                      />
                      {formErrors.riderCode && <p className="text-[11px] text-red-600 mt-1">{formErrors.riderCode}</p>}
                    </div>

                    <div>
                      <label className="block font-bold text-gray-700 mb-1">Vehicle Type *</label>
                      <select
                        value={formData.vehicleType}
                        onChange={e => setFormData({ ...formData, vehicleType: e.target.value })}
                        className="w-full px-3 py-2 bg-[#F5F4F2] rounded-xl border border-gray-200 focus:border-[#5A2628] focus:bg-white outline-none"
                      >
                        <option value="Motorbike">Motorbike</option>
                        <option value="Cargo Rickshaw">Cargo Rickshaw</option>
                        <option value="Van">Van</option>
                        <option value="Bicycle">Bicycle</option>
                      </select>
                    </div>

                    <div>
                      <label className="block font-bold text-gray-700 mb-1">Vehicle Registration Number *</label>
                      <input
                        type="text"
                        value={formData.vehicleNumber}
                        onChange={e => setFormData({ ...formData, vehicleNumber: e.target.value })}
                        placeholder="LEB-2024"
                        className="w-full px-3 py-2 bg-[#F5F4F2] rounded-xl border border-gray-200 focus:border-[#5A2628] focus:bg-white outline-none"
                      />
                      {formErrors.vehicleNumber && <p className="text-[11px] text-red-600 mt-1">{formErrors.vehicleNumber}</p>}
                    </div>

                    <div>
                      <label className="block font-bold text-gray-700 mb-1">City *</label>
                      <select
                        value={formData.city}
                        onChange={e => setFormData({ ...formData, city: e.target.value })}
                        className="w-full px-3 py-2 bg-[#F5F4F2] rounded-xl border border-gray-200 focus:border-[#5A2628] focus:bg-white outline-none"
                      >
                        <option value="Lahore">Lahore</option>
                        <option value="Karachi">Karachi</option>
                        <option value="Islamabad">Islamabad</option>
                        <option value="Rawalpindi">Rawalpindi</option>
                        <option value="Faisalabad">Faisalabad</option>
                      </select>
                    </div>

                    <div>
                      <label className="block font-bold text-gray-700 mb-1">Assigned Zone *</label>
                      <input
                        type="text"
                        value={formData.assignedZone}
                        onChange={e => setFormData({ ...formData, assignedZone: e.target.value })}
                        placeholder="Gulberg III / DHA Phase 5"
                        className="w-full px-3 py-2 bg-[#F5F4F2] rounded-xl border border-gray-200 focus:border-[#5A2628] focus:bg-white outline-none"
                      />
                      {formErrors.assignedZone && <p className="text-[11px] text-red-600 mt-1">{formErrors.assignedZone}</p>}
                    </div>

                    <div>
                      <label className="block font-bold text-gray-700 mb-1">Maximum Daily Capacity *</label>
                      <input
                        type="number"
                        value={formData.maximumDailyCapacity}
                        onChange={e => setFormData({ ...formData, maximumDailyCapacity: parseInt(e.target.value, 10) || 0 })}
                        placeholder="25"
                        className="w-full px-3 py-2 bg-[#F5F4F2] rounded-xl border border-gray-200 focus:border-[#5A2628] focus:bg-white outline-none"
                      />
                      {formErrors.maximumDailyCapacity && <p className="text-[11px] text-red-600 mt-1">{formErrors.maximumDailyCapacity}</p>}
                    </div>
                  </div>
                </div>
              )}

              <div className="pt-4 border-t border-gray-200 flex justify-end space-x-2">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="px-4 py-2 border border-gray-300 rounded-xl text-gray-700 font-bold hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-5 py-2 bg-[#5A2628] hover:bg-[#471D1F] text-white rounded-xl font-bold flex items-center space-x-2 disabled:opacity-50"
                >
                  {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
                  <span>{editingUser ? 'Save Changes' : 'Create Account'}</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* PASSWORD SETUP LINK MODAL */}
      {setupLinkUser && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-2xl max-w-lg w-full border border-[#DDD9D4] shadow-2xl p-6 space-y-4">
            <div className="flex items-center justify-between border-b pb-3">
              {setupLinkUser.setupLinkStatus === 'failed' ? (
                <div className="flex items-center space-x-2 text-amber-700">
                  <AlertTriangle className="w-6 h-6 shrink-0 text-amber-600" />
                  <h3 className="font-bold text-base text-gray-900">Account Created with Warning</h3>
                </div>
              ) : (
                <div className="flex items-center space-x-2 text-emerald-700">
                  <CheckCircle2 className="w-6 h-6 shrink-0 text-emerald-600" />
                  <h3 className="font-bold text-base text-gray-900">Account Created Successfully</h3>
                </div>
              )}
              <button
                onClick={() => {
                  setSetupLinkUser(null);
                  setRetrySetupLinkError(null);
                }}
                className="text-gray-400 hover:text-gray-600"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {setupLinkUser.setupLinkStatus === 'failed' && (
              <div className="bg-amber-50 border border-amber-200 p-3 rounded-xl text-xs text-amber-900 font-medium flex items-start space-x-2">
                <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                <div>
                  <p className="font-bold text-amber-900">Password Setup Link Warning</p>
                  <p className="text-[11px] mt-0.5">{setupLinkUser.warningMessage || 'Password setup link could not be generated automatically.'}</p>
                </div>
              </div>
            )}

            <div className="bg-emerald-50 border border-emerald-200 p-4 rounded-xl text-xs space-y-2 text-emerald-950">
              <p className="font-bold text-sm text-emerald-900">Employee Details Created:</p>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div><span className="text-emerald-700 font-medium">Employee Name:</span> <strong className="text-gray-900">{setupLinkUser.user.fullName}</strong></div>
                <div><span className="text-emerald-700 font-medium">Email:</span> <strong className="text-gray-900">{setupLinkUser.user.email}</strong></div>
                <div><span className="text-emerald-700 font-medium">Role:</span> <strong className="text-gray-900">{ROLE_LABELS[setupLinkUser.user.role]?.label || setupLinkUser.user.role}</strong></div>
                <div><span className="text-emerald-700 font-medium">Employee Code:</span> <strong className="text-gray-900 font-mono">{setupLinkUser.user.employeeCode}</strong></div>
                {setupLinkUser.user.riderCode && (
                  <div><span className="text-emerald-700 font-medium">Rider Code:</span> <strong className="text-gray-900 font-mono">{setupLinkUser.user.riderCode}</strong></div>
                )}
              </div>
            </div>

            <div>
              <label className="block text-xs font-bold text-gray-700 mb-1">Account Password Setup Link:</label>
              {setupLinkUser.link ? (
                <div className="p-3 bg-gray-50 border border-gray-200 rounded-xl font-mono text-[11px] text-gray-800 break-all select-all">
                  {setupLinkUser.link}
                </div>
              ) : (
                <div className="p-3 bg-amber-50/50 border border-amber-200 rounded-xl text-xs text-amber-800 italic">
                  Password setup link is missing. Click "Retry Setup Link" below to generate a new setup link.
                </div>
              )}
              {retrySetupLinkError && (
                <p className="text-xs text-red-600 mt-1.5 font-semibold">{retrySetupLinkError}</p>
              )}
              <p className="text-[11px] text-gray-500 mt-1 italic">
                * Share this password setup link directly with the staff member so they can set their password.
              </p>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t">
              <div className="flex items-center space-x-2">
                {setupLinkUser.link ? (
                  <button
                    onClick={() => copyToClipboard(setupLinkUser.link!)}
                    className="px-4 py-2 bg-[#5A2628] text-white rounded-xl text-xs font-bold flex items-center space-x-2 hover:bg-[#471D1F] transition"
                  >
                    {copiedLink ? <Check className="w-4 h-4 text-emerald-300" /> : <Copy className="w-4 h-4" />}
                    <span>{copiedLink ? 'Copied Setup Link!' : 'Copy Password Setup Link'}</span>
                  </button>
                ) : (
                  <button
                    onClick={handleRetrySetupLink}
                    disabled={retryingSetupLink}
                    className="px-4 py-2 bg-amber-600 text-white rounded-xl text-xs font-bold flex items-center space-x-2 hover:bg-amber-700 transition disabled:opacity-50"
                  >
                    {retryingSetupLink ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                    <span>{retryingSetupLink ? 'Generating Link...' : 'Retry Setup Link'}</span>
                  </button>
                )}

                {setupLinkUser.setupLinkStatus === 'failed' && setupLinkUser.link && (
                  <button
                    onClick={handleRetrySetupLink}
                    disabled={retryingSetupLink}
                    className="px-3 py-2 bg-amber-100 border border-amber-300 text-amber-800 rounded-xl text-xs font-bold flex items-center space-x-1 hover:bg-amber-200 transition disabled:opacity-50"
                  >
                    {retryingSetupLink ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                    <span>Retry Setup Link</span>
                  </button>
                )}
              </div>

              <button
                onClick={() => {
                  setSetupLinkUser(null);
                  setRetrySetupLinkError(null);
                }}
                className="px-4 py-2 border border-gray-300 rounded-xl text-xs font-bold text-gray-700 hover:bg-gray-50"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* DEACTIVATION / ACTIVATION CONFIRMATION MODAL */}
      {deactivatingUser && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-2xl max-w-md w-full border border-[#DDD9D4] shadow-2xl p-6 space-y-4 text-xs">
            <div className="flex items-center space-x-3 text-amber-600">
              <AlertTriangle className="w-6 h-6 shrink-0" />
              <h3 className="font-bold text-base text-gray-900">
                {deactivatingUser.active ? 'Deactivate Employee Account?' : 'Activate Employee Account?'}
              </h3>
            </div>

            <p className="text-gray-600">
              {deactivatingUser.active ? (
                <>
                  Are you sure you want to deactivate <strong className="text-gray-900">{deactivatingUser.fullName}</strong>?
                  Deactivating will immediately disable Firebase Authentication and block system access.
                </>
              ) : (
                <>
                  Are you sure you want to restore and activate <strong className="text-gray-900">{deactivatingUser.fullName}</strong>?
                  This will enable login and restore profile operations.
                </>
              )}
            </p>

            <div className="flex justify-end space-x-2 pt-2 border-t">
              <button
                onClick={() => setDeactivatingUser(null)}
                className="px-4 py-2 border border-gray-300 rounded-xl font-bold text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={() => handleToggleActivate(deactivatingUser)}
                disabled={submitting}
                className={`px-4 py-2 text-white rounded-xl font-bold flex items-center space-x-2 disabled:opacity-50 ${
                  deactivatingUser.active ? 'bg-red-600 hover:bg-red-700' : 'bg-emerald-600 hover:bg-emerald-700'
                }`}
              >
                {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
                <span>Confirm {deactivatingUser.active ? 'Deactivate' : 'Activate'}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* AUDIT LOG DRAWER */}
      {auditUser && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-xs flex justify-end z-50">
          <div className="bg-white w-full max-w-lg h-full shadow-2xl flex flex-col border-l border-[#DDD9D4]">
            <div className="p-5 border-b border-[#DDD9D4] flex items-center justify-between bg-[#F5F4F2]">
              <div className="flex items-center space-x-2">
                <History className="w-5 h-5 text-[#5A2628]" />
                <div>
                  <h3 className="font-bold text-sm text-[#1F1F1D]">Account Audit Log</h3>
                  <p className="text-[11px] text-gray-500">{auditUser.fullName} ({auditUser.email})</p>
                </div>
              </div>
              <button onClick={() => setAuditUser(null)} className="text-gray-400 hover:text-gray-600">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 flex-1 overflow-y-auto space-y-4 text-xs">
              {loadingAudit ? (
                <div className="text-center py-12 text-gray-500">
                  <Loader2 className="w-6 h-6 animate-spin mx-auto text-[#5A2628] mb-2" />
                  <span>Loading audit trail...</span>
                </div>
              ) : auditLogs.length === 0 ? (
                <div className="text-center py-12 text-gray-400">
                  <History className="w-8 h-8 mx-auto mb-2 opacity-50" />
                  <p>No recorded audit events for this user.</p>
                </div>
              ) : (
                auditLogs.map((log) => (
                  <div key={log.id} className="p-4 bg-gray-50 rounded-xl border border-gray-200 space-y-2">
                    <div className="flex justify-between items-center font-bold text-gray-900">
                      <span className="uppercase tracking-wider text-[10px] bg-[#5A2628] text-white px-2 py-0.5 rounded">
                        {log.eventType}
                      </span>
                      <span className="text-[11px] text-gray-500 font-mono">
                        {log.performedAt ? new Date(log.performedAt).toLocaleString() : ''}
                      </span>
                    </div>

                    <div className="text-[11px] text-gray-600">
                      Performed By UID: <span className="font-mono text-gray-800">{log.performedByUid}</span>
                    </div>

                    {log.newValues && (
                      <div className="pt-2 border-t border-gray-200">
                        <span className="font-bold text-[10px] text-gray-500 uppercase">Updates:</span>
                        <pre className="p-2 bg-white rounded border border-gray-200 text-[10px] font-mono text-gray-700 overflow-x-auto mt-1">
                          {JSON.stringify(log.newValues, null, 2)}
                        </pre>
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
