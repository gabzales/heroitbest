import { NextResponse } from "next/server";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { checkRateLimit } from "@/lib/rate-limit";
import { isSameOriginRequest } from "@/lib/origin-guard";
import { verifyTurnstile } from "@/lib/turnstile";
import { decryptSecret, isStoreCryptoConfigured } from "@/lib/store/crypto";
import { MIN_PRICE, createSellerQris, getAppUrl, getClientIp, newOrderRefs, normalizeSlug } from "@/lib/store/common";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const noStore = { "Cache-Control": "no-store" };
const err = (error: string, message: string, status: number) =>
  NextResponse.json({ error, message }, { status, headers: noStore });

/**
 * Pembeli publik membuat pesanan di toko seller: validasi harga/saldo/stok,
 * lalu buat tagihan QRIS di GensPay milik SELLER (uang langsung ke seller).
 * Tidak ada login -- dilindungi rate limit per IP (+ Turnstile kalau aktif).
 */
export async function POST(request: Request) {
  if (!isSupabaseConfigured) return err("supabase_not_configured", "Backend belum terhubung.", 503);
  if (!isSameOriginRequest(request)) return err("bad_origin", "Permintaan ditolak.", 403);
  if (!isStoreCryptoConfigured()) return err("store_disabled", "Fitur toko belum diaktifkan.", 503);

  const admin = createAdminSupabase();
  if (!admin) return err("service_role_missing", "Server belum siap.", 500);

  const ip = getClientIp(request);
  if (!(await checkRateLimit(admin, `store-create:${ip}`, { maxHits: 6, windowSeconds: 60 }))) {
    return err("rate_limited", "Terlalu banyak percobaan, coba lagi sebentar.", 429);
  }

  const body = await request.json().catch(() => ({}));
  const slug = normalizeSlug(body?.slug);
  const productId = typeof body?.productId === "string" ? body.productId : "";
  const durationId = typeof body?.durationId === "string" ? body.durationId : "";
  const contact = typeof body?.contact === "string" ? body.contact.trim().slice(0, 60) : "";
  if (!slug || !productId || !durationId) return err("missing_fields", "Data tidak lengkap.", 400);

  if (!(await verifyTurnstile(body?.turnstileToken, ip))) {
    return err("captcha_failed", "Verifikasi keamanan gagal, muat ulang halaman lalu coba lagi.", 400);
  }

  const { data: store } = await admin
    .from("stores")
    .select("user_id, name, enabled, admin_blocked, genspay_key_enc")
    .eq("slug", slug)
    .maybeSingle();
  if (!store || !store.enabled || store.admin_blocked || !store.genspay_key_enc) {
    return err("store_unavailable", "Toko tidak tersedia.", 404);
  }
  const apiKey = decryptSecret(store.genspay_key_enc);
  if (!apiKey) return err("store_unavailable", "Toko sedang tidak bisa menerima pembayaran.", 503);

  const sellerId = store.user_id as string;

  const { data: priceRow } = await admin
    .from("store_prices")
    .select("price, active")
    .eq("user_id", sellerId)
    .eq("product_id", productId)
    .eq("duration_id", durationId)
    .maybeSingle();
  if (!priceRow || !priceRow.active) return err("not_for_sale", "Produk ini tidak dijual di toko ini.", 404);
  const sellPrice = Number(priceRow.price);
  if (!Number.isInteger(sellPrice) || sellPrice < MIN_PRICE) return err("bad_price", "Harga tidak valid.", 400);

  const { data: dur } = await admin
    .from("product_durations")
    .select("label, price, stock_mode, products!inner(name, active, seller_id)")
    .eq("product_id", productId)
    .eq("id", durationId)
    .maybeSingle<{
      label: string;
      price: number;
      stock_mode: string;
      products: { name: string; active: boolean; seller_id: string | null } | { name: string; active: boolean; seller_id: string | null }[];
    }>();
  const prod = dur ? (Array.isArray(dur.products) ? dur.products[0] : dur.products) : null;
  if (!dur || !prod || !prod.active || prod.seller_id) return err("not_for_sale", "Produk tidak tersedia.", 404);

  // Modal seller (tier/harga custom) -- seller tidak boleh jual rugi, dan
  // saldo seller harus cukup SEBELUM pembeli diminta bayar.
  const { data: costRaw } = await admin.rpc("effective_key_price", {
    p_user_id: sellerId,
    p_product_id: productId,
    p_duration_id: durationId,
    p_default_price: dur.price,
  });
  const cost = typeof costRaw === "number" ? costRaw : dur.price;
  if (sellPrice < cost) return err("not_for_sale", "Produk sedang tidak tersedia.", 409);

  const { data: seller } = await admin.from("users").select("balance, banned").eq("id", sellerId).maybeSingle();
  if (!seller || seller.banned) return err("store_unavailable", "Toko tidak tersedia.", 404);
  if (seller.balance < cost) return err("seller_out_of_balance", "Produk sedang tidak tersedia, coba lagi nanti.", 409);

  if (dur.stock_mode !== "auto") {
    const { count } = await admin
      .from("key_stock")
      .select("id", { count: "exact", head: true })
      .eq("product_id", productId)
      .eq("duration_id", durationId)
      .eq("used", false);
    if (!count) return err("out_of_stock", "Stok key sedang habis.", 409);
  }

  const { merchantRef, token } = newOrderRefs();
  const { error: insErr } = await admin.from("store_orders").insert({
    token,
    merchant_ref: merchantRef,
    store_user_id: sellerId,
    product_id: productId,
    duration_id: durationId,
    product_name: prod.name,
    duration_label: dur.label,
    sell_price: sellPrice,
    buyer_contact: contact || null,
  });
  if (insErr) {
    console.error("store_orders insert failed:", insErr.message);
    return err("order_failed", "Gagal membuat pesanan, coba lagi.", 500);
  }

  const qris = await createSellerQris({
    apiKey,
    orderId: merchantRef,
    amount: sellPrice,
    callbackUrl: `${getAppUrl(request)}/api/webhooks/store`,
  });
  if (!qris.ok) {
    await admin.from("store_orders").update({ status: "failed", fail_reason: qris.message }).eq("merchant_ref", merchantRef);
    return err("gateway_rejected", "Toko sedang tidak bisa menerima pembayaran.", 502);
  }
  await admin.from("store_orders").update({ gross_amount: qris.amount }).eq("merchant_ref", merchantRef);

  return NextResponse.json(
    { token, qrString: qris.qrString, amount: qris.amount, expiredAt: qris.expiredAt },
    { headers: noStore }
  );
}
