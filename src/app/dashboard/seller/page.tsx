import PageHeader from "@/components/dashboard/PageHeader";
import DemoNote from "@/components/dashboard/seller/DemoNote";
import SellerHome from "@/components/dashboard/seller/SellerHome";

export default function SellerHomePage() {
  return (
    <div>
      <PageHeader title="Toko Saya" eyebrow="Jualan" />
      <DemoNote />
      <SellerHome />
    </div>
  );
}
