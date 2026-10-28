import { NextResponse } from "next/server";
import { getAdminUser } from "@/lib/require-admin";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { isSameOriginRequest } from "@/lib/origin-guard";
import { checkRateLimit } from "@/lib/rate-limit";
import { testPakasirConnection } from "@/lib/provider/pakasir";

export async function POST(request: Request) {
  const admin_user = await getAdminUser();
  if (!admin_user) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "bad_origin" }, { status: 403 });

  const admin = createAdminSupabase();
  if (!admin) return NextResponse.json({ error: "service_role_missing" }, { status: 500 });

  // Membuat transaksi uji sungguhan (langsung dibatalkan) -- dibatasi supaya
  // klik berulang tidak menumpuk transaksi uji di dashboard Pakasir.
  const allowed = await checkRateLimit(admin, `admin-pakasir-test:${admin_user.id}`, {
    maxHits: 6,
    windowSeconds: 60,
  });
  if (!allowed) {
    return NextResponse.json(
      { error: "rate_limited", message: "Terlalu banyak percobaan test, tunggu sebentar." },
      { status: 429 }
    );
  }

  return NextResponse.json(await testPakasirConnection());
}
