import React, { useEffect, useState } from 'react';
import { AlertTriangle, ChevronRight, RefreshCw, ShieldAlert, Wallet, Truck, Users, Clock3, PackageSearch } from 'lucide-react';
import { api, ManagementDrilldownResponse, ManagementFilters, ManagementMetric } from '../../services/api';

interface ManagementDashboardProps {
  onSelectOrder: (id: string) => void;
}

type OverviewPayload = any;

const initialFilters: ManagementFilters = {
  datePreset: 'today'
};

const filterInputClass = 'rounded-xl border border-[#DDD9D4] bg-white px-3 py-2 text-sm text-[#1F1F1D]';

export function ManagementDashboard({ onSelectOrder }: ManagementDashboardProps) {
  const [filters, setFilters] = useState<ManagementFilters>(initialFilters);
  const [overview, setOverview] = useState<OverviewPayload | null>(null);
  const [riders, setRiders] = useState<any | null>(null);
  const [finance, setFinance] = useState<any | null>(null);
  const [returnsData, setReturnsData] = useState<any | null>(null);
  const [exceptions, setExceptions] = useState<any | null>(null);
  const [activity, setActivity] = useState<any | null>(null);
  const [masterData, setMasterData] = useState<any | null>(null);
  const [drilldown, setDrilldown] = useState<ManagementDrilldownResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [drilldownLoading, setDrilldownLoading] = useState(false);

  useEffect(() => {
    loadDashboardData(true);
  }, []);

  useEffect(() => {
    loadDashboardData(false);
  }, [filters.datePreset, filters.fromDate, filters.toDate, filters.city, filters.zone, filters.riderId, filters.paymentType, filters.source]);

  async function loadDashboardData(initial = false) {
    if (initial) setLoading(true);
    else setRefreshing(true);
    try {
      const [overviewRes, ridersRes, financeRes, returnsRes, exceptionsRes, activityRes, masterRes] = await Promise.all([
        api.getManagementOverview(cleanFilters(filters)),
        api.getManagementRiders(cleanFilters(filters)),
        api.getManagementFinance(cleanFilters(filters)),
        api.getManagementReturns(cleanFilters(filters)),
        api.getManagementExceptions(cleanFilters(filters)),
        api.getManagementActivity(cleanFilters(filters)),
        api.getMasterData()
      ]);
      setOverview(overviewRes.data || null);
      setRiders(ridersRes.data || null);
      setFinance(financeRes.data || null);
      setReturnsData(returnsRes.data || null);
      setExceptions(exceptionsRes.data || null);
      setActivity(activityRes.data || null);
      setMasterData(masterRes.data || null);
    } catch (error) {
      console.error('Failed to load management command center:', error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  async function openDrilldown(key?: string) {
    if (!key) return;
    setDrilldownLoading(true);
    try {
      const response = await api.getManagementDrilldown(key, cleanFilters(filters));
      setDrilldown(response.data || null);
    } catch (error) {
      console.error('Failed to load management drilldown:', error);
    } finally {
      setDrilldownLoading(false);
    }
  }

  if (loading || !overview || !riders || !finance || !returnsData || !exceptions || !activity) {
    return (
      <div className="p-6 text-center text-sm text-[#6D6964]">
        Loading management command center...
      </div>
    );
  }

  const exportHref = drilldown ? `/api/management/export?${new URLSearchParams({ ...cleanFilters(filters) as any, key: drilldown.key }).toString()}` : '#';

  return (
    <div className="min-h-screen bg-[#F5F4F2] p-4 md:p-6 space-y-5">
      <section className="bg-white border border-[#DDD9D4] rounded-2xl p-4 md:p-5 shadow-sm space-y-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="flex items-center gap-2 text-[#5A2628]">
              <ShieldAlert className="w-5 h-5" />
              <span className="text-xs font-bold tracking-[0.18em] uppercase">Management Command Center</span>
            </div>
            <h2 className="text-2xl font-black text-[#1F1F1D] mt-1">Operational truth for packages, riders, cash and exceptions</h2>
            <p className="text-sm text-[#6D6964] mt-1">
              All figures below are derived from operational events, custody records, delivery attempts, returns, settlements, ledger postings and exception records.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => loadDashboardData(false)}
              className="inline-flex items-center gap-2 rounded-xl border border-[#DDD9D4] px-3 py-2 text-sm font-semibold text-[#1F1F1D] hover:bg-[#F5F4F2]"
            >
              <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
              Refresh
            </button>
            <div className="rounded-xl bg-[#F5F4F2] border border-[#DDD9D4] px-3 py-2 text-xs font-mono text-[#6D6964]">
              Last refreshed: {formatTimestamp(overview.freshness?.lastRefreshedAt)}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-2">
          <FilterChip label="Today" active={filters.datePreset === 'today'} onClick={() => setFilters({ datePreset: 'today' })} />
          <FilterChip label="Yesterday" active={filters.datePreset === 'yesterday'} onClick={() => setFilters({ datePreset: 'yesterday' })} />
          <FilterChip
            label="Custom Date"
            active={filters.datePreset === 'custom'}
            onClick={() => setFilters({
              ...filters,
              datePreset: 'custom',
              fromDate: filters.fromDate || overview.range?.fromDate,
              toDate: filters.toDate || overview.range?.toDate
            })}
          />
          <select value={filters.city || ''} onChange={(e) => setFilters({ ...filters, city: e.target.value || undefined })} className={filterInputClass}>
            <option value="">All Cities</option>
            {(masterData?.cities || []).map((city: string) => <option key={city} value={city}>{city}</option>)}
          </select>
          <select value={filters.zone || ''} onChange={(e) => setFilters({ ...filters, zone: e.target.value || undefined })} className={filterInputClass}>
            <option value="">All Zones</option>
            {Object.entries(masterData?.zones || {}).flatMap(([city, zones]: any) => (zones as string[]).map((zone: string) => <option key={`${city}_${zone}`} value={zone}>{zone}</option>))}
          </select>
          <select value={filters.riderId || ''} onChange={(e) => setFilters({ ...filters, riderId: e.target.value || undefined })} className={filterInputClass}>
            <option value="">All Riders</option>
            {(riders.riders || []).map((rider: any) => <option key={rider.riderId} value={rider.riderId}>{rider.riderName}</option>)}
          </select>
          <select value={filters.paymentType || ''} onChange={(e) => setFilters({ ...filters, paymentType: e.target.value || undefined })} className={filterInputClass}>
            <option value="">All Payment Types</option>
            {['cash', 'jazzcash', 'easypaisa', 'bank_transfer', 'prepaid'].map((method) => <option key={method} value={method}>{method}</option>)}
          </select>
          <select value={filters.source || ''} onChange={(e) => setFilters({ ...filters, source: e.target.value || undefined })} className={filterInputClass}>
            <option value="">All Sources</option>
            {['SHOPIFY', 'CSV', 'MANUAL'].map((source) => <option key={source} value={source}>{source}</option>)}
          </select>
        </div>

        {filters.datePreset === 'custom' && (
          <div className="flex flex-col md:flex-row gap-2">
            <input type="date" value={filters.fromDate || ''} onChange={(e) => setFilters({ ...filters, fromDate: e.target.value })} className={filterInputClass} />
            <input type="date" value={filters.toDate || ''} onChange={(e) => setFilters({ ...filters, toDate: e.target.value })} className={filterInputClass} />
          </div>
        )}
      </section>

      <section className="grid grid-cols-2 lg:grid-cols-4 xl:grid-cols-8 gap-3">
        {(overview.topStats || []).map((metric: ManagementMetric) => (
          <MetricCard key={metric.key} metric={metric} onClick={() => openDrilldown(metric.drilldownKey)} />
        ))}
      </section>

      <section className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <Panel title="Exception Summary" icon={<AlertTriangle className="w-4 h-4 text-[#B43B3B]" />}>
          <div className="grid grid-cols-3 gap-3">
            <SeverityCard label="Critical" count={exceptions.counts?.critical || 0} tone="critical" />
            <SeverityCard label="High" count={exceptions.counts?.high || 0} tone="warning" />
            <SeverityCard label="Medium" count={exceptions.counts?.medium || 0} tone="normal" />
          </div>
          <div className="mt-3 space-y-2">
            {(exceptions.liveAlerts || []).length === 0 ? (
              <EmptyText text="No live operational alerts under the current filter context." />
            ) : (
              (exceptions.liveAlerts || []).map((alert: any) => (
                <button key={alert.key} onClick={() => openDrilldown(alert.drilldownKey)} className="w-full text-left rounded-xl border border-[#E7E2DB] px-3 py-3 hover:bg-[#F8F7F5]">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-[#1F1F1D]">{alert.label}</p>
                      <p className="text-xs text-[#6D6964] mt-1">{alert.source}</p>
                    </div>
                    <ChevronRight className="w-4 h-4 text-[#6D6964] shrink-0" />
                  </div>
                </button>
              ))
            )}
          </div>
        </Panel>

        <Panel title="Delivery Performance" icon={<Truck className="w-4 h-4 text-[#356A8A]" />}>
          <div className="space-y-2">
            {(overview.deliveryPerformance || []).map((metric: ManagementMetric) => (
              <button key={metric.key} onClick={() => openDrilldown(metric.drilldownKey)} className="w-full rounded-xl border border-[#E7E2DB] px-3 py-3 text-left hover:bg-[#F8F7F5]">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-[#1F1F1D]">{metric.label}</p>
                    <p className="text-[11px] text-[#6D6964] mt-1">{metric.formula}</p>
                  </div>
                  <span className="text-lg font-black text-[#1F1F1D]">{metric.displayValue}</span>
                </div>
              </button>
            ))}
          </div>
        </Panel>

        <Panel title="Intake Health" icon={<PackageSearch className="w-4 h-4 text-[#5A2628]" />}>
          <KeyValue label="Orders Received Today" value={String(overview.intakeHealth?.ordersReceivedToday ?? 'N/A')} />
          <KeyValue label="Orders Ready" value={String(overview.intakeHealth?.ordersReady ?? 'N/A')} />
          <KeyValue label="Orders on Hold" value={String(overview.intakeHealth?.ordersOnHold ?? 'N/A')} />
          <KeyValue label="Address Review" value={String(overview.intakeHealth?.addressReview ?? 'N/A')} />
          <KeyValue label="Payment Review" value={formatNullable(overview.intakeHealth?.paymentReview)} />
          <KeyValue label="Cancelled" value={String(overview.intakeHealth?.cancelled ?? 'N/A')} />
          <KeyValue label="Sync Errors" value={formatNullable(overview.intakeHealth?.syncErrors)} />
          <KeyValue label="Last Successful Inbound Event" value={formatTimestamp(overview.intakeHealth?.lastSuccessfulInboundEvent)} />
          <KeyValue label="Pending Retry Events" value={formatNullable(overview.intakeHealth?.pendingRetryEvents)} />
          <KeyValue label="Dead-letter Failures" value={formatNullable(overview.intakeHealth?.deadLetterFailures)} />
        </Panel>
      </section>

      <section className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <Panel title="Package Aging" icon={<Clock3 className="w-4 h-4 text-[#A56716]" />}>
          <AgingSection title="Ready for Dispatch" buckets={overview.aging?.readyForDispatch || []} onOpen={openDrilldown} />
          <AgingSection title="Assigned but Not Out for Delivery" buckets={overview.aging?.assignedNotOutForDelivery || []} onOpen={openDrilldown} />
          <AgingSection title="With Rider" buckets={overview.aging?.withRider || []} onOpen={openDrilldown} />
        </Panel>

        <Panel title="Delivery Funnel" icon={<ChevronRight className="w-4 h-4 text-[#356A8A]" />}>
          <div className="space-y-2">
            {(overview.funnel || []).map((stage: any) => (
              <button key={stage.key} onClick={() => openDrilldown(stage.drilldownKey)} className="w-full rounded-xl border border-[#E7E2DB] px-3 py-3 hover:bg-[#F8F7F5]">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-[#1F1F1D]">{stage.label}</p>
                    <p className="text-[11px] text-[#6D6964] mt-1">{stage.source}</p>
                  </div>
                  <div className="text-right">
                    <div className="text-lg font-black text-[#1F1F1D]">{stage.count}</div>
                    <div className="text-[11px] text-[#6D6964]">{stage.percentageOfBase == null ? 'N/A' : `${stage.percentageOfBase.toFixed(1)}%`}</div>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </Panel>
      </section>

      <section className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <Panel title="COD Management Dashboard" icon={<Wallet className="w-4 h-4 text-[#1F7A52]" />}>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {(finance.summary || []).map((metric: ManagementMetric) => (
              <MetricLine key={metric.key} metric={metric} onClick={() => openDrilldown(metric.drilldownKey)} />
            ))}
          </div>
          <div className="mt-4 rounded-xl border border-[#DDD9D4] bg-[#F8F7F5] p-4">
            <p className="text-xs font-bold uppercase tracking-[0.14em] text-[#6D6964]">Today's Financial Reconciliation</p>
            <div className={`mt-2 inline-flex rounded-full px-3 py-1 text-xs font-bold ${finance.reconciliation?.status === 'MATCHED' ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-800'}`}>
              {finance.reconciliation?.status === 'MATCHED' ? 'MATCHED' : 'ATTENTION REQUIRED'}
            </div>
            <p className="text-sm text-[#1F1F1D] mt-3 leading-6">{finance.reconciliation?.equation}</p>
            <div className="grid grid-cols-3 gap-3 mt-3 text-sm">
              <KeyMetricSmall label="Ledger Debits" value={formatCurrency(finance.reconciliation?.ledger?.debits)} />
              <KeyMetricSmall label="Ledger Credits" value={formatCurrency(finance.reconciliation?.ledger?.credits)} />
              <KeyMetricSmall label="Ledger Difference" value={formatCurrency(finance.reconciliation?.ledger?.difference)} />
            </div>
          </div>
        </Panel>

        <Panel title="Returns / Reverse Logistics" icon={<AlertTriangle className="w-4 h-4 text-[#A56716]" />}>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {(returnsData.summary || []).map((metric: ManagementMetric) => (
              <MetricLine key={metric.key} metric={metric} onClick={() => openDrilldown(metric.drilldownKey)} />
            ))}
          </div>
          <div className="mt-4 space-y-2">
            {(returnsData.aging || []).map((row: any) => (
              <button key={row.key} onClick={() => openDrilldown(row.drilldownKey)} className="w-full rounded-xl border border-[#E7E2DB] px-3 py-3 text-left hover:bg-[#F8F7F5]">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold text-[#1F1F1D]">{row.label}</span>
                  <span className="text-lg font-black text-[#1F1F1D]">{row.count}</span>
                </div>
              </button>
            ))}
          </div>
        </Panel>
      </section>

      <section className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <Panel title="Top Failure Reasons" icon={<AlertTriangle className="w-4 h-4 text-[#B43B3B]" />}>
          <div className="space-y-2">
            {(overview.topFailureReasons || []).length === 0 ? (
              <EmptyText text="No failed delivery attempts in the selected time range." />
            ) : (
              (overview.topFailureReasons || []).map((reason: any) => (
                <button key={reason.reason} onClick={() => openDrilldown(reason.drilldownKey)} className="w-full rounded-xl border border-[#E7E2DB] px-3 py-3 text-left hover:bg-[#F8F7F5]">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-[#1F1F1D]">{reason.reason}</p>
                      <p className="text-[11px] text-[#6D6964] mt-1">{reason.percentage == null ? 'N/A' : `${reason.percentage.toFixed(1)}% of failed attempts`}</p>
                    </div>
                    <span className="text-lg font-black text-[#1F1F1D]">{reason.count}</span>
                  </div>
                </button>
              ))
            )}
          </div>
        </Panel>

        <Panel title="Staff Actions Today" icon={<Users className="w-4 h-4 text-[#356A8A]" />}>
          <div className="grid grid-cols-2 gap-2 mb-3">
            <KeyMetricSmall label="Human Actions" value={String(activity.summary?.humanActionCount ?? 0)} />
            <KeyMetricSmall label="System Actions" value={String(activity.summary?.systemActionCount ?? 0)} />
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left text-[#6D6964] border-b border-[#E7E2DB]">
                  <th className="py-2 pr-3">Name</th>
                  <th className="py-2 pr-3">Role</th>
                  <th className="py-2 pr-3">Actions</th>
                  <th className="py-2 pr-3">Last Action</th>
                  <th className="py-2 pr-3">Critical</th>
                  <th className="py-2">Exceptions</th>
                </tr>
              </thead>
              <tbody>
                {(activity.staffRows || []).map((row: any) => (
                  <tr key={row.actorUid} className="border-b border-[#F0ECE7]">
                    <td className="py-2 pr-3 font-semibold text-[#1F1F1D]">{row.actorName}</td>
                    <td className="py-2 pr-3 text-[#6D6964]">{row.actorRole}</td>
                    <td className="py-2 pr-3">{row.actionCount}</td>
                    <td className="py-2 pr-3">{row.lastActionLabel ? `${row.lastActionLabel} · ${formatTimestamp(row.lastActionAt)}` : 'N/A'}</td>
                    <td className="py-2 pr-3">{row.criticalActionCount}</td>
                    <td className="py-2">{row.assignedExceptionCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      </section>

      <Panel title="Rider Command Center" icon={<Users className="w-4 h-4 text-[#5A2628]" />}>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="text-left text-[#6D6964] border-b border-[#E7E2DB]">
                <th className="py-2 pr-3">Rider</th>
                <th className="py-2 pr-3">Shift Status</th>
                <th className="py-2 pr-3">Assigned</th>
                <th className="py-2 pr-3">Delivered</th>
                <th className="py-2 pr-3">Failed</th>
                <th className="py-2 pr-3">Remaining</th>
                <th className="py-2 pr-3">First Attempt %</th>
                <th className="py-2 pr-3">COD Collected</th>
                <th className="py-2 pr-3">Cash Outstanding</th>
                <th className="py-2 pr-3">Returns Pending</th>
                <th className="py-2 pr-3">Last Action</th>
                <th className="py-2">Exceptions</th>
              </tr>
            </thead>
            <tbody>
              {(riders.riders || []).map((row: any) => (
                <tr key={row.riderId} className="border-b border-[#F0ECE7]">
                  <td className="py-2 pr-3">
                    <button onClick={() => openDrilldown(row.timelineDrilldownKey)} className="font-semibold text-[#5A2628] hover:underline">
                      {row.riderName}
                    </button>
                    <div className="text-[11px] text-[#6D6964]">{row.zone || row.city || 'Unassigned Zone'}</div>
                  </td>
                  <td className="py-2 pr-3">{row.shiftStatus}</td>
                  <td className="py-2 pr-3">{row.assigned}</td>
                  <td className="py-2 pr-3">{row.delivered}</td>
                  <td className="py-2 pr-3">{row.failed}</td>
                  <td className="py-2 pr-3">{row.remaining}</td>
                  <td className="py-2 pr-3">{row.firstAttemptSuccess == null ? 'N/A' : `${row.firstAttemptSuccess.toFixed(1)}%`}</td>
                  <td className="py-2 pr-3">{formatCurrency(row.codCollected)}</td>
                  <td className="py-2 pr-3">{formatCurrency(row.cashOutstanding)}</td>
                  <td className="py-2 pr-3">{row.returnsPending}</td>
                  <td className="py-2 pr-3">{row.lastActionLabel ? `${row.lastActionLabel} · ${formatTimestamp(row.lastActionAt)}` : 'N/A'}</td>
                  <td className="py-2">{row.exceptionCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      {drilldown && (
        <div className="fixed inset-0 z-40 bg-black/30 backdrop-blur-[1px]">
          <div className="absolute right-0 top-0 h-full w-full max-w-3xl bg-white border-l border-[#DDD9D4] shadow-2xl flex flex-col">
            <div className="p-4 border-b border-[#E7E2DB] flex items-start justify-between gap-3">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.14em] text-[#6D6964]">Metric Drilldown</p>
                <h3 className="text-xl font-black text-[#1F1F1D] mt-1">{drilldown.title}</h3>
              </div>
              <div className="flex gap-2">
                <a href={exportHref} className="rounded-xl border border-[#DDD9D4] px-3 py-2 text-sm font-semibold text-[#1F1F1D] hover:bg-[#F5F4F2]">Export CSV</a>
                <button onClick={() => setDrilldown(null)} className="rounded-xl border border-[#DDD9D4] px-3 py-2 text-sm font-semibold text-[#1F1F1D] hover:bg-[#F5F4F2]">Close</button>
              </div>
            </div>
            <div className="flex-1 overflow-auto p-4">
              {drilldownLoading ? (
                <EmptyText text="Loading drilldown..." />
              ) : drilldown.rows.length === 0 ? (
                <EmptyText text="No records matched this metric under the active filters." />
              ) : (
                <div className="overflow-x-auto">
                  <table className="min-w-full text-sm">
                    <thead>
                      <tr className="text-left text-[#6D6964] border-b border-[#E7E2DB]">
                        {drilldown.columns.map((column) => (
                          <th key={column.key} className="py-2 pr-3">{column.label}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {drilldown.rows.map((row, index) => (
                        <tr key={`${row.packageId || row.key || index}`} className="border-b border-[#F0ECE7]">
                          {drilldown.columns.map((column) => (
                            <td key={column.key} className="py-2 pr-3">
                              {column.key === 'packageId' && row.packageId ? (
                                <button onClick={() => onSelectOrder(row.packageId)} className="text-[#5A2628] font-semibold hover:underline">
                                  {row[column.key]}
                                </button>
                              ) : (
                                formatCell(row[column.key])
                              )}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function cleanFilters(filters: ManagementFilters) {
  const next: Record<string, string> = {};
  Object.entries(filters).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      next[key] = String(value);
    }
  });
  return next;
}

function formatCurrency(value: number | null | undefined) {
  if (value == null || Number.isNaN(Number(value))) return 'N/A';
  return `Rs ${Math.round(Number(value)).toLocaleString()}`;
}

function formatTimestamp(value: string | null | undefined) {
  if (!value) return 'N/A';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('en-PK', {
    hour: '2-digit',
    minute: '2-digit',
    day: '2-digit',
    month: 'short'
  });
}

function formatNullable(value: unknown) {
  if (value === null || value === undefined || value === '') return 'N/A';
  return String(value);
}

function formatCell(value: any) {
  if (value === null || value === undefined || value === '') return '—';
  return String(value);
}

function Panel({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="bg-white border border-[#DDD9D4] rounded-2xl p-4 shadow-sm">
      <div className="flex items-center gap-2 mb-4">
        {icon}
        <h3 className="text-base font-black text-[#1F1F1D]">{title}</h3>
      </div>
      {children}
    </section>
  );
}

function MetricCard({ metric, onClick }: { metric: ManagementMetric; onClick: () => void }) {
  return (
    <button onClick={onClick} className="bg-white border border-[#DDD9D4] rounded-2xl p-4 text-left shadow-sm hover:bg-[#FBFAF8]">
      <p className="text-xs font-bold uppercase tracking-[0.12em] text-[#6D6964]">{metric.label}</p>
      <div className="mt-2 text-2xl font-black text-[#1F1F1D]">{metric.displayValue}</div>
      <p className="mt-2 text-[11px] text-[#6D6964] leading-5">{metric.source}</p>
    </button>
  );
}

function MetricLine({ metric, onClick }: { metric: ManagementMetric; onClick: () => void }) {
  return (
    <button onClick={onClick} className="rounded-xl border border-[#E7E2DB] px-3 py-3 text-left hover:bg-[#F8F7F5]">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-[#1F1F1D]">{metric.label}</p>
          <p className="text-[11px] text-[#6D6964] mt-1">{metric.source}</p>
        </div>
        <span className="text-lg font-black text-[#1F1F1D]">{metric.displayValue}</span>
      </div>
    </button>
  );
}

function KeyValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-[#F0ECE7] last:border-b-0">
      <span className="text-sm text-[#6D6964]">{label}</span>
      <span className="text-sm font-semibold text-[#1F1F1D] text-right">{value}</span>
    </div>
  );
}

function KeyMetricSmall({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-[#E7E2DB] p-3">
      <div className="text-[11px] uppercase tracking-[0.12em] text-[#6D6964]">{label}</div>
      <div className="text-lg font-black text-[#1F1F1D] mt-1">{value}</div>
    </div>
  );
}

function EmptyText({ text }: { text: string }) {
  return <div className="rounded-xl border border-dashed border-[#DDD9D4] px-4 py-6 text-center text-sm text-[#6D6964]">{text}</div>;
}

function SeverityCard({ label, count, tone }: { label: string; count: number; tone: 'critical' | 'warning' | 'normal' }) {
  const styles = tone === 'critical'
    ? 'bg-red-50 border-red-200 text-red-800'
    : tone === 'warning'
      ? 'bg-amber-50 border-amber-200 text-amber-800'
      : 'bg-slate-50 border-slate-200 text-slate-800';
  return (
    <div className={`rounded-xl border p-3 ${styles}`}>
      <div className="text-[11px] uppercase tracking-[0.12em]">{label}</div>
      <div className="text-2xl font-black mt-1">{count}</div>
    </div>
  );
}

function AgingSection({ title, buckets, onOpen }: { title: string; buckets: any[]; onOpen: (key?: string) => void }) {
  return (
    <div className="mb-4 last:mb-0">
      <h4 className="text-sm font-black text-[#1F1F1D] mb-2">{title}</h4>
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
        {buckets.map((bucket) => (
          <button key={bucket.key} onClick={() => onOpen(bucket.drilldownKey)} className="rounded-xl border border-[#E7E2DB] p-3 text-left hover:bg-[#F8F7F5]">
            <div className="text-[11px] uppercase tracking-[0.12em] text-[#6D6964]">{bucket.label}</div>
            <div className="text-xl font-black text-[#1F1F1D] mt-1">{bucket.count}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

function FilterChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className={`rounded-xl px-3 py-2 text-sm font-semibold border ${active ? 'bg-[#5A2628] text-white border-[#5A2628]' : 'bg-white text-[#1F1F1D] border-[#DDD9D4]'}`}>
      {label}
    </button>
  );
}
