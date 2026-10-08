import { NextResponse } from "next/server";
import { getAdminUser } from "@/lib/require-admin";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { getMarketplaceSettings } from "@/lib/marketplace";
import { isSameOriginRequest } from "@/lib/origin-guard";

export async function GET() {
  if (!(await getAdminUser())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const admin = createAdminSupabase();
  if (!admin) return NextResponse.json({ error: "service_role_missing" }, { status: 500 });
  return NextResponse.json(await getMarketplaceSettings(admin));
}

function inRange(v: unknown, min: number, max: number): number | null {
  if (!(typeof v === "number" || (typeof v === "string" && v.trim() !== ""))) return null; // null/""/boolean -> 0 diam-diam
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

export async function PUT(request: Request) {
  if (!(await getAdminUser())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  const body = await request.json().catch(() => null);

  const commission = inRange(body?.defaultCommissionPercent, 0, 100);
  const hold = inRange(body?.pendingHoldHours, 0, 720);
  const markup = inRange(body?.minAutoMarkupPercent, 0, 500);
  if (commission === null || hold === null || markup === null) {
    return NextResponse.json({ error: "invalid_fields", message: "Komisi 0-100, masa tahan 0-720 jam, margin Auto 0-500." }, { status: 400 });
  }

  const admin = createAdminSupabase();
  if (!admin) return NextResponse.json({ error: "service_role_missing" }, { status: 500 });
  const { error } = await admin.from("app_settings").upsert({
    key: "marketplace",
    value: {
      default_commission_percent: commission,
      pending_hold_hours: hold,
      min_auto_markup_percent: markup,
      seller_auto_enabled: body?.sellerAutoEnabled !== false,
    },
    updated_at: new Date().toISOString(),
  });
  if (error) return NextResponse.json({ error: "save_failed", message: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
