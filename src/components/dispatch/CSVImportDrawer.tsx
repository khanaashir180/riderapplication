import React, { useState } from 'react';
import { X, Upload, FileSpreadsheet, CheckCircle2, AlertTriangle, Loader2, ShoppingBag, ArrowRight } from 'lucide-react';
import Papa from 'papaparse';
import { api } from '../../services/api';
import { ImportValidationData } from '../../services/csvImporter';
import { ShopifySyncModal } from './ShopifySyncModal';

interface CSVImportDrawerProps {
  onClose: () => void;
  onImportSuccess: () => void;
}

export function CSVImportDrawer({ onClose, onImportSuccess }: CSVImportDrawerProps) {
  const [step, setStep] = useState<'upload' | 'validating' | 'review' | 'importing' | 'complete' | 'failed'>('upload');
  const [fileName, setFileName] = useState('');
  const [parsedRows, setParsedRows] = useState<any[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [failedBatchId, setFailedBatchId] = useState<string | null>(null);
  const [showShopifyModal, setShowShopifyModal] = useState(false);
  const [importProgress, setImportProgress] = useState<{ processed: number; total: number; stage: string }>({
    processed: 0,
    total: 0,
    stage: ''
  });

  // Validation Results
  const [valResult, setValResult] = useState<ImportValidationData | null>(null);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      setFileName(file.name);
      setErrorMessage(null);
      
      Papa.parse(file, {
        header: true,
        skipEmptyLines: true,
        complete: (results) => {
          setParsedRows(results.data);
          handleValidate(results.data, file.name);
        },
        error: (err) => {
          setErrorMessage(`Failed to parse CSV file: ${err.message}`);
          setStep('failed');
        }
      });
    }
  };

  const handleValidate = async (rowsData: any[], name: string) => {
    setIsProcessing(true);
    setStep('validating');
    setErrorMessage(null);
    setImportProgress({
      processed: rowsData.length,
      total: rowsData.length,
      stage: 'Staging raw CSV rows and validating order numbers...'
    });

    try {
      const res = await api.validateCsvImport({
        csv_data: rowsData,
        fileName: name
      });

      if (!res.success || !res.data) {
        const msg = res.error?.message || "Validation failed";
        setErrorMessage(msg);
        setFailedBatchId(res.data?.batchId || null);
        setStep('failed');
        return;
      }

      setValResult(res.data);
      setStep('review');
    } catch (e: any) {
      setErrorMessage(e.message || 'Validation error');
      setStep('failed');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleExecuteImport = async () => {
    if (!valResult || !valResult.batchId) return;
    setIsProcessing(true);
    setStep('importing');
    setErrorMessage(null);
    setImportProgress({
      processed: 0,
      total: valResult.uniquePackageCount,
      stage: 'Committing transactional package batches to Firestore...'
    });

    // Simulate animated incremental batch commits for UI responsiveness
    const totalPkgs = valResult.uniquePackageCount;
    const progressInterval = setInterval(() => {
      setImportProgress(prev => {
        const next = Math.min(totalPkgs, prev.processed + Math.ceil(totalPkgs / 5));
        return {
          ...prev,
          processed: next,
          stage: next >= totalPkgs ? 'Finalizing import run audit logs...' : `Writing packages (${next}/${totalPkgs})...`
        };
      });
    }, 400);

    try {
      const res = await api.commitCsvImport({
        batchId: valResult.batchId
      });

      clearInterval(progressInterval);
      setImportProgress({
        processed: totalPkgs,
        total: totalPkgs,
        stage: 'All packages committed.'
      });

      if (!res.success || !res.data || res.data.status !== 'completed') {
        const msg = res.error?.message || "Commit failed";
        setErrorMessage(msg);
        setFailedBatchId(valResult.batchId);
        setStep('failed');
        return;
      }

      setStep('complete');
      onImportSuccess();
    } catch (e: any) {
      clearInterval(progressInterval);
      setErrorMessage(e.message || 'Import execution failed');
      setFailedBatchId(valResult.batchId);
      setStep('failed');
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex justify-end transition-opacity">
      <div className="w-full max-w-xl bg-white h-full shadow-2xl flex flex-col overflow-hidden animate-in slide-in-from-right duration-200">
        
        {/* Header */}
        <div className="h-16 px-6 bg-[#F5F4F2] border-b border-[#DDD9D4] flex items-center justify-between shrink-0">
          <div className="flex items-center space-x-2">
            <FileSpreadsheet className="w-5 h-5 text-[#5A2628]" />
            <h3 className="font-bold text-sm text-[#1F1F1D]">Shopify / Courier CSV Dispatch Import</h3>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg text-[#6D6964] hover:text-[#1F1F1D] hover:bg-stone-200">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Body */}
        <div className="flex-1 overflow-y-auto p-6 text-xs text-[#1F1F1D] space-y-6">
          
          {/* STEP 1: UPLOAD */}
          {step === 'upload' && (
            <div className="space-y-4">
              {/* Direct Shopify Sync Banner */}
              <div className="p-4 bg-[#95BF47]/10 border border-[#95BF47]/40 rounded-lg flex items-center justify-between gap-3">
                <div className="flex items-center space-x-3">
                  <div className="w-9 h-9 rounded-lg bg-[#95BF47]/20 flex items-center justify-center text-[#43682B] shrink-0">
                    <ShoppingBag className="w-5 h-5" />
                  </div>
                  <div>
                    <h4 className="text-xs font-bold text-[#1F1F1D]">Direct Shopify Store Connection</h4>
                    <p className="text-[11px] text-[#6D6964]">Fetch and ingest live unfulfilled orders directly via Shopify Admin API</p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setShowShopifyModal(true)}
                  className="px-3 py-1.5 bg-[#43682B] hover:bg-[#345122] text-white text-xs font-bold rounded-md shadow-2xs flex items-center space-x-1.5 shrink-0 transition cursor-pointer"
                >
                  <span>Connect API</span>
                  <ArrowRight className="w-3 h-3" />
                </button>
              </div>

              <div className="flex items-center space-x-2 my-2">
                <div className="h-px bg-[#DDD9D4] flex-1"></div>
                <span className="text-[10px] uppercase font-bold text-[#6D6964]">OR Upload Export CSV</span>
                <div className="h-px bg-[#DDD9D4] flex-1"></div>
              </div>

              <div className="p-6 border-2 border-dashed border-[#DDD9D4] rounded-lg text-center space-y-3 bg-[#F5F4F2]">
                <Upload className="w-8 h-8 text-[#5A2628] mx-auto" />
                <div>
                  <p className="font-bold text-sm">Select CSV File to Import</p>
                  <p className="text-[#6D6964] text-[11px] mt-1">Supports Shopify & OMS dispatch export CSV files</p>
                </div>
                <label className="inline-block px-4 py-2 bg-[#5A2628] text-white rounded-md font-bold cursor-pointer hover:bg-[#471D1F] transition">
                  Browse File...
                  <input type="file" accept=".csv" onChange={handleFileUpload} className="hidden" />
                </label>
              </div>
            </div>
          )}

          {/* STEP 2: VALIDATING */}
          {step === 'validating' && (
            <div className="p-8 text-center space-y-3 bg-[#F5F4F2] border border-[#DDD9D4] rounded-lg">
              <div className="inline-block w-8 h-8 border-4 border-[#5A2628] border-t-transparent rounded-full animate-spin"></div>
              <p className="font-bold text-sm">Validating & Staging CSV Import...</p>
              <p className="text-xs text-[#6D6964]">Checking status precedence, delivery channels, and parent order COD balances...</p>
            </div>
          )}

          {/* STEP 3: REVIEW */}
          {step === 'review' && valResult && (
            <div className="space-y-4">
              <div className="p-3 bg-stone-100 rounded border border-[#DDD9D4] flex justify-between items-center">
                <span className="font-bold text-xs">{fileName}</span>
                <span className="text-[11px] text-[#6D6964]">{valResult.sourceRowCount} source rows ({valResult.uniquePackageCount} packages)</span>
              </div>

              {/* Status breakdown */}
              <div className="grid grid-cols-4 gap-2 text-center">
                <div className="p-2.5 bg-emerald-50 border border-emerald-200 rounded-lg">
                  <span className="text-base font-black text-emerald-800">{valResult.statusCounts.delivered}</span>
                  <span className="block text-[9px] font-bold text-emerald-700 uppercase mt-0.5">Delivered</span>
                </div>
                <div className="p-2.5 bg-blue-50 border border-blue-200 rounded-lg">
                  <span className="text-base font-black text-blue-800">{valResult.statusCounts.dispatched}</span>
                  <span className="block text-[9px] font-bold text-blue-700 uppercase mt-0.5">Dispatched</span>
                </div>
                <div className="p-2.5 bg-amber-50 border border-amber-200 rounded-lg">
                  <span className="text-base font-black text-amber-800">{valResult.statusCounts.returned}</span>
                  <span className="block text-[9px] font-bold text-amber-700 uppercase mt-0.5">Returned</span>
                </div>
                <div className="p-2.5 bg-purple-50 border border-purple-200 rounded-lg">
                  <span className="text-base font-black text-purple-800">{valResult.statusCounts.awaiting_return}</span>
                  <span className="block text-[9px] font-bold text-purple-700 uppercase mt-0.5">Awaiting Ret.</span>
                </div>
              </div>

              {/* Delivery Channels */}
              <div className="p-3 bg-[#F5F4F2] rounded-lg border border-[#DDD9D4] space-y-1 text-[11px]">
                <p className="font-bold text-xs mb-1.5">Delivery Channel Classification:</p>
                <div className="grid grid-cols-2 gap-1 text-[#6D6964]">
                  <div>External Courier: <strong className="text-[#1F1F1D]">{valResult.deliveryChannelCounts.external_courier}</strong></div>
                  <div>Internal Rider: <strong className="text-[#1F1F1D]">{valResult.deliveryChannelCounts.internal_rider}</strong></div>
                  <div>Outlet Delivery: <strong className="text-[#1F1F1D]">{valResult.deliveryChannelCounts.outlet_delivery}</strong></div>
                  <div>Internal / Manual: <strong className="text-[#1F1F1D]">{valResult.deliveryChannelCounts.internal_manual}</strong></div>
                </div>
              </div>

              {/* Active COD Reviews */}
              {valResult.activeCodReviews.length > 0 && (
                <div className="p-3 bg-amber-50 border border-amber-300 rounded-lg space-y-1">
                  <div className="flex items-center space-x-1.5 text-amber-900 font-bold text-xs">
                    <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
                    <span>{valResult.activeCodReviews.length} Multi-Package Parent Orders Require COD Review</span>
                  </div>
                  <p className="text-[11px] text-amber-800">
                    Active COD review queue generated for split parent orders with remaining balances.
                  </p>
                </div>
              )}

              <button
                onClick={handleExecuteImport}
                disabled={isProcessing || valResult.uniquePackageCount === 0}
                className="w-full py-2.5 bg-[#5A2628] text-white font-bold rounded-md hover:bg-[#471D1F] transition shadow-xs cursor-pointer"
              >
                Execute Import ({valResult.uniquePackageCount} Packages)
              </button>
            </div>
          )}

          {/* STEP 4: IMPORTING */}
          {step === 'importing' && (
            <div className="p-8 text-center space-y-4 bg-[#F5F4F2] border border-[#DDD9D4] rounded-lg">
              <div className="inline-block w-8 h-8 border-4 border-[#5A2628] border-t-transparent rounded-full animate-spin"></div>
              <div>
                <p className="font-bold text-sm text-[#1F1F1D]">Committing Import Records to Firestore...</p>
                <p className="text-xs text-[#6D6964] mt-1">{importProgress.stage || 'Writing packages in transactional chunks...'}</p>
              </div>

              {/* Progress bar */}
              <div className="space-y-1 max-w-md mx-auto pt-2">
                <div className="flex justify-between text-[11px] font-mono text-[#6D6964]">
                  <span>Progress: {importProgress.processed} / {importProgress.total}</span>
                  <span>{importProgress.total > 0 ? Math.round((importProgress.processed / importProgress.total) * 100) : 0}%</span>
                </div>
                <div className="w-full h-2 bg-[#DDD9D4] rounded-full overflow-hidden">
                  <div 
                    className="h-full bg-[#5A2628] transition-all duration-300 rounded-full"
                    style={{ width: `${importProgress.total > 0 ? Math.round((importProgress.processed / importProgress.total) * 100) : 0}%` }}
                  />
                </div>
              </div>
            </div>
          )}

          {/* STEP 5: COMPLETE */}
          {step === 'complete' && (
            <div className="p-8 text-center space-y-3 bg-[#1F7A52]/5 border border-[#1F7A52]/30 rounded-lg">
              <CheckCircle2 className="w-12 h-12 text-[#1F7A52] mx-auto" />
              <h4 className="text-base font-bold text-[#1F7A52]">CSV Import Completed Successfully</h4>
              <p className="text-xs text-[#6D6964]">Packages have been committed to production orders database with importState = committed.</p>
              <button
                onClick={onClose}
                className="mt-4 px-6 py-2 bg-[#5A2628] text-white font-bold rounded-md hover:bg-[#471D1F]"
              >
                Return to Orders Table
              </button>
            </div>
          )}

          {/* STEP 6: FAILED */}
          {step === 'failed' && (
            <div className="p-6 text-center space-y-3 bg-red-50 border border-red-200 rounded-lg">
              <AlertTriangle className="w-10 h-10 text-red-600 mx-auto" />
              <h4 className="text-sm font-bold text-red-900">Import Operation Failed</h4>
              <p className="text-xs text-red-700 font-mono bg-white p-2.5 rounded border border-red-200 text-left overflow-x-auto">
                {errorMessage || "An unexpected error occurred during import validation/commit."}
              </p>
              {failedBatchId && (
                <p className="text-[11px] text-[#6D6964]">Batch ID: <code className="font-mono bg-stone-200 px-1 rounded">{failedBatchId}</code></p>
              )}
              <div className="pt-2 flex justify-center gap-3">
                <button
                  onClick={() => setStep('upload')}
                  className="px-4 py-2 bg-[#5A2628] text-white font-bold rounded-md hover:bg-[#471D1F]"
                >
                  Try Another File
                </button>
              </div>
            </div>
          )}

        </div>

        {/* Drawer Footer */}
        <div className="p-4 bg-[#F5F4F2] border-t border-[#DDD9D4] flex justify-end shrink-0">
          <button onClick={onClose} className="px-4 py-1.5 border border-[#DDD9D4] text-[#1F1F1D] rounded-md font-semibold">
            Cancel
          </button>
        </div>

      </div>

      {/* Direct Shopify Sync Modal */}
      <ShopifySyncModal
        isOpen={showShopifyModal}
        onClose={() => setShowShopifyModal(false)}
        onSyncSuccess={() => {
          setShowShopifyModal(false);
          onImportSuccess();
        }}
      />
    </div>
  );
}

