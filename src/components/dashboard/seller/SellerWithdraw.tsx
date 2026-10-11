"use client";

import { useCallback, useEffect, useState } from "react";
import { call, rp, fmtDate, inputCls, btnPrimary, card } from "./api";

type Wd = { id: string; amount: number; status: "pending" | "approved" | "paid" | "rejected"; admin_note: string | null; requested_at: string };
const STATUS: Record<Wd["status"], { t: string; c: string }> = {
  pending: { t: "Menunggu", c: "bg-amber-500/15 text-amber-500" },
  approved: { t: "Disetujui", c: "bg-sky-500/15 text-sky-500" },
  paid: { t: "Sudah dibayar", c: "bg-emerald-500/15 text-emerald-500" },
  rejected: { t: "Ditolak", c: "bg-red-500/15 text-danger" },
};

export default function SellerWithdraw() {
  const [available, setAvailable] = useState<number | null>(null);
  const [bank, setBank] = useState<string>("");
  const [list, setList] = useState<Wd[] | null>(null);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [me, wd] = await Promise.all([
      call<{ seller: { bankName: string | null; bankAccountNumber: string | null; bankAccountHolder: string | null } | null; balance?: { available: number } }>("/api/seller/me"),
      call<{ withdrawals: Wd[] }>("/api/seller/withdrawals"),
    ]);
    setAvailable(me.balance?.available ?? 0);
    setBank(me.seller?.bankAccountNumber ? `${me.seller.bankName ?? ""} ${me.seller.bankAccountNumber} a.n. ${me.seller.bankAccountHolder ?? ""}` : "");
    setList(wd.withdrawals);
  }, []);
  useEffect(() => {
    load().catch((e) => setMsg(e.message));
  }, [load]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await call("/api/seller/withdrawals", "POST", { amount: Number(amount) });
      setAmount("");
      setMsg("Permintaan penarikan terkirim. Admin akan memproses dan mentransfer manual.");
      await load();
    } catch (err) {
      setMsg((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <form onSubmit={submit} className={`${card} space-y-3`}>
        <p className="text-[12px] text-ink-faint">Saldo yang bisa ditarik</p>
        <p className="text-[22px] font-extrabold text-emerald-500">{available === null ? "..." : rp(available)}</p>
        <p className="text-[11.5px] text-ink-faint">{bank ? `Tujuan: ${bank}` : "Info rekening belum diisi — isi dulu di halaman Toko Saya."}</p>
        <div className="flex gap-2">
          <input required type="number" min={1} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Jumlah (Rp)" className={`${inputCls} max-w-[220px]`} />
          {available !== null && available > 0 && (
            <button type="button" onClick={() => setAmount(String(available))} className="text-[12px] font-semibold text-primary hover:underline">Tarik semua</button>
          )}
          <button disabled={busy} className={btnPrimary}>{busy ? "Mengirim..." : "Ajukan Penarikan"}</button>
        </div>
        {msg && <p className="text-[12px] text-ink-faint">{msg}</p>}
      </form>

      <div className="divide-y divide-border rounded-xl2 border border-border bg-surface">
        {!list ? (
          <p className="p-4 text-[13px] text-ink-faint">Memuat...</p>
        ) : list.length === 0 ? (
          <p className="p-4 text-center text-[13px] text-ink-faint">Belum ada penarikan.</p>
        ) : (
          list.map((w) => (
            <div key={w.id} className="flex items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-bold">{rp(w.amount)}</p>
                <p className="text-[11.5px] text-ink-faint">{fmtDate(w.requested_at)}{w.admin_note ? ` · ${w.admin_note}` : ""}</p>
              </div>
              <span className={`rounded-full px-2 py-0.5 text-[10.5px] font-bold ${STATUS[w.status].c}`}>{STATUS[w.status].t}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
