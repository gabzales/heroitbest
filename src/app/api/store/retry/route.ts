import { NextResponse } from "next/server";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { checkRateLimit } from "@/lib/rate-limit";
import { isSameOriginRequest } from "@/lib/origin-guard";
import { getClientIp } from "@/lib/store/common";
import { fulfillStoreOrder } from "@/lib/store/fulfill";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const noStore = { "Cache-Control": "no-store" };

/** Pembeli menekan "Coba kirim lagi" untuk pesanan yang SUDAH dibayar tapi key belum terkirim. */
export async function POST(request: Request) {
  if (!isSupabaseConfigured) return NextResponse.json({ error: "supabase_not_configured" }, { status: 503, headers: noStore });
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "bad_origin" }, { status: 403, headers: noStore });
  const body = await request.json().catch(() => ({}));
  const token = typeof body?.token === "string" ? body.token : "";
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return NextResponse.json({ error: "bad_token" }, { status: 400, headers: noStore });

  const admin = createAdminSupabase();
  if (!admin) return NextResponse.json({ error: "service_role_missing" }, { status: 500, headers: noStore });
  if (!(await checkRateLimit(admin, `store-retry:${getClientIp(request)}`, { maxHits: 4, windowSeconds: 60 }))) {
    return NextResponse.json({ error: "rate_limited", message: "Tunggu sebentar lalu coba lagi." }, { status: 429, headers: noStore });
  }

  const { data: o } = await admin.from("store_orders").select("merchant_ref, status").eq("token", token).maybeSingle();
  if (!o) return NextResponse.json({ error: "not_found" }, { status: 404, headers: noStore });
  if (o.status !== "paid_failed" && o.status !== "paid") {
    return NextResponse.json({ ok: o.status === "delivered" }, { headers: noStore });
  }
  const r = await fulfillStoreOrder(admin, o.merchant_ref as string);
  return NextResponse.json(r.ok ? { ok: true } : { ok: false, message: r.reason }, { headers: noStore });
}
