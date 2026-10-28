import { NextResponse } from "next/server";
import { getAdminUser } from "@/lib/require-admin";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { isSameOriginRequest } from "@/lib/origin-guard";
import { checkRateLimit } from "@/lib/rate-limit";
import {
  getCheatgameBalance,
  getCheatgameCatalog,
  getCheatgameConfig,
  invalidateCheatgameCache,
} from "@/lib/provider/cheatgame";

const DEFAULT_BASE_URL = "https://cheatgame.online/reseller_api.php";

function mask(secret: string) {
  if (!secret) return "";
  if (secret.length <= 6) return "*".repeat(secret.length);
  return `${secret.slice(0, 4)}${"*".repeat(Math.max(secret.length - 8, 4))}${secret.slice(-4)}`;
}

type Stored = { apiKey?: string; baseUrl?: string };

export async function GET() {
  const admin_user = await getAdminUser();
  if (!admin_user) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const admin = createAdminSupabase();
  if (!admin) return NextResponse.json({ error: "service_role_missing" }, { status: 500 });

  const { data } = await admin.from("app_settings").select("value").eq("key", "cheatgame_api").maybeSingle();
  const value = (data?.value ?? {}) as Stored;
  const cfg = await getCheatgameConfig();
  return NextResponse.json({
    baseUrl: value.baseUrl || DEFAULT_BASE_URL,
    apiKeyMasked: mask(value.apiKey || ""),
    configured: Boolean(cfg.apiKey),
  });
}

export async function PUT(request: Request) {
  const admin_user = await getAdminUser();
  if (!admin_user) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "bad_origin" }, { status: 403 });

  const body = await request.json().catch(() => null);
  const admin = createAdminSupabase();
  if (!admin) return NextResponse.json({ error: "service_role_missing" }, { status: 500 });

  const { data: existing } = await admin.from("app_settings").select("value").eq("key", "cheatgame_api").maybeSingle();
  const current = (existing?.value ?? {}) as Stored;

  let baseUrl = current.baseUrl || DEFAULT_BASE_URL;
  if (typeof body?.baseUrl === "string" && body.baseUrl.trim()) {
    const candidate = body.baseUrl.trim().replace(/\/+$/, "");
    try {
      if (new URL(candidate).protocol !== "https:") throw new Error("not https");
    } catch {
      return NextResponse.json({ error: "bad_base_url", message: "Base URL harus berupa alamat https://" }, { status: 400 });
    }
    baseUrl = candidate;
  }
  // apiKey kosong = biarkan yang lama (GET hanya mengirim nilai ter-mask).
  const apiKey = typeof body?.apiKey === "string" && body.apiKey.trim() ? body.apiKey.trim() : current.apiKey || "";

  const { error } = await admin
    .from("app_settings")
    .upsert({ key: "cheatgame_api", value: { apiKey, baseUrl }, updated_at: new Date().toISOString() });
  if (error) return NextResponse.json({ error: "save_failed", message: error.message }, { status: 500 });

  invalidateCheatgameCache();
  return NextResponse.json({ ok: true });
}

/** Test koneksi: baca saldo partner + katalog (tidak membuat/memotong apa pun). */
export async function POST(request: Request) {
  const admin_user = await getAdminUser();
  if (!admin_user) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  const admin = createAdminSupabase();
  if (!admin) return NextResponse.json({ error: "service_role_missing" }, { status: 500 });
  if (!(await checkRateLimit(admin, `admin-cheatgame-test:${admin_user.id}`, { maxHits: 10, windowSeconds: 60 }))) {
    return NextResponse.json({ error: "rate_limited", message: "Terlalu banyak percobaan test." }, { status: 429 });
  }

  const steps: { step: string; ok: boolean; detail: string }[] = [];
  const cfg = await getCheatgameConfig();
  steps.push({ step: "config", ok: Boolean(cfg.apiKey), detail: cfg.apiKey ? `Base URL ${cfg.baseUrl}` : "API Key belum diisi" });
  if (!cfg.apiKey) return NextResponse.json({ ok: false, steps });

  const bal = await getCheatgameBalance();
  steps.push({
    step: "balance",
    ok: bal.success,
    detail: bal.success ? `Saldo akun reseller: ${bal.data.balance.toLocaleString("id-ID")} ${bal.data.currency}` : bal.message,
  });
  const cat = await getCheatgameCatalog({ fresh: true });
  steps.push({
    step: "catalog",
    ok: cat.success,
    detail: cat.success ? `${cat.data.length} produk aktif di katalog CHEATGAME` : cat.message,
  });
  return NextResponse.json({ ok: steps.every((s) => s.ok), steps });
}
