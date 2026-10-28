import PageHeader from "@/components/dashboard/PageHeader";
import AdminStoresList from "@/components/dashboard/admin/AdminStoresList";
import { getAdminStores } from "@/lib/data/store";

export const dynamic = "force-dynamic";

export default async function AdminStoresPage() {
  const rows = await getAdminStores();
  return (
    <div>
      <PageHeader title="Toko Seller" eyebrow="Admin" back="/dashboard/admin" />
      <p className="mb-3 text-[12px] text-ink-faint">
        Toko link yang dibuat reseller (link <span className="font-mono">/s/nama-toko</span>). Pembayaran masuk ke GensPay seller sendiri; admin tidak bisa melihat API key mereka.
        Blokir toko kalau ada penyalahgunaan.
      </p>
      <AdminStoresList rows={rows} />
    </div>
  );
}
