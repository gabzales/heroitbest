"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Search, X, Loader2, AlertCircle, CheckCircle2, Copy, Check, MessageCircle } from "lucide-react";
import { formatIDR } from "@/lib/format";
import TurnstileWidget, { TURNSTILE_SITE_KEY } from "@/components/TurnstileWidget";
import type { PublicStore, PublicStoreItem } from "@/lib/data/store";

type OrderView = {
  status: "pending" | "paid" | "delivered" | "paid_failed" | "expired" | "failed";
  productName: string;
  durationLabel: string;
  price: number;
  amount: number | null;
  key: string | null;
  storeName: string | null;
  sellerWa: string | null;
  failMessage: string | null;
};

function hueOf(name: string) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return h;
}
function initials(name: string) {
  const w = name.trim().split(/\s+/).filter(Boolean);
  return ((w[0]?.[0] ?? "") + (w[1]?.[0] ?? "")).toUpperCase();
}

export default function StoreFront({ store }: { store: PublicStore }) {
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<PublicStoreItem | null>(null);
  const [contact, setContact] = useState("");
  const [captcha, setCaptcha] = useState<string | null>(null);
  const [captchaReset, setCaptchaReset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [qr, setQr] = useState<{ qrString: string; amount: number } | null>(null);
  const [order, setOrder] = useState<OrderView | null>(null);
  const [copied, setCopied] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return store.items.filter((i) => !q || i.name.toLowerCase().includes(q) || i.label.toLowerCase().includes(q) || i.category.toLowerCase().includes(q));
  }, [store.items, query]);

  const poll = useCallback(async (tk: string) => {
    try {
      const res = await fetch(`/api/store/status?token=${encodeURIComponent(tk)}`, { cache: "no-store" });
      if (res.ok) {
        const data = (await res.json()) as OrderView;
        setOrder(data);
        if (data.status === "pending" || data.status === "paid") {
          timer.current = setTimeout(() => poll(tk), 3500);
        }
        return;
      }
      if (res.status === 404) {
        setError("Pesanan tidak ditemukan.");
        return;
      }
    } catch {
      /* koneksi putus sebentar: coba lagi */
    }
    timer.current = setTimeout(() => poll(tk), 6000);
  }, []);

  // Lanjutkan pesanan setelah halaman di-refresh (token disimpan di URL ?o=...).
  useEffect(() => {
    const tk = new URLSearchParams(window.location.search).get("o");
    if (tk && /^[A-Za-z0-9_-]{20,64}$/.test(tk)) {
      setToken(tk);
      poll(tk);
    }
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [poll]);

  function closeAll() {
    if (timer.current) clearTimeout(timer.current);
    setPicked(null);
    setToken(null);
    setQr(null);
    setOrder(null);
    setError("");
    setContact("");
    window.history.replaceState(null, "", window.location.pathname);
  }

  async function pay() {
    if (!picked || busy) return;
    if (TURNSTILE_SITE_KEY && !captcha) {
      setError("Selesaikan verifikasi keamanan dulu.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/store/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: store.slug,
          productId: picked.productId,
          durationId: picked.durationId,
          contact,
          turnstileToken: captcha,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || "Gagal membuat pesanan.");
      setToken(data.token);
      setQr({ qrString: data.qrString, amount: data.amount });
      window.history.replaceState(null, "", `${window.location.pathname}?o=${data.token}`);
      poll(data.token);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Gagal membuat pesanan.");
      setCaptcha(null);
      setCaptchaReset((n) => n + 1);
    } finally {
      setBusy(false);
    }
  }

  async function retry() {
    if (!token || retrying) return;
    setRetrying(true);
    try {
      const res = await fetch("/api/store/retry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) setError(data.message || "Belum bisa dikirim, coba lagi nanti.");
      else setError("");
      poll(token);
    } finally {
      setRetrying(false);
    }
  }

  async function copyKey(k: string) {
    try {
      await navigator.clipboard.writeText(k);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard diblokir */
    }
  }

  const showSheet = Boolean(picked || token);
  const waHref = (order?.sellerWa || store.contactWa) ? `https://wa.me/${order?.sellerWa || store.contactWa}` : null;
  // Pesanan yang dilanjutkan dari URL belum tahu item-nya: ambil dari status.
  const title = order?.productName ?? picked?.name ?? "";
  const sub = order?.durationLabel ?? picked?.label ?? "";

  return (
    <div className="mx-auto min-h-dvh max-w-[820px] px-4 pb-16 pt-8 sm:px-6">
      <header className="mb-6">
        <p className="text-[11px] font-bold uppercase tracking-widest text-primary">Toko</p>
        <h1 className="mt-1 font-display text-[24px] font-extrabold leading-tight">{store.name}</h1>
        <p className="mt-1 text-[12.5px] text-ink-faint">Bayar pakai QRIS, key langsung tampil setelah pembayaran terkonfirmasi.</p>
      </header>

      <div className="relative">
        <Search size={15} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-faint" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Cari produk / varian..."
          className="w-full rounded-xl border border-border-strong bg-surface py-3 pl-10 pr-4 text-[13.5px] outline-none placeholder:text-ink-faint focus:border-primary/60"
        />
      </div>

      {shown.length === 0 ? (
        <p className="mt-10 text-center text-[13px] text-ink-faint">
          {store.items.length === 0 ? "Belum ada produk yang tersedia saat ini." : "Produk tidak ditemukan."}
        </p>
      ) : (
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {shown.map((i) => {
            const hue = hueOf(i.name);
            return (
              <button
                key={`${i.productId}-${i.durationId}`}
                onClick={() => {
                  setPicked(i);
                  setError("");
                }}
                className="flex flex-col overflow-hidden rounded-xl2 border border-border bg-surface text-left transition-all hover:-translate-y-0.5 hover:border-primary/50 active:scale-[0.98]"
              >
                <span
                  className="relative flex aspect-[4/3] items-center justify-center font-display text-[28px] font-black text-white/90"
                  style={{ background: `linear-gradient(135deg, hsl(${hue} 70% 45%), hsl(${(hue + 50) % 360} 70% 30%))` }}
                >
                  {initials(i.name)}
                  <span className="absolute left-2 top-2 rounded-full bg-black/45 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-white">Tersedia</span>
                </span>
                <span className="flex flex-1 flex-col p-3">
                  <span className="line-clamp-2 text-[12.5px] font-extrabold uppercase leading-tight">{i.name}</span>
                  <span className="mt-1 line-clamp-2 text-[11px] uppercase text-ink-faint">{i.label}</span>
                  <span className="mt-2 rounded-lg border border-border bg-surface-2 px-2.5 py-2">
                    <span className="block text-[9px] font-bold uppercase tracking-widest text-ink-faint">Harga</span>
                    <span className="block font-display text-[14px] font-bold">{formatIDR(i.price)}</span>
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}

      {showSheet && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center" onClick={() => !busy && !qr && !order && setPicked(null)}>
          <div
            onClick={(e) => e.stopPropagation()}
            className="max-h-[90vh] w-full max-w-[440px] animate-fadeUp overflow-y-auto rounded-t-2xl border border-border-strong bg-surface p-5 sm:rounded-2xl"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-display text-[16px] font-bold leading-tight">{title || "Pesanan"}</p>
                <p className="mt-0.5 text-[12px] uppercase text-ink-faint">{sub}</p>
              </div>
              <button onClick={closeAll} aria-label="Tutup" className="rounded-lg p-1.5 text-ink-faint hover:text-ink">
                <X size={18} />
              </button>
            </div>

            {!token && picked && (
              <>
                <div className="mt-4 flex items-center justify-between rounded-xl border border-border bg-surface-2 px-4 py-3 text-[13px]">
                  <span className="text-ink-dim">Harga</span>
                  <span className="font-display font-bold">{formatIDR(picked.price)}</span>
                </div>
                <p className="mt-2 text-[11px] text-ink-faint">Biaya QRIS dari penyedia pembayaran dapat ditambahkan di total yang kamu bayar.</p>
                <label className="mt-4 block text-[12px] font-semibold text-ink-dim">
                  Kontak (opsional, mis. WhatsApp)
                  <input
                    value={contact}
                    onChange={(e) => setContact(e.target.value)}
                    maxLength={60}
                    placeholder="08xxxxxxxxxx"
                    className="mt-1.5 w-full rounded-xl border border-border-strong bg-surface-2 px-3.5 py-3 text-[13.5px] font-normal outline-none focus:border-primary/60"
                  />
                </label>
                {TURNSTILE_SITE_KEY && (
                  <div className="mt-4 flex justify-center">
                    <TurnstileWidget onToken={setCaptcha} resetKey={captchaReset} />
                  </div>
                )}
                {error && (
                  <p className="mt-3 flex items-center gap-1.5 text-[12px] font-medium text-danger">
                    <AlertCircle size={13} /> {error}
                  </p>
                )}
                <button
                  onClick={pay}
                  disabled={busy}
                  className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl bg-primary py-3.5 text-[13.5px] font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                >
                  {busy ? <Loader2 size={16} className="animate-spin" /> : null}
                  {busy ? "Membuat tagihan..." : "Bayar via QRIS"}
                </button>
              </>
            )}

            {token && (!order || order.status === "pending") && (
              <div className="mt-5 text-center">
                {qr ? (
                  <>
                    <div className="mx-auto inline-block rounded-2xl bg-white p-4">
                      <QRCodeSVG value={qr.qrString} size={200} />
                    </div>
                    <p className="mt-3 font-display text-[18px] font-bold">{formatIDR(qr.amount)}</p>
                    <p className="mt-1 text-[12px] text-ink-faint">Scan dengan aplikasi e-wallet / m-banking. Jangan tutup halaman ini.</p>
                  </>
                ) : (
                  <p className="text-[12.5px] text-ink-faint">
                    Pesanan sudah dibuat. Kalau kamu sudah membayar, tunggu sebentar — halaman ini otomatis menampilkan key.
                  </p>
                )}
                <p className="mt-3 flex items-center justify-center gap-2 text-[12px] text-ink-dim">
                  <Loader2 size={14} className="animate-spin" /> Menunggu pembayaran...
                </p>
              </div>
            )}

            {order?.status === "paid" && (
              <p className="mt-6 flex items-center justify-center gap-2 text-[13px] font-semibold text-ink-dim">
                <Loader2 size={15} className="animate-spin" /> Pembayaran diterima, key sedang disiapkan...
              </p>
            )}

            {order?.status === "delivered" && order.key && (
              <div className="mt-5 text-center">
                <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary-dim text-primary">
                  <CheckCircle2 size={24} />
                </span>
                <p className="mt-3 font-display text-[15px] font-bold">Pembayaran berhasil</p>
                <div className="mt-3 break-all rounded-xl border border-border-strong bg-surface-2 px-4 py-3 font-mono text-[14px] font-bold tracking-wide text-primary">
                  {order.key}
                </div>
                <button
                  onClick={() => copyKey(order.key as string)}
                  className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-border-strong px-3.5 py-2 text-[12.5px] font-semibold text-ink-dim hover:text-ink"
                >
                  {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? "Tersalin" : "Salin key"}
                </button>
                <p className="mt-3 text-[11.5px] text-ink-faint">Simpan key ini. Link halaman ini juga bisa dibuka lagi untuk melihatnya.</p>
              </div>
            )}

            {order?.status === "paid_failed" && (
              <div className="mt-5">
                <p className="flex items-start gap-2 text-[13px] font-semibold text-danger">
                  <AlertCircle size={16} className="mt-0.5 shrink-0" />
                  Pembayaran kamu sudah diterima, tapi key belum bisa dikirim.
                </p>
                <p className="mt-2 text-[12px] leading-relaxed text-ink-faint">
                  {order.failMessage || "Terjadi kendala di sisi penjual."} Jangan bayar ulang. Coba kirim lagi, atau hubungi penjual dan simpan link halaman ini sebagai bukti.
                </p>
                {error && <p className="mt-2 text-[12px] font-medium text-danger">{error}</p>}
                <button
                  onClick={retry}
                  disabled={retrying}
                  className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-primary py-3 text-[13.5px] font-bold text-white disabled:opacity-50"
                >
                  {retrying ? <Loader2 size={16} className="animate-spin" /> : null} Coba kirim lagi
                </button>
                {waHref && (
                  <a
                    href={waHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl border border-border-strong py-3 text-[13px] font-semibold text-ink-dim"
                  >
                    <MessageCircle size={15} /> Hubungi penjual
                  </a>
                )}
              </div>
            )}

            {(order?.status === "expired" || order?.status === "failed") && (
              <div className="mt-5 text-center">
                <p className="text-[13px] font-semibold text-ink-dim">
                  {order.status === "expired" ? "Tagihan kedaluwarsa sebelum dibayar." : "Pembayaran tidak berhasil."}
                </p>
                <p className="mt-1 text-[12px] text-ink-faint">Kalau kamu sudah terlanjur membayar, hubungi penjual dengan menyertakan link halaman ini.</p>
                <button onClick={closeAll} className="mt-4 w-full rounded-xl bg-primary py-3 text-[13.5px] font-bold text-white">
                  Buat pesanan baru
                </button>
              </div>
            )}

            {order?.status === "delivered" && (
              <button onClick={closeAll} className="mt-4 w-full rounded-xl border border-border-strong py-3 text-[13px] font-semibold text-ink-dim">
                Selesai
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
