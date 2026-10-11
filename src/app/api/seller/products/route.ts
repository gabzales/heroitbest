import { NextResponse } from "next/server";
import { requireActiveSeller } from "@/lib/seller-context";
import { isSameOriginRequest } from "@/lib/origin-guard";

const slugify = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

export async function GET() {
  const ctx = await requireActiveSeller();
  if (!ctx.ok) return ctx.response;

  const { data, error } = await ctx.admin
    .from("products")
    .select("id, name, category, active, product_durations ( id, label, price, stock_mode )")
    .eq("seller_id", ctx.seller.id)
    .order("sort_order", { ascending: false })
    .limit(200);
  if (error) return NextResponse.json({ error: "query_failed", message: error.message }, { status: 500 });
  return NextResponse.json({ products: data ?? [] });
}

export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  const ctx = await requireActiveSeller();
  if (!ctx.ok) return ctx.response;

  const body = await request.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim().slice(0, 80) : "";
  const category = typeof body?.category === "string" && body.category.trim() ? body.category.trim().slice(0, 40) : "General";
  if (!name) return NextResponse.json({ error: "missing_name", message: "Nama produk wajib diisi." }, { status: 400 });

  // id produk = slug toko + slug nama, supaya dua seller dengan nama produk
  // sama tidak bentrok (listing TERPISAH per seller, bukan digabung).
  const base = slugify(`${ctx.seller.store_slug}-${name}`);
  if (!base) return NextResponse.json({ error: "invalid_name" }, { status: 400 });
  let id = base;
  const { data: existing } = await ctx.admin.from("products").select("id").eq("id", id).maybeSingle();
  if (existing) id = `${base}-${Date.now().toString(36)}`;

  const { data: top } = await ctx.admin.from("products").select("sort_order").order("sort_order", { ascending: false }).limit(1).maybeSingle();

  const { error } = await ctx.admin.from("products").insert({
    id,
    name,
    category,
    active: false, // aktif otomatis begitu durasi pertama ditambahkan
    sort_order: (top?.sort_order ?? 0) + 1,
    seller_id: ctx.seller.id,
  });
  if (error) return NextResponse.json({ error: "insert_failed", message: error.message }, { status: 500 });
  return NextResponse.json({ id });
}
