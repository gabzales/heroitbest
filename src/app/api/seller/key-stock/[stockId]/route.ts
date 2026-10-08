import { NextResponse } from "next/server";
import { requireActiveSeller } from "@/lib/seller-context";
import { isSameOriginRequest } from "@/lib/origin-guard";

export async function DELETE(request: Request, { params }: { params: Promise<{ stockId: string }> }) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  const auth = await requireActiveSeller();
  if (!auth.ok) return auth.response;
  const { stockId } = await params;

  // Hanya key MILIK seller ini dan BELUM terpakai yang boleh dihapus.
  const { error } = await auth.admin.from("key_stock").delete().eq("id", stockId).eq("seller_id", auth.seller.id).eq("used", false);
  if (error) return NextResponse.json({ error: "delete_failed", message: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
