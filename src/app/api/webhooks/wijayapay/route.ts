import { NextResponse } from "next/server";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { getWijayapayStatus, verifyWijayapaySignature } from "@/lib/provider/wijayapay";

/**
 * Webhook WijayaPay (kontrak lengkap: src/lib/provider/wijayapay.ts).
 *
 *   POST atau GET, payload { data:{ ref_id, total_dibayar, ... }, status:"paid" }
 *   header X-Signature = md5(code_merchant + api_key + ref_id)
 *   Balasan WAJIB JSON { "status": true } -- selain itu WijayaPay menganggap gagal.
 *
 * Keamanan berlapis -- payload TIDAK dipercaya mentah-mentah:
 *  1. Kalau header X-Signature ada, wajib cocok (kalau tidak cocok -> 401).
 *  2. Status dikonfirmasi lewat API get-status memakai kredensial kita sendiri;
 *     hanya "paid" dengan nominal >= nominal top up yang dikreditkan.
 *  3. user_id / nominal / bonus selalu dari baris pending kita (merchant_ref = ref_id).
 * Kalau API WijayaPay tidak terjangkau: dikreditkan hanya jika signature ada DAN cocok;
 * kalau tidak, balas 503 supaya dicoba lagi.
 */
export const maxDuration = 30;

async function logWebhook(
  admin: ReturnType<typeof createAdminSupabase>,
  result: string,
  orderId: string | null,
  detail?: Record<string, unknown>
) {
  if (!admin) return;
  try {
    await admin.from("webhook_log").insert({ provider: "wijayapay", result, order_id: orderId, detail: detail ?? null });
  } catch {
    // best-effort
  }
}

const ack = () => NextResponse.json({ status: true });

async function handle(request: Request, payload: Record<string, unknown>) {
  if (!isSupabaseConfigured) return NextResponse.json({ status: false, error: "supabase_not_configured" }, { status: 503 });
  const admin = createAdminSupabase();
  if (!admin) return NextResponse.json({ status: false, error: "service_role_missing" }, { status: 500 });

  const data = (payload.data && typeof payload.data === "object" ? payload.data : payload) as Record<string, unknown>;
  const refId = String(data.ref_id ?? payload.ref_id ?? "");
  const status = String(payload.status ?? data.status ?? payload.status_pembayaran ?? "").toLowerCase();
  const sig = request.headers.get("x-signature");

  if (!refId) {
    await logWebhook(admin, "bad_payload", null, { keys: Object.keys(payload).slice(0, 10) });
    return NextResponse.json({ status: false, error: "missing_ref_id" }, { status: 400 });
  }

  const sigProvided = Boolean(sig);
  const sigOk = sigProvided && (await verifyWijayapaySignature(refId, sig));
  if (sigProvided && !sigOk) {
    await logWebhook(admin, "signature_invalid", refId);
    return NextResponse.json({ status: false, error: "invalid_signature" }, { status: 401 });
  }

  // Pengujian dari dashboard / pesanan bukan top up kita.
  const { data: pending, error: lookupError } = await admin
    .from("topups")
    .select("user_id, nominal, bonus")
    .eq("merchant_ref", refId)
    .neq("status", "success") // bayar telat tetap dikreditkan
    .maybeSingle();
  if (lookupError) {
    await logWebhook(admin, "error", refId, { stage: "pending_lookup", message: lookupError.message });
    return NextResponse.json({ status: false, error: "lookup_failed" }, { status: 500 });
  }
  if (!pending) {
    await logWebhook(admin, "no_pending_row", refId);
    return ack();
  }
  const nominal = pending.nominal as number;

  if (status !== "paid") {
    await logWebhook(admin, "not_paid_status", refId, { status: status || "unknown" });
    return ack();
  }

  const paidAmt = Number(data.total_dibayar);
  if (Number.isFinite(paidAmt) && paidAmt > 0 && paidAmt < nominal) {
    await logWebhook(admin, "amount_mismatch", refId, { nominal, total_dibayar: paidAmt });
    return NextResponse.json({ status: false, error: "amount_mismatch" }, { status: 400 });
  }

  const verified = await getWijayapayStatus(refId);
  if (verified.success) {
    if (verified.status !== "paid") {
      await logWebhook(admin, "verify_not_paid", refId, { status: verified.status });
      return ack();
    }
    if (verified.amount !== null && verified.amount < nominal) {
      await logWebhook(admin, "verify_mismatch", refId, { apiAmount: verified.amount, nominal });
      return NextResponse.json({ status: false, error: "verify_mismatch" }, { status: 400 });
    }
  } else if (!sigOk) {
    await logWebhook(admin, "verify_unavailable", refId, { message: verified.message });
    return NextResponse.json({ status: false, error: "verify_unavailable" }, { status: 503 });
  } else {
    await logWebhook(admin, "verify_skipped_signature_ok", refId, { message: verified.message });
  }

  const { error } = await admin.rpc("settle_topup", {
    p_provider_ref: refId,
    p_user_id: pending.user_id as string,
    p_nominal: nominal,
    p_bonus: pending.bonus as number,
  });
  if (error) {
    await logWebhook(admin, "error", refId, { stage: "settle_topup", message: error.message });
    return NextResponse.json({ status: false, error: "settle_failed" }, { status: 500 });
  }

  await logWebhook(admin, "settled", refId, { nominal });
  return ack();
}

export async function POST(request: Request) {
  const rawBody = await request.text();
  if (rawBody.length > 20000) return NextResponse.json({ status: false, error: "too_large" }, { status: 413 });
  let payload: Record<string, unknown> = {};
  try {
    payload = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
  } catch {
    try {
      payload = Object.fromEntries(new URLSearchParams(rawBody));
    } catch {
      payload = {};
    }
  }
  return handle(request, payload);
}

export async function GET(request: Request) {
  const sp = new URL(request.url).searchParams;
  if (!sp.get("ref_id")) {
    return NextResponse.json({ status: true, message: "WijayaPay webhook endpoint active" });
  }
  return handle(request, Object.fromEntries(sp));
}
