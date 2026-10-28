import PageHeader from "@/components/dashboard/PageHeader";
import AdminSellers from "@/components/dashboard/admin/AdminSellers";

export default function Page() {
  return (
    <div>
      <PageHeader title="Seller" eyebrow="Admin · Marketplace" back="/dashboard/admin" />
      <AdminSellers />
    </div>
  );
}
