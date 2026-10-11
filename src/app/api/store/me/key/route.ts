import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { checkRateLimit } from "@/lib/rate-limit";
import { encryptSecret, isStoreCryptoConfigured } from "@/lib/store/crypto";
import { createSellerQris, getAppUrl } from "@/lib/store/common";
import { getStoreSession, noStore } from "@/lib/store/session";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Simpan API key GensPay seller. Key divalidasi dulu (transaksi uji Rp1.000
 * yang tidak dibayar & kedaluwarsa sendiri), lalu disimpan TERENKRIPSI.
 * Respons tidak pernah memuat key -- hanya 4 digit terakhir.
 */
export async function PUT(request: Request) {
  const s = await getStoreSession(request, { mutating: true });
  if (s instanceof NextResponse) return s;
  const { admin, userId } = s;

  if (!isStoreCryptoConfigured()) {
    return NextResponse.json({ error: "store_disabled", message: "Fitur toko belum diaktifkan admin (STORE_SECRET_KEY)." }, { status: 503, headers: noStore });
  }
  if (!(await checkRateLimit(admin, `store-key:${userId}`, { maxHits: 5, windowSeconds: 60 }))) {
    return NextResponse.json({ error: "rate_limited", message: "Terlalu banyak percobaan, tunggu sebentar." }, { status: 429, headers: noStore });
  }

  const { data: store } = await admin.from("stores").select("user_id").eq("user_id", userId).maybeSingle();
  if (!store) {
    return NextResponse.json({ error: "no_store", message: "Simpan nama & link toko dulu." }, { status: 400, headers: noStore });
  }

  const body = await request.json().catch(() => ({}));
  const apiKey = typeof body?.apiKey === "string" ? body.apiKey.trim() : "";
  if (apiKey.length < 8 || apiKey.length > 200 || !/^[\x21-\x7e]+$/.test(apiKey)) {
    return NextResponse.json({ error: "bad_key", message: "Format API key tidak valid." }, { status: 400, headers: noStore });
  }

  const test = await createSellerQris({
    apiKey,
    orderId: `test-${randomBytes(8).toString("hex")}`,
    amount: 1000,
    callbackUrl: `${getAppUrl(request)}/api/webhooks/store`,
  });
  if (!test.ok) {
    return NextResponse.json(
      { error: "key_rejected", message: test.status === 401 ? "API key GensPay ditolak. Cek lagi key-nya." : `Gagal memverifikasi key: ${test.message}` },
      { status: 400, headers: noStore }
    );
  }

  const { error } = await admin
    .from("stores")
    .update({ genspay_key_enc: encryptSecret(apiKey), genspay_key_last4: apiKey.slice(-4), updated_at: new Date().toISOString() })
    .eq("user_id", userId);
  if (error) {
    console.error("[store/key] save failed:", error.message);
    return NextResponse.json({ error: "save_failed", message: "Gagal menyimpan key." }, { status: 500, headers: noStore });
  }
  return NextResponse.json({ ok: true, last4: apiKey.slice(-4) }, { headers: noStore });
}

/** Hapus key sekaligus menutup toko. */
export async function DELETE(request: Request) {
  const s = await getStoreSession(request, { mutating: true });
  if (s instanceof NextResponse) return s;
  const { admin, userId } = s;
  const { error } = await admin
    .from("stores")
    .update({ genspay_key_enc: null, genspay_key_last4: null, enabled: false, updated_at: new Date().toISOString() })
    .eq("user_id", userId);
  if (error) return NextResponse.json({ error: "save_failed", message: "Gagal menghapus key." }, { status: 500, headers: noStore });
  return NextResponse.json({ ok: true }, { headers: noStore });
}
