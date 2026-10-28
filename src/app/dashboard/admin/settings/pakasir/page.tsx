import PageHeader from "@/components/dashboard/PageHeader";
import PakasirSettingsForm from "@/components/dashboard/admin/PakasirSettingsForm";

export default function AdminPakasirSettingsPage() {
  return (
    <div>
      <PageHeader title="Pakasir" eyebrow="Admin · Pengaturan" back="/dashboard/admin" />
      <PakasirSettingsForm />
    </div>
  );
}
