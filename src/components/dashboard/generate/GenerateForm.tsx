"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { KeyRound, Check, Loader2, AlertCircle, Search, X } from "lucide-react";
import PageHeader from "@/components/dashboard/PageHeader";
import { formatIDR } from "@/lib/format";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { Product } from "@/lib/types";

function hueOf(name: string) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return h;
}
function initials(name: string) {
  const w = name.trim().split(/\s+/).filter(Boolean);
  return ((w[0]?.[0] ?? "") + (w[1]?.[0] ?? "")).toUpperCase();
}

export default function GenerateForm({
  products,
  balance,
}: {
  products: Product[];
  balance: number;
}) {
  const router = useRouter();
  const [productId, setProductId] = useState("");
  const [durationId, setDurationId] = useState("");
  const [query, setQuery] = useState("");
  const [cat, setCat] = useState("Semua");
  const [sheet, setSheet] = useState(false);
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [resultKey, setResultKey] = useState("");

  const product = useMemo(
    () => products.find((p) => p.id === productId),
    [products, productId]
  );
  const duration = useMemo(
    () => product?.durations.find((d) => d.id === durationId),
    [product, durationId]
  );

  const categories = useMemo(
    () => ["Semua", ...Array.from(new Set(products.map((p) => p.category).filter(Boolean)))],
    [products]
  );
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return products
      .filter((p) => cat === "Semua" || p.category === cat)
      .flatMap((p) => p.durations.map((d) => ({ p, d })))
      .filter(
        ({ p, d }) =>
          !q ||
          p.name.toLowerCase().includes(q) ||
          p.category.toLowerCase().includes(q) ||
          d.label.toLowerCase().includes(q)
      );
  }, [products, query, cat]);

  const canGenerate = Boolean(product && duration && balance >= (duration?.price ?? 0));

  async function handleGenerate() {
    if (!canGenerate || !product || !duration) return;
    setStatus("loading");
    setErrorMsg("");

    if (!isSupabaseConfigured) {
      // Demo mode — no backend yet, simulate so the flow stays reviewable.
      setTimeout(() => {
        setResultKey(
          Array.from({ length: 4 })
            .map(() => Math.random().toString(36).slice(2, 6).toUpperCase())
            .join("-")
        );
        setStatus("done");
      }, 800);
      return;
    }

    try {
      const res = await fetch("/api/generate-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId: product.id, durationId: duration.id }),
      });
      let data: { message?: string; key?: { key_string: string } };
      try {
        data = await res.json();
      } catch {
        // FIX (Sep 2026): res.json() gagal parse (body kosong/putus di
        // tengah jalan -- biasanya koneksi HP ke server kepotong, bukan
        // berarti request-nya gagal di server) sebelumnya nyampe ke user
        // sebagai pesan mentah "Unexpected end of JSON input" yang bikin
        // panik & gak jelas harus ngapain. Yang bikin ini beresiko: kalau
        // requestnya SEBENARNYA sudah sukses di server (key sudah dibuat,
        // saldo sudah kepotong) tapi respons-nya yang putus di jalan,
        // asal klik Generate lagi bisa bikin key & potongan saldo DOBEL.
        // Makanya pesannya eksplisit nyuruh cek Riwayat dulu, bukan cuma
        // "coba lagi".
        throw new Error(
          "Koneksi terputus saat menunggu respons server. JANGAN langsung klik Generate lagi -- " +
          "cek dulu di Riwayat Key & saldo kamu, kalau key/potongan sudah muncul di sana berarti " +
          "sebenarnya sudah berhasil. Kalau belum ada, baru aman dicoba ulang."
        );
      }
      if (!res.ok) throw new Error(data.message || "Gagal membuat key.");
      setResultKey(data.key!.key_string);
      setStatus("done");
      router.refresh(); // re-fetch balance in the layout/sidebar
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Gagal membuat key.");
      setStatus("error");
    }
  }

  return (
    <div className="mx-auto max-w-[760px]">
      <PageHeader title="Beli Key" eyebrow="Etalase" />

      {status === "done" ? (
        <div className="animate-fadeUp rounded-xl2 border border-primary-dim bg-surface p-6 text-center">
          <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-primary-dim text-primary">
            <Check size={26} />
          </span>
          <p className="mt-4 font-display text-[16px] font-bold">Key berhasil dibuat</p>
          <p className="mt-1 text-[12.5px] text-ink-faint">
            {product?.name} · {duration?.label}
          </p>
          <div className="mt-4 rounded-xl border border-border-strong bg-surface-2 px-4 py-3 font-mono text-[15px] font-bold tracking-wide text-primary">
            {resultKey}
          </div>
          <button
            onClick={() => {
              setStatus("idle");
              setProductId("");
              setDurationId("");
              setSheet(false);
            }}
            className="mt-5 w-full rounded-xl bg-primary py-3 text-[13.5px] font-bold text-white transition-opacity hover:opacity-90"
          >
            Buat Key Lain
          </button>
        </div>
      ) : (
        <>
          <p className="mb-3 text-[12.5px] text-ink-faint">
            Saldo kamu: <span className="font-bold text-ink">{formatIDR(balance)}</span>
          </p>

          <div className="relative">
            <Search size={15} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-faint" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Cari produk / varian..."
              className="w-full rounded-xl border border-border-strong bg-surface py-3 pl-10 pr-4 text-[13.5px] outline-none placeholder:text-ink-faint focus:border-primary/60"
            />
          </div>

          {categories.length > 2 && (
            <div className="-mx-1 mt-3 flex gap-2 overflow-x-auto px-1 pb-1">
              {categories.map((c) => (
                <button
                  key={c}
                  onClick={() => setCat(c)}
                  className={`shrink-0 rounded-full border px-3.5 py-1.5 text-[12px] font-semibold transition-colors ${
                    cat === c
                      ? "border-primary bg-primary-dim text-primary"
                      : "border-border-strong text-ink-dim hover:text-ink"
                  }`}
                >
                  {c}
                </button>
              ))}
            </div>
          )}

          {shown.length === 0 ? (
            <p className="mt-8 text-center text-[13px] text-ink-faint">Produk tidak ditemukan.</p>
          ) : (
            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
              {shown.map(({ p, d }) => {
                const hue = hueOf(p.name);
                return (
                  <button
                    key={`${p.id}-${d.id}`}
                    onClick={() => {
                      setProductId(p.id);
                      setDurationId(d.id);
                      setStatus("idle");
                      setSheet(true);
                    }}
                    className="group flex flex-col overflow-hidden rounded-xl2 border border-border bg-surface text-left transition-all hover:-translate-y-0.5 hover:border-primary/50 active:scale-[0.98]"
                  >
                    <span
                      className="relative flex aspect-[4/3] items-center justify-center font-display text-[28px] font-black text-white/90"
                      style={{ background: `linear-gradient(135deg, hsl(${hue} 70% 45%), hsl(${(hue + 50) % 360} 70% 30%))` }}
                    >
                      {initials(p.name)}
                      <span className="absolute left-2 top-2 rounded-full bg-black/45 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-white">
                        Tersedia
                      </span>
                    </span>
                    <span className="flex flex-1 flex-col p-3">
                      <span className="line-clamp-2 text-[12.5px] font-extrabold uppercase leading-tight">{p.name}</span>
                      <span className="mt-1 line-clamp-2 text-[11px] uppercase text-ink-faint">
                        {d.label}
                        {p.sellerName ? ` · Toko ${p.sellerName}` : ""}
                      </span>
                      <span className="mt-2 rounded-lg border border-border bg-surface-2 px-2.5 py-2">
                        <span className="block text-[9px] font-bold uppercase tracking-widest text-ink-faint">Harga</span>
                        <span className="block font-display text-[14px] font-bold">{formatIDR(d.price)}</span>
                        <span className="mt-1 inline-block rounded-full bg-primary-dim px-2 py-0.5 text-[9.5px] font-bold text-primary">ON</span>
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {sheet && product && (
            <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center" onClick={() => status !== "loading" && setSheet(false)}>
              <div
                onClick={(e) => e.stopPropagation()}
                className="max-h-[88vh] w-full max-w-[480px] animate-fadeUp overflow-y-auto rounded-t-2xl border border-border-strong bg-surface p-5 sm:rounded-2xl"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-display text-[16px] font-bold leading-tight">{product.name}</p>
                    <p className="mt-0.5 text-[11.5px] text-ink-faint">{product.category}</p>
                  </div>
                  <button onClick={() => setSheet(false)} aria-label="Tutup" className="rounded-lg p-1.5 text-ink-faint hover:text-ink">
                    <X size={18} />
                  </button>
                </div>

                {duration && (
                  <p className="mt-4 text-[13px] font-semibold uppercase text-ink-dim">{duration.label}</p>
                )}

                {duration && (
                  <div className="mt-5 flex items-center justify-between rounded-xl border border-border bg-surface-2 px-4 py-3.5 text-[13px]">
                    <span className="text-ink-dim">Total harga</span>
                    <span className="font-display font-bold text-ink">{formatIDR(duration.price)}</span>
                  </div>
                )}

                {product && duration && balance < duration.price && (
                  <p className="mt-3 text-[12px] font-medium text-danger">
                    Saldo tidak mencukupi. Silakan top up terlebih dahulu.
                  </p>
                )}

                {status === "error" && (
                  <p className="mt-3 flex items-center gap-1.5 text-[12px] font-medium text-danger">
                    <AlertCircle size={13} /> {errorMsg}
                  </p>
                )}

                <button
                  disabled={!canGenerate || status === "loading"}
                  onClick={handleGenerate}
                  className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl bg-primary py-3.5 text-[13.5px] font-bold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {status === "loading" ? <Loader2 size={16} className="animate-spin" /> : <KeyRound size={16} />}
                  {status === "loading" ? "Memproses..." : "Beli Key"}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
