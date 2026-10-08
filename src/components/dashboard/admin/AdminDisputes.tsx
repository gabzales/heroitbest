"use client";

import { useCallback, useEffect, useState } from "react";
import { call, rp, fmtDate, inputCls, card } from "@/components/dashboard/seller/api";

type One<T> = T | T[] | null;
type D = {
  id: string; reason: string; status: "open" | "resolved_refund" | "resolved_release" | "dismissed";
  admin_note: string | null; created_at: string;
  reseller_keys: One<{ product_name: string; duration_label: string; price: number; key_string: string; provider_cost: number | null }>;
  sellers: One<{ store_name: string }>; users: One<{ email: string }>;
};
const first = <T,>(v: One<T>): T | null => (Array.isArray(v) ? (v[0] ?? null) : v);
const LABEL: Record<D["status"], string> = { open: "Terbuka", resolved_refund: "Direfund ke pembeli", resolved_release: "Dilepas ke seller", dismissed: "Komplain ditolak" };

export default function AdminDisputes() {
  const [rows, setRows] = useState<D[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setRows((await call<{ disputes: D[] }>("/api/admin/disputes")).disputes); } catch (e) { setError((e as Error).message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function resolve(id: string, resolution: string, note: string) {
    setError(null);
    try { await call(`/api/admin/disputes/${id}`, "POST", { resolution, note }); await load(); } catch (e) { setError((e as Error).message); await load(); }
  }

  if (!rows) return <div className={`${card} text-[13px] text-ink-faint`}>{error ?? "Memuat..."}</div>;
  if (rows.length === 0) return <div className={`${card} text-center text-[13px] text-ink-faint`}>Belum ada komplain.</div>;
  return (
    <div className="space-y-3">
      {error && <p className="text-[12px] text-danger">{error}</p>}
      {rows.map((d) => <DisputeRow key={d.id} d={d} onResolve={resolve} />)}
    </div>
  );
}

function DisputeRow({ d, onResolve }: { d: D; onResolve: (id: string, r: string, note: string) => void }) {
  const [note, setNote] = useState("");
  const key = first(d.reseller_keys);
  return (
    <div className={`${card} space-y-2`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-[13.5px] font-bold">{key?.product_name} · {key?.duration_label} · {rp(key?.price ?? 0)}</p>
          <p className="text-[11.5px] text-ink-faint">
            Toko {first(d.sellers)?.store_name ?? "-"} · pembeli {first(d.users)?.email ?? "-"} · {fmtDate(d.created_at)}
          </p>
        </div>
        <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-bold ${d.status === "open" ? "bg-amber-500/15 text-amber-500" : "bg-surface-2 text-ink-faint"}`}>{LABEL[d.status]}</span>
      </div>
      <p className="rounded-lg bg-surface-2 px-3 py-2 text-[12.5px]"><b>Alasan pembeli:</b> {d.reason}</p>
      <p className="font-mono text-[12px] text-ink-faint">Key: {key?.key_string}</p>
      {key?.provider_cost != null && <p className="text-[11.5px] text-ink-faint">Listing Auto — ongkos supplier {rp(key.provider_cost)} (tidak kembali kalau di-refund).</p>}
      {d.admin_note && <p className="text-[12px] text-ink-faint">Catatan admin: {d.admin_note}</p>}
      {d.status === "open" && (
        <div className="flex flex-wrap items-center gap-2">
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Catatan keputusan (opsional)" className={`${inputCls} min-w-[200px] flex-1`} />
          <button onClick={() => confirm("Refund penuh ke saldo pembeli? Pendapatan seller dari key ini dihapus.") && onResolve(d.id, "resolved_refund", note)} className="rounded-lg bg-red-500 px-3 py-2 text-[12px] font-bold text-white">Refund pembeli</button>
          <button onClick={() => onResolve(d.id, "resolved_release", note)} className="rounded-lg bg-emerald-500 px-3 py-2 text-[12px] font-bold text-white">Lepas ke seller</button>
          <button onClick={() => onResolve(d.id, "dismissed", note)} className="rounded-lg bg-surface-2 px-3 py-2 text-[12px] font-bold text-ink-dim">Tolak komplain</button>
        </div>
      )}
    </div>
  );
}
