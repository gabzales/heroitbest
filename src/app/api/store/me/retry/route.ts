import { NextResponse } from "next/server";
import { checkRateLimit } from "@/lib/rate-limit";
import { fulfillStoreOrder } from "@/lib/store/fulfill";
import { getStoreSession, noStore } from "@/lib/store/session";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Seller mencoba kirim ulang key untuk pesanannya yang sudah dibayar tapi gagal terkirim (mis. setelah top up saldo). */
export async function POST(request: Request) {
  const s = await getStoreSession(request, { mutating: true });
  if (s instanceof NextResponse) return s;
  const { admin, userId } = s;
  if (!(await checkRateLimit(admin, `store-me-retry:${userId}`, { maxHits: 10, windowSeconds: 60 }))) {
    return NextResponse.json({ error: "rate_limited", message: "Tunggu sebentar lalu coba lagi." }, { status: 429, headers: noStore });
  }
  const body = await request.json().catch(() => ({}));
  const orderId = typeof body?.orderId === "string" ? body.orderId : "";
  const { data: o } = await admin
    .from("store_orders")
    .select("merchant_ref, status")
    .eq("id", orderId)
    .eq("store_user_id", userId)
    .maybeSingle();
  if (!o) return NextResponse.json({ error: "not_found", message: "Pesanan tidak ditemukan." }, { status: 404, headers: noStore });
  if (o.status !== "paid_failed" && o.status !== "paid") {
    return NextResponse.json({ ok: o.status === "delivered" }, { headers: noStore });
  }
  const r = await fulfillStoreOrder(admin, o.merchant_ref as string);
  return NextResponse.json(r.ok ? { ok: true } : { ok: false, message: r.reason }, { headers: noStore });
}
