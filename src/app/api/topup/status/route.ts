import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { checkStenlyStatus, getActivePaymentGateway } from "@/lib/provider/stenly";

// Pending lebih lama dari ini dianggap kedaluwarsa (QRIS gateway biasanya
// 15-30 menit). Pembayaran telat tetap dikreditkan oleh webhook.
const PENDING_TTL_MS = 30 * 60 * 1000;
// Reconcile ke gateway hanya setelah pending cukup lama (webhook normalnya
// datang dalam hitungan detik) -- hemat request ke gateway/Supabase.
const RECONCILE_AFTER_MS = 45 * 1000;

/**
 * Polled by TopupForm's QR modal every few seconds while a GensPay QRIS
 * payment is pending -- webhook settlement is still the source of truth
 * (see src/app/api/webhooks/topup/route.ts), this endpoint just lets the
 * client find out it already happened without a full page reload.
 *
 * Reads via the user's own session (RLS "users read own topups" policy),
 * NOT the service-role client -- this route only ever needs to read a row
 * the requesting user already owns, so there's no reason to bypass RLS
 * here the way /api/topup/create and the webhook legitimately do.
 */
export async function GET(request: Request) {
  if (!isSupabaseConfigured) {
    return NextResponse.json({ error: "supabase_not_configured" }, { status: 503 });
  }

  const { searchParams } = new URL(request.url);
  const ref = searchParams.get("ref");
  if (!ref) {
    return NextResponse.json({ error: "missing_ref" }, { status: 400 });
  }

  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = (await supabase?.auth.getUser()) ?? { data: { user: null } };
  if (!user || !supabase) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { data, error } = await supabase
    .from("topups")
    .select("status, total, nominal, bonus, created_at")
    .eq("merchant_ref", ref)
    .eq("user_id", user.id) // belt-and-suspenders on top of RLS -- explicit is cheap here
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: "query_failed", message: error.message }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  let status = data.status as "pending" | "success" | "expired" | "failed";
  if (status === "pending") {
    const age = Date.now() - new Date(data.created_at as string).getTime();
    const admin = createAdminSupabase();
    if (admin) {
      // stenly.id TIDAK retry webhook (per dokumentasinya) -- satu webhook
      // yang gagal = saldo tidak pernah masuk. Cek langsung ke gateway.
      if (age > RECONCILE_AFTER_MS && (await getActivePaymentGateway()) === "stenly") {
        const st = await checkStenlyStatus(ref);
        if (st.success && st.status === "paid") {
          const { data: row } = await admin
            .from("topups")
            .select("user_id, nominal, bonus")
            .eq("merchant_ref", ref)
            .eq("user_id", user.id)
            .neq("status", "success")
            .maybeSingle();
          if (row) {
            const { error: sErr } = await admin.rpc("settle_topup", {
              p_provider_ref: ref,
              p_user_id: row.user_id,
              p_nominal: row.nominal,
              p_bonus: row.bonus,
            });
            if (!sErr) status = "success";
          }
        } else if (st.success && (st.status === "expired" || st.status === "cancelled")) {
          await admin.rpc("mark_topup_final", { p_merchant_ref: ref, p_status: "expired" });
          status = "expired";
        }
      }
      if (status === "pending" && age > PENDING_TTL_MS) {
        await admin.rpc("mark_topup_final", { p_merchant_ref: ref, p_status: "expired" });
        status = "expired";
      }
    }
  }

  return NextResponse.json({
    status,
    total: data.total,
    nominal: data.nominal,
    bonus: data.bonus,
  });
}
