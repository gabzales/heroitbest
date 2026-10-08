import { NextResponse } from "next/server";
import { requireActiveSeller, ownsProduct } from "@/lib/seller-context";
import { validateAutoListingPrice } from "@/lib/marketplace";
import { isSameOriginRequest } from "@/lib/origin-guard";

type Ctx = { params: Promise<{ id: string; durationId: string }> };

export async function PATCH(request: Request, { params }: Ctx) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  const auth = await requireActiveSeller();
  if (!auth.ok) return auth.response;
  const { id: productId, durationId } = await params;
  if (!(await ownsProduct(auth.admin, productId, auth.seller.id))) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const { data: dur } = await auth.admin
    .from("product_durations")
    .select("id, price, stock_mode, provider_item_id")
    .eq("product_id", productId)
    .eq("id", durationId)
    .maybeSingle();
  if (!dur) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const body = await request.json().catch(() => null);
  const patch: Record<string, unknown> = {};
  if (typeof body?.label === "string" && body.label.trim()) patch.label = body.label.trim().slice(0, 80);
  if (body?.price !== undefined) {
    const price = Number(body.price);
    if (!Number.isSafeInteger(price) || price < 1) return NextResponse.json({ error: "invalid_price", message: "Harga harus bilangan bulat." }, { status: 400 });
    if (dur.stock_mode === "auto") {
      const check = await validateAutoListingPrice(auth.admin, String(dur.provider_item_id), price);
      if (!check.ok) return NextResponse.json({ error: "price_guard", message: check.message }, { status: check.status });
    }
    patch.price = price;
  }
  if (Object.keys(patch).length === 0) return NextResponse.json({ error: "nothing_to_update" }, { status: 400 });

  const { error } = await auth.admin.from("product_durations").update(patch).eq("product_id", productId).eq("id", durationId);
  if (error) return NextResponse.json({ error: "update_failed", message: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request, { params }: Ctx) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  const auth = await requireActiveSeller();
  if (!auth.ok) return auth.response;
  const { id: productId, durationId } = await params;
  if (!(await ownsProduct(auth.admin, productId, auth.seller.id))) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const { error } = await auth.admin.from("product_durations").delete().eq("product_id", productId).eq("id", durationId);
  if (error) return NextResponse.json({ error: "delete_failed", message: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
