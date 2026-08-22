import React, { useState, useEffect } from 'react';
import { BarChart3, TrendingUp, CheckCircle2, AlertTriangle, DollarSign, Users, Clock, Building2 } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';
import { AnalyticsSummary, Order } from '../../types';
import { api } from '../../services/api';

interface ManagementDashboardProps {
  onSelectOrder: (id: string) => void;
}

export function ManagementDashboard({ onSelectOrder }: ManagementDashboardProps) {
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  const [recentOrders, setRecentOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadAnalyticsData();
  }, []);

  const loadAnalyticsData = async () => {
    setLoading(true);
    try {
      const [sumRes, ordRes] = await Promise.all([
        api.getAnalyticsSummary(),
        api.getOrders({ limit: 50 })
      ]);
      if (sumRes.data) {
        setSummary(sumRes.data);
      }
      setRecentOrders(ordRes.orders || ordRes.data?.orders || []);
    } catch (e) {
      console.error('Failed to load management dashboard analytics:', e);
    } finally {
      setLoading(false);
    }
  };

  if (loading || !summary) {
    return (
      <div className="p-8 text-center text-xs text-[#6D6964] animate-pulse">
        Loading executive decision dashboard...
      </div>
    );
  }

  // MAX TWO CHARTS:
  // Chart 1: Delivery Status Breakdown (Bar chart)
  const chartDataStatus = [
    { name: 'Assigned Today', count: summary.assignedToday ?? 0 },
    { name: 'Delivered Today', count: summary.deliveredToday ?? 0 },
    { name: 'Failed Today', count: summary.failedToday ?? 0 },
    { name: 'Returned Today', count: summary.returnedToday ?? 0 }
  ];

  // Chart 2: COD Settlement Balance (Pie chart)
  const chartDataCOD = [
    { name: 'Settled COD', value: summary.totalSettledCod ?? 0, color: '#1F7A52' },
    { name: 'Cash With Riders', value: summary.codHeldByRiders ?? 0, color: '#A56716' },
    { name: 'Unsettled COD', value: summary.unsettledCod ?? 0, color: '#B43B3B' }
  ];

  const exceptions = recentOrders.filter(o => ['Customer Unavailable', 'Refused', 'Rescheduled'].includes(o.current_status));

  return (
    <div className="p-6 space-y-6 bg-[#F5F4F2] min-h-screen">
      
      {/* Top Restrained Executive Header */}
      <div className="bg-white p-4 rounded-lg border border-[#DDD9D4] shadow-xs flex justify-between items-center">
        <div>
          <h2 className="text-sm font-bold text-[#1F1F1D]">Executive Logistics & COD Control Overview</h2>
          <p className="text-xs text-[#6D6964]">High-level operational performance metrics for Gomila Intersole LMS</p>
        </div>
        <span className="text-[10px] font-mono text-[#6D6964] bg-[#F5F4F2] px-2.5 py-1 rounded border border-[#DDD9D4]">
          Karachi Day: {summary.reportingDay || 'Live'}
        </span>
      </div>

      {/* 8 Primary KPI Cards Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        
        <div className="bg-white p-4 rounded-lg border border-[#DDD9D4] shadow-xs space-y-1">
          <div className="flex justify-between items-center text-[#6D6964]">
            <span className="text-xs font-semibold">Assigned Today</span>
            <CheckCircle2 className="w-4 h-4 text-[#1F7A52]" />
          </div>
          <span className="text-2xl font-black text-[#1F1F1D]">{summary.assignedToday ?? 0}</span>
          <p className="text-[10px] text-[#6D6964]">Assignments created within today only</p>
        </div>

        <div className="bg-white p-4 rounded-lg border border-[#DDD9D4] shadow-xs space-y-1">
          <div className="flex justify-between items-center text-[#6D6964]">
            <span className="text-xs font-semibold">First-Attempt Success</span>
            <TrendingUp className="w-4 h-4 text-[#356A8A]" />
          </div>
          <span className="text-2xl font-black text-[#1F1F1D]">{summary.firstAttemptPercentage}</span>
          <p className="text-[10px] text-[#6D6964]">Target &gt; 85%</p>
        </div>

        <div className="bg-white p-4 rounded-lg border border-[#DDD9D4] shadow-xs space-y-1">
          <div className="flex justify-between items-center text-[#6D6964]">
            <span className="text-xs font-semibold">COD Collected</span>
            <DollarSign className="w-4 h-4 text-[#1F7A52]" />
          </div>
          <span className="text-xl font-black text-[#5A2628] font-mono">
            Rs. {(summary.totalCollectedCod || 0).toLocaleString()}
          </span>
          <p className="text-[10px] text-[#6D6964]">Total doorstep cash collected</p>
        </div>

        <div className="bg-white p-4 rounded-lg border border-[#DDD9D4] shadow-xs space-y-1">
          <div className="flex justify-between items-center text-[#6D6964]">
            <span className="text-xs font-semibold">Cash With Riders</span>
            <DollarSign className="w-4 h-4 text-[#A56716]" />
          </div>
          <span className="text-xl font-black text-[#A56716] font-mono">
            Rs. {(summary.codHeldByRiders || 0).toLocaleString()}
          </span>
          <p className="text-[10px] text-[#6D6964]">Net rider wallet exposure</p>
        </div>

        <div className="bg-white p-4 rounded-lg border border-[#DDD9D4] shadow-xs space-y-1">
          <div className="flex justify-between items-center text-[#6D6964]">
            <span className="text-xs font-semibold">Open Shortage</span>
            <AlertTriangle className="w-4 h-4 text-[#B43B3B]" />
          </div>
          <span className="text-xl font-black text-[#B43B3B] font-mono">
            Rs. {(summary.openShortage || 0).toLocaleString()}
          </span>
          <p className="text-[10px] text-[#B43B3B] font-bold">Unresolved shortage only</p>
        </div>

        <div className="bg-white p-4 rounded-lg border border-[#DDD9D4] shadow-xs space-y-1">
          <div className="flex justify-between items-center text-[#6D6964]">
            <span className="text-xs font-semibold">Cashier Received</span>
            <Clock className="w-4 h-4 text-[#B43B3B]" />
          </div>
          <span className="text-xl font-black text-[#1F1F1D] font-mono">
            Rs. {(summary.cashierReceived || 0).toLocaleString()}
          </span>
          <p className="text-[10px] text-[#6D6964]">Physical receipts confirmed today</p>
        </div>

        <div className="bg-white p-4 rounded-lg border border-[#DDD9D4] shadow-xs space-y-1">
          <div className="flex justify-between items-center text-[#6D6964]">
            <span className="text-xs font-semibold">Delivered Today</span>
            <Users className="w-4 h-4 text-[#356A8A]" />
          </div>
          <span className="text-2xl font-black text-[#1F1F1D]">{summary.deliveredToday ?? 0}</span>
          <p className="text-[10px] text-[#6D6964]">Today-scoped successful drops</p>
        </div>

        <div className="bg-white p-4 rounded-lg border border-[#DDD9D4] shadow-xs space-y-1">
          <div className="flex justify-between items-center text-[#6D6964]">
            <span className="text-xs font-semibold">Open Excess</span>
            <Building2 className="w-4 h-4 text-[#5A2628]" />
          </div>
          <span className="text-xl font-black text-[#1F1F1D] font-mono">Rs. {(summary.openExcess || 0).toLocaleString()}</span>
          <p className="text-[10px] text-[#6D6964]">Unresolved excess cash</p>
        </div>

      </div>

      {/* STRICT RESTRAINT: MAX TWO CHARTS ONLY */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        
        {/* CHART 1: Volume & Status Breakdown */}
        <div className="bg-white rounded-lg border border-[#DDD9D4] p-4 space-y-3">
          <h3 className="text-xs font-bold text-[#1F1F1D]">Delivery Volume by Status</h3>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartDataStatus}>
                <XAxis dataKey="name" stroke="#6D6964" fontSize={11} />
                <YAxis stroke="#6D6964" fontSize={11} />
                <Tooltip />
                <Bar dataKey="count" fill="#5A2628" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* CHART 2: COD Cash Distribution */}
        <div className="bg-white rounded-lg border border-[#DDD9D4] p-4 space-y-3">
          <h3 className="text-xs font-bold text-[#1F1F1D]">COD Cash Allocation Breakdown</h3>
          <div className="h-64 flex items-center justify-center">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={chartDataCOD}
                  dataKey="value"
                  nameKey="name"
                  cx="50%"
                  cy="50%"
                  outerRadius={80}
                  label={({ name, value }) => `${name}: Rs.${value.toLocaleString()}`}
                >
                  {chartDataCOD.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>

      </div>

      {/* PRIORITISED EXCEPTION TABLE */}
      <div className="bg-white rounded-lg border border-[#DDD9D4] p-4 space-y-3 shadow-xs">
        <h3 className="text-xs font-bold text-[#1F1F1D]">Critical Delivery & Financial Exception Log</h3>
        <div className="divide-y divide-[#DDD9D4] text-xs">
          {exceptions.length === 0 ? (
            <div className="p-4 text-center text-[#6D6964]">No operational exceptions reported</div>
          ) : (
            exceptions.slice(0, 5).map((ord) => (
              <div key={ord.id} className="py-2.5 flex justify-between items-center hover:bg-[#F5F4F2]/50 px-2 rounded transition">
                <div>
                  <button onClick={() => onSelectOrder(ord.id)} className="font-mono font-bold text-[#5A2628]">
                    {ord.original_order_number}
                  </button>
                  <p className="text-[#6D6964] text-[11px]">{ord.customer_name} • {ord.city}</p>
                </div>
                <div className="text-right">
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-[#B43B3B]/10 text-[#B43B3B] border border-[#B43B3B]/30 block mb-0.5">
                    {ord.current_status}
                  </span>
                  <span className="font-mono text-[11px] text-[#6D6964]">COD: Rs. {ord.cod_expected.toLocaleString()}</span>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

    </div>
  );
}
