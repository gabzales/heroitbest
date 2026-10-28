import { NextResponse } from "next/server";
import { getAdminUser } from "@/lib/require-admin";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { isSameOriginRequest } from "@/lib/origin-guard";

const KNOWN: Record<string, [number, string]> = {
  invalid_resolution: [400, "Keputusan tidak valid."],
  dispute_not_found: [404, "Komplain tidak ditemukan."],
  dispute_not_open: [409, "Komplain ini sudah diputuskan. Muat ulang halaman."],
  already_refunded: [409, "Key ini sudah direfund sebelumnya."],
};

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await getAdminUser())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  const { id } = await params;
  const body = await request.json().catch(() => null);
  const resolution = typeof body?.resolution === "string" ? body.resolution : "";
  const note = typeof body?.note === "string" ? body.note.trim().slice(0, 500) : "";

  const admin = createAdminSupabase();
  if (!admin) return NextResponse.json({ error: "service_role_missing" }, { status: 500 });

  const { data, error } = await admin.rpc("resolve_order_dispute", { p_dispute_id: id, p_resolution: resolution, p_admin_note: note });
  if (error) {
    const hit = Object.entries(KNOWN).find(([code]) => error.message.includes(code));
    if (hit) return NextResponse.json({ error: hit[0], message: hit[1][1] }, { status: hit[1][0] });
    console.error("resolve_order_dispute failed:", error.message);
    return NextResponse.json({ error: "resolve_failed", message: "Gagal memutuskan komplain." }, { status: 500 });
  }
  return NextResponse.json({ dispute: data });
}
