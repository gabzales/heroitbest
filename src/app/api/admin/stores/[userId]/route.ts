import { NextResponse } from "next/server";
import { getAdminUser } from "@/lib/require-admin";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { isSameOriginRequest } from "@/lib/origin-guard";

export const dynamic = "force-dynamic";
const noStore = { "Cache-Control": "no-store" };

// PATCH /api/admin/stores/[userId]  Body: { blocked: boolean }
// Admin menonaktifkan/mengaktifkan kembali toko seller (blokir = toko langsung tutup).
export async function PATCH(request: Request, { params }: { params: Promise<{ userId: string }> }) {
  const adminUser = await getAdminUser();
  if (!adminUser) return NextResponse.json({ error: "forbidden" }, { status: 403, headers: noStore });
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "bad_origin" }, { status: 403, headers: noStore });

  const { userId } = await params;
  const body = await request.json().catch(() => ({}));
  if (typeof body?.blocked !== "boolean") return NextResponse.json({ error: "bad_body" }, { status: 400, headers: noStore });

  const admin = createAdminSupabase();
  if (!admin) return NextResponse.json({ error: "service_role_missing" }, { status: 500, headers: noStore });

  const patch: Record<string, unknown> = { admin_blocked: body.blocked, updated_at: new Date().toISOString() };
  if (body.blocked) patch.enabled = false;
  const { data, error } = await admin.from("stores").update(patch).eq("user_id", userId).select("user_id");
  if (error) return NextResponse.json({ error: "update_failed" }, { status: 500, headers: noStore });
  if (!data?.length) return NextResponse.json({ error: "not_found" }, { status: 404, headers: noStore });
  return NextResponse.json({ ok: true }, { headers: noStore });
}
