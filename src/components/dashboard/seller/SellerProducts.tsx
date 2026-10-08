"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ArrowRight } from "lucide-react";
import { call, rp, inputCls, btnPrimary, card } from "./api";

type Row = {
  id: string;
  name: string;
  category: string;
  active: boolean;
  product_durations: { id: string; label: string; price: number; stock_mode: string }[];
};

export default function SellerProducts() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await call<{ products: Row[] }>("/api/seller/products");
      setRows(d.products);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await call("/api/seller/products", "POST", { name, category });
      setName("");
      setCategory("");
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <form onSubmit={create} className={`${card} space-y-3`}>
        <p className="text-[13px] font-bold">Produk baru</p>
        <div className="grid gap-2 sm:grid-cols-2">
          <input required value={name} onChange={(e) => setName(e.target.value)} placeholder="Nama produk" className={inputCls} />
          <input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="Kategori (contoh: Free Fire)" className={inputCls} />
        </div>
        {error && <p className="text-[12px] text-danger">{error}</p>}
        <button disabled={busy} className={btnPrimary}>{busy ? "Menyimpan..." : "Buat Produk"}</button>
      </form>

      {!rows ? (
        <div className={`${card} text-[13px] text-ink-faint`}>Memuat...</div>
      ) : rows.length === 0 ? (
        <div className={`${card} text-center text-[13px] text-ink-faint`}>Belum ada produk. Buat yang pertama di atas.</div>
      ) : (
        <div className="divide-y divide-border rounded-xl2 border border-border bg-surface">
          {rows.map((p) => (
            <Link key={p.id} href={`/dashboard/seller/products/${p.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-surface-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13.5px] font-bold">{p.name}</p>
                <p className="truncate text-[11.5px] text-ink-faint">
                  {p.category} · {p.product_durations.length} durasi
                  {p.product_durations.length > 0 && ` · mulai ${rp(Math.min(...p.product_durations.map((d) => d.price)))}`}
                </p>
              </div>
              <span className={`rounded-full px-2 py-0.5 text-[10.5px] font-bold ${p.active ? "bg-emerald-500/15 text-emerald-500" : "bg-surface-2 text-ink-faint"}`}>
                {p.active ? "Tayang" : "Draft"}
              </span>
              <ArrowRight size={15} className="text-ink-faint" />
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
