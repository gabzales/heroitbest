"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { AdminStoreRow } from "@/lib/data/store";

export default function AdminStoresList({ rows }: { rows: AdminStoreRow[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  async function setBlocked(userId: string, blocked: boolean) {
    setBusy(userId);
    setError("");
    try {
      const res = await fetch(`/api/admin/stores/${userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ blocked }),
      });
      if (!res.ok) throw new Error("Gagal mengubah status toko.");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Gagal mengubah status toko.");
    } finally {
      setBusy(null);
    }
  }

  if (rows.length === 0) {
    return (
      <div className="rounded-xl2 border border-dashed border-border p-8 text-center text-[13px] text-ink-faint">
        Belum ada seller yang membuat toko.
      </div>
    );
  }

  return (
    <div>
      {error && <p className="mb-3 text-[12px] font-medium text-danger">{error}</p>}
      <div className="divide-y divide-border rounded-xl2 border border-border bg-surface">
        {rows.map((r) => (
          <div key={r.userId} className="flex flex-wrap items-center gap-3 px-4 py-3.5">
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13.5px] font-bold">{r.name}</p>
              <p className="truncate text-[11.5px] text-ink-faint">
                {r.email} · /s/{r.slug}
              </p>
              <p className="mt-1 text-[11px] text-ink-faint">
                {r.orders} terjual · GensPay {r.hasKey ? "terpasang" : "belum"}
                {r.needsAction > 0 && <span className="ml-1 font-semibold text-danger">· {r.needsAction} pesanan dibayar belum terkirim</span>}
              </p>
            </div>
            <span
              className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${
                r.blocked ? "bg-red-500/15 text-danger" : r.enabled ? "bg-emerald-500/15 text-emerald-500" : "bg-surface-2 text-ink-faint"
              }`}
            >
              {r.blocked ? "DIBLOKIR" : r.enabled ? "BUKA" : "TUTUP"}
            </span>
            <button
              disabled={busy === r.userId}
              onClick={() =>
                (r.blocked || confirm(`Nonaktifkan toko "${r.name}"? Toko langsung tutup dan seller tidak bisa membukanya lagi.`)) &&
                setBlocked(r.userId, !r.blocked)
              }
              className={`rounded-lg px-3 py-2 text-[12px] font-bold disabled:opacity-50 ${
                r.blocked ? "bg-emerald-500 text-white" : "border border-border-strong text-danger"
              }`}
            >
              {r.blocked ? "Aktifkan lagi" : "Nonaktifkan"}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
