import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Mutex per akun untuk pembelian mode Auto (lihat 0014_all_fixes.sql).
 * Pembelian Auto memanggil provider (uang platform keluar) SEBELUM saldo
 * didebit; tanpa mutex, request paralel dengan saldo cukup untuk 1 order
 * semuanya lolos pre-check dan membeli key yang tak bisa didebit.
 *
 * Fail-OPEN kalau RPC-nya error (mis. migrasi belum dijalankan) supaya
 * endpoint tidak mati total -- sama seperti checkRateLimit().
 */
export async function acquireAutoOrderLock(admin: SupabaseClient, userId: string): Promise<boolean> {
  const { data, error } = await admin.rpc("acquire_auto_order_lock", { p_user_id: userId, p_ttl_seconds: 60 });
  if (error) {
    console.error("acquire_auto_order_lock failed, proceeding without lock:", error.message);
    return true;
  }
  return Boolean(data);
}

export async function releaseAutoOrderLock(admin: SupabaseClient, userId: string): Promise<void> {
  const { error } = await admin.rpc("release_auto_order_lock", { p_user_id: userId });
  if (error) console.error("release_auto_order_lock failed (lock expires by TTL):", error.message);
}

/**
 * Key yang sudah dibeli dari provider tapi pencatatan/debit lokal gagal.
 * Disimpan supaya admin bisa rekonsiliasi (best-effort, tidak boleh
 * menggagalkan response utama).
 */
export async function logOrphanProviderKey(
  admin: SupabaseClient,
  row: {
    userId: string;
    productId: string;
    durationId: string;
    keyString: string;
    providerCost: number | null;
    errorMessage: string;
    source: string;
  }
): Promise<void> {
  try {
    const { error } = await admin.from("provider_orphan_keys").insert({
      user_id: row.userId,
      product_id: row.productId,
      duration_id: row.durationId,
      key_string: row.keyString,
      provider_cost: row.providerCost,
      error_message: row.errorMessage.slice(0, 500),
      source: row.source,
    });
    if (error) console.error("gagal simpan provider_orphan_keys:", error.message);
  } catch (e) {
    console.error("gagal simpan provider_orphan_keys:", e);
  }
}
