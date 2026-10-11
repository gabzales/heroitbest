import { cache } from "react";
import { createServerSupabase } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { CURRENT_USER } from "@/lib/mock-data";
import { ResellerUser } from "@/lib/types";

/**
 * Resolves the signed-in user for the current request.
 * - Supabase configured + no session  -> null (caller should redirect;
 *   middleware already does this for everything under /dashboard).
 * - Supabase configured + session     -> real row from `public.users`.
 * - Supabase NOT configured           -> the mock demo user, so every
 *   page keeps working before a project is wired up.
 *
 * Wrapped in React's `cache()` so the layout and each page can both call
 * this without issuing duplicate Supabase requests per render pass.
 */
export type CurrentUserResult = {
  user: ResellerUser | null;
  /** Ada sesi login valid, tapi baris profil gagal dibaca. */
  hasSession: boolean;
  error: string | null;
};

export const getCurrentUserResult = cache(async (): Promise<CurrentUserResult> => {
  if (!isSupabaseConfigured) return { user: CURRENT_USER, hasSession: true, error: null };

  const supabase = await createServerSupabase();
  if (!supabase) return { user: CURRENT_USER, hasSession: true, error: null };

  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();
  if (!authUser) return { user: null, hasSession: false, error: null };

  // select("*") (bukan daftar kolom) supaya tetap jalan walau ada kolom
  // opsional yang belum ada di DB (mis. `theme` kalau setup.sql belum penuh).
  const { data, error } = await supabase
    .from("users")
    .select("*")
    .eq("id", authUser.id)
    .maybeSingle();

  if (error || !data) {
    return {
      user: null,
      hasSession: true,
      error: error?.message ?? "Baris profil untuk akun ini tidak ada di tabel public.users.",
    };
  }

  return {
    user: {
      id: data.id,
      name: data.full_name || String(data.email ?? "").split("@")[0],
      email: data.email,
      avatarSeed: data.id,
      balance: data.balance ?? 0,
      role: data.role ?? "user",
      verified: data.verified ?? false,
      theme: data.theme || "hero",
    },
    hasSession: true,
    error: null,
  };
});

export const getCurrentUser = cache(async (): Promise<ResellerUser | null> => {
  return (await getCurrentUserResult()).user;
});
