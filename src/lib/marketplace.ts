import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getProviderProducts } from "@/lib/provider/vipibmstore";

export type MarketplaceSettings = {
  defaultCommissionPercent: number;
  pendingHoldHours: number;
  minAutoMarkupPercent: number;
  sellerAutoEnabled: boolean;
};

const n = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : fallback);

// Default HARUS sama dengan fallback di SQL (generate_key_seller_*): 10% / 48 jam.
export async function getMarketplaceSettings(admin: SupabaseClient): Promise<MarketplaceSettings> {
  const { data } = await admin.from("app_settings").select("value").eq("key", "marketplace").maybeSingle();
  const v = (data?.value ?? {}) as Record<string, unknown>;
  return {
    defaultCommissionPercent: n(v.default_commission_percent, 10),
    pendingHoldHours: n(v.pending_hold_hours, 48),
    minAutoMarkupPercent: n(v.min_auto_markup_percent, 20),
    sellerAutoEnabled: v.seller_auto_enabled !== false,
  };
}

export function minSellPrice(providerCost: number, markupPercent: number): number {
  return Math.ceil(providerCost * (1 + markupPercent / 100));
}

type AutoCheck = { ok: true } | { ok: false; status: number; message: string };

/**
 * Guard harga listing mode Auto: harga jual seller wajib >= harga katalog
 * vipbestmods SAAT INI * (1 + min_auto_markup_percent/100). Penting karena
 * tiap penjualan listing Auto motong saldo vipbestmods PLATFORM. Kalau
 * katalog tidak terjangkau kita TOLAK (bukan loloskan) -- tanpa harga acuan
 * margin tidak bisa dipastikan. Dicek saat listing dibuat/diedit saja.
 */
export async function validateAutoListingPrice(
  admin: SupabaseClient,
  providerItemId: string,
  price: number
): Promise<AutoCheck> {
  const settings = await getMarketplaceSettings(admin);
  if (!settings.sellerAutoEnabled) {
    return { ok: false, status: 403, message: "Mode Auto belum dibuka untuk seller. Gunakan mode Manual." };
  }
  const catalog = await getProviderProducts({});
  if (!catalog.success) {
    return { ok: false, status: 503, message: "Katalog provider sedang tidak terjangkau, coba lagi nanti." };
  }
  const item = catalog.data.find((p) => String(p.id) === String(providerItemId));
  if (!item) return { ok: false, status: 400, message: "Item Auto tidak ditemukan di katalog." };
  if (typeof item.price !== "number") return { ok: false, status: 502, message: "Harga acuan item ini tidak tersedia." };
  const min = minSellPrice(item.price, settings.minAutoMarkupPercent);
  if (price < min) {
    return { ok: false, status: 400, message: `Harga minimal untuk item Auto ini Rp${min.toLocaleString("id-ID")}.` };
  }
  return { ok: true };
}
