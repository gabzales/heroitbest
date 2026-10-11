import { NextResponse } from "next/server";
import { getAdminUser } from "@/lib/require-admin";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { isSameOriginRequest } from "@/lib/origin-guard";

// Transisi yang boleh: pending -> approved | paid | rejected, approved -> paid | rejected.
// Update dikondisikan ke status asal (.in) supaya dua admin yang klik
// bersamaan tidak bisa saling menimpa keputusan.
const FROM: Record<string, { to: string; from: string[] }> = {
  approve: { to: "approved", from: ["pending"] },
  pay: { to: "paid", from: ["pending", "approved"] },
  reject: { to: "rejected", from: ["pending", "approved"] },
};

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await getAdminUser())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  const { id } = await params;
  const body = await request.json().catch(() => null);

  const rule = typeof body?.action === "string" ? FROM[body.action] : undefined;
  if (!rule) return NextResponse.json({ error: "invalid_action" }, { status: 400 });
  const note = typeof body?.note === "string" && body.note.trim() ? body.note.trim().slice(0, 500) : null;

  const admin = createAdminSupabase();
  if (!admin) return NextResponse.json({ error: "service_role_missing" }, { status: 500 });

  const patch: Record<string, unknown> = { status: rule.to };
  if (note !== null) patch.admin_note = note;
  if (rule.to !== "approved") patch.resolved_at = new Date().toISOString();

  const { data, error } = await admin.from("withdrawal_requests").update(patch).eq("id", id).in("status", rule.from).select("id");
  if (error) return NextResponse.json({ error: "update_failed", message: error.message }, { status: 500 });
  if (!data || data.length === 0) return NextResponse.json({ error: "stale", message: "Status permintaan sudah berubah. Muat ulang halaman." }, { status: 409 });
  return NextResponse.json({ ok: true });
}
