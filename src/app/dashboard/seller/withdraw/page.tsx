import PageHeader from "@/components/dashboard/PageHeader";
import DemoNote from "@/components/dashboard/seller/DemoNote";
import SellerWithdraw from "@/components/dashboard/seller/SellerWithdraw";

export default function SellerWithdrawPage() {
  return (
    <div>
      <PageHeader title="Tarik Saldo" eyebrow="Jualan" back="/dashboard/seller" />
      <DemoNote />
      <SellerWithdraw />
    </div>
  );
}
