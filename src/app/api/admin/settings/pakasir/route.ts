import { NextResponse } from "next/server";
import { getAdminUser } from "@/lib/require-admin";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { isSameOriginRequest } from "@/lib/origin-guard";
import { invalidatePakasirConfigCache } from "@/lib/provider/pakasir";

type Stored = { slug?: string; apiKey?: string; webhookSecret?: string; baseUrl?: string };

function mask(secret: string) {
  if (!secret) return "";
  if (secret.length <= 6) return "*".repeat(secret.length);
  return `${secret.slice(0, 4)}${"*".repeat(Math.max(secret.length - 8, 4))}${secret.slice(-4)}`;
}

export async function GET() {
  const admin_user = await getAdminUser();
  if (!admin_user) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const admin = createAdminSupabase();
  if (!admin) return NextResponse.json({ error: "service_role_missing" }, { status: 500 });

  const [{ data: pakRow }, { data: gatewayRow }] = await Promise.all([
    admin.from("app_settings").select("value").eq("key", "pakasir").maybeSingle(),
    admin.from("app_settings").select("value").eq("key", "payment_gateway").maybeSingle(),
  ]);
  const value = (pakRow?.value ?? {}) as Stored;
  const activeRaw = (gatewayRow?.value as { active?: string } | null)?.active;
  const active = activeRaw === "pakasir" || activeRaw === "wijayapay" ? activeRaw : "genspay";

  return NextResponse.json({
    baseUrl: value.baseUrl || "https://app.pakasir.com",
    slug: value.slug || "",
    apiKeyMasked: mask(value.apiKey || ""),
    webhookSecretMasked: mask(value.webhookSecret || ""),
    configured: Boolean(value.slug && value.apiKey),
    activeGateway: active,
  });
}

export async function PUT(request: Request) {
  const admin_user = await getAdminUser();
  if (!admin_user) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "bad_origin" }, { status: 403 });

  const body = await request.json().catch(() => null);
  const admin = createAdminSupabase();
  if (!admin) return NextResponse.json({ error: "service_role_missing" }, { status: 500 });

  const { data: existing } = await admin.from("app_settings").select("value").eq("key", "pakasir").maybeSingle();
  const current = (existing?.value ?? {}) as Stored;

  // Field kosong = "jangan diubah" (GET hanya mengembalikan nilai tersamar).
  const pick = (v: unknown, fallback: string) => (typeof v === "string" && v.trim() ? v.trim() : fallback);
  const baseUrl = pick(body?.baseUrl, current.baseUrl || "https://app.pakasir.com").replace(/\/+$/, "");
  if (!/^https:\/\//i.test(baseUrl)) {
    return NextResponse.json({ error: "bad_base_url", message: "Base URL harus diawali https://" }, { status: 400 });
  }
  const next: Stored = {
    baseUrl,
    slug: pick(body?.slug, current.slug || ""),
    apiKey: pick(body?.apiKey, current.apiKey || ""),
    webhookSecret: pick(body?.webhookSecret, current.webhookSecret || ""),
  };

  const { error } = await admin
    .from("app_settings")
    .upsert({ key: "pakasir", value: next, updated_at: new Date().toISOString() });
  if (error) return NextResponse.json({ error: "save_failed", message: error.message }, { status: 500 });

  // Saklar gateway aktif boleh ikut dikirim dari form yang sama.
  if (body?.activeGateway === "genspay" || body?.activeGateway === "pakasir" || body?.activeGateway === "wijayapay") {
    if (body.activeGateway === "pakasir" && !(next.slug && next.apiKey)) {
      return NextResponse.json(
        { error: "not_configured", message: "Isi Slug dan API Key Pakasir dulu sebelum mengaktifkannya." },
        { status: 400 }
      );
    }
    if (body.activeGateway === "wijayapay") {
      const { data: wp } = await admin.from("app_settings").select("value").eq("key", "wijayapay").maybeSingle();
      const w = (wp?.value ?? {}) as { merchantCode?: string; apiKey?: string };
      if (!(w.merchantCode && w.apiKey)) {
        return NextResponse.json(
          { error: "not_configured", message: "Isi Merchant Code dan API Key WijayaPay dulu (menu WijayaPay) sebelum mengaktifkannya." },
          { status: 400 }
        );
      }
    }
    const { error: gwError } = await admin
      .from("app_settings")
      .upsert({ key: "payment_gateway", value: { active: body.activeGateway }, updated_at: new Date().toISOString() });
    if (gwError) return NextResponse.json({ error: "save_failed", message: gwError.message }, { status: 500 });
  }

  invalidatePakasirConfigCache();
  return NextResponse.json({ ok: true });
}
