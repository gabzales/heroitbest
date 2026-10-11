"use client";

import { useCallback, useEffect, useState } from "react";
import { call, rp, inputCls, card } from "@/components/dashboard/seller/api";

type Row = {
  id: string; storeName: string; storeSlug: string; status: "active" | "suspended";
  commissionPercent: number | null; email: string; pending: number; available: number; paidOut: number;
};

export default function AdminSellers() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setRows((await call<{ sellers: Row[] }>("/api/admin/sellers")).sellers); } catch (e) { setError((e as Error).message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function patch(id: string, body: unknown) {
    setError(null);
    try { await call(`/api/admin/sellers/${id}`, "PATCH", body); await load(); } catch (e) { setError((e as Error).message); }
  }

  if (!rows) return <div className={`${card} text-[13px] text-ink-faint`}>{error ?? "Memuat..."}</div>;
  if (rows.length === 0) return <div className={`${card} text-center text-[13px] text-ink-faint`}>Belum ada seller.</div>;

  return (
    <div className="space-y-3">
      {error && <p className="text-[12px] text-danger">{error}</p>}
      {rows.map((s) => <SellerRow key={s.id} s={s} onPatch={patch} />)}
    </div>
  );
}

function SellerRow({ s, onPatch }: { s: Row; onPatch: (id: string, body: unknown) => void }) {
  const [c, setC] = useState(s.commissionPercent === null ? "" : String(s.commissionPercent));
  return (
    <div className={`${card} space-y-3`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-[14px] font-extrabold">{s.storeName}</p>
          <p className="truncate text-[11.5px] text-ink-faint">{s.email} · /{s.storeSlug}</p>
        </div>
        <button
          onClick={() => onPatch(s.id, { status: s.status === "active" ? "suspended" : "active" })}
          className={`rounded-full px-3 py-1.5 text-[11.5px] font-bold ${s.status === "active" ? "bg-emerald-500/15 text-emerald-500" : "bg-red-500/15 text-danger"}`}
        >
          {s.status === "active" ? "Aktif — klik untuk suspend" : "Disuspend — klik untuk aktifkan"}
        </button>
      </div>
      <p className="text-[12px] text-ink-faint">
        Ditahan {rp(s.pending)} · Bisa ditarik {rp(s.available)} · Sudah dicairkan {rp(s.paidOut)}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12px] text-ink-faint">Komisi khusus (%)</span>
        <input type="number" min={0} max={100} step="any" value={c} onChange={(e) => setC(e.target.value)} placeholder="default" className={`${inputCls} max-w-[110px]`} />
        <button onClick={() => onPatch(s.id, { commissionPercent: c === "" ? null : Number(c) })} className="rounded-lg bg-primary px-3 py-2 text-[12px] font-bold text-white">Simpan</button>
        <span className="text-[11px] text-ink-faint">kosong = pakai komisi default</span>
      </div>
    </div>
  );
}
