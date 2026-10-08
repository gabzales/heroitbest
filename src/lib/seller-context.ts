import "server-only";
import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServerSupabase } from "@/lib/supabase/server";
import { createAdminSupabase } from "@/lib/supabase/admin";

export type SellerRow = {
  id: string;
  user_id: string;
  store_name: string;
  store_slug: string;
  bank_name: string | null;
  bank_account_number: string | null;
  bank_account_holder: string | null;
  status: "active" | "suspended";
  commission_percent: number | null;
  created_at: string;
};

type UserContext =
  | { ok: true; userId: string; admin: SupabaseClient; seller: SellerRow | null }
  | { ok: false; response: NextResponse };

/**
 * Siapa yang manggil (dari cookie session, BUKAN dari body request) + baris
 * `sellers`-nya kalau ada. Tabel sellers sengaja tanpa policy RLS apapun
 * (lihat 0013_marketplace_sellers.sql), jadi query-nya HARUS lewat service
 * role -- auth.getUser() dulu lewat client cookie buat tahu user id-nya,
 * baru service role dipakai dengan filter user_id itu.
 */
export async function resolveUserContext(): Promise<UserContext> {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = (await supabase?.auth.getUser()) ?? { data: { user: null } };
  if (!user) return { ok: false, response: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };

  const admin = createAdminSupabase();
  if (!admin) return { ok: false, response: NextResponse.json({ error: "service_role_missing" }, { status: 500 }) };

  const { data: seller } = await admin.from("sellers").select("*").eq("user_id", user.id).maybeSingle<SellerRow>();
  return { ok: true, userId: user.id, admin, seller: seller ?? null };
}

type ActiveSellerContext =
  | { ok: true; userId: string; admin: SupabaseClient; seller: SellerRow }
  | { ok: false; response: NextResponse };

export async function requireActiveSeller(): Promise<ActiveSellerContext> {
  const ctx = await resolveUserContext();
  if (!ctx.ok) return ctx;
  if (!ctx.seller) return { ok: false, response: NextResponse.json({ error: "not_a_seller", message: "Kamu belum terdaftar sebagai seller." }, { status: 403 }) };
  if (ctx.seller.status !== "active") {
    return { ok: false, response: NextResponse.json({ error: "seller_suspended", message: "Toko kamu sedang dinonaktifkan. Hubungi admin." }, { status: 403 }) };
  }
  return { ok: true, userId: ctx.userId, admin: ctx.admin, seller: ctx.seller };
}

/** Produk harus milik seller ini -- selalu dicek sebelum edit apapun di bawahnya. */
export async function ownsProduct(admin: SupabaseClient, productId: string, sellerId: string): Promise<boolean> {
  const { data } = await admin.from("products").select("id").eq("id", productId).eq("seller_id", sellerId).maybeSingle();
  return Boolean(data);
}
