import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { checkRateLimit } from "@/lib/rate-limit";
import { acquireAutoOrderLock, releaseAutoOrderLock, logOrphanProviderKey } from "@/lib/auto-order";
import { isSameOriginRequest } from "@/lib/origin-guard";
import { orderProviderKey, providerErrorToCustomerMessage } from "@/lib/provider/vipibmstore";

// Provider call (orderProviderKey) can legitimately take up to
// REQUEST_TIMEOUT_MS (25s) waiting on vipibmstore.com. Without this,
// Vercel's default serverless timeout (10s on Hobby plans) kills the
// function mid-request and returns its own 502 HTML error page --
// which is what breaks the frontend's res.json() parse with
// "Unexpected token '<'". This must be >= REQUEST_TIMEOUT_MS below.
export const maxDuration = 30;

const MAX_ATTEMPTS = 5;

// Kode error yang berlaku untuk KEDUA jalur (produk platform sendiri
// maupun listing marketplace milik seller) -- respons http/pesan ke
// customer harus sama persis siapa pun pemilik produknya.
const KNOWN_ERRORS: Record<string, { status: number; message: string }> = {
  insufficient_balance: { status: 402, message: "Saldo tidak mencukupi." },
  invalid_product_or_duration: { status: 400, message: "Produk/durasi tidak valid." },
  user_not_found: { status: 404, message: "Akun tidak ditemukan." },
  out_of_stock: { status: 409, message: "Stok key untuk paket ini sedang habis." },
  // Marketplace-only (lihat 0013_marketplace_sellers.sql):
  seller_unavailable: { status: 409, message: "Toko penjual sedang tidak aktif." },
  not_a_marketplace_listing: { status: 500, message: "Gagal membuat key." }, // bug internal kalau muncul, bukan salah user
  wrong_rpc_for_stock_mode: { status: 500, message: "Gagal membuat key." }, // idem
  self_purchase_not_allowed: { status: 403, message: "Kamu tidak bisa membeli produk dari tokomu sendiri." },
  user_banned: { status: 403, message: "Akun tidak dapat melakukan transaksi." },
  invalid_key: { status: 500, message: "Gagal membuat key." },
};

export async function POST(request: Request) {
  if (!isSupabaseConfigured) {
    return NextResponse.json(
      { error: "supabase_not_configured", message: "Backend belum terhubung (mode demo)." },
      { status: 503 }
    );
  }

  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  }

  const { productId, durationId } = await request.json().catch(() => ({}));
  if (!productId || !durationId || typeof productId !== "string" || typeof durationId !== "string") {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }

  // 1. Identify the caller from their session cookie -- never trust a
  //    user id sent in the request body.
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = (await supabase?.auth.getUser()) ?? { data: { user: null } };

  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const admin = createAdminSupabase();
  if (!admin) {
    return NextResponse.json({ error: "service_role_missing" }, { status: 500 });
  }

  // 2. Cap how often a single account can hit this endpoint -- a compromised
  //    session or a scripted client shouldn't be able to hammer the RPC.
  const allowed = await checkRateLimit(admin, `generate-key:${user.id}`, {
    maxHits: 20,
    windowSeconds: 60,
  });
  if (!allowed) {
    return NextResponse.json(
      { error: "rate_limited", message: "Terlalu banyak percobaan, coba lagi sebentar." },
      { status: 429 }
    );
  }

  // 3. Look up how this specific duration is stocked -- 'manual' draws from
  //    the key_stock pool (an admin OR a marketplace seller filled in),
  //    'auto' generates live from the vipbestmods.com reseller API (using
  //    the PLATFORM's own shared credentials either way -- a marketplace
  //    seller never has their own separate vipbestmods account, see
  //    0013_marketplace_sellers.sql).
  //
  //    products.seller_id (nullable) is what tells us whether this is a
  //    platform-owned product (existing behavior, untouched) or a
  //    marketplace listing (new generate_key_seller_* RPCs instead of
  //    generate_key/generate_key_manual, different balance/commission
  //    bookkeeping) -- everything else about this endpoint (rate limit,
  //    HTTP status codes, error messages) stays identical for the buyer,
  //    so the frontend never needs to know which kind of product it is.
  const { data: duration, error: durationError } = await admin
    .from("product_durations")
    .select("stock_mode, provider_item_id, price, products!inner(seller_id, active)")
    .eq("product_id", productId)
    .eq("id", durationId)
    .maybeSingle<{
      stock_mode: string;
      provider_item_id: string | null;
      price: number;
      products: { seller_id: string | null; active: boolean } | { seller_id: string | null; active: boolean }[];
    }>();

  if (durationError || !duration) {
    return NextResponse.json({ error: "invalid_product_or_duration", message: KNOWN_ERRORS.invalid_product_or_duration.message }, { status: 400 });
  }

  // Supabase's JS client types a `!inner` join as an array even though the
  // FK makes it always exactly one row -- normalize here once instead of
  // repeating the array-vs-object check at every call site below.
  const productMeta = Array.isArray(duration.products) ? duration.products[0] : duration.products;
  const sellerId = productMeta?.seller_id ?? null;
  // Produk nonaktif tidak boleh dibeli lewat panggilan API langsung (RPC
  // seller juga menolak, tapi di jalur Auto itu terjadi SETELAH provider
  // sudah ditagih -- tolak lebih awal).
  if (productMeta && productMeta.active === false) {
    return NextResponse.json({ error: "invalid_product_or_duration", message: KNOWN_ERRORS.invalid_product_or_duration.message }, { status: 400 });
  }

  function respondForRpcError(error: { message: string }): NextResponse {
    const match = Object.entries(KNOWN_ERRORS).find(([code]) => error.message.includes(code));
    const info = match?.[1] ?? { status: 500, message: "Gagal membuat key." };
    return NextResponse.json({ error: match?.[0] ?? "unknown", message: info.message }, { status: info.status });
  }

  if (duration.stock_mode === "auto") {
    // Mutex per akun: pembelian Auto memanggil provider (uang platform
    // keluar) sebelum saldo didebit, jadi request paralel tidak boleh
    // sama-sama lolos pre-check saldo di bawah (lihat 0015 + lib/auto-order).
    if (!(await acquireAutoOrderLock(admin, user.id))) {
      return NextResponse.json(
        { error: "order_in_progress", message: "Masih ada pembelian Auto yang sedang diproses. Tunggu sebentar lalu coba lagi." },
        { status: 429 }
      );
    }
    try {
      return await (async (): Promise<NextResponse> => {
    // Check the balance BEFORE spending a real provider order -- without
    // this, a reseller/buyer with insufficient balance would still trigger
    // a real (billed) key purchase at vipbestmods.com, only to have our
    // own generate_key/generate_key_seller_auto RPC reject it afterwards.
    // This precheck is a courtesy, not the source of truth: a concurrent
    // purchase can still race between this read and the RPC call below,
    // which is why the RPC's own balance check stays in place as the real
    // guard either way.
    const { data: profile } = await admin.from("users").select("balance").eq("id", user.id).maybeSingle();
    if (!profile) {
      return NextResponse.json({ error: "user_not_found", message: KNOWN_ERRORS.user_not_found.message }, { status: 404 });
    }

    // FIX (see generate_key_seller_auto's docstring): marketplace listings
    // don't have tiers/custom prices -- the seller's product_durations.price
    // IS the price, full stop. Platform-owned products keep using
    // effective_key_price() (tier discount or admin custom_prices override)
    // exactly as before -- only branch on that when sellerId is null.
    let effectivePrice: number;
    if (sellerId) {
      effectivePrice = duration.price;
    } else {
      const { data: platformPrice, error: priceError } = await admin.rpc("effective_key_price", {
        p_user_id: user.id,
        p_product_id: productId,
        p_duration_id: durationId,
        p_default_price: duration.price,
      });
      if (priceError || typeof platformPrice !== "number") {
        return NextResponse.json({ error: "invalid_product_or_duration", message: KNOWN_ERRORS.invalid_product_or_duration.message }, { status: 400 });
      }
      effectivePrice = platformPrice;
    }
    if (profile.balance < effectivePrice) {
      return NextResponse.json({ error: "insufficient_balance", message: KNOWN_ERRORS.insufficient_balance.message }, { status: 402 });
    }

    // Tolak SEBELUM menagih provider: seller nonaktif atau beli dari toko
    // sendiri (cuci saldo topup -> saldo seller). RPC juga menolak, tapi
    // di titik itu key provider sudah terlanjur dibeli.
    if (sellerId) {
      const { data: sellerRow } = await admin.from("sellers").select("user_id, status").eq("id", sellerId).maybeSingle();
      if (!sellerRow || sellerRow.status !== "active") {
        return NextResponse.json({ error: "seller_unavailable", message: KNOWN_ERRORS.seller_unavailable.message }, { status: 409 });
      }
      if (sellerRow.user_id === user.id) {
        return NextResponse.json({ error: "self_purchase_not_allowed", message: KNOWN_ERRORS.self_purchase_not_allowed.message }, { status: 403 });
      }
    }

    // Idempotency key must be stable per attempt at the SAME purchase, not
    // random per retry -- otherwise a network retry could order two real
    // keys from the provider for one balance debit. Deriving it from
    // user+product+duration+minute bucket keeps accidental double-clicks
    // from double-ordering while still allowing a genuinely new purchase
    // a moment later.
    const idempotencyKey = `${user.id}:${productId}:${durationId}:${Math.floor(Date.now() / 60000)}`;
    const providerStartedAt = Date.now();
    const providerResult = await orderProviderKey({
      productItemId: duration.provider_item_id || "",
      idempotencyKey,
      customerReference: user.id,
    });
    // Timing log so a future 502 (Vercel killing the function before this
    // resolves) is visible in Vercel Runtime Logs even without a thrown
    // error -- a 502 from an external timeout never reaches our own
    // catch/error handling, so this is the only trace we get of it.
    console.log("orderProviderKey took", Date.now() - providerStartedAt, "ms", {
      success: providerResult.success,
    });

    if (!providerResult.success) {
      // Simpan ke provider_error_log biar owner bisa lihat riwayat/pola
      // kegagalan lewat GUI (/dashboard/admin/provider-debug) tanpa perlu
      // buka Vercel Runtime Logs. Best-effort -- kegagalan nyimpen log
      // tidak boleh sampai gagalin response error yang sebenarnya ke user.
      // Log-nya tetap simpan pesan MENTAH dari provider (buat debugging
      // owner) -- yang diubah cuma pesan yang dibalas ke customer di bawah.
      admin
        .from("provider_error_log")
        .insert({
          user_id: user.id,
          product_id: productId,
          duration_id: durationId,
          provider_item_id: duration.provider_item_id || null,
          error_message: `[${providerResult.code}] ${providerResult.message || "(tanpa pesan)"}`,
        })
        .then(({ error: logError }) => {
          if (logError) console.error("gagal simpan provider_error_log:", logError.message);
        });
      // FIX: pesan mentah dari provider (termasuk kode sensitif seperti
      // INVALID_SIGNATURE) sebelumnya diteruskan APA ADANYA ke customer.
      // Sekarang dipetakan lewat tabel resmi VIP Best Mods -- lihat
      // providerErrorToCustomerMessage() di vipibmstore.ts.
      const customerFacing = providerErrorToCustomerMessage(providerResult.code, providerResult.message || "");
      return NextResponse.json({ error: "provider_error", message: customerFacing.message }, { status: 502 });
    }
    const providerKey = providerResult.data?.codes?.[0];
    if (!providerKey) {
      return NextResponse.json({ error: "out_of_stock", message: KNOWN_ERRORS.out_of_stock.message }, { status: 409 });
    }

    if (sellerId) {
      // provider_cost = ongkos REAL yang baru saja kepotong dari saldo
      // vipbestmods platform untuk order ini -- dicatat buat audit admin,
      // TIDAK dipakai untuk hitung seller_earning (lihat komentar kolom
      // provider_cost di migration). Null-safe: kalau providernya suatu
      // saat tidak lagi mengirim balance_before/after di response,
      // provider_cost tetap tersimpan null daripada bikin request gagal.
      const providerCost =
        typeof providerResult.data?.balance_before === "number" && typeof providerResult.data?.balance_after === "number"
          ? providerResult.data.balance_before - providerResult.data.balance_after
          : null;

      const { data, error } = await admin.rpc("generate_key_seller_auto", {
        p_buyer_id: user.id,
        p_product_id: productId,
        p_duration_id: durationId,
        p_key_string: providerKey,
        p_provider_cost: providerCost,
      });
      if (!error) return NextResponse.json({ key: data });
      // NOTE: the provider key has already been issued (and billed on their
      // end) even though our own balance debit failed -- same "external
      // side-effect before local commit" tradeoff the platform path below
      // accepts. Logged so it can be reconciled manually rather than
      // silently lost.
      console.error("generate_key_seller_auto RPC failed after provider already issued a key", {
        userId: user.id, productId, durationId, error: error.message,
      });
      if (!error.message.includes("duplicate key")) {
        await logOrphanProviderKey(admin, {
          userId: user.id, productId, durationId, keyString: providerKey, providerCost,
          errorMessage: error.message, source: "generate-key:seller-auto",
        });
      }
      return respondForRpcError(error);
    }

    const { data, error } = await admin.rpc("generate_key", {
      p_user_id: user.id,
      p_product_id: productId,
      p_duration_id: durationId,
      p_key_string: providerKey,
    });

    if (!error) return NextResponse.json({ key: data });

    console.error("generate_key RPC failed after provider already issued a key", {
      userId: user.id, productId, durationId, error: error.message,
    });
    if (!error.message.includes("duplicate key")) {
      await logOrphanProviderKey(admin, {
        userId: user.id, productId, durationId, keyString: providerKey, providerCost: null,
        errorMessage: error.message, source: "generate-key:platform-auto",
      });
    }
    return respondForRpcError(error);
      })();
    } finally {
      await releaseAutoOrderLock(admin, user.id);
    }
  }

  // 4. Manual mode: atomically claim one row from key_stock inside
  //    generate_key_manual() (platform products, supabase/migrations/
  //    0003_admin_provider.sql) or generate_key_seller_manual() (seller
  //    listings, 0013_marketplace_sellers.sql) -- both claim a row scoped
  //    to the right owner, so a seller's stock and the platform's own
  //    stock for a same-named product never collide. No local key_string
  //    generation -- the key must be a real one someone pasted in.
  // PostgREST matches named params by name, and the two RPCs use
  // different first-argument names (p_user_id vs p_buyer_id) -- call each
  // explicitly rather than trying to force one shared object shape.
  let lastError: { message: string } | null = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const attemptStartedAt = Date.now();
    const { data, error } = sellerId
      ? await admin.rpc("generate_key_seller_manual", {
          p_buyer_id: user.id,
          p_product_id: productId,
          p_duration_id: durationId,
        })
      : await admin.rpc("generate_key_manual", {
          p_user_id: user.id,
          p_product_id: productId,
          p_duration_id: durationId,
        });
    console.log("generate_key_manual attempt", attempt, "took", Date.now() - attemptStartedAt, "ms", {
      hasError: Boolean(error),
      seller: Boolean(sellerId),
    });

    if (!error) return NextResponse.json({ key: data });

    lastError = error;
    // out_of_stock / insufficient_balance etc. are never worth retrying;
    // only loop on the astronomically unlikely key_string race.
    const isCollision = error.message.includes("duplicate key") || error.message.includes("key_string");
    if (!isCollision) break;
  }

  return respondForRpcError(lastError ?? { message: "unknown" });
}
