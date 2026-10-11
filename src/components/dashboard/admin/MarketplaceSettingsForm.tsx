"use client";

import { useEffect, useState } from "react";
import { call, inputCls, btnPrimary, card } from "@/components/dashboard/seller/api";

export default function MarketplaceSettingsForm() {
  const [f, setF] = useState({ defaultCommissionPercent: "10", pendingHoldHours: "48", minAutoMarkupPercent: "20", sellerAutoEnabled: true });
  const [loaded, setLoaded] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    call<{ defaultCommissionPercent: number; pendingHoldHours: number; minAutoMarkupPercent: number; sellerAutoEnabled: boolean }>("/api/admin/settings/marketplace")
      .then((d) => setF({ defaultCommissionPercent: String(d.defaultCommissionPercent), pendingHoldHours: String(d.pendingHoldHours), minAutoMarkupPercent: String(d.minAutoMarkupPercent), sellerAutoEnabled: d.sellerAutoEnabled }))
      .catch((e) => setMsg(e.message)).finally(() => setLoaded(true));
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setMsg(null);
    try {
      await call("/api/admin/settings/marketplace", "PUT", {
        defaultCommissionPercent: Number(f.defaultCommissionPercent), pendingHoldHours: Number(f.pendingHoldHours),
        minAutoMarkupPercent: Number(f.minAutoMarkupPercent), sellerAutoEnabled: f.sellerAutoEnabled,
      });
      setMsg("Tersimpan. Berlaku untuk penjualan berikutnya.");
    } catch (err) { setMsg((err as Error).message); } finally { setBusy(false); }
  }

  if (!loaded) return <div className={`${card} text-[13px] text-ink-faint`}>Memuat...</div>;
  const field = (label: string, hint: string, key: "defaultCommissionPercent" | "pendingHoldHours" | "minAutoMarkupPercent") => (
    <label className="block">
      <span className="text-[12.5px] font-bold">{label}</span>
      <input type="number" min={0} step="any" value={f[key]} onChange={(e) => setF({ ...f, [key]: e.target.value })} className={`${inputCls} mt-1 max-w-[180px]`} />
      <span className="mt-1 block text-[11.5px] text-ink-faint">{hint}</span>
    </label>
  );
  return (
    <form onSubmit={save} className={`${card} space-y-4`}>
      {field("Komisi platform default (%)", "Potongan dari harga jual tiap penjualan seller. Bisa dioverride per seller di halaman Seller.", "defaultCommissionPercent")}
      {field("Masa tahan saldo (jam)", "Hasil penjualan baru bisa ditarik setelah waktu ini, dan pembeli bisa komplain selama masa ini.", "pendingHoldHours")}
      {field("Margin minimum listing Auto (%)", "Harga jual seller untuk item Auto wajib ≥ harga modal supplier × (1 + persen ini). Melindungi platform dari rugi.", "minAutoMarkupPercent")}
      <label className="flex items-start gap-2">
        <input type="checkbox" checked={f.sellerAutoEnabled} onChange={(e) => setF({ ...f, sellerAutoEnabled: e.target.checked })} className="mt-1" />
        <span><span className="text-[12.5px] font-bold">Izinkan seller membuat listing Auto</span>
          <span className="block text-[11.5px] text-ink-faint">Listing Auto memakai saldo supplier milik platform tiap ada penjualan. Matikan kalau mau seller hanya jual stok sendiri.</span></span>
      </label>
      <div className="flex items-center gap-3">
        <button disabled={busy} className={btnPrimary}>{busy ? "Menyimpan..." : "Simpan"}</button>
        {msg && <span className="text-[12px] text-ink-faint">{msg}</span>}
      </div>
    </form>
  );
}
