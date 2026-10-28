import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { checkRateLimit } from "@/lib/rate-limit";
import { isSameOriginRequest } from "@/lib/origin-guard";

const KNOWN: Record<string, [number, string]> = {
  reason_required: [400, "Tulis alasan komplain dulu."],
  key_not_found: [404, "Key tidak ditemukan."],
  not_a_marketplace_listing: [400, "Komplain hanya untuk key dari toko seller."],
  already_refunded: [409, "Key ini sudah direfund."],
  dispute_window_closed: [409, "Masa komplain untuk key ini sudah lewat."],
  dispute_already_filed: [409, "Key ini sudah pernah dikomplain."],
};

export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "bad_origin" }, { status: 403 });

  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = (await supabase?.auth.getUser()) ?? { data: { user: null } };
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const admin = createAdminSupabase();
  if (!admin) return NextResponse.json({ error: "service_role_missing" }, { status: 500 });

  const allowed = await checkRateLimit(admin, `dispute:${user.id}`, { maxHits: 10, windowSeconds: 60 });
  if (!allowed) return NextResponse.json({ error: "rate_limited", message: "Terlalu banyak percobaan, coba lagi sebentar." }, { status: 429 });

  const body = await request.json().catch(() => null);
  const keyId = typeof body?.resellerKeyId === "string" ? body.resellerKeyId : "";
  const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
  if (!keyId) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

  const { data, error } = await admin.rpc("create_order_dispute", { p_buyer_id: user.id, p_key_id: keyId, p_reason: reason });
  if (error) {
    const hit = Object.entries(KNOWN).find(([code]) => error.message.includes(code));
    if (hit) return NextResponse.json({ error: hit[0], message: hit[1][1] }, { status: hit[1][0] });
    console.error("create_order_dispute failed:", error.message);
    return NextResponse.json({ error: "dispute_failed", message: "Gagal mengirim komplain." }, { status: 500 });
  }
  return NextResponse.json({ dispute: data });
}
