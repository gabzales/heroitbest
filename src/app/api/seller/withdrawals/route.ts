import { NextResponse } from "next/server";
import { requireActiveSeller } from "@/lib/seller-context";
import { isSameOriginRequest } from "@/lib/origin-guard";
import { checkRateLimit } from "@/lib/rate-limit";

export async function GET() {
  const auth = await requireActiveSeller();
  if (!auth.ok) return auth.response;
  const { data, error } = await auth.admin
    .from("withdrawal_requests")
    .select("id, amount, status, admin_note, requested_at, resolved_at")
    .eq("seller_id", auth.seller.id)
    .order("requested_at", { ascending: false })
    .limit(50);
  if (error) return NextResponse.json({ error: "query_failed", message: error.message }, { status: 500 });
  return NextResponse.json({ withdrawals: data ?? [] });
}

export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  const auth = await requireActiveSeller();
  if (!auth.ok) return auth.response;

  const body = await request.json().catch(() => null);
  const amount = Number(body?.amount);
  if (!Number.isSafeInteger(amount) || amount <= 0) return NextResponse.json({ error: "invalid_amount", message: "Jumlah harus bilangan bulat > 0." }, { status: 400 });

  const allowed = await checkRateLimit(auth.admin, `seller-withdraw:${auth.seller.id}`, { maxHits: 10, windowSeconds: 60 });
  if (!allowed) return NextResponse.json({ error: "rate_limited", message: "Terlalu banyak percobaan, coba lagi sebentar." }, { status: 429 });

  const { data, error } = await auth.admin.rpc("request_seller_withdrawal", { p_seller_id: auth.seller.id, p_amount: amount });
  if (error) {
    const known: Record<string, [number, string]> = {
      insufficient_available_balance: [400, "Saldo yang bisa ditarik tidak cukup (saldo masih ditahan atau ada dispute)."],
      bank_info_missing: [400, "Isi info rekening dulu di halaman toko sebelum menarik saldo."],
      seller_suspended: [403, "Toko kamu sedang dinonaktifkan."],
      invalid_amount: [400, "Jumlah tidak valid."],
      user_banned: [403, "Akun tidak dapat melakukan penarikan. Hubungi admin."],
    };
    const hit = Object.entries(known).find(([code]) => error.message.includes(code));
    if (hit) return NextResponse.json({ error: hit[0], message: hit[1][1] }, { status: hit[1][0] });
    console.error("request_seller_withdrawal failed:", error.message);
    return NextResponse.json({ error: "withdraw_failed", message: "Gagal mengajukan penarikan." }, { status: 500 });
  }
  return NextResponse.json({ withdrawal: data });
}
