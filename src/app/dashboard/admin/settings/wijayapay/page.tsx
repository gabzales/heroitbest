import PageHeader from "@/components/dashboard/PageHeader";
import WijayapaySettingsForm from "@/components/dashboard/admin/WijayapaySettingsForm";

export default function AdminWijayapaySettingsPage() {
  return (
    <div>
      <PageHeader title="WijayaPay" eyebrow="Admin · Pengaturan" back="/dashboard/admin" />
      <WijayapaySettingsForm />
    </div>
  );
}
