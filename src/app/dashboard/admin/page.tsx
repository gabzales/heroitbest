import { SELLER_ENABLED } from "@/lib/features";
import Link from "next/link";
import { Package, Settings, ArrowRight, KeyRound, Users, Wallet, Megaphone, History, Stethoscope, Store, Banknote, Scale, Percent } from "lucide-react";
import PageHeader from "@/components/dashboard/PageHeader";
import { createAdminSupabase } from "@/lib/supabase/admin";

// FIX (Sep 2026, audit menyeluruh): halaman ini baca data yang berubah-ubah
// (saldo, riwayat, harga tier, dll) lewat Server Component -- tanpa
// force-dynamic, Next.js App Router (v14) bisa nge-cache hasil fetch di
// dalamnya dan nyangkut di data BASI selamanya walau database-nya sudah
// berubah (kejadian nyata: reseller lihat harga lama di /dashboard/generate
// walau tier-nya sudah naik -- lihat riwayat perbaikan di halaman itu).
// Diterapkan ke semua halaman dashboard yang baca data live sebagai
// tindakan pencegahan, bukan cuma yang sudah kebukti kena.
export const dynamic = 'force-dynamic';

async function getStats() {
  const admin = createAdminSupabase();
  if (!admin) return { products: 0, activeProducts: 0, keysSold: 0, resellers: 0 };

  const [{ count: products }, { count: activeProducts }, { count: keysSold }, { count: resellers }] =
    await Promise.all([
      admin.from("products").select("id", { count: "exact", head: true }),
      admin.from("products").select("id", { count: "exact", head: true }).eq("active", true),
      admin.from("reseller_keys").select("id", { count: "exact", head: true }),
      admin.from("users").select("id", { count: "exact", head: true }).eq("role", "user"),
    ]);

  return {
    products: products ?? 0,
    activeProducts: activeProducts ?? 0,
    keysSold: keysSold ?? 0,
    resellers: resellers ?? 0,
  };
}

export default async function AdminOverviewPage() {
  const stats = await getStats();

  return (
    <div>
      <PageHeader title="Admin" eyebrow="Panel" />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatCard icon={Package} label="Produk" value={stats.products} sub={`${stats.activeProducts} aktif`} tone="indigo" />
        <StatCard icon={KeyRound} label="Key Terjual" value={stats.keysSold} sub="total key" tone="emerald" />
        <StatCard icon={Users} label="Reseller" value={stats.resellers} sub="akun terdaftar" tone="blue" />
      </div>

      <div className="hm-section-label mt-5">Quick Actions</div>
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
        <QuickAction href="/dashboard/admin/products" icon={Package} label="Produk" tone="indigo" />
        <QuickAction href="/dashboard/admin/resellers" icon={Users} label="Reseller" tone="blue" />
        <QuickAction href="/dashboard/admin/key-history" icon={History} label="Riwayat" tone="emerald" />
        <QuickAction href="/dashboard/admin/withdrawals" icon={Banknote} label="Tarik Saldo" tone="amber" />
        <QuickAction href="/dashboard/admin/settings" icon={Settings} label="Setting" tone="purple" />
        <QuickAction href="/dashboard/admin/broadcasts" icon={Megaphone} label="Broadcast" tone="pink" />
      </div>

      <div className="hm-section-label mt-5">Semua Menu</div>
      <div className="divide-y divide-border rounded-xl2 border border-border bg-surface">
        <Link
          href="/dashboard/admin/products"
          className="flex items-center gap-3 px-5 py-4 transition-colors hover:bg-surface-2"
        >
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary-dim text-primary">
            <Package size={16} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[13.5px] font-bold">Kelola Produk</p>
            <p className="text-[11.5px] text-ink-faint">Tambah, edit, hapus produk & stok key</p>
          </div>
          <ArrowRight size={16} className="text-ink-faint" />
        </Link>
        <Link
          href="/dashboard/admin/resellers"
          className="flex items-center gap-3 px-5 py-4 transition-colors hover:bg-surface-2"
        >
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary-dim text-primary">
            <Users size={16} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[13.5px] font-bold">Kelola Reseller</p>
            <p className="text-[11.5px] text-ink-faint">Tambah/kurangi saldo manual, di luar QRIS</p>
          </div>
          <ArrowRight size={16} className="text-ink-faint" />
        </Link>
        <Link
          href="/dashboard/admin/settings"
          className="flex items-center gap-3 px-5 py-4 transition-colors hover:bg-surface-2"
        >
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary-dim text-primary">
            <Settings size={16} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[13.5px] font-bold">Reseller API</p>
            <p className="text-[11.5px] text-ink-faint">Kredensial vipbestmods.com buat mode Auto</p>
          </div>
          <ArrowRight size={16} className="text-ink-faint" />
        </Link>
        <Link
          href="/dashboard/admin/provider-debug"
          className="flex items-center gap-3 px-5 py-4 transition-colors hover:bg-surface-2"
        >
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-red-500/10 text-red-400">
            <Stethoscope size={16} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[13.5px] font-bold">Debug Provider</p>
            <p className="text-[11.5px] text-ink-faint">Saldo, katalog & mapping vipbestmods.com — akar masalah &quot;Invalid request&quot;/&quot;Insufficient balance&quot;</p>
          </div>
          <ArrowRight size={16} className="text-ink-faint" />
        </Link>
        <Link
          href="/dashboard/admin/settings/genspay"
          className="flex items-center gap-3 px-5 py-4 transition-colors hover:bg-surface-2"
        >
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary-dim text-primary">
            <Wallet size={16} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[13.5px] font-bold">GensPay</p>
            <p className="text-[11.5px] text-ink-faint">Kredensial payment gateway QRIS + test/debug</p>
          </div>
          <ArrowRight size={16} className="text-ink-faint" />
        </Link>
        <Link
          href="/dashboard/admin/settings/pakasir"
          className="flex items-center gap-3 px-5 py-4 transition-colors hover:bg-surface-2"
        >
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary-dim text-primary">
            <Wallet size={16} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[13.5px] font-bold">Pakasir (API v2)</p>
            <p className="text-[11.5px] text-ink-faint">Gateway QRIS kedua + saklar gateway aktif (GensPay/Pakasir/WijayaPay) + test</p>
          </div>
          <ArrowRight size={16} className="text-ink-faint" />
        </Link>
        <Link
          href="/dashboard/admin/settings/wijayapay"
          className="flex items-center gap-3 px-5 py-4 transition-colors hover:bg-surface-2"
        >
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary-dim text-primary">
            <Wallet size={16} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[13.5px] font-bold">WijayaPay</p>
            <p className="text-[11.5px] text-ink-faint">Gateway QRIS ketiga (top up saldo) + saklar gateway aktif + test</p>
          </div>
          <ArrowRight size={16} className="text-ink-faint" />
        </Link>
        <Link
          href="/dashboard/admin/stores"
          className="flex items-center gap-3 px-5 py-4 transition-colors hover:bg-surface-2"
        >
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary-dim text-primary">
            <Store size={16} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[13.5px] font-bold">Toko Seller</p>
            <p className="text-[11.5px] text-ink-faint">Toko link buatan reseller: lihat & blokir kalau perlu</p>
          </div>
          <ArrowRight size={16} className="text-ink-faint" />
        </Link>
        <Link
          href="/dashboard/admin/settings/partner-api"
          className="flex items-center gap-3 px-5 py-4 transition-colors hover:bg-surface-2"
        >
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary-dim text-primary">
            <KeyRound size={16} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[13.5px] font-bold">Partner API</p>
            <p className="text-[11.5px] text-ink-faint">API Key buat toko client (mis. Toko A) auto-restock</p>
          </div>
          <ArrowRight size={16} className="text-ink-faint" />
        </Link>
        <Link
          href="/dashboard/admin/topup-packages"
          className="flex items-center gap-3 px-5 py-4 transition-colors hover:bg-surface-2"
        >
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary-dim text-primary">
            <Wallet size={16} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[13.5px] font-bold">Paket Top Up</p>
            <p className="text-[11.5px] text-ink-faint">Edit nominal & bonus paket top up</p>
          </div>
          <ArrowRight size={16} className="text-ink-faint" />
        </Link>
        <Link
          href="/dashboard/admin/broadcasts"
          className="flex items-center gap-3 px-5 py-4 transition-colors hover:bg-surface-2"
        >
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary-dim text-primary">
            <Megaphone size={16} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[13.5px] font-bold">Broadcast Notifikasi</p>
            <p className="text-[11.5px] text-ink-faint">Kirim pengumuman ke semua reseller</p>
          </div>
          <ArrowRight size={16} className="text-ink-faint" />
        </Link>
        <Link
          href="/dashboard/admin/key-history"
          className="flex items-center gap-3 px-5 py-4 transition-colors hover:bg-surface-2"
        >
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary-dim text-primary">
            <History size={16} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[13.5px] font-bold">Riwayat Key</p>
            <p className="text-[11.5px] text-ink-faint">Lihat key yang digenerate lintas semua reseller</p>
          </div>
          <ArrowRight size={16} className="text-ink-faint" />
        </Link>
        {SELLER_ENABLED && (
          <>
        <Link
          href="/dashboard/admin/sellers"
          className="flex items-center gap-3 px-5 py-4 transition-colors hover:bg-surface-2"
        >
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary-dim text-primary">
            <Store size={16} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[13.5px] font-bold">Seller</p>
            <p className="text-[11.5px] text-ink-faint">Daftar toko, suspend/aktifkan, komisi per toko</p>
          </div>
          <ArrowRight size={16} className="text-ink-faint" />
        </Link>
        <Link
          href="/dashboard/admin/withdrawals"
          className="flex items-center gap-3 px-5 py-4 transition-colors hover:bg-surface-2"
        >
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary-dim text-primary">
            <Banknote size={16} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[13.5px] font-bold">Penarikan Saldo Seller</p>
            <p className="text-[11.5px] text-ink-faint">Antrian permintaan tarik saldo</p>
          </div>
          <ArrowRight size={16} className="text-ink-faint" />
        </Link>
        <Link
          href="/dashboard/admin/disputes"
          className="flex items-center gap-3 px-5 py-4 transition-colors hover:bg-surface-2"
        >
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary-dim text-primary">
            <Scale size={16} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[13.5px] font-bold">Komplain Pembeli</p>
            <p className="text-[11.5px] text-ink-faint">Putuskan refund atau lepas ke seller</p>
          </div>
          <ArrowRight size={16} className="text-ink-faint" />
        </Link>
        <Link
          href="/dashboard/admin/settings/marketplace"
          className="flex items-center gap-3 px-5 py-4 transition-colors hover:bg-surface-2"
        >
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary-dim text-primary">
            <Percent size={16} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[13.5px] font-bold">Pengaturan Marketplace</p>
            <p className="text-[11.5px] text-ink-faint">Komisi default, masa tahan saldo, margin minimum Auto</p>
          </div>
          <ArrowRight size={16} className="text-ink-faint" />
        </Link>
          </>
        )}
      </div>
    </div>
  );
}

const TONES = {
  indigo: { box: "bg-indigo-500/10 border-indigo-500/20 hover:bg-indigo-500/20", text: "text-indigo-300", icon: "text-indigo-400", grad: "rgba(99,102,241,.12),rgba(139,92,246,.06)", line: "rgba(99,102,241,.25)" },
  emerald: { box: "bg-emerald-500/10 border-emerald-500/20 hover:bg-emerald-500/20", text: "text-emerald-300", icon: "text-emerald-400", grad: "rgba(16,185,129,.1),rgba(5,150,105,.05)", line: "rgba(16,185,129,.25)" },
  blue: { box: "bg-blue-500/10 border-blue-500/20 hover:bg-blue-500/20", text: "text-blue-300", icon: "text-blue-400", grad: "rgba(59,130,246,.1),rgba(37,99,235,.05)", line: "rgba(59,130,246,.25)" },
  amber: { box: "bg-amber-500/10 border-amber-500/20 hover:bg-amber-500/20", text: "text-amber-300", icon: "text-amber-400", grad: "rgba(234,179,8,.1),rgba(245,158,11,.05)", line: "rgba(234,179,8,.25)" },
  purple: { box: "bg-purple-500/10 border-purple-500/20 hover:bg-purple-500/20", text: "text-purple-300", icon: "text-purple-400", grad: "rgba(168,85,247,.1),rgba(126,34,206,.05)", line: "rgba(168,85,247,.25)" },
  pink: { box: "bg-pink-500/10 border-pink-500/20 hover:bg-pink-500/20", text: "text-pink-300", icon: "text-pink-400", grad: "rgba(236,72,153,.1),rgba(190,24,93,.05)", line: "rgba(236,72,153,.25)" },
} as const;
type Tone = keyof typeof TONES;

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  tone = "indigo",
}: {
  icon: typeof Package;
  label: string;
  value: number;
  sub?: string;
  tone?: Tone;
}) {
  const t = TONES[tone];
  return (
    <div className="hm-stat-card" style={{ background: `linear-gradient(135deg,${t.grad})`, borderColor: t.line }}>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint">{label}</span>
        <Icon size={18} className={t.icon} />
      </div>
      <p className="font-display text-2xl font-black text-white">{value}</p>
      {sub && <p className="mt-1 text-[10px] text-ink-faint">{sub}</p>}
    </div>
  );
}

function QuickAction({ href, icon: Icon, label, tone }: { href: string; icon: typeof Package; label: string; tone: Tone }) {
  const t = TONES[tone];
  return (
    <Link href={href} className={`flex flex-col items-center gap-1.5 rounded-xl border p-3 transition-all ${t.box}`}>
      <Icon size={20} className={t.icon} />
      <span className={`text-[10px] font-semibold ${t.text}`}>{label}</span>
    </Link>
  );
}
