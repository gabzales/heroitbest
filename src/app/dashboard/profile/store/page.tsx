import { redirect } from "next/navigation";
import PageHeader from "@/components/dashboard/PageHeader";
import StoreSettings from "@/components/dashboard/store/StoreSettings";
import { getCurrentUser } from "@/lib/data/user";
import { getMyStore } from "@/lib/data/store";

export const dynamic = "force-dynamic";

export default async function MyStorePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const data = await getMyStore(user.id);
  return (
    <div className="mx-auto max-w-[640px]">
      <PageHeader title="Toko Saya" eyebrow="Profil" back="/dashboard/profile" />
      <StoreSettings data={data} />
    </div>
  );
}
