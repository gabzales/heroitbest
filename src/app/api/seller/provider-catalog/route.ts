import { NextResponse } from "next/server";
import { requireActiveSeller } from "@/lib/seller-context";
import { getMarketplaceSettings, minSellPrice } from "@/lib/marketplace";
import { getProviderProducts } from "@/lib/provider/vipibmstore";

// Katalog item Auto untuk dropdown seller. SENGAJA tidak mengirim harga
// modal mentah dari supplier -- seller cukup tahu harga MINIMAL jual.
export async function GET() {
  const auth = await requireActiveSeller();
  if (!auth.ok) return auth.response;
  const settings = await getMarketplaceSettings(auth.admin);
  if (!settings.sellerAutoEnabled) return NextResponse.json({ enabled: false, items: [] });

  const catalog = await getProviderProducts({});
  if (!catalog.success) return NextResponse.json({ error: "provider_unreachable", message: "Katalog Auto sedang tidak terjangkau." }, { status: 503 });

  const items = catalog.data
    .filter((p) => typeof p.price === "number" && (p.status === undefined || p.status === "active"))
    .map((p) => ({
      id: String(p.id),
      name: `${p.product_name} — ${p.item_name}`,
      minSellPrice: minSellPrice(p.price as number, settings.minAutoMarkupPercent),
    }));
  return NextResponse.json({ enabled: true, items });
}
