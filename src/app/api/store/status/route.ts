import { NextResponse } from "next/server";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { checkRateLimit } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/store/common";
import { fulfillStoreOrder } from "@/lib/store/fulfill";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const noStore = { "Cache-Control": "no-store" };
const PENDING_TTL_MS = 30 * 60 * 1000;

/** Dipolling halaman pesanan pembeli. Token acak = satu-satunya akses ke key. */
export async function GET(request: Request) {
  if (!isSupabaseConfigured) return NextResponse.json({ error: "supabase_not_configured" }, { status: 503, headers: noStore });
  const token = new URL(request.url).searchParams.get("token") || "";
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return NextResponse.json({ error: "bad_token" }, { status: 400, headers: noStore });

  const admin = createAdminSupabase();
  if (!admin) return NextResponse.json({ error: "service_role_missing" }, { status: 500, headers: noStore });

  if (!(await checkRateLimit(admin, `store-status:${getClientIp(request)}`, { maxHits: 60, windowSeconds: 60 }))) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: noStore });
  }

  const load = () =>
    admin
      .from("store_orders")
      .select("merchant_ref, status, fail_reason, product_name, duration_label, sell_price, gross_amount, created_at, key_id, store_user_id")
      .eq("token", token)
      .maybeSingle();

  let { data: o } = await load();
  if (!o) return NextResponse.json({ error: "not_found" }, { status: 404, headers: noStore });

  // Webhook sudah menandai paid tapi pengiriman belum selesai (mis. timeout): selesaikan di sini.
  if (o.status === "paid") {
    await fulfillStoreOrder(admin, o.merchant_ref as string);
    ({ data: o } = await load());
    if (!o) return NextResponse.json({ error: "not_found" }, { status: 404, headers: noStore });
  }

  if (o.status === "pending" && Date.now() - new Date(o.created_at as string).getTime() > PENDING_TTL_MS) {
    await admin.from("store_orders").update({ status: "expired" }).eq("merchant_ref", o.merchant_ref).eq("status", "pending");
    o = { ...o, status: "expired" };
  }

  let key: string | null = null;
  if (o.status === "delivered" && o.key_id) {
    const { data: k } = await admin.from("reseller_keys").select("key_string").eq("id", o.key_id).maybeSingle();
    key = (k?.key_string as string) ?? null;
  }

  const { data: store } = await admin.from("stores").select("name, contact_wa").eq("user_id", o.store_user_id).maybeSingle();

  return NextResponse.json(
    {
      status: o.status,
      productName: o.product_name,
      durationLabel: o.duration_label,
      price: o.sell_price,
      amount: o.gross_amount,
      key,
      storeName: store?.name ?? null,
      sellerWa: store?.contact_wa ?? null,
      failMessage: o.status === "paid_failed" ? o.fail_reason : null,
    },
    { headers: noStore }
  );
}
