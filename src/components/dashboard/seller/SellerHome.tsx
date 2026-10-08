"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Package, Receipt, Banknote } from "lucide-react";
import { call, rp, inputCls, btnPrimary, card } from "./api";

type Me = {
  seller: null | {
    storeName: string;
    storeSlug: string;
    bankName: string | null;
    bankAccountNumber: string | null;
    bankAccountHolder: string | null;
    status: "active" | "suspended";
    commissionPercent: number;
  };
  balance?: { pending: number; available: number; paidOut: number };
  holdHours?: number;
};

export default function SellerHome() {
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setMe(await call<Me>("/api/seller/me"));
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  if (error) return <p className="text-[13px] text-danger">{error}</p>;
  if (!me) return <div className={`${card} text-[13px] text-ink-faint`}>Memuat...</div>;
  if (!me.seller) return <RegisterForm onDone={load} />;

  const s = me.seller;
  const b = me.balance ?? { pending: 0, available: 0, paidOut: 0 };
  return (
    <div className="space-y-4">
      <div className={card}>
        <div className="flex items-center justify-between gap-2">
          <div>
            <p className="text-[15px] font-extrabold">{s.storeName}</p>
            <p className="text-[11.5px] text-ink-faint">
              Komisi platform {s.commissionPercent}% · saldo ditahan {me.holdHours ?? 48} jam setelah penjualan
            </p>
          </div>
          <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${s.status === "active" ? "bg-emerald-500/15 text-emerald-500" : "bg-red-500/15 text-danger"}`}>
            {s.status === "active" ? "Aktif" : "Nonaktif"}
          </span>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Bisa ditarik" value={rp(b.available)} tone="good" />
        <Stat label="Masih ditahan" value={rp(b.pending)} />
        <Stat label="Sudah dicairkan" value={rp(b.paidOut)} />
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <NavCard href="/dashboard/seller/products" icon={<Package size={16} />} title="Produk & Stok" desc="Buat listing, tambah key" />
        <NavCard href="/dashboard/seller/sales" icon={<Receipt size={16} />} title="Penjualan" desc="Riwayat & status saldo" />
        <NavCard href="/dashboard/seller/withdraw" icon={<Banknote size={16} />} title="Tarik Saldo" desc="Ajukan penarikan" />
      </div>

      <BankForm seller={s} onSaved={load} />
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "good" }) {
  return (
    <div className={card}>
      <p className="text-[11.5px] font-semibold text-ink-faint">{label}</p>
      <p className={`mt-1 text-[18px] font-extrabold ${tone === "good" ? "text-emerald-500" : ""}`}>{value}</p>
    </div>
  );
}

function NavCard({ href, icon, title, desc }: { href: string; icon: React.ReactNode; title: string; desc: string }) {
  return (
    <Link href={href} className={`${card} flex items-center gap-3 transition-colors hover:bg-surface-2`}>
      <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary-dim text-primary">{icon}</span>
      <span>
        <span className="block text-[13.5px] font-bold">{title}</span>
        <span className="block text-[11.5px] text-ink-faint">{desc}</span>
      </span>
    </Link>
  );
}

function RegisterForm({ onDone }: { onDone: () => void }) {
  const [f, setF] = useState({ storeName: "", bankName: "", bankAccountNumber: "", bankAccountHolder: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await call("/api/seller/register", "POST", f);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  return (
    <form onSubmit={submit} className={`${card} space-y-3`}>
      <p className="text-[14px] font-extrabold">Daftar jadi Seller</p>
      <p className="text-[12px] text-ink-faint">
        Jualan key kamu sendiri di marketplace. Hasil penjualan masuk ke saldo toko (dipotong komisi platform) dan bisa ditarik ke rekening kamu.
      </p>
      <input required value={f.storeName} onChange={set("storeName")} placeholder="Nama toko" className={inputCls} />
      <div className="grid gap-2 sm:grid-cols-3">
        <input value={f.bankName} onChange={set("bankName")} placeholder="Bank / e-wallet" className={inputCls} />
        <input value={f.bankAccountNumber} onChange={set("bankAccountNumber")} placeholder="No. rekening" className={inputCls} />
        <input value={f.bankAccountHolder} onChange={set("bankAccountHolder")} placeholder="Atas nama" className={inputCls} />
      </div>
      <p className="text-[11px] text-ink-faint">Info rekening bisa diisi nanti, tapi wajib sebelum menarik saldo.</p>
      {error && <p className="text-[12px] text-danger">{error}</p>}
      <button disabled={busy} className={btnPrimary}>{busy ? "Mendaftar..." : "Daftar Seller"}</button>
    </form>
  );
}

function BankForm({ seller, onSaved }: { seller: NonNullable<Me["seller"]>; onSaved: () => void }) {
  const [f, setF] = useState({
    bankName: seller.bankName ?? "",
    bankAccountNumber: seller.bankAccountNumber ?? "",
    bankAccountHolder: seller.bankAccountHolder ?? "",
  });
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await call("/api/seller/me", "PUT", f);
      setMsg("Tersimpan.");
      onSaved();
    } catch (err) {
      setMsg((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  return (
    <form onSubmit={save} className={`${card} space-y-3`}>
      <p className="text-[13px] font-bold">Rekening penarikan</p>
      <div className="grid gap-2 sm:grid-cols-3">
        <input value={f.bankName} onChange={set("bankName")} placeholder="Bank / e-wallet" className={inputCls} />
        <input value={f.bankAccountNumber} onChange={set("bankAccountNumber")} placeholder="No. rekening" className={inputCls} />
        <input value={f.bankAccountHolder} onChange={set("bankAccountHolder")} placeholder="Atas nama" className={inputCls} />
      </div>
      <div className="flex items-center gap-3">
        <button disabled={busy} className={btnPrimary}>{busy ? "Menyimpan..." : "Simpan"}</button>
        {msg && <span className="text-[12px] text-ink-faint">{msg}</span>}
      </div>
    </form>
  );
}
