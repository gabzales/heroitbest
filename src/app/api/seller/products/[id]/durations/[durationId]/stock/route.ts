import { NextResponse } from "next/server";
import { requireActiveSeller, ownsProduct } from "@/lib/seller-context";
import { isSameOriginRequest } from "@/lib/origin-guard";

const MAX_KEYS_PER_PASTE = 1000;
type Ctx = { params: Promise<{ id: string; durationId: string }> };

export async function POST(request: Request, { params }: Ctx) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  const auth = await requireActiveSeller();
  if (!auth.ok) return auth.response;
  const { id: productId, durationId } = await params;
  if (!(await ownsProduct(auth.admin, productId, auth.seller.id))) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const { data: dur } = await auth.admin.from("product_durations").select("stock_mode").eq("product_id", productId).eq("id", durationId).maybeSingle();
  if (!dur) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (dur.stock_mode !== "manual") return NextResponse.json({ error: "not_manual", message: "Durasi mode Auto tidak memakai stok manual." }, { status: 400 });

  const body = await request.json().catch(() => null);
  const raw: string[] = Array.isArray(body?.keys) ? body.keys : typeof body?.keysText === "string" ? body.keysText.split("\n") : [];
  const keys = Array.from(new Set(raw.map((k) => String(k).trim()).filter(Boolean))).slice(0, MAX_KEYS_PER_PASTE);
  if (keys.length === 0) return NextResponse.json({ error: "no_keys", message: "Tidak ada key yang valid." }, { status: 400 });

  // upsert + ignoreDuplicates: key yang sudah pernah terdaftar (siapa pun
  // seller-nya, terpakai atau belum -- lihat unique index key_stock_key_string_uniq
  // di 0013) dilewati, sisanya tetap masuk, daripada satu duplikat menggagalkan
  // seluruh tempelan.
  const { error, count } = await auth.admin.from("key_stock").upsert(
    keys.map((key_string) => ({ product_id: productId, duration_id: durationId, key_string, seller_id: auth.seller.id })),
    { onConflict: "key_string", ignoreDuplicates: true, count: "exact" }
  );
  if (error) return NextResponse.json({ error: "insert_failed", message: error.message }, { status: 500 });
  const added = count ?? keys.length;
  return NextResponse.json({ added, skipped: Math.max(keys.length - added, 0) });
}

export async function GET(_req: Request, { params }: Ctx) {
  const auth = await requireActiveSeller();
  if (!auth.ok) return auth.response;
  const { id: productId, durationId } = await params;

  const { data, error } = await auth.admin
    .from("key_stock")
    .select("id, key_string, created_at")
    .eq("product_id", productId)
    .eq("duration_id", durationId)
    .eq("seller_id", auth.seller.id)
    .eq("used", false)
    .order("created_at", { ascending: true })
    .limit(500);
  if (error) return NextResponse.json({ error: "query_failed", message: error.message }, { status: 500 });
  return NextResponse.json({ keys: data ?? [] });
}
