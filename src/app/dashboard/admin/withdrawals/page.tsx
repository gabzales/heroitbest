import PageHeader from "@/components/dashboard/PageHeader";
import AdminWithdrawals from "@/components/dashboard/admin/AdminWithdrawals";

export default function Page() {
  return (
    <div>
      <PageHeader title="Penarikan Saldo Seller" eyebrow="Admin · Marketplace" back="/dashboard/admin" />
      <AdminWithdrawals />
    </div>
  );
}
