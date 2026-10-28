import PageHeader from "@/components/dashboard/PageHeader";
import AdminDisputes from "@/components/dashboard/admin/AdminDisputes";

export default function Page() {
  return (
    <div>
      <PageHeader title="Komplain Pembeli" eyebrow="Admin · Marketplace" back="/dashboard/admin" />
      <AdminDisputes />
    </div>
  );
}
