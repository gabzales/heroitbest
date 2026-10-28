import { NextResponse } from "next/server";
import { checkRateLimit } from "@/lib/rate-limit";
import { MIN_PRICE } from "@/lib/store/common";
import { getStoreSession, noStore } from "@/lib/store/session";

export const dynamic = "force-dynamic";

type Item = { productId?: unknown; durationId?: unknown; price?: unknown; active?: unknown };

/**
 * Simpan harga jual per varian. price kosong/null = hapus dari toko.
 * Harga jual tidak boleh di bawah modal seller (tier/harga custom) atau Rp1.000.
 */
export async function PUT(request: Request) {
  const s = await getStoreSession(request, { mutating: true });
  if (s instanceof NextResponse) return s;
  const { admin, userId } = s;

  if (!(await checkRateLimit(admin, `store-prices:${userId}`, { maxHits: 20, windowSeconds: 60 }))) {
    return NextResponse.json({ error: "rate_limited", message: "Terlalu banyak percobaan." }, { status: 429, headers: noStore });
  }
  const { data: store } = await admin.from("stores").select("user_id").eq("user_id", userId).maybeSingle();
  if (!store) return NextResponse.json({ error: "no_store", message: "Simpan nama & link toko dulu." }, { status: 400, headers: noStore });

  const body = await request.json().catch(() => ({}));
  const items: Item[] = Array.isArray(body?.items) ? body.items.slice(0, 500) : [];
  if (!items.length) return NextResponse.json({ error: "empty", message: "Tidak ada perubahan." }, { status: 400, headers: noStore });

  // Modal efektif seller untuk SEMUA varian platform dalam satu query.
  const { data: costs, error: costErr } = await admin.rpc("effective_key_prices", { p_user_id: userId });
  if (costErr || !Array.isArray(costs)) {
    return NextResponse.json({ error: "cost_failed", message: "Gagal membaca harga modal." }, { status: 500, headers: noStore });
  }
  const costMap = new Map<string, number>();
  for (const c of costs as { product_id: string; duration_id: string; price: number }[]) {
    costMap.set(`${c.product_id}\u0000${c.duration_id}`, Number(c.price));
  }
  const { data: activeProducts } = await admin.from("products").select("id").eq("active", true).is("seller_id", null);
  const activeSet = new Set((activeProducts ?? []).map((p: { id: string }) => p.id));

  const upserts: { user_id: string; product_id: string; duration_id: string; price: number; active: boolean }[] = [];
  const removals: { product_id: string; duration_id: string }[] = [];

  for (const it of items) {
    const productId = typeof it.productId === "string" ? it.productId : "";
    const durationId = typeof it.durationId === "string" ? it.durationId : "";
    const cost = costMap.get(`${productId}\u0000${durationId}`);
    if (!productId || !durationId || cost === undefined || !activeSet.has(productId)) {
      return NextResponse.json({ error: "bad_item", message: "Ada produk yang tidak valid." }, { status: 400, headers: noStore });
    }
    if (it.price === null || it.price === "" || it.price === undefined) {
      removals.push({ product_id: productId, duration_id: durationId });
      continue;
    }
    const price = Number(it.price);
    if (!Number.isInteger(price) || price < MIN_PRICE || price > 100_000_000) {
      return NextResponse.json({ error: "bad_price", message: `Harga minimal Rp${MIN_PRICE.toLocaleString("id-ID")} (angka bulat).` }, { status: 400, headers: noStore });
    }
    if (price < cost) {
      return NextResponse.json(
        { error: "below_cost", message: `Harga jual tidak boleh di bawah modal (Rp${cost.toLocaleString("id-ID")}).` },
        { status: 400, headers: noStore }
      );
    }
    upserts.push({ user_id: userId, product_id: productId, duration_id: durationId, price, active: it.active !== false });
  }

  if (upserts.length) {
    const { error } = await admin.from("store_prices").upsert(upserts, { onConflict: "user_id,product_id,duration_id" });
    if (error) {
      console.error("[store/prices] upsert failed:", error.message);
      return NextResponse.json({ error: "save_failed", message: "Gagal menyimpan harga." }, { status: 500, headers: noStore });
    }
  }
  for (const r of removals) {
    await admin.from("store_prices").delete().eq("user_id", userId).eq("product_id", r.product_id).eq("duration_id", r.duration_id);
  }
  return NextResponse.json({ ok: true, saved: upserts.length, removed: removals.length }, { headers: noStore });
}
