import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { acquireAutoOrderLock, releaseAutoOrderLock, logOrphanProviderKey } from "@/lib/auto-order";
import { orderProviderKey } from "@/lib/provider/vipibmstore";

export type FulfillResult = { ok: true } | { ok: false; reason: string };

const REASONS: Record<string, string> = {
  insufficient_balance: "Saldo penjual di heroitbest tidak cukup.",
  out_of_stock: "Stok key sedang habis.",
  user_banned: "Akun penjual sedang dinonaktifkan.",
  invalid_product_or_duration: "Produk sudah tidak tersedia.",
  user_not_found: "Akun penjual tidak ditemukan.",
};

function reasonFrom(message: string): string {
  const hit = Object.entries(REASONS).find(([code]) => message.includes(code));
  return hit ? hit[1] : "Gagal mengirim key (kesalahan sistem).";
}

async function markFailed(admin: SupabaseClient, merchantRef: string, reason: string) {
  await admin
    .from("store_orders")
    .update({ status: "paid_failed", fail_reason: reason })
    .eq("merchant_ref", merchantRef)
    .in("status", ["paid", "paid_failed"]);
}

/**
 * Kirim key untuk pesanan toko yang SUDAH dibayar. Aman dipanggil berulang
 * (webhook, polling pembeli, tombol coba lagi): pesanan delivered tidak
 * pernah diproses dua kali -- pengiriman dilakukan di dalam satu transaksi
 * database yang mengunci baris pesanan (lihat store_issue_manual/auto).
 */
export async function fulfillStoreOrder(admin: SupabaseClient, merchantRef: string): Promise<FulfillResult> {
  const { data: order } = await admin
    .from("store_orders")
    .select("id, status, store_user_id, product_id, duration_id")
    .eq("merchant_ref", merchantRef)
    .maybeSingle();
  if (!order) return { ok: false, reason: "Pesanan tidak ditemukan." };
  if (order.status === "delivered") return { ok: true };
  if (order.status !== "paid" && order.status !== "paid_failed") {
    return { ok: false, reason: "Pesanan belum dibayar." };
  }

  const { data: dur } = await admin
    .from("product_durations")
    .select("stock_mode, provider_item_id")
    .eq("product_id", order.product_id)
    .eq("id", order.duration_id)
    .maybeSingle();
  if (!dur) {
    const reason = REASONS.invalid_product_or_duration;
    await markFailed(admin, merchantRef, reason);
    return { ok: false, reason };
  }

  if (dur.stock_mode !== "auto") {
    const { error } = await admin.rpc("store_issue_manual", { p_merchant_ref: merchantRef });
    if (error) {
      const reason = reasonFrom(error.message);
      await markFailed(admin, merchantRef, reason);
      return { ok: false, reason };
    }
    return { ok: true };
  }

  // Mode Auto: beli key dari provider (uang keluar duluan), jadi dijaga
  // mutex per seller + cek saldo seller dulu supaya tidak membeli key yang
  // tidak bisa didebit.
  if (!(await acquireAutoOrderLock(admin, order.store_user_id))) {
    return { ok: false, reason: "Pesanan sedang diproses, coba lagi sebentar." };
  }
  try {
    const { data: fresh } = await admin
      .from("store_orders")
      .select("status")
      .eq("merchant_ref", merchantRef)
      .maybeSingle();
    if (fresh?.status === "delivered") return { ok: true };

    const { data: seller } = await admin.from("users").select("balance").eq("id", order.store_user_id).maybeSingle();
    const { data: base } = await admin
      .from("product_durations")
      .select("price")
      .eq("product_id", order.product_id)
      .eq("id", order.duration_id)
      .maybeSingle();
    const basePrice = typeof base?.price === "number" ? base.price : null;
    let costPrice: number | null = null;
    if (basePrice !== null) {
      const { data: cost } = await admin.rpc("effective_key_price", {
        p_user_id: order.store_user_id,
        p_product_id: order.product_id,
        p_duration_id: order.duration_id,
        p_default_price: basePrice,
      });
      costPrice = typeof cost === "number" ? cost : basePrice;
    }
    if (!seller || costPrice === null || seller.balance < costPrice) {
      const reason = REASONS.insufficient_balance;
      await markFailed(admin, merchantRef, reason);
      return { ok: false, reason };
    }

    const providerResult = await orderProviderKey({
      productItemId: dur.provider_item_id || "",
      idempotencyKey: `store:${merchantRef}`,
      customerReference: order.store_user_id,
    });
    const providerKey = providerResult.success ? providerResult.data?.codes?.[0] : undefined;
    if (!providerResult.success || !providerKey) {
      const reason = providerResult.success ? REASONS.out_of_stock : "Pemasok key sedang bermasalah, coba lagi nanti.";
      await markFailed(admin, merchantRef, reason);
      return { ok: false, reason };
    }

    const { error } = await admin.rpc("store_issue_auto", { p_merchant_ref: merchantRef, p_key_string: providerKey });
    if (error) {
      console.error("store_issue_auto failed after provider issued a key", { merchantRef, error: error.message });
      await logOrphanProviderKey(admin, {
        userId: order.store_user_id,
        productId: order.product_id,
        durationId: order.duration_id,
        keyString: providerKey,
        providerCost: null,
        errorMessage: error.message,
        source: "store-order:auto",
      });
      const reason = reasonFrom(error.message);
      await markFailed(admin, merchantRef, reason);
      return { ok: false, reason };
    }
    return { ok: true };
  } finally {
    await releaseAutoOrderLock(admin, order.store_user_id);
  }
}
