import { createServerSupabase } from "@/lib/supabase/server";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { KEY_HISTORY, TOPUP_HISTORY, ACTIVITY_DAYS } from "@/lib/mock-data";
import { DisputeStatus, GeneratedKey, TopupTx } from "@/lib/types";

export async function getKeyHistory(): Promise<GeneratedKey[]> {
  if (!isSupabaseConfigured) return KEY_HISTORY;
  const supabase = await createServerSupabase();
  if (!supabase) return KEY_HISTORY;

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];

  const { data, error } = await supabase
    .from("reseller_keys")
    .select("id, product_name, duration_label, key_string, created_at, seller_id, held_until, refunded_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(50);

  if (error || !data) return [];

  // Status komplain per key (tabel order_disputes tanpa policy RLS -> service
  // role; filter buyer_id = user yang sudah terautentikasi di atas).
  const disputeByKey = new Map<string, DisputeStatus>();
  const sellerKeyIds = data.filter((k) => k.seller_id).map((k) => k.id as string);
  if (sellerKeyIds.length > 0) {
    const admin = createAdminSupabase();
    if (admin) {
      const { data: disputes } = await admin
        .from("order_disputes")
        .select("reseller_key_id, status")
        .eq("buyer_id", user.id)
        .in("reseller_key_id", sellerKeyIds);
      for (const d of disputes ?? []) disputeByKey.set(d.reseller_key_id as string, d.status as DisputeStatus);
    }
  }

  const now = Date.now();
  return data.map((k) => {
    const fromSeller = Boolean(k.seller_id);
    const disputeStatus = disputeByKey.get(k.id as string) ?? null;
    return {
      id: k.id,
      productName: k.product_name,
      duration: k.duration_label,
      keyString: k.key_string,
      createdAt: k.created_at,
      fromSeller,
      refunded: Boolean(k.refunded_at),
      disputeStatus,
      canDispute:
        fromSeller && !k.refunded_at && !disputeStatus && Boolean(k.held_until) && new Date(k.held_until as string).getTime() > now,
    };
  });
}

export async function getTopupHistory(): Promise<TopupTx[]> {
  if (!isSupabaseConfigured) return TOPUP_HISTORY;
  const supabase = await createServerSupabase();
  if (!supabase) return TOPUP_HISTORY;

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];

  // Pending basi -> expired (lazy, tanpa cron). Best-effort, tidak boleh
  // menggagalkan riwayat.
  try {
    const adm = createAdminSupabase();
    if (adm) await adm.rpc("expire_stale_topups", { p_user_id: user.id, p_minutes: 30 });
  } catch {}

  const { data, error } = await supabase
    .from("topups")
    .select("id, nominal, bonus, total, method, status, created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(50);

  if (error || !data) return [];

  return data.map((t) => ({
    id: t.id,
    nominal: t.nominal,
    bonus: t.bonus,
    total: t.total,
    method: t.method,
    status: t.status,
    createdAt: t.created_at,
  }));
}

export async function getActivityDays(): Promise<number[]> {
  if (!isSupabaseConfigured) return ACTIVITY_DAYS;
  const [keys, topups] = await Promise.all([getKeyHistory(), getTopupHistory()]);
  const days = new Set<number>();
  [...keys.map((k) => k.createdAt), ...topups.map((t) => t.createdAt)].forEach((iso) => {
    days.add(new Date(iso).getDate());
  });
  return Array.from(days);
}
