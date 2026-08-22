import React, { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, RefreshCw, ShieldCheck } from "lucide-react";
import { api } from "../../services/api";
import { ShopifySyncModal } from "../dispatch/ShopifySyncModal";

export function ShopifyIntegrationWorkspace() {
  const [health, setHealth] = useState<any>(null);
  const [subscriptions, setSubscriptions] = useState<any>(null);
  const [deadLetters, setDeadLetters] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [showRecovery, setShowRecovery] = useState(false);

  const load = async () => {
    setLoading(true);
    const [healthRes, subscriptionsRes, deadLetterRes] = await Promise.allSettled([
      api.getShopifyHealth(), api.getShopifyWebhookSubscriptions(), api.getShopifyDeadLetters()
    ]);
    if (healthRes.status === "fulfilled") setHealth(healthRes.value.data || null);
    if (subscriptionsRes.status === "fulfilled") setSubscriptions(subscriptionsRes.value.data || null);
    if (deadLetterRes.status === "fulfilled") setDeadLetters(deadLetterRes.value.data || []);
    setLoading(false);
  };

  useEffect(() => { load().catch((error) => { setMessage(error.message); setLoading(false); }); }, []);

  const repair = async () => {
    setMessage(null);
    const result = await api.repairShopifyWebhookSubscriptions();
    setMessage(result.success ? "Webhook subscription repair requested." : result.error?.message || "Repair failed.");
    await load();
  };

  const replay = async (eventId: string) => {
    const result = await api.replayShopifyWebhook(eventId);
    setMessage(result.success ? `Replay queued for ${eventId}.` : result.error?.message || "Replay failed.");
    await load();
  };

  if (loading) return <div className="p-8 text-sm font-semibold text-[#6D6964]">Loading Shopify integration health...</div>;
  return (
    <div className="p-6 space-y-5">
      <div className="flex items-start justify-between">
        <div><p className="text-xs font-bold uppercase tracking-[0.16em] text-[#6D6964]">Admin / Integrations / Shopify</p><h2 className="mt-1 text-2xl font-black">Continuous Commerce Connection</h2><p className="mt-1 text-sm text-[#6D6964]">Daily order flow is webhook-driven. Recovery tools are restricted to administrators.</p></div>
        <button onClick={() => load()} className="rounded-lg border border-[#DDD9D4] p-2"><RefreshCw className="h-4 w-4" /></button>
      </div>
      {message && <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">{message}</div>}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <HealthCard label="Connection" value={health?.connected ? "CONNECTED" : "NOT CONFIGURED"} ok={health?.connected} />
        <HealthCard label="API Version" value={health?.apiVersion || "N/A"} ok={Boolean(health?.apiVersion)} />
        <HealthCard label="Last Webhook" value={health?.lastSuccessfulWebhookAt ? new Date(health.lastSuccessfulWebhookAt).toLocaleString() : "NONE"} ok={Boolean(health?.lastSuccessfulWebhookAt)} />
        <HealthCard label="Dead Letters" value={String(health?.eventCounts?.deadLetter || deadLetters.length)} ok={!health?.eventCounts?.deadLetter} />
      </div>
      <section className="rounded-xl border border-[#DDD9D4] bg-white p-4"><div className="flex items-center justify-between"><div><h3 className="font-bold">Webhook Subscription Health</h3><p className="text-xs text-[#6D6964]">Required topics are checked against Shopify GraphQL.</p></div><div className="flex gap-2"><button onClick={() => setShowRecovery(true)} className="rounded-lg border border-[#DDD9D4] px-3 py-2 text-xs font-bold">RECOVERY SYNC</button><button onClick={repair} className="rounded-lg bg-[#5A2628] px-3 py-2 text-xs font-bold text-white">REPAIR SUBSCRIPTIONS</button></div></div><div className="mt-3 flex flex-wrap gap-2">{(subscriptions?.expectedTopics || []).map((topic: string) => <span key={topic} className={`rounded-full px-2 py-1 text-[10px] font-bold ${subscriptions?.missingTopics?.includes(topic) ? "bg-red-100 text-red-800" : "bg-emerald-100 text-emerald-800"}`}>{topic}</span>)}</div></section>
      <section className="rounded-xl border border-[#DDD9D4] bg-white p-4"><div className="flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-[#5A2628]" /><h3 className="font-bold">Recovery / Dead Letter Queue</h3></div><div className="mt-3 space-y-2">{deadLetters.length === 0 ? <p className="text-sm text-[#6D6964]">No dead-letter events.</p> : deadLetters.map((event) => <div key={event.eventId} className="flex items-center justify-between rounded-lg border border-red-100 bg-red-50 p-3"><div><p className="text-xs font-bold">{event.topic} / {event.shopifyOrderId}</p><p className="text-xs text-red-800">{event.errorMessage || event.error || "Unknown error"} · attempts {event.retryCount || 0}</p></div><button onClick={() => replay(event.eventId)} className="rounded-lg border border-red-200 px-3 py-1 text-xs font-bold text-red-800">RETRY</button></div>)}</div></section>
      <ShopifySyncModal isOpen={showRecovery} onClose={() => setShowRecovery(false)} onSyncSuccess={() => { setShowRecovery(false); load(); }} />
    </div>
  );
}

function HealthCard({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return <div className="rounded-xl border border-[#DDD9D4] bg-white p-3"><p className="text-[10px] font-bold uppercase tracking-wide text-[#6D6964]">{label}</p><div className="mt-2 flex items-center gap-1 text-xs font-black">{ok ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" /> : <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />}{value}</div></div>;
}
