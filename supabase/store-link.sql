-- ── 9. Toko link seller (seller jual key lewat /s/<slug>, bayar ke GensPay seller sendiri) ──
-- Alur: pembeli bayar QRIS ke akun GensPay milik seller -> webhook terverifikasi
-- (pakai API key seller) -> key diambil dari SALDO seller di heroitbest pada
-- harga modal seller -> key tampil di halaman pesanan pembeli.
-- Semua tabel di sini TERKUNCI (RLS aktif, tanpa policy, tanpa grant):
-- hanya service_role (server) yang bisa baca/tulis. API key GensPay seller
-- disimpan TERENKRIPSI (AES-256-GCM di server) dan tidak pernah dikirim ke browser.
create table if not exists public.stores (
  user_id uuid primary key references public.users (id) on delete cascade,
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{2,29}$'),
  name text not null check (char_length(name) between 2 and 40),
  contact_wa text check (contact_wa is null or contact_wa ~ '^[0-9]{8,16}$'),
  genspay_key_enc text,
  genspay_key_last4 text,
  enabled boolean not null default false,
  admin_blocked boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.store_prices (
  user_id uuid not null references public.stores (user_id) on delete cascade,
  product_id text not null,
  duration_id text not null,
  price bigint not null check (price >= 1000),
  active boolean not null default true,
  primary key (user_id, product_id, duration_id),
  foreign key (product_id, duration_id) references public.product_durations (product_id, id) on delete cascade
);

create table if not exists public.store_orders (
  id uuid primary key default gen_random_uuid(),
  token text not null unique,
  merchant_ref text not null unique,
  store_user_id uuid not null references public.stores (user_id) on delete cascade,
  product_id text not null,
  duration_id text not null,
  product_name text not null,
  duration_label text not null,
  sell_price bigint not null,
  gross_amount bigint,
  buyer_contact text,
  status text not null default 'pending'
    check (status in ('pending','paid','delivered','paid_failed','expired','failed')),
  fail_reason text,
  key_id uuid references public.reseller_keys (id),
  cost_price bigint,
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  delivered_at timestamptz
);
create index if not exists store_orders_store_idx on public.store_orders (store_user_id, created_at desc);

alter table public.stores enable row level security;
alter table public.store_prices enable row level security;
alter table public.store_orders enable row level security;
revoke all on public.stores, public.store_prices, public.store_orders from anon, authenticated;

-- Ambil key manual (stok key_stock) untuk satu pesanan, ATOMIK: debit saldo
-- seller + klaim stok + tandai pesanan delivered dalam satu transaksi.
-- Idempotent: pesanan yang sudah delivered mengembalikan key yang sama.
create or replace function public.store_issue_manual(p_merchant_ref text)
returns public.reseller_keys
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.store_orders;
  v_row public.reseller_keys;
begin
  select * into v_order from public.store_orders where merchant_ref = p_merchant_ref for update;
  if not found then raise exception 'order_not_found'; end if;

  if v_order.status = 'delivered' then
    select * into v_row from public.reseller_keys where id = v_order.key_id;
    return v_row;
  end if;
  if v_order.status not in ('paid', 'paid_failed') then
    raise exception 'order_not_paid';
  end if;

  v_row := public.generate_key_manual(v_order.store_user_id, v_order.product_id, v_order.duration_id);

  update public.store_orders
     set status = 'delivered', key_id = v_row.id, cost_price = v_row.price,
         delivered_at = now(), fail_reason = null
   where id = v_order.id;
  return v_row;
end;
$$;

-- Sama, untuk produk mode Auto: key sudah dibeli dari provider oleh server,
-- fungsi ini mendebit saldo seller + mencatat key + menandai delivered.
create or replace function public.store_issue_auto(p_merchant_ref text, p_key_string text)
returns public.reseller_keys
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.store_orders;
  v_row public.reseller_keys;
begin
  select * into v_order from public.store_orders where merchant_ref = p_merchant_ref for update;
  if not found then raise exception 'order_not_found'; end if;

  if v_order.status = 'delivered' then
    select * into v_row from public.reseller_keys where id = v_order.key_id;
    return v_row;
  end if;
  if v_order.status not in ('paid', 'paid_failed') then
    raise exception 'order_not_paid';
  end if;

  v_row := public.generate_key(v_order.store_user_id, v_order.product_id, v_order.duration_id, p_key_string);

  update public.store_orders
     set status = 'delivered', key_id = v_row.id, cost_price = v_row.price,
         delivered_at = now(), fail_reason = null
   where id = v_order.id;
  return v_row;
end;
$$;

-- Fungsi baru bagian 9: tutup dari anon/authenticated, buka hanya untuk service_role.
revoke all on function public.store_issue_manual(text) from public, anon, authenticated;
revoke all on function public.store_issue_auto(text, text) from public, anon, authenticated;
grant execute on function public.store_issue_manual(text) to service_role;
grant execute on function public.store_issue_auto(text, text) to service_role;
