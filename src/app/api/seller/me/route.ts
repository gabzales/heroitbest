import { NextResponse } from "next/server";
import { resolveUserContext } from "@/lib/seller-context";
import { getMarketplaceSettings } from "@/lib/marketplace";
import { isSameOriginRequest } from "@/lib/origin-guard";

export async function GET() {
  const ctx = await resolveUserContext();
  if (!ctx.ok) return ctx.response;
  if (!ctx.seller) return NextResponse.json({ seller: null });

  const [{ data: bal }, settings] = await Promise.all([
    ctx.admin.rpc("seller_balance", { p_seller_id: ctx.seller.id }),
    getMarketplaceSettings(ctx.admin),
  ]);
  const row = (Array.isArray(bal) ? bal[0] : bal) as { pending: number; available: number; paid_out: number } | undefined;
  const s = ctx.seller;
  return NextResponse.json({
    seller: {
      id: s.id,
      storeName: s.store_name,
      storeSlug: s.store_slug,
      bankName: s.bank_name,
      bankAccountNumber: s.bank_account_number,
      bankAccountHolder: s.bank_account_holder,
      status: s.status,
      commissionPercent: s.commission_percent ?? settings.defaultCommissionPercent,
    },
    balance: { pending: row?.pending ?? 0, available: row?.available ?? 0, paidOut: row?.paid_out ?? 0 },
    holdHours: settings.pendingHoldHours,
    autoEnabled: settings.sellerAutoEnabled,
  });
}

export async function PUT(request: Request) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  const ctx = await resolveUserContext();
  if (!ctx.ok) return ctx.response;
  if (!ctx.seller) return NextResponse.json({ error: "not_a_seller" }, { status: 403 });

  const body = await request.json().catch(() => null);
  const pick = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : undefined);
  const patch: Record<string, string | null> = {};
  const storeName = pick(body?.storeName, 60);
  if (storeName) patch.store_name = storeName; // slug sengaja TIDAK ikut berubah (URL toko stabil)
  const bn = pick(body?.bankName, 80);
  const ba = pick(body?.bankAccountNumber, 40);
  const bh = pick(body?.bankAccountHolder, 80);
  if (bn !== undefined) patch.bank_name = bn || null;
  if (ba !== undefined) patch.bank_account_number = ba || null;
  if (bh !== undefined) patch.bank_account_holder = bh || null;
  if (Object.keys(patch).length === 0) return NextResponse.json({ error: "nothing_to_update" }, { status: 400 });

  const { error } = await ctx.admin.from("sellers").update(patch).eq("id", ctx.seller.id);
  if (error) return NextResponse.json({ error: "update_failed", message: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
