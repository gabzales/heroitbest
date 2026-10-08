import { NextResponse } from "next/server";
import { requireActiveSeller, ownsProduct } from "@/lib/seller-context";
import { validateAutoListingPrice } from "@/lib/marketplace";
import { isSameOriginRequest } from "@/lib/origin-guard";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  const ctx = await requireActiveSeller();
  if (!ctx.ok) return ctx.response;
  const { id: productId } = await params;
  if (!(await ownsProduct(ctx.admin, productId, ctx.seller.id))) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const body = await request.json().catch(() => null);
  const label = typeof body?.label === "string" ? body.label.trim().slice(0, 80) : "";
  const days = Number(body?.days);
  const price = Number(body?.price);
  const stockMode = body?.stockMode === "auto" ? "auto" : "manual";
  const providerItemId = typeof body?.providerItemId === "string" && body.providerItemId ? body.providerItemId : null;

  if (!label || !Number.isInteger(days) || days <= 0 || days > 3650 || !Number.isSafeInteger(price) || price < 1) {
    return NextResponse.json({ error: "invalid_fields", message: "Label, durasi (hari, bilangan bulat), dan harga (bilangan bulat) wajib valid." }, { status: 400 });
  }
  if (stockMode === "auto") {
    if (!providerItemId) return NextResponse.json({ error: "missing_provider_item", message: "Pilih item Auto dulu." }, { status: 400 });
    const check = await validateAutoListingPrice(ctx.admin, providerItemId, price);
    if (!check.ok) return NextResponse.json({ error: "price_guard", message: check.message }, { status: check.status });
  }

  const durationId = `${days}d-${Date.now().toString(36)}`;
  const { error } = await ctx.admin.from("product_durations").insert({
    id: durationId,
    product_id: productId,
    label,
    days,
    price,
    stock_mode: stockMode,
    provider_item_id: stockMode === "auto" ? providerItemId : null,
  });
  if (error) return NextResponse.json({ error: "insert_failed", message: error.message }, { status: 500 });

  // Produk mulai tampil di katalog begitu punya durasi pertama.
  await ctx.admin.from("products").update({ active: true }).eq("id", productId).eq("seller_id", ctx.seller.id);
  return NextResponse.json({ id: durationId });
}
