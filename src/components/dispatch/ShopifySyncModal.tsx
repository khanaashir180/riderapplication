import React, { useState, useEffect } from 'react';
import { 
  X, 
  ShoppingBag, 
  RefreshCw, 
  CheckCircle2, 
  AlertTriangle, 
  ArrowRight, 
  Truck, 
  MapPin, 
  DollarSign, 
  Package, 
  ExternalLink,
  ShieldCheck,
  Filter,
  Layers
} from 'lucide-react';
import { api } from '../../services/api';

interface ShopifySyncModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSyncSuccess: () => void;
}

export function ShopifySyncModal({ isOpen, onClose, onSyncSuccess }: ShopifySyncModalProps) {
  const [status, setStatus] = useState<{ configured: boolean; storeDomain: string | null; apiVersion: string } | null>(null);
  const [shopDetails, setShopDetails] = useState<{ shopName?: string; email?: string; currency?: string } | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [testingConnection, setTestingConnection] = useState(false);

  // Sync Parameters
  const [fulfillmentFilter, setFulfillmentFilter] = useState<'unfulfilled' | 'partial' | 'any'>('unfulfilled');
  const [orderLimit, setOrderLimit] = useState<number>(50);

  // Preview & Execution State
  const [stage, setStage] = useState<'config' | 'previewing' | 'preview_ready' | 'syncing' | 'completed' | 'error'>('config');
  const [previewData, setPreviewData] = useState<any | null>(null);
  const [syncResult, setSyncResult] = useState<any | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [syncProgress, setSyncProgress] = useState({ processed: 0, total: 0, stage: '' });

  useEffect(() => {
    if (isOpen) {
      checkShopifyConfig();
    }
  }, [isOpen]);

  const checkShopifyConfig = async () => {
    setLoadingStatus(true);
    setErrorMessage(null);
    try {
      const res = await api.getShopifyStatus();
      if (res.success && res.data) {
        setStatus(res.data);
        if (res.data.configured) {
          // Verify connection and load shop name
          testConnection();
        }
      }
    } catch (e: any) {
      setErrorMessage(e.message || 'Failed to check Shopify configuration');
    } finally {
      setLoadingStatus(false);
    }
  };

  const testConnection = async () => {
    setTestingConnection(true);
    try {
      const testRes = await api.testShopifyConnection();
      if (testRes.success && testRes.data) {
        setShopDetails(testRes.data);
      }
    } catch (e: any) {
      console.warn('Shopify connection test warning:', e.message);
    } finally {
      setTestingConnection(false);
    }
  };

  const handleFetchPreview = async () => {
    setStage('previewing');
    setErrorMessage(null);
    try {
      const res = await api.previewShopifyOrders({
        limit: orderLimit,
        status: 'open',
        fulfillmentStatus: fulfillmentFilter === 'any' ? '' : fulfillmentFilter
      });

      if (!res.success || !res.data) {
        throw new Error(res.error?.message || 'Failed to fetch Shopify orders');
      }

      setPreviewData(res.data);
      setStage('preview_ready');
    } catch (e: any) {
      setErrorMessage(e.message || 'Error communicating with Shopify API');
      setStage('error');
    }
  };

  const handleExecuteSync = async () => {
    if (!previewData) return;
    setStage('syncing');
    setErrorMessage(null);

    const total = previewData.totalShopifyOrders;
    setSyncProgress({
      processed: 0,
      total,
      stage: 'Connecting to Shopify and committing orders...'
    });

    const interval = setInterval(() => {
      setSyncProgress(prev => {
        const next = Math.min(total, prev.processed + Math.ceil(total / 4));
        return {
          ...prev,
          processed: next,
          stage: next >= total ? 'Finalizing operational audit events...' : `Committing packages (${next}/${total})...`
        };
      });
    }, 350);

    try {
      const res = await api.syncShopifyOrders({
        limit: orderLimit,
        status: 'open',
        fulfillmentStatus: fulfillmentFilter === 'any' ? '' : fulfillmentFilter
      });

      clearInterval(interval);
      setSyncProgress({ processed: total, total, stage: 'Sync complete.' });

      if (!res.success || !res.data) {
        throw new Error(res.error?.message || 'Shopify sync failed');
      }

      setSyncResult(res.data);
      setStage('completed');
      onSyncSuccess();
    } catch (e: any) {
      clearInterval(interval);
      setErrorMessage(e.message || 'Execution failure during sync');
      setStage('error');
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl border border-[#DDD9D4] w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-200">
        
        {/* Header */}
        <div className="px-6 py-4 border-b border-[#DDD9D4] flex items-center justify-between bg-[#FDFCFA]">
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 rounded-lg bg-[#95BF47]/15 flex items-center justify-center text-[#5E8E3E]">
              <ShoppingBag className="w-6 h-6" />
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <h2 className="text-lg font-bold text-[#1F1F1D]">Shopify Direct API Sync</h2>
                {status?.configured ? (
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-800 border border-emerald-300">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 mr-1.5 animate-pulse"></span>
                    API Connected
                  </span>
                ) : (
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-800 border border-amber-300">
                    Not Configured
                  </span>
                )}
              </div>
              <p className="text-xs text-[#6D6964]">
                Directly ingest unfulfilled COD & prepaid orders into Gomila Rider Control
              </p>
            </div>
          </div>

          <button 
            onClick={onClose}
            className="p-1.5 text-[#6D6964] hover:text-[#1F1F1D] hover:bg-[#F5F4F2] rounded-lg transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">

          {/* Config / Connection Card */}
          <div className="bg-[#F5F4F2] border border-[#DDD9D4] rounded-lg p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="space-y-1">
                <div className="flex items-center space-x-2">
                  <span className="text-xs font-bold uppercase tracking-wider text-[#6D6964]">Store Domain:</span>
                  <span className="text-xs font-mono font-semibold text-[#1F1F1D] bg-white px-2 py-0.5 rounded border border-[#DDD9D4]">
                    {status?.storeDomain || 'Not set in .env (SHOPIFY_STORE_DOMAIN)'}
                  </span>
                  {shopDetails?.shopName && (
                    <span className="text-xs font-bold text-[#5A2628]">({shopDetails.shopName})</span>
                  )}
                </div>
                <div className="flex items-center space-x-2 text-[11px] text-[#6D6964]">
                  <span>API Version: {status?.apiVersion || '2024-04'}</span>
                  <span>•</span>
                  <span>Currency: {shopDetails?.currency || 'PKR'}</span>
                </div>
              </div>

              {status?.configured && (
                <button
                  onClick={testConnection}
                  disabled={testingConnection}
                  className="px-3 py-1.5 text-xs font-semibold text-[#1F1F1D] bg-white hover:bg-neutral-50 rounded-md border border-[#DDD9D4] flex items-center space-x-1.5 transition disabled:opacity-50 cursor-pointer"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${testingConnection ? 'animate-spin text-[#5A2628]' : ''}`} />
                  <span>Test Connection</span>
                </button>
              )}
            </div>

            {!status?.configured && (
              <div className="bg-amber-50 border border-amber-200 rounded-md p-3 text-xs text-amber-900 space-y-1.5">
                <div className="flex items-center space-x-1.5 font-bold">
                  <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
                  <span>Shopify Admin API Credentials Required</span>
                </div>
                <p className="text-[11px] text-amber-800 leading-relaxed">
                  To load live orders directly from Shopify, configure the following environment variables in your project settings:
                </p>
                <div className="bg-white/80 p-2 rounded border border-amber-200 font-mono text-[11px] text-[#1F1F1D] space-y-0.5">
                  <div>SHOPIFY_STORE_DOMAIN="gomila-intersole.myshopify.com"</div>
                  <div>SHOPIFY_ADMIN_ACCESS_TOKEN="shpat_xxxxxxxxxxxxxxxxxxxxxxxx"</div>
                  <div>SHOPIFY_API_VERSION="2024-04"</div>
                </div>
              </div>
            )}
          </div>

          {/* Error Message */}
          {errorMessage && (
            <div className="p-4 bg-rose-50 border border-rose-200 rounded-lg flex items-start space-x-3 text-rose-900">
              <AlertTriangle className="w-5 h-5 text-rose-600 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <p className="text-xs font-bold">Operation Encountered an Error</p>
                <p className="text-xs text-rose-800">{errorMessage}</p>
              </div>
            </div>
          )}

          {/* STAGE: CONFIG & QUERY CONTROLS */}
          {(stage === 'config' || stage === 'error') && status?.configured && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-xs font-bold text-[#1F1F1D]">Fulfillment Filter</label>
                  <select
                    value={fulfillmentFilter}
                    onChange={(e: any) => setFulfillmentFilter(e.target.value)}
                    className="w-full text-xs bg-white border border-[#DDD9D4] rounded-md px-3 py-2 text-[#1F1F1D] focus:ring-1 focus:ring-[#5A2628] focus:border-[#5A2628]"
                  >
                    <option value="unfulfilled">Unfulfilled Orders Only (Recommended)</option>
                    <option value="partial">Partially Fulfilled Orders</option>
                    <option value="any">All Open Orders</option>
                  </select>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-bold text-[#1F1F1D]">Batch Fetch Limit</label>
                  <select
                    value={orderLimit}
                    onChange={(e) => setOrderLimit(Number(e.target.value))}
                    className="w-full text-xs bg-white border border-[#DDD9D4] rounded-md px-3 py-2 text-[#1F1F1D] focus:ring-1 focus:ring-[#5A2628] focus:border-[#5A2628]"
                  >
                    <option value={25}>25 Orders</option>
                    <option value={50}>50 Orders</option>
                    <option value={100}>100 Orders</option>
                    <option value={250}>250 Orders (Max Single Batch)</option>
                  </select>
                </div>
              </div>

              <div className="pt-2 flex justify-end">
                <button
                  onClick={handleFetchPreview}
                  className="px-5 py-2.5 bg-[#5A2628] hover:bg-[#451C1E] text-white rounded-lg text-xs font-bold shadow-sm flex items-center space-x-2 transition cursor-pointer"
                >
                  <ShoppingBag className="w-4 h-4" />
                  <span>Fetch & Preview Shopify Orders</span>
                </button>
              </div>
            </div>
          )}

          {/* STAGE: PREVIEWING SKELETON */}
          {stage === 'previewing' && (
            <div className="p-12 text-center space-y-4">
              <div className="inline-block w-10 h-10 border-4 border-[#5A2628] border-t-transparent rounded-full animate-spin"></div>
              <div>
                <p className="font-bold text-sm text-[#1F1F1D]">Communicating with Shopify Admin API...</p>
                <p className="text-xs text-[#6D6964] mt-1">
                  Fetching unfulfilled orders, normalizing phone numbers, and cross-checking existing packages.
                </p>
              </div>
            </div>
          )}

          {/* STAGE: PREVIEW READY */}
          {stage === 'preview_ready' && previewData && (
            <div className="space-y-6">
              {/* Metric Summary Grid */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="bg-white p-3 rounded-lg border border-[#DDD9D4]">
                  <span className="text-[11px] font-bold text-[#6D6964] uppercase">Total Fetched</span>
                  <div className="text-xl font-bold text-[#1F1F1D] mt-1">{previewData.totalShopifyOrders}</div>
                  <span className="text-[10px] text-[#6D6964]">Shopify orders</span>
                </div>

                <div className="bg-emerald-50/60 p-3 rounded-lg border border-emerald-200">
                  <span className="text-[11px] font-bold text-emerald-800 uppercase">New Packages</span>
                  <div className="text-xl font-bold text-emerald-900 mt-1">{previewData.newOrdersCount}</div>
                  <span className="text-[10px] text-emerald-700">Ready to ingest</span>
                </div>

                <div className="bg-amber-50/60 p-3 rounded-lg border border-amber-200">
                  <span className="text-[11px] font-bold text-amber-800 uppercase">Existing / Duplicates</span>
                  <div className="text-xl font-bold text-amber-900 mt-1">{previewData.duplicateOrdersCount}</div>
                  <span className="text-[10px] text-amber-700">{previewData.conflictCount} active conflicts</span>
                </div>

                <div className="bg-white p-3 rounded-lg border border-[#DDD9D4]">
                  <span className="text-[11px] font-bold text-[#6D6964] uppercase">Expected COD</span>
                  <div className="text-xl font-bold text-[#5A2628] mt-1 font-mono">
                    Rs. {Number(previewData.totalExpectedCod || 0).toLocaleString()}
                  </div>
                  <span className="text-[10px] text-[#6D6964]">{previewData.codCount} COD • {previewData.prepaidCount} Paid</span>
                </div>
              </div>

              {/* Channel Routing Distribution */}
              <div className="flex flex-wrap items-center justify-between gap-2 p-3 bg-[#F5F4F2] rounded-lg border border-[#DDD9D4] text-xs">
                <div className="flex items-center space-x-2">
                  <Truck className="w-4 h-4 text-[#5A2628]" />
                  <span className="font-bold text-[#1F1F1D]">Delivery Channel Routing:</span>
                </div>
                <div className="flex items-center space-x-4">
                  <span className="text-[#1F1F1D]">
                    <strong className="text-[#5A2628]">{previewData.internalRiderCount}</strong> Karachi Rider
                  </span>
                  <span>•</span>
                  <span className="text-[#1F1F1D]">
                    <strong className="text-[#5A2628]">{previewData.externalCourierCount}</strong> National Courier
                  </span>
                </div>
              </div>

              {/* Order Preview Table */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-bold text-[#1F1F1D] uppercase tracking-wider">
                    Order Ingestion Preview ({previewData.orders?.length || 0})
                  </h3>
                  <button
                    onClick={handleFetchPreview}
                    className="text-xs text-[#5A2628] font-semibold hover:underline flex items-center space-x-1"
                  >
                    <RefreshCw className="w-3 h-3" />
                    <span>Re-fetch from Shopify</span>
                  </button>
                </div>

                <div className="border border-[#DDD9D4] rounded-lg overflow-hidden max-h-72 overflow-y-auto bg-white">
                  <table className="w-full text-left text-xs border-collapse">
                    <thead className="bg-[#F5F4F2] text-[#6D6964] sticky top-0 border-b border-[#DDD9D4]">
                      <tr>
                        <th className="p-2.5 font-bold">Order / Package</th>
                        <th className="p-2.5 font-bold">Customer</th>
                        <th className="p-2.5 font-bold">Items</th>
                        <th className="p-2.5 font-bold">Destination</th>
                        <th className="p-2.5 font-bold">Payment / COD</th>
                        <th className="p-2.5 font-bold">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#DDD9D4]">
                      {previewData.orders?.map((ord: any, idx: number) => (
                        <tr key={idx} className="hover:bg-neutral-50/80">
                          <td className="p-2.5 font-mono font-bold text-[#1F1F1D]">
                            {ord.displayOrderNumber}
                          </td>
                          <td className="p-2.5">
                            <div className="font-semibold text-[#1F1F1D]">{ord.customerName}</div>
                            <div className="text-[10px] text-[#6D6964] font-mono">{ord.customerPhone || 'No Phone'}</div>
                          </td>
                          <td className="p-2.5">
                            <div className="max-w-[200px] truncate text-[11px] text-[#1F1F1D]" title={ord.itemSummary}>
                              {ord.itemSummary}
                            </div>
                            <div className="text-[10px] text-[#6D6964]">{ord.totalQuantity} items</div>
                          </td>
                          <td className="p-2.5">
                            <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                              ord.courierType === 'internal_rider' 
                                ? 'bg-blue-50 text-blue-800 border border-blue-200' 
                                : 'bg-purple-50 text-purple-800 border border-purple-200'
                            }`}>
                              {ord.city} • {ord.courierType === 'internal_rider' ? 'Rider' : 'Courier'}
                            </span>
                          </td>
                          <td className="p-2.5">
                            {ord.paymentStatus === 'paid' ? (
                              <span className="text-emerald-700 font-bold text-[11px]">Paid</span>
                            ) : (
                              <span className="text-[#5A2628] font-mono font-bold">
                                Rs. {Number(ord.codExpected).toLocaleString()}
                              </span>
                            )}
                          </td>
                          <td className="p-2.5">
                            {ord.importStatus === 'new' && (
                              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-800">
                                New
                              </span>
                            )}
                            {ord.importStatus === 'update_candidate' && (
                              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-blue-100 text-blue-800">
                                Update
                              </span>
                            )}
                            {ord.importStatus === 'operational_conflict' && (
                              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-rose-100 text-rose-800">
                                In Flight
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Action Buttons */}
              <div className="flex items-center justify-between pt-4 border-t border-[#DDD9D4]">
                <button
                  onClick={() => setStage('config')}
                  className="px-4 py-2 text-xs font-semibold text-[#6D6964] hover:text-[#1F1F1D] rounded-md transition"
                >
                  Change Filters
                </button>

                <div className="flex items-center space-x-3">
                  <button
                    onClick={onClose}
                    className="px-4 py-2 text-xs font-semibold text-[#1F1F1D] hover:bg-neutral-100 rounded-md border border-[#DDD9D4] transition cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleExecuteSync}
                    disabled={previewData.totalShopifyOrders === 0}
                    className="px-5 py-2 bg-[#5A2628] hover:bg-[#451C1E] text-white rounded-lg text-xs font-bold shadow-sm flex items-center space-x-2 transition disabled:opacity-50 cursor-pointer"
                  >
                    <CheckCircle2 className="w-4 h-4" />
                    <span>Confirm & Sync ({previewData.totalShopifyOrders}) Orders</span>
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* STAGE: SYNCING IN PROGRESS */}
          {stage === 'syncing' && (
            <div className="p-8 text-center space-y-4 bg-[#F5F4F2] border border-[#DDD9D4] rounded-lg">
              <div className="inline-block w-8 h-8 border-4 border-[#5A2628] border-t-transparent rounded-full animate-spin"></div>
              <div>
                <p className="font-bold text-sm text-[#1F1F1D]">Synchronizing Shopify Orders to Dispatch...</p>
                <p className="text-xs text-[#6D6964] mt-1">{syncProgress.stage}</p>
              </div>

              <div className="space-y-1 max-w-md mx-auto pt-2">
                <div className="flex justify-between text-[11px] font-mono text-[#6D6964]">
                  <span>Progress: {syncProgress.processed} / {syncProgress.total}</span>
                  <span>{syncProgress.total > 0 ? Math.round((syncProgress.processed / syncProgress.total) * 100) : 0}%</span>
                </div>
                <div className="w-full h-2 bg-[#DDD9D4] rounded-full overflow-hidden">
                  <div 
                    className="h-full bg-[#5A2628] transition-all duration-300 rounded-full"
                    style={{ width: `${syncProgress.total > 0 ? Math.round((syncProgress.processed / syncProgress.total) * 100) : 0}%` }}
                  />
                </div>
              </div>
            </div>
          )}

          {/* STAGE: COMPLETED */}
          {stage === 'completed' && syncResult && (
            <div className="p-6 text-center space-y-4 bg-emerald-50/50 border border-emerald-200 rounded-lg">
              <div className="w-12 h-12 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center mx-auto">
                <CheckCircle2 className="w-7 h-7" />
              </div>

              <div className="space-y-1">
                <h3 className="text-base font-bold text-emerald-950">Shopify Orders Successfully Synchronized!</h3>
                <p className="text-xs text-emerald-800">
                  Import Run ID: <span className="font-mono font-semibold">{syncResult.syncRunId}</span>
                </p>
              </div>

              <div className="grid grid-cols-3 gap-3 max-w-md mx-auto pt-2 text-left">
                <div className="bg-white p-3 rounded border border-emerald-200">
                  <span className="text-[10px] font-bold text-[#6D6964] uppercase">Created</span>
                  <div className="text-lg font-bold text-emerald-700">{syncResult.created}</div>
                </div>
                <div className="bg-white p-3 rounded border border-emerald-200">
                  <span className="text-[10px] font-bold text-[#6D6964] uppercase">Updated</span>
                  <div className="text-lg font-bold text-blue-700">{syncResult.updated}</div>
                </div>
                <div className="bg-white p-3 rounded border border-emerald-200">
                  <span className="text-[10px] font-bold text-[#6D6964] uppercase">Conflicts Preserved</span>
                  <div className="text-lg font-bold text-amber-700">{syncResult.conflicts}</div>
                </div>
              </div>

              <div className="pt-4 flex justify-center space-x-3">
                <button
                  onClick={onClose}
                  className="px-5 py-2.5 bg-[#5A2628] hover:bg-[#451C1E] text-white rounded-lg text-xs font-bold shadow-sm transition cursor-pointer"
                >
                  View Orders in Dispatch
                </button>
              </div>
            </div>
          )}

        </div>

      </div>
    </div>
  );
}
