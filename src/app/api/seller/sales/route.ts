import { NextResponse } from "next/server";
import { requireActiveSeller } from "@/lib/seller-context";

export async function GET() {
  const auth = await requireActiveSeller();
  if (!auth.ok) return auth.response;

  // key_string & provider_cost SENGAJA tidak dikirim: seller tidak perlu
  // (dan tidak boleh) melihat key hasil Auto maupun ongkos supplier.
  const { data, error } = await auth.admin
    .from("reseller_keys")
    .select("id, product_name, duration_label, price, seller_earning, commission_amount, held_until, created_at")
    .eq("seller_id", auth.seller.id)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) return NextResponse.json({ error: "query_failed", message: error.message }, { status: 500 });

  const ids = (data ?? []).map((r) => r.id);
  const disputed = new Set<string>();
  if (ids.length > 0) {
    const { data: disputes } = await auth.admin.from("order_disputes").select("reseller_key_id").in("reseller_key_id", ids).eq("status", "open");
    for (const d of disputes ?? []) disputed.add(d.reseller_key_id);
  }
  return NextResponse.json({ sales: (data ?? []).map((r) => ({ ...r, disputed: disputed.has(r.id) })) });
}
