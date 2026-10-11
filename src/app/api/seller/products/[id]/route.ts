import { NextResponse } from "next/server";
import { requireActiveSeller, ownsProduct } from "@/lib/seller-context";
import { isSameOriginRequest } from "@/lib/origin-guard";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireActiveSeller();
  if (!ctx.ok) return ctx.response;
  const { id } = await params;

  const { data: product } = await ctx.admin
    .from("products")
    .select("id, name, category, active, product_durations ( id, label, days, price, stock_mode, provider_item_id )")
    .eq("id", id)
    .eq("seller_id", ctx.seller.id)
    .maybeSingle();
  if (!product) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // Jumlah stok manual yang belum terpakai per durasi.
  const { data: stockRows } = await ctx.admin
    .from("key_stock")
    .select("duration_id")
    .eq("product_id", id)
    .eq("seller_id", ctx.seller.id)
    .eq("used", false);
  const counts: Record<string, number> = {};
  for (const r of stockRows ?? []) counts[r.duration_id] = (counts[r.duration_id] ?? 0) + 1;

  return NextResponse.json({
    product: {
      ...product,
      product_durations: (product.product_durations ?? []).map((d: { id: string }) => ({ ...d, stock_count: counts[d.id] ?? 0 })),
    },
  });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  const ctx = await requireActiveSeller();
  if (!ctx.ok) return ctx.response;
  const { id } = await params;
  if (!(await ownsProduct(ctx.admin, id, ctx.seller.id))) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const body = await request.json().catch(() => null);
  const patch: Record<string, unknown> = {};
  if (typeof body?.active === "boolean") patch.active = body.active;
  if (typeof body?.name === "string" && body.name.trim()) patch.name = body.name.trim().slice(0, 80);
  if (typeof body?.category === "string" && body.category.trim()) patch.category = body.category.trim().slice(0, 40);
  if (Object.keys(patch).length === 0) return NextResponse.json({ error: "nothing_to_update" }, { status: 400 });

  const { error } = await ctx.admin.from("products").update(patch).eq("id", id).eq("seller_id", ctx.seller.id);
  if (error) return NextResponse.json({ error: "update_failed", message: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
