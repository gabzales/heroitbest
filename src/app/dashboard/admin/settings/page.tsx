import PageHeader from "@/components/dashboard/PageHeader";
import ProviderSettingsForm from "@/components/dashboard/admin/ProviderSettingsForm";
import CheatgameSettingsForm from "@/components/dashboard/admin/CheatgameSettingsForm";

export default function AdminSettingsPage() {
  return (
    <div>
      <PageHeader title="Reseller API" eyebrow="Admin · Pengaturan" back="/dashboard/admin" />
      <ProviderSettingsForm />
      <CheatgameSettingsForm />
    </div>
  );
}
