"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, AlertCircle, Check, Copy, ExternalLink, KeyRound } from "lucide-react";
import { formatIDR, formatDateTime } from "@/lib/format";
import type { MyStore } from "@/lib/data/store";

const inputCls =
  "w-full rounded-xl border border-border-strong bg-surface-2 px-3.5 py-3 text-[13.5px] outline-none placeholder:text-ink-faint focus:border-primary/60";
const cardCls = "mt-4 rounded-xl2 border border-border bg-surface p-5";

const STATUS: Record<string, { label: string; cls: string }> = {
  pending: { label: "Menunggu bayar", cls: "bg-amber-500/15 text-amber-500" },
  paid: { label: "Dibayar, memproses", cls: "bg-sky-500/15 text-sky-500" },
  delivered: { label: "Terkirim", cls: "bg-emerald-500/15 text-emerald-500" },
  paid_failed: { label: "Dibayar, key GAGAL terkirim", cls: "bg-red-500/15 text-danger" },
  expired: { label: "Kedaluwarsa", cls: "bg-surface-2 text-ink-faint" },
  failed: { label: "Gagal", cls: "bg-surface-2 text-ink-faint" },
};

async function call(url: string, method: string, body?: unknown) {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || "Terjadi kesalahan.");
  return data;
}

export default function StoreSettings({ data }: { data: MyStore }) {
  const router = useRouter();
  const s = data.store;

  const [slug, setSlug] = useState(s?.slug ?? "");
  const [name, setName] = useState(s?.name ?? "");
  const [wa, setWa] = useState(s?.contactWa ?? "");
  const [apiKey, setApiKey] = useState("");
  const [prices, setPrices] = useState<Record<string, string>>(() => {
    const m: Record<string, string> = {};
    for (const v of data.variants) m[`${v.productId}|${v.durationId}`] = v.price === null ? "" : String(v.price);
    return m;
  });
  const [bulk, setBulk] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const link = s ? `${origin}/s/${s.slug}` : "";

  async function run(key: string, fn: () => Promise<string | void>) {
    setBusy(key);
    setMsg(null);
    try {
      const text = await fn();
      if (text) setMsg({ kind: "ok", text });
      router.refresh();
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : "Terjadi kesalahan." });
    } finally {
      setBusy(null);
    }
  }

  const grouped = useMemo(() => {
    const g = new Map<string, typeof data.variants>();
    for (const v of data.variants) {
      const arr = g.get(v.productName) ?? [];
      arr.push(v);
      g.set(v.productName, arr);
    }
    return Array.from(g.entries());
  }, [data]);

  function applyBulk() {
    const add = Number(bulk);
    if (!Number.isInteger(add) || add < 0) {
      setMsg({ kind: "err", text: "Isi untung per key dengan angka bulat (Rp)." });
      return;
    }
    const next: Record<string, string> = {};
    for (const v of data.variants) next[`${v.productId}|${v.durationId}`] = String(v.cost + add);
    setPrices(next);
    setMsg({ kind: "ok", text: "Harga terisi (modal + untung). Klik Simpan harga untuk menyimpan." });
  }

  function savePrices() {
    return run("prices", async () => {
      const items = data.variants.map((v) => {
        const raw = (prices[`${v.productId}|${v.durationId}`] ?? "").trim();
        return { productId: v.productId, durationId: v.durationId, price: raw === "" ? null : Number(raw), active: true };
      });
      await call("/api/store/me/prices", "PUT", { items });
      return "Harga tersimpan.";
    });
  }

  if (!data.configured) {
    return (
      <div className={cardCls}>
        <p className="flex items-center gap-2 text-[13.5px] font-bold">
          <AlertCircle size={16} className="text-danger" /> Fitur toko belum diaktifkan
        </p>
        <p className="mt-2 text-[12.5px] leading-relaxed text-ink-faint">
          Admin perlu mengisi <span className="font-mono">STORE_SECRET_KEY</span> di pengaturan hosting dulu. Hubungi admin.
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="rounded-xl2 border border-border bg-surface p-5">
        <p className="text-[12.5px] leading-relaxed text-ink-faint">
          Jual key lewat link tokomu sendiri. Pembeli bayar QRIS langsung ke akun GensPay milikmu. Setelah bayar, key diambil dari{" "}
          <b className="text-ink-dim">saldo heroitbest-mu</b> sebesar harga modal, jadi saldo harus selalu cukup. Saldo sekarang:{" "}
          <b className="text-ink">{formatIDR(data.balance)}</b>.
        </p>
      </div>

      {msg && (
        <p className={`mt-4 flex items-start gap-1.5 text-[12.5px] font-medium ${msg.kind === "ok" ? "text-emerald-500" : "text-danger"}`}>
          {msg.kind === "ok" ? <Check size={14} className="mt-0.5 shrink-0" /> : <AlertCircle size={14} className="mt-0.5 shrink-0" />} {msg.text}
        </p>
      )}

      {s?.adminBlocked && (
        <p className="mt-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-[12.5px] font-semibold text-danger">
          Tokomu dinonaktifkan admin. Hubungi admin untuk membukanya lagi.
        </p>
      )}

      {/* 1. Info toko */}
      <div className={cardCls}>
        <p className="text-[13.5px] font-bold">1. Info toko</p>
        <div className="mt-3 space-y-3">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nama toko" maxLength={40} className={inputCls} />
          <div>
            <input
              value={slug}
              onChange={(e) => setSlug(e.target.value.toLowerCase())}
              placeholder="link-toko (huruf kecil, angka, strip)"
              maxLength={30}
              className={inputCls}
            />
            <p className="mt-1 text-[11px] text-ink-faint">
              Alamat tokomu: {origin}/s/{slug || "link-toko"}
            </p>
          </div>
          <input
            value={wa}
            onChange={(e) => setWa(e.target.value)}
            placeholder="WhatsApp penjual (opsional, mis. 6281234567890)"
            inputMode="numeric"
            className={inputCls}
          />
        </div>
        <button
          disabled={busy !== null}
          onClick={() =>
            run("info", async () => {
              await call("/api/store/me", "PUT", { slug, name, contactWa: wa, enabled: s?.enabled ?? false });
              return "Info toko tersimpan.";
            })
          }
          className="mt-4 flex items-center gap-2 rounded-xl bg-primary px-5 py-3 text-[13px] font-bold text-white disabled:opacity-50"
        >
          {busy === "info" && <Loader2 size={15} className="animate-spin" />} Simpan info toko
        </button>
      </div>

      {/* 2. GensPay */}
      <div className={cardCls}>
        <p className="flex items-center gap-2 text-[13.5px] font-bold">
          <KeyRound size={15} /> 2. API GensPay-mu
        </p>
        <p className="mt-1.5 text-[12px] leading-relaxed text-ink-faint">
          Ambil API key dari dashboard GensPay milikmu. Key disimpan terenkripsi, tidak pernah ditampilkan lagi, dan tidak bisa dilihat siapa pun (termasuk admin).
        </p>
        <div className="mt-3 rounded-xl border border-border bg-surface-2 p-3 text-[12px] leading-relaxed">
          <p className="font-bold">Wajib: isi Webhook URL di GensPay-mu</p>
          <p className="mt-1 text-ink-faint">
            Di GensPay buka <b>Settings → Project</b>, isi <b>Webhook URL</b> dengan alamat di bawah, lalu klik <b>Uji Coba Webhook</b>.
            Tanpa ini, pembeli sudah bayar tapi key tidak terkirim otomatis.
          </p>
          <code className="mt-2 block break-all rounded-lg bg-surface px-2.5 py-2 font-mono text-[11.5px]">
            {(typeof window !== "undefined" ? window.location.origin : "") + "/api/webhooks/store"}
          </code>
        </div>
        {s?.hasKey && (
          <p className="mt-2 text-[12px] font-semibold text-emerald-500">Tersimpan (berakhiran ••••{s.keyLast4}). Isi lagi untuk mengganti.</p>
        )}
        {!s ? (
          <p className="mt-3 text-[12px] text-ink-faint">Simpan info toko dulu.</p>
        ) : (
          <>
            <input
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="Tempel API key GensPay"
              className={`${inputCls} mt-3 font-mono`}
            />
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                disabled={busy !== null || apiKey.trim().length < 8}
                onClick={() =>
                  run("key", async () => {
                    await call("/api/store/me/key", "PUT", { apiKey });
                    setApiKey("");
                    return "API key valid dan tersimpan.";
                  })
                }
                className="flex items-center gap-2 rounded-xl bg-primary px-5 py-3 text-[13px] font-bold text-white disabled:opacity-50"
              >
                {busy === "key" && <Loader2 size={15} className="animate-spin" />} Verifikasi &amp; simpan
              </button>
              {s.hasKey && (
                <button
                  disabled={busy !== null}
                  onClick={() =>
                    confirm("Hapus API key? Tokomu akan ditutup.") &&
                    run("delkey", async () => {
                      await call("/api/store/me/key", "DELETE");
                      return "API key dihapus, toko ditutup.";
                    })
                  }
                  className="rounded-xl border border-border-strong px-5 py-3 text-[13px] font-semibold text-danger disabled:opacity-50"
                >
                  Hapus key
                </button>
              )}
            </div>
          </>
        )}
      </div>

      {/* 3. Harga */}
      <div className={cardCls}>
        <p className="text-[13.5px] font-bold">3. Harga jual</p>
        <p className="mt-1.5 text-[12px] leading-relaxed text-ink-faint">
          Isi harga yang kamu mau. Tidak boleh di bawah modal. Kosongkan = tidak dijual. Untungmu = harga jual − modal (biaya QRIS GensPay mengikuti pengaturan project GensPay-mu: ditambah ke pembeli atau dipotong dari hasil jualanmu).
        </p>
        {!s ? (
          <p className="mt-3 text-[12px] text-ink-faint">Simpan info toko dulu.</p>
        ) : (
          <>
            <div className="mt-3 flex gap-2">
              <input
                value={bulk}
                onChange={(e) => setBulk(e.target.value.replace(/\D/g, ""))}
                inputMode="numeric"
                placeholder="Untung per key (Rp)"
                className={inputCls}
              />
              <button onClick={applyBulk} className="shrink-0 rounded-xl border border-border-strong px-4 text-[12.5px] font-semibold text-ink-dim">
                Isi semua
              </button>
            </div>
            <div className="mt-4 space-y-4">
              {grouped.map(([prod, vs]) => (
                <div key={prod}>
                  <p className="text-[12.5px] font-bold uppercase">{prod}</p>
                  <div className="mt-1.5 divide-y divide-border rounded-xl border border-border">
                    {vs.map((v) => {
                      const k = `${v.productId}|${v.durationId}`;
                      return (
                        <div key={k} className="flex items-center gap-3 px-3 py-2.5">
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-[12.5px] font-semibold uppercase">{v.label}</p>
                            <p className="text-[11px] text-ink-faint">Modal {formatIDR(v.cost)}</p>
                          </div>
                          <input
                            value={prices[k] ?? ""}
                            onChange={(e) => setPrices((p) => ({ ...p, [k]: e.target.value.replace(/\D/g, "") }))}
                            inputMode="numeric"
                            placeholder="Harga jual"
                            className="w-28 rounded-lg border border-border-strong bg-surface-2 px-3 py-2 text-right text-[13px] outline-none focus:border-primary/60"
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
            <button
              disabled={busy !== null}
              onClick={savePrices}
              className="mt-4 flex items-center gap-2 rounded-xl bg-primary px-5 py-3 text-[13px] font-bold text-white disabled:opacity-50"
            >
              {busy === "prices" && <Loader2 size={15} className="animate-spin" />} Simpan harga
            </button>
          </>
        )}
      </div>

      {/* 4. Buka toko */}
      <div className={cardCls}>
        <p className="text-[13.5px] font-bold">4. Buka toko</p>
        {s ? (
          <>
            <p className="mt-1.5 text-[12px] text-ink-faint">
              Status: <b className={s.enabled ? "text-emerald-500" : "text-ink-dim"}>{s.enabled ? "BUKA" : "TUTUP"}</b>. Syarat buka: API GensPay tersimpan dan minimal 1 harga terisi.
            </p>
            <button
              disabled={busy !== null || s.adminBlocked}
              onClick={() =>
                run("toggle", async () => {
                  await call("/api/store/me", "PUT", { slug: s.slug, name: s.name, contactWa: s.contactWa, enabled: !s.enabled });
                  return s.enabled ? "Toko ditutup." : "Toko dibuka.";
                })
              }
              className={`mt-3 flex items-center gap-2 rounded-xl px-5 py-3 text-[13px] font-bold disabled:opacity-50 ${
                s.enabled ? "border border-border-strong text-ink-dim" : "bg-primary text-white"
              }`}
            >
              {busy === "toggle" && <Loader2 size={15} className="animate-spin" />} {s.enabled ? "Tutup toko" : "Buka toko"}
            </button>
            {s.enabled && (
              <div className="mt-4 flex items-center gap-2 rounded-xl border border-border bg-surface-2 px-3.5 py-3">
                <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{link}</span>
                <button
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(link);
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1500);
                    } catch {
                      /* clipboard diblokir */
                    }
                  }}
                  className="rounded-lg p-1.5 text-ink-dim hover:text-ink"
                  aria-label="Salin link"
                >
                  {copied ? <Check size={15} /> : <Copy size={15} />}
                </button>
                <a href={link} target="_blank" rel="noopener noreferrer" className="rounded-lg p-1.5 text-ink-dim hover:text-ink" aria-label="Buka toko">
                  <ExternalLink size={15} />
                </a>
              </div>
            )}
          </>
        ) : (
          <p className="mt-1.5 text-[12px] text-ink-faint">Simpan info toko dulu.</p>
        )}
      </div>

      {/* Pesanan */}
      {s && (
        <div className={cardCls}>
          <p className="text-[13.5px] font-bold">Pesanan terbaru</p>
          <div className="mt-2 grid grid-cols-3 gap-2 text-center">
            <div className="rounded-lg bg-surface-2 py-2.5">
              <p className="text-[10px] uppercase text-ink-faint">Terjual</p>
              <p className="font-display text-[15px] font-bold">{data.stats.delivered}</p>
            </div>
            <div className="rounded-lg bg-surface-2 py-2.5">
              <p className="text-[10px] uppercase text-ink-faint">Omzet</p>
              <p className="font-display text-[15px] font-bold">{formatIDR(data.stats.revenue)}</p>
            </div>
            <div className="rounded-lg bg-surface-2 py-2.5">
              <p className="text-[10px] uppercase text-ink-faint">Untung</p>
              <p className="font-display text-[15px] font-bold">{formatIDR(data.stats.profit)}</p>
            </div>
          </div>
          {data.stats.needsAction > 0 && (
            <p className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12px] font-semibold text-danger">
              {data.stats.needsAction} pesanan sudah DIBAYAR pembeli tapi key belum terkirim. Top up saldo / isi stok, lalu tekan &quot;Kirim ulang&quot;.
            </p>
          )}
          {data.orders.length === 0 ? (
            <p className="mt-3 text-[12px] text-ink-faint">Belum ada pesanan.</p>
          ) : (
            <div className="mt-3 divide-y divide-border rounded-xl border border-border">
              {data.orders.map((o) => {
                const st = STATUS[o.status] ?? STATUS.failed;
                return (
                  <div key={o.id} className="px-3 py-2.5">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-[12.5px] font-semibold uppercase">
                          {o.productName} · {o.durationLabel}
                        </p>
                        <p className="text-[11px] text-ink-faint">
                          {formatDateTime(o.createdAt)}
                          {o.buyerContact ? ` · ${o.buyerContact}` : ""}
                        </p>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="text-[12.5px] font-bold">{formatIDR(o.sellPrice)}</p>
                        <span className={`mt-0.5 inline-block rounded-full px-2 py-0.5 text-[10px] font-bold ${st.cls}`}>{st.label}</span>
                      </div>
                    </div>
                    {(o.status === "paid_failed" || o.status === "paid") && (
                      <div className="mt-2 flex items-center justify-between gap-2">
                        <p className="text-[11px] text-danger">{o.failReason ?? "Menunggu pengiriman."}</p>
                        <button
                          disabled={busy !== null}
                          onClick={() =>
                            run(`retry-${o.id}`, async () => {
                              const r = await call("/api/store/me/retry", "POST", { orderId: o.id });
                              if (r.ok === false) throw new Error(r.message || "Belum bisa dikirim.");
                              return "Key terkirim ke pembeli.";
                            })
                          }
                          className="shrink-0 rounded-lg bg-primary px-3 py-1.5 text-[11.5px] font-bold text-white disabled:opacity-50"
                        >
                          {busy === `retry-${o.id}` ? "Memproses..." : "Kirim ulang"}
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
