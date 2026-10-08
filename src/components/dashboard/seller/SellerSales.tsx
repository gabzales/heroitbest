"use client";

import { useEffect, useState } from "react";
import { call, rp, fmtDate, card } from "./api";

type Sale = {
  id: string;
  product_name: string;
  duration_label: string;
  price: number;
  seller_earning: number | null;
  commission_amount: number | null;
  held_until: string | null;
  created_at: string;
  disputed: boolean;
};

export default function SellerSales() {
  const [sales, setSales] = useState<Sale[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    call<{ sales: Sale[] }>("/api/seller/sales").then((d) => setSales(d.sales)).catch((e) => setError(e.message));
  }, []);

  if (error) return <p className="text-[13px] text-danger">{error}</p>;
  if (!sales) return <div className={`${card} text-[13px] text-ink-faint`}>Memuat...</div>;
  if (sales.length === 0) return <div className={`${card} text-center text-[13px] text-ink-faint`}>Belum ada penjualan.</div>;

  const now = Date.now();
  return (
    <div className="divide-y divide-border rounded-xl2 border border-border bg-surface">
      {sales.map((s) => {
        const held = s.held_until && new Date(s.held_until).getTime() > now;
        const status = s.disputed ? { t: "Dispute", c: "bg-red-500/15 text-danger" } : held ? { t: "Ditahan", c: "bg-amber-500/15 text-amber-500" } : { t: "Tersedia", c: "bg-emerald-500/15 text-emerald-500" };
        return (
          <div key={s.id} className="flex items-center gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-bold">{s.product_name} · {s.duration_label}</p>
              <p className="text-[11.5px] text-ink-faint">
                {fmtDate(s.created_at)} · harga {rp(s.price)} · komisi {rp(s.commission_amount ?? 0)}
                {held && s.held_until ? ` · cair ${fmtDate(s.held_until)}` : ""}
              </p>
            </div>
            <div className="text-right">
              <p className="text-[13px] font-extrabold">{rp(s.seller_earning ?? 0)}</p>
              <span className={`rounded-full px-2 py-0.5 text-[10.5px] font-bold ${status.c}`}>{status.t}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
