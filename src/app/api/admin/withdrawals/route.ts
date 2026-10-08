import { NextResponse } from "next/server";
import { getAdminUser } from "@/lib/require-admin";
import { createAdminSupabase } from "@/lib/supabase/admin";

export async function GET() {
  if (!(await getAdminUser())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const admin = createAdminSupabase();
  if (!admin) return NextResponse.json({ error: "service_role_missing" }, { status: 500 });

  const { data, error } = await admin
    .from("withdrawal_requests")
    .select("id, amount, status, bank_snapshot, admin_note, requested_at, resolved_at, sellers ( store_name, users ( email ) )")
    .order("requested_at", { ascending: false })
    .limit(200);
  if (error) return NextResponse.json({ error: "query_failed", message: error.message }, { status: 500 });
  return NextResponse.json({ withdrawals: data ?? [] });
}
