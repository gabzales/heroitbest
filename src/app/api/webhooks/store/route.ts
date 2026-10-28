import { NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "crypto";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { decryptSecret } from "@/lib/store/crypto";
import { fulfillStoreOrder } from "@/lib/store/fulfill";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Callback GensPay untuk pesanan toko seller. Tiap seller punya API key
 * sendiri, jadi order_id dibaca dulu (hanya untuk mencari pesanan), lalu
 * tanda tangan DIVERIFIKASI dengan key seller pemilik pesanan itu:
 *   X-GensPay-Signature = hex sha256(rawBody + apiKeySeller)
 * Tanpa tanda tangan valid, tidak ada yang diproses.
 */
function signatureValid(rawBody: string, header: string | null, secret: string): boolean {
  if (!header || !secret) return false;
  const expected = createHash("sha256").update(rawBody + secret).digest();
  if (!/^[0-9a-f]+$/i.test(header) || header.length !== expected.length * 2) return false;
  return timingSafeEqual(expected, Buffer.from(header, "hex"));
}

export async function POST(request: Request) {
  if (!isSupabaseConfigured) return NextResponse.json({ error: "supabase_not_configured" }, { status: 503 });
  const admin = createAdminSupabase();
  if (!admin) return NextResponse.json({ error: "service_role_missing" }, { status: 500 });

  const rawBody = await request.text();
  if (rawBody.length > 20000) return NextResponse.json({ error: "too_large" }, { status: 413 });

  let payload: { event?: string; data?: { order_id?: string; status?: string; amount?: number; net_amount?: number } };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const orderId = payload.data?.order_id;
  if (typeof orderId !== "string" || !/^so-[0-9a-f]{24}$/.test(orderId)) {
    return NextResponse.json({ ok: true, ignored: "not_a_store_order" });
  }

  const { data: order } = await admin
    .from("store_orders")
    .select("status, sell_price, store_user_id")
    .eq("merchant_ref", orderId)
    .maybeSingle();
  if (!order) return NextResponse.json({ ok: true, ignored: "no_order" });

  const { data: store } = await admin.from("stores").select("genspay_key_enc").eq("user_id", order.store_user_id).maybeSingle();
  const secret = decryptSecret(store?.genspay_key_enc as string | undefined);
  if (!secret || !signatureValid(rawBody, request.headers.get("x-genspay-signature"), secret)) {
    return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
  }

  if (payload.event !== "transaction.updated") return NextResponse.json({ ok: true, ignored: payload.event ?? "unknown" });

  const status = payload.data?.status;
  if (status !== "SUCCESS") {
    if (status === "EXPIRED" || status === "FAILED") {
      await admin
        .from("store_orders")
        .update({ status: status === "EXPIRED" ? "expired" : "failed" })
        .eq("merchant_ref", orderId)
        .eq("status", "pending");
    }
    return NextResponse.json({ ok: true, ignored: status ?? "unknown_status" });
  }

  // GensPay punya 2 mode fee per project (dokumentasi GensPay, bagian "Struktur Fee"):
  //  - BUYER_PAY_FEE    : pembeli bayar harga + fee  -> net_amount == harga pesanan
  //  - MERCHANT_PAY_FEE : pembeli bayar tepat harga  -> amount == harga pesanan (net_amount = harga - fee)
  // Dua-duanya sah. Yang ditolak hanya kalau tidak ada satu pun yang cocok dengan harga pesanan.
  const price = Number(order.sell_price);
  const net = payload.data?.net_amount;
  const gross = payload.data?.amount;
  const known = typeof net === "number" || typeof gross === "number";
  if (known && net !== price && gross !== price) {
    console.error("store webhook amount mismatch", { orderId, expected: price, amount: gross, net });
    return NextResponse.json({ error: "amount_mismatch" }, { status: 400 });
  }

  // pending/expired/failed -> paid (bayar telat tetap diproses); idempotent.
  await admin
    .from("store_orders")
    .update({ status: "paid", paid_at: new Date().toISOString() })
    .eq("merchant_ref", orderId)
    .in("status", ["pending", "expired", "failed"]);

  const result = await fulfillStoreOrder(admin, orderId);
  // Selalu 200 agar GensPay berhenti retry; kegagalan kirim tercatat di pesanan (paid_failed)
  // dan bisa dicoba ulang pembeli/seller.
  return NextResponse.json({ ok: true, delivered: result.ok });
}
