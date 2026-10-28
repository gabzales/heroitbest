import { NextResponse } from "next/server";
import { resolveUserContext } from "@/lib/seller-context";
import { isSameOriginRequest } from "@/lib/origin-guard";

const str = (v: unknown, max = 80) => (typeof v === "string" ? v.trim().slice(0, max) : "");

export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  const ctx = await resolveUserContext();
  if (!ctx.ok) return ctx.response;
  if (ctx.seller) return NextResponse.json({ error: "already_a_seller", message: "Akun ini sudah terdaftar sebagai seller." }, { status: 409 });

  const body = await request.json().catch(() => null);
  const storeName = str(body?.storeName, 60);
  if (!storeName) return NextResponse.json({ error: "store_name_required", message: "Nama toko wajib diisi." }, { status: 400 });

  const { data, error } = await ctx.admin.rpc("register_seller", {
    p_user_id: ctx.userId,
    p_store_name: storeName,
    p_bank_name: str(body?.bankName) || null,
    p_bank_account_number: str(body?.bankAccountNumber, 40) || null,
    p_bank_account_holder: str(body?.bankAccountHolder) || null,
  });
  if (error) {
    const known: Record<string, [number, string]> = {
      already_a_seller: [409, "Akun ini sudah terdaftar sebagai seller."],
      store_name_required: [400, "Nama toko wajib diisi."],
    };
    const hit = Object.entries(known).find(([code]) => error.message.includes(code));
    if (hit) return NextResponse.json({ error: hit[0], message: hit[1][1] }, { status: hit[1][0] });
    console.error("register_seller failed:", error.message);
    return NextResponse.json({ error: "register_failed", message: "Gagal mendaftar seller." }, { status: 400 });
  }
  return NextResponse.json({ seller: data });
}
