import { NextResponse } from "next/server";
import { getAdminUser } from "@/lib/require-admin";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { isSameOriginRequest } from "@/lib/origin-guard";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await getAdminUser())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  const { id } = await params;
  const body = await request.json().catch(() => null);

  const patch: Record<string, unknown> = {};
  if (body?.status === "active" || body?.status === "suspended") patch.status = body.status;
  if (body && "commissionPercent" in body) {
    if (body.commissionPercent === null) {
      patch.commission_percent = null; // balik ke default global
    } else {
      // Number("")/Number(false)/Number([]) == 0 -> komisi 0% tanpa sengaja; hanya terima number/string angka.
      const raw = body.commissionPercent;
      const c = typeof raw === "number" || (typeof raw === "string" && raw.trim() !== "") ? Number(raw) : NaN;
      if (!Number.isFinite(c) || c < 0 || c > 100) return NextResponse.json({ error: "invalid_commission", message: "Komisi harus 0-100." }, { status: 400 });
      patch.commission_percent = c;
    }
  }
  if (Object.keys(patch).length === 0) return NextResponse.json({ error: "nothing_to_update" }, { status: 400 });

  const admin = createAdminSupabase();
  if (!admin) return NextResponse.json({ error: "service_role_missing" }, { status: 500 });
  const { error } = await admin.from("sellers").update(patch).eq("id", id);
  if (error) return NextResponse.json({ error: "update_failed", message: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
