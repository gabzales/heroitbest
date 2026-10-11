import { NextResponse } from "next/server";
import { checkRateLimit } from "@/lib/rate-limit";
import { isStoreCryptoConfigured } from "@/lib/store/crypto";
import { SLUG_RE, normalizeSlug } from "@/lib/store/common";
import { getStoreSession, noStore } from "@/lib/store/session";

export const dynamic = "force-dynamic";

/** Simpan pengaturan dasar toko: slug, nama, WhatsApp, saklar buka/tutup. */
export async function PUT(request: Request) {
  const s = await getStoreSession(request, { mutating: true });
  if (s instanceof NextResponse) return s;
  const { admin, userId } = s;

  if (!(await checkRateLimit(admin, `store-me:${userId}`, { maxHits: 30, windowSeconds: 60 }))) {
    return NextResponse.json({ error: "rate_limited", message: "Terlalu banyak percobaan." }, { status: 429, headers: noStore });
  }
  if (!isStoreCryptoConfigured()) {
    return NextResponse.json({ error: "store_disabled", message: "Fitur toko belum diaktifkan admin (STORE_SECRET_KEY)." }, { status: 503, headers: noStore });
  }

  const body = await request.json().catch(() => ({}));
  const slug = normalizeSlug(body?.slug);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const waRaw = typeof body?.contactWa === "string" ? body.contactWa.replace(/\D/g, "") : "";
  const wantEnabled = body?.enabled === true;

  if (!SLUG_RE.test(slug)) {
    return NextResponse.json({ error: "bad_slug", message: "Link toko 3-30 karakter: huruf kecil, angka, strip." }, { status: 400, headers: noStore });
  }
  if (name.length < 2 || name.length > 40) {
    return NextResponse.json({ error: "bad_name", message: "Nama toko 2-40 karakter." }, { status: 400, headers: noStore });
  }
  if (waRaw && !/^[0-9]{8,16}$/.test(waRaw)) {
    return NextResponse.json({ error: "bad_wa", message: "Nomor WhatsApp tidak valid (angka saja, contoh 6281234567890)." }, { status: 400, headers: noStore });
  }

  const { data: existing } = await admin.from("stores").select("genspay_key_enc, admin_blocked").eq("user_id", userId).maybeSingle();

  let enabled = wantEnabled;
  if (enabled) {
    if (existing?.admin_blocked) {
      return NextResponse.json({ error: "blocked", message: "Tokomu dinonaktifkan admin. Hubungi admin." }, { status: 403, headers: noStore });
    }
    if (!existing?.genspay_key_enc) {
      return NextResponse.json({ error: "no_key", message: "Isi API GensPay dulu sebelum membuka toko." }, { status: 400, headers: noStore });
    }
    const { count } = await admin
      .from("store_prices")
      .select("product_id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("active", true);
    if (!count) {
      return NextResponse.json({ error: "no_prices", message: "Isi harga jual minimal satu produk dulu." }, { status: 400, headers: noStore });
    }
  } else {
    enabled = false;
  }

  const row = { slug, name, contact_wa: waRaw || null, enabled, updated_at: new Date().toISOString() };
  const { error } = existing
    ? await admin.from("stores").update(row).eq("user_id", userId)
    : await admin.from("stores").insert({ user_id: userId, ...row, enabled: false });
  if (error) {
    if (error.code === "23505") {
      return NextResponse.json({ error: "slug_taken", message: "Link toko itu sudah dipakai, pilih yang lain." }, { status: 409, headers: noStore });
    }
    console.error("[store/me] save failed:", error.message);
    return NextResponse.json({ error: "save_failed", message: "Gagal menyimpan." }, { status: 500, headers: noStore });
  }
  return NextResponse.json({ ok: true }, { headers: noStore });
}
