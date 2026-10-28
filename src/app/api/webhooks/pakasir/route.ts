import { NextResponse } from "next/server";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { getPakasirConfig, getPakasirStatus, verifyPakasirSecret } from "@/lib/provider/pakasir";

/**
 * Webhook Pakasir API v2 (lihat src/lib/provider/pakasir.ts untuk kontrak lengkapnya).
 *
 *   POST, header  X-Secret: <secret proyek>
 *   body { txn_id, order_id, amount, is_sandbox, status: "completed", completed_at }
 *
 * Dikirim HANYA saat transaksi berhasil. Retry tidak terdokumentasi, jadi
 * /api/topup/status juga mengecek ulang ke Pakasir sebagai jaring pengaman.
 *
 * Keamanan berlapis -- payload TIDAK dipercaya mentah-mentah:
 *  1. Kalau Webhook Secret diisi di panel: header X-Secret wajib cocok.
 *  2. Status dikonfirmasi lewat API Pakasir (GET transaction-status) memakai API key
 *     kita sendiri; hanya "completed" dengan order_id + nominal yang cocok yang dikreditkan.
 *  3. user_id / nominal / bonus selalu dari baris pending kita (merchant_ref = order_id),
 *     tidak pernah dari payload.
 * Kalau API Pakasir sedang tidak terjangkau: dikreditkan hanya jika secret terisi DAN cocok
 * (dan nominal sama); kalau tidak, balas 503 supaya bisa dicoba lagi.
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
    await admin.from("webhook_log").insert({ provider: "pakasir", result, order_id: orderId, detail: detail ?? null });
  } catch {
    // best-effort
  }
}

export async function POST(request: Request) {
  if (!isSupabaseConfigured) {
    return NextResponse.json({ error: "supabase_not_configured" }, { status: 503 });
  }
  const admin = createAdminSupabase();
  if (!admin) return NextResponse.json({ error: "service_role_missing" }, { status: 500 });

  const rawBody = await request.text();
  if (rawBody.length > 20000) return NextResponse.json({ error: "too_large" }, { status: 413 });

  const cfg = await getPakasirConfig();
  const secretHeader = request.headers.get("x-secret");
  const secretConfigured = Boolean(cfg.webhookSecret);
  const secretOk = secretConfigured && verifyPakasirSecret(secretHeader, cfg.webhookSecret);
  if (secretConfigured && !secretOk) {
    await logWebhook(admin, "secret_invalid", null, { hadSecretHeader: Boolean(secretHeader) });
    return NextResponse.json({ error: "invalid_secret" }, { status: 401 });
  }

  let payload: { txn_id?: string; order_id?: string; amount?: number; status?: string; is_sandbox?: boolean };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    await logWebhook(admin, "bad_payload", null, { reason: "invalid_json", rawBodyPreview: rawBody.slice(0, 200) });
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const orderId = payload.order_id;
  const txnId = payload.txn_id;
  if (typeof orderId !== "string" || typeof txnId !== "string") {
    await logWebhook(admin, "bad_payload", null, { reason: "missing_order_or_txn", payload });
    return NextResponse.json({ error: "bad_payload" }, { status: 400 });
  }

  // Pengujian dari dashboard/cron lain -- bukan pesanan topup kita.
  const { data: pending, error: lookupError } = await admin
    .from("topups")
    .select("user_id, nominal, bonus")
    .eq("merchant_ref", orderId)
    .neq("status", "success") // bayar telat tetap dikreditkan
    .maybeSingle();
  if (lookupError) {
    await logWebhook(admin, "error", orderId, { stage: "pending_lookup", message: lookupError.message });
    return NextResponse.json({ error: "lookup_failed" }, { status: 500 });
  }
  if (!pending) {
    await logWebhook(admin, "no_pending_row", orderId);
    return NextResponse.json({ ok: true, ignored: "no_pending_row" });
  }
  const nominal = pending.nominal as number;

  if (payload.status !== "completed") {
    await logWebhook(admin, "not_completed_status", orderId, { status: payload.status ?? "unknown" });
    return NextResponse.json({ ok: true, ignored: payload.status ?? "unknown_status" });
  }

  if (typeof payload.amount === "number" && payload.amount !== nominal) {
    await logWebhook(admin, "amount_mismatch", orderId, { nominal, amount: payload.amount });
    return NextResponse.json({ error: "amount_mismatch" }, { status: 400 });
  }

  // Konfirmasi ke Pakasir (sumber kebenaran).
  const verified = await getPakasirStatus(txnId);
  if (verified.success) {
    if (verified.status !== "completed") {
      await logWebhook(admin, "verify_not_completed", orderId, { status: verified.status });
      return NextResponse.json({ ok: true, ignored: `api_status_${verified.status}` });
    }
    if ((verified.orderId && verified.orderId !== orderId) || (verified.amount !== null && verified.amount !== nominal)) {
      await logWebhook(admin, "verify_mismatch", orderId, { apiOrderId: verified.orderId, apiAmount: verified.amount, nominal });
      return NextResponse.json({ error: "verify_mismatch" }, { status: 400 });
    }
  } else if (!secretOk) {
    await logWebhook(admin, "verify_unavailable", orderId, { message: verified.message });
    return NextResponse.json({ error: "verify_unavailable" }, { status: 503 });
  } else {
    await logWebhook(admin, "verify_skipped_secret_ok", orderId, { message: verified.message });
  }

  const { data, error } = await admin.rpc("settle_topup", {
    p_provider_ref: orderId,
    p_user_id: pending.user_id as string,
    p_nominal: nominal,
    p_bonus: pending.bonus as number,
  });
  if (error) {
    await logWebhook(admin, "error", orderId, { stage: "settle_topup", message: error.message });
    return NextResponse.json({ error: "settle_failed", message: error.message }, { status: 500 });
  }

  await logWebhook(admin, "settled", orderId, { nominal, sandbox: payload.is_sandbox === true });
  return NextResponse.json({ ok: true, topup: data });
}
