import { createServerSupabase } from "@/lib/supabase/server";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { PRODUCTS } from "@/lib/mock-data";
import { Product } from "@/lib/types";

// Embed to-one dari PostgREST kadang bertipe array -- ratakan sekali di sini.
function one<T>(v: T | T[] | null | undefined): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

type SellerEmbed = { store_name: string; status: string };

export async function getProducts(): Promise<Product[]> {
  if (!isSupabaseConfigured) return PRODUCTS;

  const supabase = await createServerSupabase();
  if (!supabase) return PRODUCTS;

  // Tabel sellers tanpa policy RLS (lihat 0013_marketplace_sellers.sql), jadi
  // join nama toko HARUS lewat service role. Fallback ke client cookie kalau
  // service role tidak ada -- tanpa info seller (pembelian listing seller
  // tetap diblok di RPC kalau seller-nya nonaktif).
  const client = createAdminSupabase() ?? supabase;

  const { data, error } = await client
    .from("products")
    .select("id, name, category, seller_id, sellers ( store_name, status ), product_durations ( id, label, days, price )")
    .eq("active", true)
    .order("sort_order");

  if (error || !data) return PRODUCTS;

  return data
    .filter((p) => one<SellerEmbed>(p.sellers)?.status !== "suspended")
    .map((p) => ({
    id: p.id,
    name: p.name,
    category: p.category,
    sellerName: one<SellerEmbed>(p.sellers)?.store_name ?? null,
    durations: (p.product_durations ?? [])
      .slice()
      .sort((a: { days: number }, b: { days: number }) => a.days - b.days),
  }));
}

/**
 * Same as getProducts(), but overrides each duration's `price` with the
 * result of effective_key_price() for the given user so that the Generate
 * page shows the user's actual price (custom or tier) instead of the
 * default product price.
 *
 * Uses the admin client (service role) because effective_key_price() needs
 * to read from custom_prices and price_tiers which have no authenticated
 * RLS policy -- the only caller is a server component that already
 * confirmed the user is logged in.
 */
export async function getProductsWithEffectivePrice(userId: string): Promise<Product[]> {
  if (!isSupabaseConfigured) return PRODUCTS;

  const admin = createAdminSupabase();
  if (!admin) return getProducts();

  // Fetch all active products + durations
  const { data: products, error: pErr } = await admin
    .from("products")
    .select("id, name, category, seller_id, sellers ( store_name, status ), product_durations ( id, label, days, price )")
    .eq("active", true)
    .order("sort_order");

  if (pErr || !products) return getProducts();

  // Harga efektif SEMUA produk platform dalam 1 query (effective_key_prices,
  // 0015) -- menggantikan 1 RPC per durasi. Kalau RPC belum ada (migrasi
  // belum jalan), jatuh ke jalur lama per-durasi di bawah.
  const { data: bulkPrices, error: bulkErr } = await admin.rpc("effective_key_prices", { p_user_id: userId });
  const priceMap = new Map<string, number>();
  if (!bulkErr && Array.isArray(bulkPrices)) {
    for (const r of bulkPrices as { product_id: string; duration_id: string; price: number }[]) {
      priceMap.set(`${r.product_id}\u0000${r.duration_id}`, Number(r.price));
    }
  }
  const bulkOk = !bulkErr && Array.isArray(bulkPrices);

  // Resolve effective price per duration in parallel
  const visible = products.filter((p) => one<SellerEmbed>(p.sellers)?.status !== "suspended");
  const result = await Promise.all(
    visible.map(async (p) => {
      const sellerName = one<SellerEmbed>(p.sellers)?.store_name ?? null;
      // Listing seller TIDAK pakai tier/harga custom (harga = harga yang
      // seller set, sama persis dengan yang dipotong generate_key_seller_*).
      if (p.seller_id) {
        const plain = ((p.product_durations ?? []) as { id: string; label: string; days: number; price: number }[])
          .slice()
          .sort((a, b) => a.days - b.days);
        return { id: p.id, name: p.name, category: p.category, sellerName, durations: plain };
      }
      const durations = await Promise.all(
        ((p.product_durations ?? []) as { id: string; label: string; days: number; price: number }[])
          .slice()
          .sort((a, b) => a.days - b.days)
          .map(async (d) => {
            if (bulkOk) {
              const bp = priceMap.get(`${p.id}\u0000${d.id}`);
              return { ...d, price: typeof bp === "number" && Number.isFinite(bp) ? bp : d.price };
            }
            const { data } = await admin.rpc("effective_key_price", {
              p_user_id: userId,
              p_product_id: p.id,
              p_duration_id: d.id,
              p_default_price: d.price,
            });
            return { ...d, price: typeof data === "number" ? data : d.price };
          })
      );
      return { id: p.id, name: p.name, category: p.category, sellerName, durations };
    })
  );

  return result;
}
