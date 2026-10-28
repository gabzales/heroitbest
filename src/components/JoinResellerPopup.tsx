"use client";

import { useEffect, useState } from "react";
import { X, MessageCircle, Crown } from "lucide-react";

// Nomor admin diatur di env hosting (NEXT_PUBLIC_ADMIN_WHATSAPP_NUMBER,
// digit saja, contoh 6281235690535). Tanpa nomor, tombol tidak ditampilkan.
const WA = (process.env.NEXT_PUBLIC_ADMIN_WHATSAPP_NUMBER ?? "").replace(/\D/g, "");
const HREF = WA
  ? `https://wa.me/${WA}?text=${encodeURIComponent("Halo Admin, saya ingin daftar reseller")}`
  : undefined;
const KEY = "hib_join_popup_seen";

export default function JoinResellerPopup() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    try {
      if (sessionStorage.getItem(KEY)) return;
    } catch {
      /* storage diblokir: tetap tampilkan sekali */
    }
    const t = setTimeout(() => setOpen(true), 1500);
    return () => clearTimeout(t);
  }, []);

  function close() {
    setOpen(false);
    try {
      sessionStorage.setItem(KEY, "1");
    } catch {
      /* abaikan */
    }
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/65 px-5"
      onClick={close}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-[360px] animate-fadeUp rounded-xl2 border border-border-strong bg-surface p-6 text-center shadow-glow"
      >
        <button onClick={close} aria-label="Tutup" className="absolute right-3 top-3 rounded-lg p-1.5 text-ink-faint hover:text-ink">
          <X size={18} />
        </button>
        <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-primary-dim text-primary">
          <Crown size={26} />
        </span>
        <p className="mt-4 font-display text-[17px] font-bold">Mau jadi Reseller?</p>
        <p className="mt-2 text-[12.5px] leading-relaxed text-ink-faint">
          Dapat harga modal, beli key kapan saja, dan bisa dihubungkan ke web tokomu lewat API.
          Hubungi admin, akunmu dibuatkan lalu saldo diisi.
        </p>
        {HREF && (
          <a
            href={HREF}
            target="_blank"
            rel="noopener noreferrer"
            onClick={close}
            className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl bg-primary py-3 text-[13.5px] font-bold text-white transition-opacity hover:opacity-90"
          >
            <MessageCircle size={16} /> Daftar via WhatsApp
          </a>
        )}
        <button onClick={close} className="mt-3 text-[12px] font-medium text-ink-faint hover:text-ink-dim">
          Nanti saja
        </button>
      </div>
    </div>
  );
}
