"use client";

import { useCallback, useEffect, useState } from "react";
import { call, rp, fmtDate, inputCls, card } from "@/components/dashboard/seller/api";

type Wd = {
  id: string; amount: number; status: "pending" | "approved" | "paid" | "rejected";
  bank_snapshot: { bank_name?: string; bank_account_number?: string; bank_account_holder?: string };
  admin_note: string | null; requested_at: string;
  sellers: { store_name: string; users: { email: string } | { email: string }[] | null } | { store_name: string; users: unknown }[] | null;
};
const BADGE: Record<Wd["status"], string> = {
  pending: "bg-amber-500/15 text-amber-500", approved: "bg-sky-500/15 text-sky-500",
  paid: "bg-emerald-500/15 text-emerald-500", rejected: "bg-red-500/15 text-danger",
};
const LABEL: Record<Wd["status"], string> = { pending: "Menunggu", approved: "Disetujui", paid: "Sudah dibayar", rejected: "Ditolak" };

function storeInfo(w: Wd): { name: string; email: string } {
  const s = Array.isArray(w.sellers) ? w.sellers[0] : w.sellers;
  const u = s ? (Array.isArray((s as { users: unknown }).users) ? ((s as { users: { email: string }[] }).users[0]) : ((s as { users: { email: string } | null }).users)) : null;
  return { name: (s as { store_name?: string } | null)?.store_name ?? "-", email: u?.email ?? "-" };
}

export default function AdminWithdrawals() {
  const [rows, setRows] = useState<Wd[] | null>(null);
  const [filter, setFilter] = useState<"open" | "all">("open");
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setRows((await call<{ withdrawals: Wd[] }>("/api/admin/withdrawals")).withdrawals); } catch (e) { setError((e as Error).message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function act(id: string, action: "approve" | "pay" | "reject", note: string) {
    setError(null);
    try { await call(`/api/admin/withdrawals/${id}`, "PATCH", { action, note }); await load(); } catch (e) { setError((e as Error).message); await load(); }
  }

  if (!rows) return <div className={`${card} text-[13px] text-ink-faint`}>{error ?? "Memuat..."}</div>;
  const shown = filter === "open" ? rows.filter((r) => r.status === "pending" || r.status === "approved") : rows;

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        {(["open", "all"] as const).map((f) => (
          <button key={f} onClick={() => setFilter(f)} className={`rounded-full px-3 py-1.5 text-[12px] font-bold ${filter === f ? "bg-primary text-white" : "bg-surface-2 text-ink-faint"}`}>
            {f === "open" ? "Perlu diproses" : "Semua"}
          </button>
        ))}
      </div>
      {error && <p className="text-[12px] text-danger">{error}</p>}
      {shown.length === 0 && <div className={`${card} text-center text-[13px] text-ink-faint`}>Tidak ada permintaan.</div>}
      {shown.map((w) => <WdRow key={w.id} w={w} onAct={act} />)}
    </div>
  );
}

function WdRow({ w, onAct }: { w: Wd; onAct: (id: string, a: "approve" | "pay" | "reject", note: string) => void }) {
  const [note, setNote] = useState("");
  const info = storeInfo(w);
  const open = w.status === "pending" || w.status === "approved";
  return (
    <div className={`${card} space-y-2`}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-[16px] font-extrabold">{rp(w.amount)}</p>
          <p className="text-[12px] text-ink-faint">{info.name} · {info.email} · {fmtDate(w.requested_at)}</p>
        </div>
        <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${BADGE[w.status]}`}>{LABEL[w.status]}</span>
      </div>
      <p className="rounded-lg bg-surface-2 px-3 py-2 font-mono text-[12.5px]">
        {w.bank_snapshot.bank_name ?? "-"} · {w.bank_snapshot.bank_account_number ?? "-"} · a.n. {w.bank_snapshot.bank_account_holder ?? "-"}
      </p>
      {w.admin_note && <p className="text-[12px] text-ink-faint">Catatan: {w.admin_note}</p>}
      {open && (
        <div className="flex flex-wrap items-center gap-2">
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Catatan (opsional, mis. no. referensi transfer)" className={`${inputCls} min-w-[200px] flex-1`} />
          {w.status === "pending" && <button onClick={() => onAct(w.id, "approve", note)} className="rounded-lg bg-sky-500 px-3 py-2 text-[12px] font-bold text-white">Setujui</button>}
          <button onClick={() => onAct(w.id, "pay", note)} className="rounded-lg bg-emerald-500 px-3 py-2 text-[12px] font-bold text-white">Tandai Sudah Dibayar</button>
          <button onClick={() => confirm("Tolak permintaan ini? Saldo kembali tersedia untuk seller.") && onAct(w.id, "reject", note)} className="rounded-lg bg-red-500 px-3 py-2 text-[12px] font-bold text-white">Tolak</button>
        </div>
      )}
    </div>
  );
}
