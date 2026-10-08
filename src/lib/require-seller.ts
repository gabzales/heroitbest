import "server-only";
import { createServerSupabase } from "@/lib/supabase/server";

export type SellerProfile = {
  id: string;
  userId: string;
  storeName: string;
  storeSlug: string;
  bankName: string | null;
  bankAccountNumber: string | null;
  bankAccountHolder: string | null;
  status: "active" | "suspended";
  commissionPercent: number | null;
};

/**
 * Resolves the signed-in user AND their `sellers` row, if any. Mirrors
 * require-admin.ts's getAdminUser() pattern (RLS "users read own row"
 * already covers auth.getUser(), then a plain select -- sellers table
 * itself has RLS on with no grants to anon/authenticated per
 * 0013_marketplace_sellers.sql, but that's fine here: this reads via the
 * cookie-bound client which is still subject to RLS, so a *separate*
 * policy would be needed for a seller to read their own row this way.
 * Since we don't want to widen sellers' RLS, every /api/seller/** route
 * instead uses createAdminSupabase() (service role) for the actual query
 * and calls this helper ONLY to resolve auth.getUser() cheaply first.
 */
export async function getSignedInUserId(): Promise<string | null> {
  const supabase = await createServerSupabase();
  if (!supabase) return null;
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user?.id ?? null;
}
