import { NextResponse } from "next/server";
import { getAdminUser } from "@/lib/require-admin";
import { createAdminSupabase } from "@/lib/supabase/admin";

export async function GET() {
  if (!(await getAdminUser())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const admin = createAdminSupabase();
  if (!admin) return NextResponse.json({ error: "service_role_missing" }, { status: 500 });

  const { data, error } = await admin
    .from("sellers")
    .select("id, store_name, store_slug, status, commission_percent, bank_name, created_at, users ( email )")
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) return NextResponse.json({ error: "query_failed", message: error.message }, { status: 500 });

  type Bal = { pending: number; available: number; paid_out: number };
  // 1 query set-based (seller_balances_bulk, 0015) menggantikan 1 RPC per seller.
  const balById = new Map<string, Bal>();
  let bulkOk = false;
  if ((data ?? []).length > 0) {
    const { data: bulk, error: bulkErr } = await admin.rpc("seller_balances_bulk", { p_seller_ids: (data ?? []).map((s) => s.id) });
    if (!bulkErr && Array.isArray(bulk)) {
      bulkOk = true;
      for (const b of bulk as (Bal & { seller_id: string })[]) balById.set(b.seller_id, b);
    }
  } else {
    bulkOk = true;
  }

  const sellers = await Promise.all(
    (data ?? []).map(async (s) => {
      let row: Bal | undefined = balById.get(s.id);
      if (!row && !bulkOk) {
        // Fallback (migrasi 0015 belum dijalankan): perilaku lama.
        const { data: bal } = await admin.rpc("seller_balance", { p_seller_id: s.id });
        row = (Array.isArray(bal) ? bal[0] : bal) as Bal | undefined;
      }
      const u = Array.isArray(s.users) ? s.users[0] : s.users;
      return {
        id: s.id,
        storeName: s.store_name,
        storeSlug: s.store_slug,
        status: s.status,
        commissionPercent: s.commission_percent as number | null,
        email: (u as { email?: string } | null)?.email ?? "-",
        createdAt: s.created_at,
        pending: row?.pending ?? 0,
        available: row?.available ?? 0,
        paidOut: row?.paid_out ?? 0,
      };
    })
  );
  return NextResponse.json({ sellers });
}
