import { NextResponse } from "next/server";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { authenticatePartnerRequest } from "@/lib/provider/partner-auth";

export const dynamic = "force-dynamic";

// GET /api/v1/partner/balance
// Header wajib: X-API-Key
// Dipakai toko client (mis. heromarket) untuk menampilkan sisa saldo akun
// partner di panel admin mereka, supaya tahu kapan harus top up.
// Hanya mengembalikan saldo akun yang terikat ke key ini -- tidak ada data lain.
export async function GET(request: Request) {
  if (!isSupabaseConfigured) {
    return NextResponse.json({ error: "supabase_not_configured" }, { status: 503 });
  }
  const partnerKey = await authenticatePartnerRequest(request.headers.get("x-api-key")?.trim() || null);
  if (!partnerKey) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  if (!partnerKey.resellerId) {
    return NextResponse.json({ error: "partner_reseller_not_configured" }, { status: 500 });
  }
  const admin = createAdminSupabase();
  if (!admin) return NextResponse.json({ error: "service_role_missing" }, { status: 500 });

  const { data, error } = await admin.from("users").select("balance").eq("id", partnerKey.resellerId).maybeSingle();
  if (error || !data) {
    return NextResponse.json({ error: "user_not_found", message: "Akun partner tidak ditemukan." }, { status: 404 });
  }
  return NextResponse.json(
    { balance: data.balance, currency: "IDR", label: partnerKey.label },
    { headers: { "Cache-Control": "no-store" } }
  );
}
