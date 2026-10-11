import "server-only";
import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServerSupabase } from "@/lib/supabase/server";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { isSameOriginRequest } from "@/lib/origin-guard";

export const noStore = { "Cache-Control": "no-store" };

/** Identifikasi seller dari cookie sesi (bukan dari body) + cek origin untuk request yang mengubah data. */
export async function getStoreSession(
  request: Request,
  { mutating }: { mutating: boolean }
): Promise<{ admin: SupabaseClient; userId: string } | NextResponse> {
  if (!isSupabaseConfigured) return NextResponse.json({ error: "supabase_not_configured" }, { status: 503, headers: noStore });
  if (mutating && !isSameOriginRequest(request)) return NextResponse.json({ error: "bad_origin" }, { status: 403, headers: noStore });
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = (await supabase?.auth.getUser()) ?? { data: { user: null } };
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: noStore });
  const admin = createAdminSupabase();
  if (!admin) return NextResponse.json({ error: "service_role_missing" }, { status: 500, headers: noStore });
  const { data: u } = await admin.from("users").select("banned").eq("id", user.id).maybeSingle();
  if (!u || u.banned) return NextResponse.json({ error: "forbidden" }, { status: 403, headers: noStore });
  return { admin, userId: user.id };
}
