import PageHeader from "@/components/dashboard/PageHeader";
import MarketplaceSettingsForm from "@/components/dashboard/admin/MarketplaceSettingsForm";

export default function Page() {
  return (
    <div>
      <PageHeader title="Pengaturan Marketplace" eyebrow="Admin · Marketplace" back="/dashboard/admin" />
      <MarketplaceSettingsForm />
    </div>
  );
}
