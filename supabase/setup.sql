-- ══════════════════════════════════════════════════════════════════
-- heroitbest — SETUP DATABASE (satu file)
-- Jalankan SELURUH isi file ini SEKALI di Supabase → SQL Editor (project baru/kosong).
-- Isi: tabel inti, hardening, admin/provider, saldo, harga tier, ops reseller,
-- top-up aman (anti pending/kredit ganda), marketplace seller, lock-down RPC.
-- ══════════════════════════════════════════════════════════════════

-- >>>>>>>>>> 0001_init.sql
-- heroitbest schema
-- Run this in the Supabase SQL editor (or `supabase db push`) on the SAME
-- project that heroitbest.com already uses (PRD 1: shared database).
--
-- Idempotent-ish: safe to re-run, uses IF NOT EXISTS / OR REPLACE.

-- ────────────────────────────────────────────────────────────────────────
-- 1. users — one row per Supabase Auth user, source of truth for balance
-- ────────────────────────────────────────────────────────────────────────
create table if not exists public.users (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  full_name text,
  avatar_url text,
  balance bigint not null default 0 check (balance >= 0),
  role text not null default 'user' check (role in ('user', 'admin')),
  verified boolean not null default false,
  source_domain text not null default 'heroitbest.com',
  created_at timestamptz not null default now()
);

-- Auto-create a users row the moment an account exists in auth.users --
-- which, since there's no public sign-up form, only happens when an
-- admin creates one (Supabase Dashboard -> Authentication -> Add User,
-- or the Admin API) after approving a reseller over WhatsApp.
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.users (id, email, full_name, avatar_url)
  values (
    new.id,
    new.email,
    new.raw_user_meta_data ->> 'full_name',
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_auth_user();

-- ────────────────────────────────────────────────────────────────────────
-- 2. products / product_durations — pulled from the central catalog
-- ────────────────────────────────────────────────────────────────────────
create table if not exists public.products (
  id text primary key,
  name text not null,
  category text not null default 'General',
  active boolean not null default true,
  sort_order int not null default 0
);

create table if not exists public.product_durations (
  id text not null,
  product_id text not null references public.products (id) on delete cascade,
  label text not null,
  days int not null,
  price bigint not null check (price >= 0),
  primary key (product_id, id)
);

-- ────────────────────────────────────────────────────────────────────────
-- 3. reseller_keys — every key a reseller has generated
-- ────────────────────────────────────────────────────────────────────────
create table if not exists public.reseller_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  product_id text not null references public.products (id),
  product_name text not null,
  duration_label text not null,
  price bigint not null,
  key_string text not null,
  created_at timestamptz not null default now()
);

create index if not exists reseller_keys_user_idx
  on public.reseller_keys (user_id, created_at desc);

-- ────────────────────────────────────────────────────────────────────────
-- 4. topups — QRIS deposit transactions
-- ────────────────────────────────────────────────────────────────────────
create table if not exists public.topups (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  nominal bigint not null check (nominal > 0),
  bonus bigint not null default 0,
  total bigint not null,
  method text not null default 'QRIS',
  status text not null default 'pending' check (status in ('pending', 'success', 'failed')),
  provider_ref text unique, -- external gateway transaction id, for webhook idempotency
  created_at timestamptz not null default now(),
  settled_at timestamptz
);

create index if not exists topups_user_idx
  on public.topups (user_id, created_at desc);

-- ────────────────────────────────────────────────────────────────────────
-- 5. RPC: generate_key — atomic "check balance → debit → insert key"
--    Called from the server route with the service role so RLS is
--    bypassed here on purpose; the route itself authenticates the caller.
-- ────────────────────────────────────────────────────────────────────────
create or replace function public.generate_key(
  p_user_id uuid,
  p_product_id text,
  p_duration_id text,
  p_key_string text
)
returns public.reseller_keys
language plpgsql
security definer
set search_path = public
as $$
declare
  v_price bigint;
  v_label text;
  v_product_name text;
  v_balance bigint;
  v_row public.reseller_keys;
begin
  select pd.price, pd.label, p.name
    into v_price, v_label, v_product_name
  from public.product_durations pd
  join public.products p on p.id = pd.product_id
  where pd.product_id = p_product_id and pd.id = p_duration_id;

  if v_price is null then
    raise exception 'invalid_product_or_duration';
  end if;

  select balance into v_balance from public.users where id = p_user_id for update;

  if v_balance is null then
    raise exception 'user_not_found';
  end if;

  if v_balance < v_price then
    raise exception 'insufficient_balance';
  end if;

  update public.users set balance = balance - v_price where id = p_user_id;

  insert into public.reseller_keys (user_id, product_id, product_name, duration_label, price, key_string)
  values (p_user_id, p_product_id, v_product_name, v_label, v_price, p_key_string)
  returning * into v_row;

  return v_row;
end;
$$;

-- ────────────────────────────────────────────────────────────────────────
-- 6. RPC: settle_topup — called by the QRIS webhook handler once the
--    payment gateway confirms a successful payment. Idempotent on
--    provider_ref so a retried webhook can't double-credit balance.
-- ────────────────────────────────────────────────────────────────────────
create or replace function public.settle_topup(
  p_provider_ref text,
  p_user_id uuid,
  p_nominal bigint,
  p_bonus bigint
)
returns public.topups
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.topups;
begin
  select * into v_row from public.topups where provider_ref = p_provider_ref;

  if found then
    return v_row; -- already settled, no-op (idempotent)
  end if;

  insert into public.topups (user_id, nominal, bonus, total, status, provider_ref, settled_at)
  values (p_user_id, p_nominal, p_bonus, p_nominal + p_bonus, 'success', p_provider_ref, now())
  returning * into v_row;

  update public.users set balance = balance + v_row.total where id = p_user_id;

  return v_row;
end;
$$;

-- ────────────────────────────────────────────────────────────────────────
-- 7. Row Level Security (PRD 5)
-- ────────────────────────────────────────────────────────────────────────
-- IMPORTANT: RLS policies restrict which ROWS a role can touch, not which
-- COLUMNS. Supabase grants broad table privileges to `anon`/`authenticated`
-- by default, so without the explicit REVOKE/GRANT block below, a signed-in
-- user could call `supabase.from('users').update({ balance: 999999999 })`
-- from the browser and — because the row-level check `auth.uid() = id`
-- would pass — actually succeed. Column-level privileges close that gap.
alter table public.users enable row level security;
alter table public.products enable row level security;
alter table public.product_durations enable row level security;
alter table public.reseller_keys enable row level security;
alter table public.topups enable row level security;

revoke all on public.users, public.reseller_keys, public.topups
  from anon, authenticated;
revoke all on public.products, public.product_durations
  from anon, authenticated;

grant select on public.products, public.product_durations to anon, authenticated;
grant select on public.users, public.reseller_keys, public.topups to authenticated;
-- Only these two columns are ever safe for a user to change themselves.
-- balance / role / verified are writable ONLY via generate_key() /
-- settle_topup() (SECURITY DEFINER, called with the service_role key).
grant update (full_name, avatar_url) on public.users to authenticated;

drop policy if exists "users read own row" on public.users;
create policy "users read own row" on public.users
  for select using (auth.uid() = id);

drop policy if exists "users update own non-balance fields" on public.users;
create policy "users update own non-balance fields" on public.users
  for update using (auth.uid() = id)
  with check (auth.uid() = id);
  -- The GRANT above already limits this to (full_name, avatar_url) at the
  -- column level — this row-level policy only adds "must be your own row"
  -- on top of that. Never widen the GRANT to include balance/role/verified.

drop policy if exists "anyone can read active products" on public.products;
create policy "anyone can read active products" on public.products
  for select using (active = true);

drop policy if exists "anyone can read durations" on public.product_durations;
create policy "anyone can read durations" on public.product_durations
  for select using (true);

drop policy if exists "users read own keys" on public.reseller_keys;
create policy "users read own keys" on public.reseller_keys
  for select using (auth.uid() = user_id);

drop policy if exists "users read own topups" on public.topups;
create policy "users read own topups" on public.topups
  for select using (auth.uid() = user_id);

-- ────────────────────────────────────────────────────────────────────────
-- 8. Seed products (safe to edit / re-run)
-- ────────────────────────────────────────────────────────────────────────
insert into public.products (id, name, category, sort_order) values
  ('hg-apkmod-ff', 'HG APKMOD FF', 'Free Fire', 1),
  ('drip-client-root', 'Drip Client Root', 'Free Fire', 2),
  ('fluorite-ios-mlbb', 'Fluorite iOS MLBB', 'Mobile Legends', 3),
  ('aurora-vn-pc', 'Aurora VN PC', 'PC', 4)
on conflict (id) do nothing;

insert into public.product_durations (id, product_id, label, days, price) values
  ('1d', 'hg-apkmod-ff', '1 Day', 1, 8000),
  ('7d', 'hg-apkmod-ff', '7 Days', 7, 45000),
  ('10d', 'hg-apkmod-ff', '10 Days', 10, 60000),
  ('30d', 'hg-apkmod-ff', '30 Days', 30, 150000),
  ('1d', 'drip-client-root', '1 Day', 1, 10000),
  ('7d', 'drip-client-root', '7 Days', 7, 55000),
  ('30d', 'drip-client-root', '30 Days', 30, 180000),
  ('1d', 'fluorite-ios-mlbb', '1 Day', 1, 12000),
  ('7d', 'fluorite-ios-mlbb', '7 Days', 7, 65000),
  ('30d', 'fluorite-ios-mlbb', '30 Days', 30, 210000),
  ('1d', 'aurora-vn-pc', '1 Day', 1, 15000),
  ('30d', 'aurora-vn-pc', '30 Days', 30, 250000)
on conflict (product_id, id) do nothing;


-- >>>>>>>>>> 0002_production_hardening.sql
-- heroitbest — production hardening pass
-- Run AFTER 0001_init.sql on the same project. Safe to re-run (uses
-- IF NOT EXISTS / OR REPLACE / DROP ... IF EXISTS throughout).

-- ────────────────────────────────────────────────────────────────────────
-- 1. reseller_keys.key_string must be globally unique.
--    generate_key() now retries on a random key_string collision from the
--    route handler; the DB constraint is the real guarantee. A duplicate
--    key_string would otherwise mean two customers holding "the same"
--    license/activation key.
-- ────────────────────────────────────────────────────────────────────────
alter table public.reseller_keys
  drop constraint if exists reseller_keys_key_string_key;
alter table public.reseller_keys
  add constraint reseller_keys_key_string_key unique (key_string);

-- ────────────────────────────────────────────────────────────────────────
-- 2. topups.merchant_ref — stores the exact "topup:<user_id>:<nominal>:
--    <nonce>" value used to create the transaction upstream, so
--    /api/topup/create can find/upsert the pending row and the webhook can
--    cross-check it. provider_ref (external gateway trx id) remains the
--    idempotency key for settle_topup().
-- ────────────────────────────────────────────────────────────────────────
alter table public.topups
  add column if not exists merchant_ref text;
alter table public.topups
  drop constraint if exists topups_merchant_ref_key;
alter table public.topups
  add constraint topups_merchant_ref_key unique (merchant_ref);

-- ────────────────────────────────────────────────────────────────────────
-- 3. Rate limiting — generic sliding-window counter table + atomic RPC.
--    Used by /api/generate-key and /api/topup/create to cap how often a
--    given user can hit balance-mutating endpoints. SECURITY DEFINER so
--    it's only reachable through the service-role client in route
--    handlers, never directly from the browser (no RLS policy grants
--    anon/authenticated access to this table at all).
-- ────────────────────────────────────────────────────────────────────────
create table if not exists public.rate_limit_hits (
  id bigint generated always as identity primary key,
  bucket text not null,        -- e.g. 'generate-key:<user_id>'
  created_at timestamptz not null default now()
);

create index if not exists rate_limit_hits_bucket_idx
  on public.rate_limit_hits (bucket, created_at desc);

alter table public.rate_limit_hits enable row level security;
revoke all on public.rate_limit_hits from anon, authenticated;
-- No grants at all: only the service-role key (which bypasses RLS/grants)
-- can touch this table, and only via the RPC below.

-- Periodically prune old rows so the table doesn't grow unbounded. Cheap
-- enough to run inline on every call rather than needing pg_cron.
create or replace function public.check_rate_limit(
  p_bucket text,
  p_max_hits int,
  p_window_seconds int
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  delete from public.rate_limit_hits
    where bucket = p_bucket
      and created_at < now() - make_interval(secs => p_window_seconds * 4);

  select count(*) into v_count
    from public.rate_limit_hits
    where bucket = p_bucket
      and created_at > now() - make_interval(secs => p_window_seconds);

  if v_count >= p_max_hits then
    return false; -- caller should respond 429
  end if;

  insert into public.rate_limit_hits (bucket) values (p_bucket);
  return true;
end;
$$;

-- ────────────────────────────────────────────────────────────────────────
-- 4. settle_topup() — also accept/record merchant_ref so a topup created
--    by /api/topup/create (status 'pending') gets updated in place
--    instead of leaving an orphaned pending row next to a new settled one.
-- ────────────────────────────────────────────────────────────────────────
create or replace function public.settle_topup(
  p_provider_ref text,
  p_user_id uuid,
  p_nominal bigint,
  p_bonus bigint,
  p_merchant_ref text default null
)
returns public.topups
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.topups;
begin
  select * into v_row from public.topups where provider_ref = p_provider_ref;
  if found then
    return v_row; -- already settled, no-op (idempotent)
  end if;

  -- If /api/topup/create already inserted a 'pending' row for this
  -- merchant_ref, settle that same row instead of inserting a duplicate.
  if p_merchant_ref is not null then
    select * into v_row from public.topups
      where merchant_ref = p_merchant_ref and status = 'pending'
      for update;
  end if;

  if found then
    update public.topups
      set status = 'success',
          bonus = p_bonus,
          total = p_nominal + p_bonus,
          provider_ref = p_provider_ref,
          settled_at = now()
      where id = v_row.id
      returning * into v_row;
  else
    insert into public.topups (user_id, nominal, bonus, total, status, provider_ref, merchant_ref, settled_at)
    values (p_user_id, p_nominal, p_bonus, p_nominal + p_bonus, 'success', p_provider_ref, p_merchant_ref, now())
    returning * into v_row;
  end if;

  update public.users set balance = balance + v_row.total where id = p_user_id;

  return v_row;
end;
$$;

-- ────────────────────────────────────────────────────────────────────────
-- 5. create_pending_topup() — the one write /api/topup/create is allowed
--    to make, via the service-role client, right after the gateway
--    accepts the transaction. Kept as an RPC (not a raw insert) so the
--    same validation lives in one place regardless of which route calls
--    it.
-- ────────────────────────────────────────────────────────────────────────
create or replace function public.create_pending_topup(
  p_user_id uuid,
  p_merchant_ref text,
  p_nominal bigint,
  p_bonus bigint
)
returns public.topups
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.topups;
begin
  insert into public.topups (user_id, nominal, bonus, total, status, merchant_ref)
  values (p_user_id, p_nominal, p_bonus, p_nominal + p_bonus, 'pending', p_merchant_ref)
  returning * into v_row;
  return v_row;
end;
$$;


-- >>>>>>>>>> 0003_admin_provider.sql
-- heroitbest — admin authority: product CRUD, manual key stock pool,
-- reseller-provider (vipibmstore.com) integration for auto-generated keys.
-- Run AFTER 0001_init.sql and 0002_production_hardening.sql. Safe to re-run.

-- ────────────────────────────────────────────────────────────────────────
-- 1. product_durations — stock mode per duration, same idea as heroitbest
--    (settings.json stockMode): 'manual' draws from key_stock below,
--    'auto' calls the reseller provider live at generate time.
--    provider_item_id is the matched item id in the provider's own
--    catalog (picked by admin from /api/admin/provider/products), only
--    meaningful when stock_mode = 'auto'.
-- ────────────────────────────────────────────────────────────────────────
alter table public.product_durations
  add column if not exists stock_mode text not null default 'manual'
    check (stock_mode in ('manual', 'auto'));
alter table public.product_durations
  add column if not exists provider_item_id text;

-- ────────────────────────────────────────────────────────────────────────
-- 2. key_stock — manual pool of not-yet-sold keys, one row per key.
--    Admin bulk-pastes keys in the product editor; generate_key_manual()
--    below atomically claims one row per sale (FOR UPDATE SKIP LOCKED so
--    concurrent purchases never hand out the same key twice).
-- ────────────────────────────────────────────────────────────────────────
create table if not exists public.key_stock (
  id uuid primary key default gen_random_uuid(),
  product_id text not null,
  duration_id text not null,
  key_string text not null,
  used boolean not null default false,
  used_by uuid references public.users (id) on delete set null,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (product_id, duration_id)
    references public.product_durations (product_id, id) on delete cascade
);

create index if not exists key_stock_available_idx
  on public.key_stock (product_id, duration_id)
  where used = false;

-- ────────────────────────────────────────────────────────────────────────
-- 3. app_settings — small key/value store for admin-configured settings
--    that shouldn't live in env vars alone (mirrors heroitbest's
--    settings.json). Currently just the reseller_api credentials for
--    vipibmstore.com. Service-role only: no grants to anon/authenticated
--    at all, exactly like rate_limit_hits.
-- ────────────────────────────────────────────────────────────────────────
create table if not exists public.app_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

-- ────────────────────────────────────────────────────────────────────────
-- 4. RPC: generate_key_manual — same balance-check-and-debit contract as
--    generate_key(), but the key comes from the manual pool instead of
--    being passed in. Used when the duration's stock_mode = 'manual'.
-- ────────────────────────────────────────────────────────────────────────
create or replace function public.generate_key_manual(
  p_user_id uuid,
  p_product_id text,
  p_duration_id text
)
returns public.reseller_keys
language plpgsql
security definer
set search_path = public
as $$
declare
  v_price bigint;
  v_label text;
  v_product_name text;
  v_balance bigint;
  v_stock_id uuid;
  v_key_string text;
  v_row public.reseller_keys;
begin
  select pd.price, pd.label, p.name
    into v_price, v_label, v_product_name
  from public.product_durations pd
  join public.products p on p.id = pd.product_id
  where pd.product_id = p_product_id and pd.id = p_duration_id;

  if v_price is null then
    raise exception 'invalid_product_or_duration';
  end if;

  select balance into v_balance from public.users where id = p_user_id for update;

  if v_balance is null then
    raise exception 'user_not_found';
  end if;

  if v_balance < v_price then
    raise exception 'insufficient_balance';
  end if;

  select id, key_string into v_stock_id, v_key_string
  from public.key_stock
  where product_id = p_product_id and duration_id = p_duration_id and used = false
  order by created_at asc
  limit 1
  for update skip locked;

  if v_stock_id is null then
    raise exception 'out_of_stock';
  end if;

  update public.key_stock
    set used = true, used_by = p_user_id, used_at = now()
    where id = v_stock_id;

  update public.users set balance = balance - v_price where id = p_user_id;

  insert into public.reseller_keys (user_id, product_id, product_name, duration_label, price, key_string)
  values (p_user_id, p_product_id, v_product_name, v_label, v_price, v_key_string)
  returning * into v_row;

  return v_row;
end;
$$;

-- ────────────────────────────────────────────────────────────────────────
-- 5. RLS — key_stock and app_settings are admin/service-role only. Product
--    reads for resellers still go through the existing public.products /
--    product_durations policies (unchanged); stock_mode and
--    provider_item_id are internal fields the storefront query never
--    selects, but REVOKE keeps that enforced at the DB layer too, not
--    just by convention in the query.
-- ────────────────────────────────────────────────────────────────────────
alter table public.key_stock enable row level security;
alter table public.app_settings enable row level security;

revoke all on public.key_stock, public.app_settings from anon, authenticated;
-- No policies created on purpose: zero grants means zero access for
-- anon/authenticated regardless of policy, matching rate_limit_hits.
-- Only the service-role client (src/lib/supabase/admin.ts) can touch
-- these two tables, and every route that does first calls requireAdmin().

-- products / product_durations already have admin-safe read policies
-- from 0001; admin write access to those goes through the service-role
-- client too (see src/app/api/admin/**), so no policy changes needed
-- there -- anon/authenticated were never granted insert/update/delete.


-- >>>>>>>>>> 0004_manual_balance.sql
-- heroitbest — admin manual balance adjustment (top up saldo reseller di
-- luar QRIS/GensPay, mis. transfer manual/bonus/koreksi), sama seperti
-- fitur adjustBalance di heroitbest. Run after 0003_admin_provider.sql.

-- ────────────────────────────────────────────────────────────────────────
-- 1. balance_adjustments — audit trail: siapa admin-nya, ke user mana,
--    berapa, kenapa. Admin-only (service role), tidak pernah dibuka ke
--    anon/authenticated langsung.
-- ────────────────────────────────────────────────────────────────────────
create table if not exists public.balance_adjustments (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid not null references public.users (id) on delete set null,
  user_id uuid not null references public.users (id) on delete cascade,
  amount bigint not null check (amount <> 0), -- positive = tambah, negative = kurangi
  note text,
  created_at timestamptz not null default now()
);

create index if not exists balance_adjustments_user_idx
  on public.balance_adjustments (user_id, created_at desc);

alter table public.balance_adjustments enable row level security;
revoke all on public.balance_adjustments from anon, authenticated;
-- No policies on purpose -- service-role only, same pattern as
-- rate_limit_hits / key_stock / app_settings.

-- ────────────────────────────────────────────────────────────────────────
-- 2. RPC: admin_adjust_balance — atomically credits/debits a reseller's
--    balance and logs it. No upper bound on the amount (admin is trusted
--    by definition -- the only floor enforced is the same `balance >= 0`
--    check every other balance mutation already respects, so a deduction
--    still can't push someone negative).
--
--    A positive amount also creates a matching row in `topups` with
--    method = 'MANUAL' so the reseller sees it plainly in their own
--    History Top Up instead of a balance that silently jumped with no
--    paper trail on their side. Negative adjustments (corrections) are
--    NOT mirrored into topups -- there's no such thing as a "negative
--    top up" from the reseller's point of view; those stay recorded in
--    balance_adjustments only, which is admin-facing.
-- ────────────────────────────────────────────────────────────────────────
create or replace function public.admin_adjust_balance(
  p_admin_id uuid,
  p_user_id uuid,
  p_amount bigint,
  p_note text default null
)
returns public.users
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user public.users;
begin
  if p_amount = 0 then
    raise exception 'invalid_amount';
  end if;

  select * into v_user from public.users where id = p_user_id for update;
  if v_user is null then
    raise exception 'user_not_found';
  end if;

  if v_user.balance + p_amount < 0 then
    raise exception 'insufficient_balance';
  end if;

  update public.users set balance = balance + p_amount where id = p_user_id
    returning * into v_user;

  insert into public.balance_adjustments (admin_id, user_id, amount, note)
  values (p_admin_id, p_user_id, p_amount, p_note);

  if p_amount > 0 then
    insert into public.topups (user_id, nominal, bonus, total, method, status, provider_ref, settled_at)
    values (p_user_id, p_amount, 0, p_amount, 'MANUAL', 'success', 'ADJ-' || gen_random_uuid()::text, now());
  end if;

  return v_user;
end;
$$;


-- >>>>>>>>>> 0005_key_pricing.sql
-- heroitbest — harga key bertingkat (tier berdasarkan total top up) +
-- harga khusus per reseller (custom, admin pilih user tertentu). Run
-- after 0004_manual_balance.sql.
--
-- Prioritas harga saat generate key (lihat effective_key_price() di
-- bawah), dari yang paling spesifik ke paling umum:
--   1. custom_prices   -- admin set harga khusus untuk 1 user + 1 durasi
--   2. price_tiers     -- harga otomatis berdasarkan total_topup user,
--                          ambil tier tertinggi yang masih <= total_topup
--   3. product_durations.price -- harga default, dipakai kalau tidak ada
--                          override sama sekali

-- ────────────────────────────────────────────────────────────────────────
-- 1. users.total_topup — akumulasi lifetime top up SUKSES (QRIS via
--    settle_topup() maupun manual via admin_adjust_balance()), dipakai
--    sebagai patokan tier. Terpisah dari `balance` (yang bisa berkurang
--    saat beli key) supaya tier reseller tidak turun lagi cuma karena
--    saldonya kepakai.
-- ────────────────────────────────────────────────────────────────────────
alter table public.users
  add column if not exists total_topup bigint not null default 0;

-- Backfill dari histori topups sukses yang sudah ada (baik QRIS maupun
-- method='MANUAL' dari admin_adjust_balance) supaya tier langsung akurat
-- untuk reseller lama, bukan cuma reseller baru setelah migration ini.
update public.users u
set total_topup = coalesce((
  select sum(t.total) from public.topups t
  where t.user_id = u.id and t.status = 'success'
), 0)
where total_topup = 0;

-- ────────────────────────────────────────────────────────────────────────
-- 2. price_tiers — harga per (product_id, duration_id) yang berlaku kalau
--    total_topup user >= min_total_topup. Beberapa tier boleh ada untuk
--    durasi yang sama (mis. >=500rb, >=1jt, >=5jt) -- effective_key_price()
--    di bawah otomatis ambil yang tertinggi yang masih terpenuhi.
-- ────────────────────────────────────────────────────────────────────────
create table if not exists public.price_tiers (
  id uuid primary key default gen_random_uuid(),
  product_id text not null,
  duration_id text not null,
  min_total_topup bigint not null check (min_total_topup >= 0),
  price bigint not null check (price >= 0),
  created_at timestamptz not null default now(),
  foreign key (product_id, duration_id)
    references public.product_durations (product_id, id) on delete cascade,
  unique (product_id, duration_id, min_total_topup)
);

create index if not exists price_tiers_lookup_idx
  on public.price_tiers (product_id, duration_id, min_total_topup desc);

-- ────────────────────────────────────────────────────────────────────────
-- 3. custom_prices — harga khusus admin pilih 1 user + 1 durasi. Selalu
--    menang di atas price_tiers kalau ada baris yang cocok persis.
-- ────────────────────────────────────────────────────────────────────────
create table if not exists public.custom_prices (
  user_id uuid not null references public.users (id) on delete cascade,
  product_id text not null,
  duration_id text not null,
  price bigint not null check (price >= 0),
  created_at timestamptz not null default now(),
  primary key (user_id, product_id, duration_id),
  foreign key (product_id, duration_id)
    references public.product_durations (product_id, id) on delete cascade
);

-- ────────────────────────────────────────────────────────────────────────
-- 4. effective_key_price() — dipanggil dari generate_key() /
--    generate_key_manual() menggantikan pd.price langsung.
-- ────────────────────────────────────────────────────────────────────────
create or replace function public.effective_key_price(
  p_user_id uuid,
  p_product_id text,
  p_duration_id text,
  p_default_price bigint
)
returns bigint
language plpgsql
stable
set search_path = public
as $$
declare
  v_custom bigint;
  v_tier bigint;
  v_total_topup bigint;
begin
  select price into v_custom
  from public.custom_prices
  where user_id = p_user_id and product_id = p_product_id and duration_id = p_duration_id;

  if v_custom is not null then
    return v_custom;
  end if;

  select total_topup into v_total_topup from public.users where id = p_user_id;

  select price into v_tier
  from public.price_tiers
  where product_id = p_product_id
    and duration_id = p_duration_id
    and min_total_topup <= coalesce(v_total_topup, 0)
  order by min_total_topup desc
  limit 1;

  if v_tier is not null then
    return v_tier;
  end if;

  return p_default_price;
end;
$$;

-- ────────────────────────────────────────────────────────────────────────
-- 5. generate_key() / generate_key_manual() — swap pd.price for
--    effective_key_price(pd.price) as the charged price. Balance debit
--    and reseller_keys.price both use the effective price now, so
--    History Key Generate shows what was actually charged, not the
--    catalog default.
-- ────────────────────────────────────────────────────────────────────────
create or replace function public.generate_key(
  p_user_id uuid,
  p_product_id text,
  p_duration_id text,
  p_key_string text
)
returns public.reseller_keys
language plpgsql
security definer
set search_path = public
as $$
declare
  v_default_price bigint;
  v_price bigint;
  v_label text;
  v_product_name text;
  v_balance bigint;
  v_row public.reseller_keys;
begin
  select pd.price, pd.label, p.name
    into v_default_price, v_label, v_product_name
  from public.product_durations pd
  join public.products p on p.id = pd.product_id
  where pd.product_id = p_product_id and pd.id = p_duration_id;

  if v_default_price is null then
    raise exception 'invalid_product_or_duration';
  end if;

  v_price := public.effective_key_price(p_user_id, p_product_id, p_duration_id, v_default_price);

  select balance into v_balance from public.users where id = p_user_id for update;

  if v_balance is null then
    raise exception 'user_not_found';
  end if;

  if v_balance < v_price then
    raise exception 'insufficient_balance';
  end if;

  update public.users set balance = balance - v_price where id = p_user_id;

  insert into public.reseller_keys (user_id, product_id, product_name, duration_label, price, key_string)
  values (p_user_id, p_product_id, v_product_name, v_label, v_price, p_key_string)
  returning * into v_row;

  return v_row;
end;
$$;

create or replace function public.generate_key_manual(
  p_user_id uuid,
  p_product_id text,
  p_duration_id text
)
returns public.reseller_keys
language plpgsql
security definer
set search_path = public
as $$
declare
  v_default_price bigint;
  v_price bigint;
  v_label text;
  v_product_name text;
  v_balance bigint;
  v_stock_id uuid;
  v_key_string text;
  v_row public.reseller_keys;
begin
  select pd.price, pd.label, p.name
    into v_default_price, v_label, v_product_name
  from public.product_durations pd
  join public.products p on p.id = pd.product_id
  where pd.product_id = p_product_id and pd.id = p_duration_id;

  if v_default_price is null then
    raise exception 'invalid_product_or_duration';
  end if;

  v_price := public.effective_key_price(p_user_id, p_product_id, p_duration_id, v_default_price);

  select balance into v_balance from public.users where id = p_user_id for update;

  if v_balance is null then
    raise exception 'user_not_found';
  end if;

  if v_balance < v_price then
    raise exception 'insufficient_balance';
  end if;

  select id, key_string into v_stock_id, v_key_string
  from public.key_stock
  where product_id = p_product_id and duration_id = p_duration_id and used = false
  order by created_at asc
  limit 1
  for update skip locked;

  if v_stock_id is null then
    raise exception 'out_of_stock';
  end if;

  update public.key_stock
    set used = true, used_by = p_user_id, used_at = now()
    where id = v_stock_id;

  update public.users set balance = balance - v_price where id = p_user_id;

  insert into public.reseller_keys (user_id, product_id, product_name, duration_label, price, key_string)
  values (p_user_id, p_product_id, v_product_name, v_label, v_price, v_key_string)
  returning * into v_row;

  return v_row;
end;
$$;

-- ────────────────────────────────────────────────────────────────────────
-- 6. settle_topup() / admin_adjust_balance() — also accumulate
--    total_topup so tiers move up as a reseller keeps topping up.
--    settle_topup() always represents a real successful top up, so it
--    always adds. admin_adjust_balance() only adds when amount > 0 --
--    matches its existing "mirror into topups" condition (negative
--    adjustments are corrections, not top ups, so they must NOT reduce
--    total_topup and reset a reseller's earned tier).
-- ────────────────────────────────────────────────────────────────────────
create or replace function public.settle_topup(
  p_provider_ref text,
  p_user_id uuid,
  p_nominal bigint,
  p_bonus bigint
)
returns public.topups
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.topups;
begin
  select * into v_row from public.topups where provider_ref = p_provider_ref;

  if found then
    return v_row; -- already settled, no-op (idempotent)
  end if;

  insert into public.topups (user_id, nominal, bonus, total, status, provider_ref, settled_at)
  values (p_user_id, p_nominal, p_bonus, p_nominal + p_bonus, 'success', p_provider_ref, now())
  returning * into v_row;

  update public.users
    set balance = balance + v_row.total, total_topup = total_topup + v_row.total
    where id = p_user_id;

  return v_row;
end;
$$;

create or replace function public.admin_adjust_balance(
  p_admin_id uuid,
  p_user_id uuid,
  p_amount bigint,
  p_note text default null
)
returns public.users
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user public.users;
begin
  if p_amount = 0 then
    raise exception 'invalid_amount';
  end if;

  select * into v_user from public.users where id = p_user_id for update;
  if v_user is null then
    raise exception 'user_not_found';
  end if;

  if v_user.balance + p_amount < 0 then
    raise exception 'insufficient_balance';
  end if;

  update public.users
    set balance = balance + p_amount,
        total_topup = total_topup + greatest(p_amount, 0)
    where id = p_user_id
    returning * into v_user;

  insert into public.balance_adjustments (admin_id, user_id, amount, note)
  values (p_admin_id, p_user_id, p_amount, p_note);

  if p_amount > 0 then
    insert into public.topups (user_id, nominal, bonus, total, method, status, provider_ref, settled_at)
    values (p_user_id, p_amount, 0, p_amount, 'MANUAL', 'success', 'ADJ-' || gen_random_uuid()::text, now());
  end if;

  return v_user;
end;
$$;

-- ────────────────────────────────────────────────────────────────────────
-- 7. RLS — same "service-role only" pattern as key_stock/app_settings:
--    zero grants to anon/authenticated, no policies. Every route that
--    reads/writes these goes through getAdminUser() first.
-- ────────────────────────────────────────────────────────────────────────
alter table public.price_tiers enable row level security;
alter table public.custom_prices enable row level security;

revoke all on public.price_tiers, public.custom_prices from anon, authenticated;


-- >>>>>>>>>> 0006_reseller_ops.sql
-- heroitbest — 4 fitur lanjutan dari daftar revisi 123.md:
--   1. Ban/hapus reseller
--   2. Edit nominal/bonus paket top up (dulu hardcoded di mock-data.ts)
--   3. Broadcast notifikasi ke semua reseller
--   4. Riwayat key lintas-reseller yang bisa dilihat admin (bukan cuma
--      "punya sendiri" seperti getKeyHistory() yang sudah ada)
-- Run after 0005_key_pricing.sql.

-- ────────────────────────────────────────────────────────────────────────
-- 1. BAN RESELLER
--    Soft-ban dulu (banned=true) supaya reversible dan tidak menghapus
--    histori key/topup reseller yang mungkin masih relevan buat rekap.
--    Hard delete tetap disediakan sebagai endpoint terpisah (lihat route),
--    dengan ON DELETE CASCADE yang sudah ada dari 0001 (reseller_keys,
--    topups, balance_adjustments, custom_prices semua cascade ke users).
-- ────────────────────────────────────────────────────────────────────────
alter table public.users
  add column if not exists banned boolean not null default false;

alter table public.users
  add column if not exists banned_at timestamptz;

-- Dicek di getCurrentUser()/getAdminUser() dan di setiap RPC yang
-- mengubah saldo (generate_key, generate_key_manual, settle_topup lewat
-- webhook, admin_adjust_balance) supaya reseller yang dibanned tidak bisa
-- login-session-nya dipakai untuk transaksi baru meski token masih valid.
create or replace function public.assert_not_banned(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_banned boolean;
begin
  select banned into v_banned from public.users where id = p_user_id;
  if v_banned then
    raise exception 'user_banned';
  end if;
end;
$$;

create or replace function public.generate_key(
  p_user_id uuid,
  p_product_id text,
  p_duration_id text,
  p_key_string text
)
returns public.reseller_keys
language plpgsql
security definer
set search_path = public
as $$
declare
  v_default_price bigint;
  v_price bigint;
  v_label text;
  v_product_name text;
  v_balance bigint;
  v_row public.reseller_keys;
begin
  perform public.assert_not_banned(p_user_id);

  select pd.price, pd.label, p.name
    into v_default_price, v_label, v_product_name
  from public.product_durations pd
  join public.products p on p.id = pd.product_id
  where pd.product_id = p_product_id and pd.id = p_duration_id;

  if v_default_price is null then
    raise exception 'invalid_product_or_duration';
  end if;

  v_price := public.effective_key_price(p_user_id, p_product_id, p_duration_id, v_default_price);

  select balance into v_balance from public.users where id = p_user_id for update;

  if v_balance is null then
    raise exception 'user_not_found';
  end if;

  if v_balance < v_price then
    raise exception 'insufficient_balance';
  end if;

  update public.users set balance = balance - v_price where id = p_user_id;

  insert into public.reseller_keys (user_id, product_id, product_name, duration_label, price, key_string)
  values (p_user_id, p_product_id, v_product_name, v_label, v_price, p_key_string)
  returning * into v_row;

  return v_row;
end;
$$;

create or replace function public.generate_key_manual(
  p_user_id uuid,
  p_product_id text,
  p_duration_id text
)
returns public.reseller_keys
language plpgsql
security definer
set search_path = public
as $$
declare
  v_default_price bigint;
  v_price bigint;
  v_label text;
  v_product_name text;
  v_balance bigint;
  v_stock_id uuid;
  v_key_string text;
  v_row public.reseller_keys;
begin
  perform public.assert_not_banned(p_user_id);

  select pd.price, pd.label, p.name
    into v_default_price, v_label, v_product_name
  from public.product_durations pd
  join public.products p on p.id = pd.product_id
  where pd.product_id = p_product_id and pd.id = p_duration_id;

  if v_default_price is null then
    raise exception 'invalid_product_or_duration';
  end if;

  v_price := public.effective_key_price(p_user_id, p_product_id, p_duration_id, v_default_price);

  select balance into v_balance from public.users where id = p_user_id for update;

  if v_balance is null then
    raise exception 'user_not_found';
  end if;

  if v_balance < v_price then
    raise exception 'insufficient_balance';
  end if;

  select id, key_string into v_stock_id, v_key_string
  from public.key_stock
  where product_id = p_product_id and duration_id = p_duration_id and used = false
  order by created_at asc
  limit 1
  for update skip locked;

  if v_stock_id is null then
    raise exception 'out_of_stock';
  end if;

  update public.key_stock
    set used = true, used_by = p_user_id, used_at = now()
    where id = v_stock_id;

  update public.users set balance = balance - v_price where id = p_user_id;

  insert into public.reseller_keys (user_id, product_id, product_name, duration_label, price, key_string)
  values (p_user_id, p_product_id, v_product_name, v_label, v_price, v_key_string)
  returning * into v_row;

  return v_row;
end;
$$;

-- settle_topup dipanggil dari webhook (server-to-server, tidak ada sesi
-- reseller di baliknya) -- tetap diblokir supaya reseller yang dibanned
-- tapi transaksi QRIS-nya kepending sebelum banned tidak ke-settle diam-
-- diam sesudahnya.
create or replace function public.settle_topup(
  p_provider_ref text,
  p_user_id uuid,
  p_nominal bigint,
  p_bonus bigint
)
returns public.topups
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.topups;
begin
  select * into v_row from public.topups where provider_ref = p_provider_ref;

  if found then
    return v_row; -- already settled, no-op (idempotent)
  end if;

  perform public.assert_not_banned(p_user_id);

  insert into public.topups (user_id, nominal, bonus, total, status, provider_ref, settled_at)
  values (p_user_id, p_nominal, p_bonus, p_nominal + p_bonus, 'success', p_provider_ref, now())
  returning * into v_row;

  update public.users
    set balance = balance + v_row.total, total_topup = total_topup + v_row.total
    where id = p_user_id;

  return v_row;
end;
$$;

-- Admin sendiri boleh tetap adjust saldo reseller yang dibanned (misal
-- buat koreksi/refund sebelum hard-delete), jadi admin_adjust_balance
-- SENGAJA tidak dipasangi assert_not_banned di sini.

-- ────────────────────────────────────────────────────────────────────────
-- 2. TOPUP PACKAGES — dulu array statis TOPUP_PACKAGES di
--    src/lib/mock-data.ts, sekarang tabel supaya admin bisa ubah nominal
--    & bonus tanpa redeploy. topup/create route baca dari sini (fallback
--    ke TOPUP_PACKAGES kalau tabel kosong, lihat kode route).
-- ────────────────────────────────────────────────────────────────────────
create table if not exists public.topup_packages (
  id uuid primary key default gen_random_uuid(),
  nominal bigint not null check (nominal > 0),
  bonus bigint not null default 0 check (bonus >= 0),
  active boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  unique (nominal)
);

alter table public.topup_packages enable row level security;
-- Reseller harus bisa BACA daftar paket (halaman Top Up), tapi tidak
-- pernah menulis -- sama pola dengan products/product_durations di 0001.
revoke all on public.topup_packages from anon, authenticated;
grant select on public.topup_packages to authenticated;

drop policy if exists "topup packages readable" on public.topup_packages;
create policy "topup packages readable" on public.topup_packages
  for select using (true);

-- Seed dari TOPUP_PACKAGES yang sudah ada supaya tidak ada gap nominal
-- begitu tabel ini mulai dipakai (kalau tabel masih kosong).
insert into public.topup_packages (nominal, bonus, sort_order)
select v.nominal, v.bonus, v.sort_order
from (values
  (500000, 50000, 1),
  (1000000, 150000, 2),
  (1500000, 350000, 3),
  (2000000, 500000, 4),
  (3000000, 700000, 5),
  (5000000, 1300000, 6),
  (10000000, 2300000, 7),
  (15000000, 4000000, 8),
  (20000000, 7000000, 9)
) as v(nominal, bonus, sort_order)
where not exists (select 1 from public.topup_packages);

-- ────────────────────────────────────────────────────────────────────────
-- 3. BROADCAST NOTIFIKASI — admin kirim 1 pesan ke semua reseller.
--    broadcast_reads melacak siapa sudah baca (buat titik merah/badge di
--    Bell icon), bukan siapa sudah "menerima" -- broadcast selalu
--    langsung kelihatan untuk semua reseller begitu dikirim, tidak ada
--    per-user targeting di versi ini (bisa ditambah nanti kalau perlu).
-- ────────────────────────────────────────────────────────────────────────
create table if not exists public.broadcasts (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid references public.users (id) on delete set null,
  title text not null,
  body text not null,
  created_at timestamptz not null default now()
);

create index if not exists broadcasts_created_idx
  on public.broadcasts (created_at desc);

create table if not exists public.broadcast_reads (
  broadcast_id uuid not null references public.broadcasts (id) on delete cascade,
  user_id uuid not null references public.users (id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key (broadcast_id, user_id)
);

alter table public.broadcasts enable row level security;
alter table public.broadcast_reads enable row level security;

-- Reseller boleh baca semua broadcast (tidak ada info sensitif per-user
-- di sini) tapi tidak boleh insert/update/delete langsung -- pengiriman
-- selalu lewat route admin (service role).
revoke all on public.broadcasts from anon, authenticated;
grant select on public.broadcasts to authenticated;

drop policy if exists "broadcasts readable by signed-in users" on public.broadcasts;
create policy "broadcasts readable by signed-in users" on public.broadcasts
  for select using (auth.uid() is not null);

-- broadcast_reads: reseller boleh baca & tulis HANYA baris miliknya
-- sendiri (menandai broadcast tertentu sudah dibaca).
revoke all on public.broadcast_reads from anon, authenticated;
grant select, insert on public.broadcast_reads to authenticated;

drop policy if exists "users read own broadcast reads" on public.broadcast_reads;
create policy "users read own broadcast reads" on public.broadcast_reads
  for select using (auth.uid() = user_id);

drop policy if exists "users mark own broadcast reads" on public.broadcast_reads;
create policy "users mark own broadcast reads" on public.broadcast_reads
  for insert with check (auth.uid() = user_id);

-- RPC dipanggil dari route admin (service role) supaya admin_id tercatat
-- konsisten dan tidak bisa dipalsukan dari client.
create or replace function public.send_broadcast(
  p_admin_id uuid,
  p_title text,
  p_body text
)
returns public.broadcasts
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.broadcasts;
begin
  if coalesce(trim(p_title), '') = '' or coalesce(trim(p_body), '') = '' then
    raise exception 'invalid_broadcast';
  end if;

  insert into public.broadcasts (admin_id, title, body)
  values (p_admin_id, trim(p_title), trim(p_body))
  returning * into v_row;

  return v_row;
end;
$$;

-- ────────────────────────────────────────────────────────────────────────
-- 4. RIWAYAT KEY ADMIN (lintas semua reseller) — view read-only, service
--    role only. Reseller tetap hanya bisa lihat punya sendiri lewat
--    getKeyHistory() yang sudah ada (RLS reseller_keys tidak berubah).
-- ────────────────────────────────────────────────────────────────────────
create or replace view public.admin_key_history as
select
  rk.id,
  rk.user_id,
  u.full_name,
  u.email,
  rk.product_id,
  rk.product_name,
  rk.duration_label,
  rk.price,
  rk.key_string,
  rk.created_at
from public.reseller_keys rk
join public.users u on u.id = rk.user_id
order by rk.created_at desc;

revoke all on public.admin_key_history from anon, authenticated;
-- No grant at all -- read exclusively via createAdminSupabase() (service
-- role bypasses RLS/grants), same pattern as key_stock/app_settings.


-- >>>>>>>>>> 0007_fix_settle_topup_overload.sql
-- BUG FIX: settle_topup() has silently existed as TWO overloaded functions
-- since 0002_production_hardening.sql, and every single webhook/self-test
-- settlement attempt since has failed because of it.
--
-- Timeline:
--   0001_init.sql                 settle_topup(text, uuid, bigint, bigint)              -- 4 params
--   0002_production_hardening.sql settle_topup(text, uuid, bigint, bigint, text default null) -- 5 params
--   0005_key_pricing.sql          settle_topup(text, uuid, bigint, bigint)              -- 4 params
--   0006_reseller_ops.sql         settle_topup(text, uuid, bigint, bigint)              -- 4 params
--
-- `create or replace function` only replaces a function whose parameter
-- COUNT and TYPES match exactly. 0002 added a 5th parameter, so it did
-- NOT replace 0001's version -- it created a second, separate overloaded
-- function. 0005 and 0006 both went back to the original 4-parameter
-- shape, so each of those replaced the 4-param version in turn -- but
-- 0002's 5-param version was never touched again by anything. It has
-- been sitting in the database the entire time, orphaned but still
-- fully callable.
--
-- Because 0002's 5th parameter (`p_merchant_ref`) has `default null`,
-- that 5-param function can ALSO be called with just 4 arguments --
-- Postgres fills in the default for the missing one. That means every
-- 4-argument call to settle_topup() is genuinely ambiguous: BOTH the
-- 4-param function (from 0006) and the 5-param function (from 0002,
-- using its default) are equally valid matches. PostgREST detects this
-- ambiguity and refuses to guess, rejecting the call outright with
-- PGRST203 ("Could not choose the best candidate function") -- before
-- either function's body ever runs.
--
-- This is why balance crediting failed 100% of the time regardless of
-- whether the webhook was reached at all: the RPC call itself was being
-- rejected by PostgREST's function resolution, not by any application
-- logic inside settle_topup.
--
-- Fix: drop the orphaned 5-param overload, leaving exactly one
-- settle_topup() function (the current 4-param version from
-- 0006_reseller_ops.sql) so calls resolve unambiguously.
drop function if exists public.settle_topup(text, uuid, bigint, bigint, text);

-- Sanity check: confirm exactly one settle_topup overload remains after
-- this migration runs. If this raises, something above didn't work as
-- expected and needs a human to look before assuming this is fixed.
do $$
declare
  v_count int;
begin
  select count(*) into v_count
  from pg_proc
  where proname = 'settle_topup'
    and pronamespace = 'public'::regnamespace;

  if v_count <> 1 then
    raise exception 'Expected exactly 1 settle_topup() overload after cleanup, found %', v_count;
  end if;
end;
$$;


-- >>>>>>>>>> 0008_fix_settle_topup_update_in_place.sql
-- BUG FIX: settle_topup() inserted a BRAND NEW row on success instead of
-- updating the existing 'pending' row that create_pending_topup() had
-- already inserted at checkout time -- and that new row never had
-- merchant_ref set at all (only user_id/nominal/bonus/total/status/
-- provider_ref/settled_at were in the insert's column list).
--
-- Two user-visible symptoms follow directly from that:
--
--   1. GET /api/topup/status?ref=<merchant_ref> (polled by the QR modal
--      while waiting for payment) filters strictly by merchant_ref. Once
--      settled, the ORIGINAL row (merchant_ref = order_id, status =
--      'pending') is left completely untouched forever -- the NEW
--      'success' row is a separate row with merchant_ref = null, so this
--      query can never find it. The QR modal would poll forever and
--      show "Menunggu" indefinitely even after balance was actually
--      credited correctly.
--
--   2. Top-up History (queried by user_id, not merchant_ref) shows BOTH
--      rows for what was really a single transaction: the original
--      stuck at "pending" forever, plus a separate "success" entry --
--      i.e. exactly the duplicated/confusing "ada history-nya tapi
--      kayak nyangkut" symptom that's been reported.
--
-- Fix: keep the exact same 4-parameter signature (no overload risk, see
-- 0007) but change the body to UPDATE the existing pending row in place
-- rather than inserting a new one. In this codebase's design,
-- `p_provider_ref` (GensPay's order_id, echoed back on the webhook) is
-- ALWAYS the same string create_pending_topup() stored as `merchant_ref`
-- at checkout time (see topup/create/route.ts) -- so looking that row
-- up by merchant_ref = p_provider_ref and updating it is safe and exact,
-- no ambiguity about which row it refers to.
--
-- Falls back to inserting a fresh row only if no matching pending row
-- exists (e.g. a manually-triggered settle with no prior checkout, or a
-- pending row that was deleted) -- preserves the old behavior for any
-- edge case rather than failing outright.
create or replace function public.settle_topup(
  p_provider_ref text,
  p_user_id uuid,
  p_nominal bigint,
  p_bonus bigint
)
returns public.topups
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.topups;
begin
  -- Idempotency: if this exact provider_ref was already settled (retry
  -- from GensPay, or a re-run of the debug resettle tool), return the
  -- already-settled row as a no-op rather than settling twice.
  select * into v_row from public.topups where provider_ref = p_provider_ref and status = 'success';
  if found then
    return v_row;
  end if;

  perform public.assert_not_banned(p_user_id);

  -- Update the existing pending row in place, matched by merchant_ref
  -- (== p_provider_ref in this codebase's design -- see comment above).
  -- Also guarded by status = 'pending' so this can't accidentally
  -- re-settle/overwrite a row some other path already finalized.
  update public.topups
    set status = 'success',
        provider_ref = p_provider_ref,
        nominal = p_nominal,
        bonus = p_bonus,
        total = p_nominal + p_bonus,
        settled_at = now()
    where merchant_ref = p_provider_ref
      and status = 'pending'
    returning * into v_row;

  if not found then
    -- No matching pending row -- fall back to inserting fresh rather
    -- than silently doing nothing, same safety net the old version had.
    insert into public.topups (user_id, nominal, bonus, total, status, provider_ref, merchant_ref, settled_at)
    values (p_user_id, p_nominal, p_bonus, p_nominal + p_bonus, 'success', p_provider_ref, p_provider_ref, now())
    returning * into v_row;
  end if;

  update public.users
    set balance = balance + v_row.total, total_topup = total_topup + v_row.total
    where id = p_user_id;

  return v_row;
end;
$$;


-- >>>>>>>>>> 0009_theme_per_account.sql
-- FEATURE: theme (color palette) preference is now stored per-ACCOUNT,
-- not just per-device localStorage. Previously ThemeSwitcher.tsx only
-- ever wrote to localStorage (see ThemeProvider.tsx) -- switching
-- devices, or a fresh browser profile, always fell back to
-- DEFAULT_THEME with no memory of what the account had picked before.
--
-- theme is intentionally NOT constrained with a foreign-key-style enum
-- against a THEMES table -- the valid set lives in src/lib/theme.ts
-- (THEMES array) and can grow over time without a migration. A CHECK
-- constraint against a hardcoded list would need updating every time a
-- theme is added there, so validation instead happens in
-- getTheme()/ThemeProvider (falls back to DEFAULT_THEME for anything
-- unrecognized) -- same graceful-fallback approach already used for an
-- invalid/stale localStorage value.
alter table public.users
  add column if not exists theme text not null default 'hero';

-- Same self-update pattern as full_name/avatar_url (0001_init.sql):
-- users may change their OWN theme, nothing else, never balance/role/
-- verified. Widening this grant to include theme (rather than a
-- separate policy) keeps the "only these fields are user-writable"
-- comment in 0001 accurate in one place.
grant update (full_name, avatar_url, theme) on public.users to authenticated;
-- The existing "users update own non-balance fields" policy
-- (auth.uid() = id, both using + with check) already covers this new
-- column automatically -- RLS policies apply per-row, not per-column,
-- so no new policy is needed, only the wider column grant above.


-- >>>>>>>>>> 0010_admin_set_total_topup.sql
-- FEATURE: admin panel could only VIEW total_topup (used for automatic
-- tier pricing, see 0005_key_pricing.sql), never directly edit it.
-- admin_adjust_balance() only ever INCREASES total_topup (by design --
-- 0005's comment explicitly says this prevents an admin/reseller from
-- gaming tiers backward by requesting a "refund" via Kurangi and keeping
-- an already-earned tier). But that same one-way design means there was
-- also no way to CORRECT a total_topup that ended up too high for the
-- wrong reason -- e.g. a manual courtesy credit or refund adjustment
-- given via Tambah in the past also silently counted toward tier
-- eligibility, inflating it beyond what the reseller's real qualifying
-- topups justify.
--
-- This RPC sets total_topup to an explicit value chosen by the admin,
-- separately from balance -- an intentional, auditable correction
-- rather than an automatic side effect of a balance change.
-- Dedicated audit table, sama gaya seperti balance_adjustments
-- (0004_manual_balance.sql) tapi untuk perubahan total_topup secara
-- eksplisit -- tidak dipaksakan ke balance_adjustments karena tabel itu
-- punya check constraint (amount <> 0) yang secara semantik terikat ke
-- perubahan saldo, bukan koreksi total_topup.
create table if not exists public.total_topup_adjustments (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid not null references public.users (id) on delete set null,
  user_id uuid not null references public.users (id) on delete cascade,
  old_total_topup bigint not null,
  new_total_topup bigint not null,
  note text,
  created_at timestamptz not null default now()
);

create index if not exists total_topup_adjustments_user_idx
  on public.total_topup_adjustments (user_id, created_at desc);

alter table public.total_topup_adjustments enable row level security;
-- Sama seperti balance_adjustments -- cuma bisa ditulis lewat RPC
-- security definer di bawah (service_role/definer bypass RLS), tidak ada
-- grant langsung ke authenticated/anon.
revoke all on public.total_topup_adjustments from anon, authenticated;

create or replace function public.admin_set_total_topup(
  p_admin_id uuid,
  p_user_id uuid,
  p_new_total_topup bigint,
  p_note text default null
)
returns public.users
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.users;
  v_old bigint;
begin
  if p_new_total_topup < 0 then
    raise exception 'invalid_amount';
  end if;

  perform public.assert_not_banned(p_user_id);

  select total_topup into v_old from public.users where id = p_user_id;
  if not found then
    raise exception 'user_not_found';
  end if;

  update public.users
    set total_topup = p_new_total_topup
    where id = p_user_id
    returning * into v_row;

  insert into public.total_topup_adjustments (admin_id, user_id, old_total_topup, new_total_topup, note)
  values (p_admin_id, p_user_id, v_old, p_new_total_topup, p_note);

  return v_row;
end;
$$;

grant execute on function public.admin_set_total_topup(uuid, uuid, bigint, text) to authenticated;


-- >>>>>>>>>> 0011_webhook_log.sql
-- FEATURE: persistent webhook call log. Sampai sekarang, satu-satunya
-- cara tahu apakah GensPay BENERAN memanggil /api/webhooks/topup (dan
-- kenapa gagal kalau gagal) adalah menggali Vercel Runtime Logs secara
-- manual -- yang sifatnya sementara/ephemeral dan gampang kelewat kalau
-- tidak dicek persis pas kejadian. Tabel ini menyimpan SETIAP percobaan
-- webhook (masuk atau tidak signature-nya, ketemu row pending atau
-- tidak, berhasil settle atau tidak) secara permanen, supaya bisa dicek
-- kapan saja lewat query biasa -- termasuk untuk membedakan "GensPay
-- tidak pernah memanggil sama sekali" vs "memanggil tapi ditolak" vs
-- "berhasil diproses tapi ada masalah lain".
create table if not exists public.webhook_log (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'genspay',
  result text not null, -- 'signature_invalid' | 'bad_payload' | 'ignored_event' | 'no_pending_row' | 'settled' | 'amount_mismatch' | 'error'
  order_id text,
  detail jsonb,
  created_at timestamptz not null default now()
);

create index if not exists webhook_log_created_idx on public.webhook_log (created_at desc);
create index if not exists webhook_log_order_idx on public.webhook_log (order_id);

alter table public.webhook_log enable row level security;
-- Cuma bisa ditulis lewat service-role client (webhook route pakai
-- createAdminSupabase(), bypass RLS) -- tidak ada akses langsung dari
-- anon/authenticated, sama seperti tabel internal lain di project ini.
revoke all on public.webhook_log from anon, authenticated;


-- >>>>>>>>>> 0012_provider_error_log.sql
-- provider_error_log — catatan tiap kali order ke provider upstream
-- (vipibmstore.com) gagal saat generate-key mode auto (mis. "Insufficient
-- balance", "Invalid request", dll). Sebelumnya cuma console.error() yang
-- ilang begitu request selesai (Vercel serverless) -- gak ada cara buat
-- lihat riwayat/pola tanpa buka Vercel Runtime Logs manual. Dipakai oleh
-- halaman /dashboard/admin/provider-debug biar owner bisa lihat sendiri
-- tanpa perlu ngerti log server.
create table if not exists public.provider_error_log (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  user_id uuid references public.users(id) on delete set null,
  product_id text,
  duration_id text,
  provider_item_id text,
  error_message text not null
);

create index if not exists provider_error_log_created_at_idx on public.provider_error_log (created_at desc);

alter table public.provider_error_log enable row level security;
revoke all on public.provider_error_log from anon, authenticated;
-- service-role only (dibaca/ditulis lewat createAdminSupabase(), sama pola
-- dengan key_stock/app_settings di 0003_admin_provider.sql)


-- >>>>>>>>>> 0013_marketplace_sellers.sql
-- ══════════════════════════════════════════════════════════════════
-- 0013_marketplace_sellers.sql — heroitbest marketplace layer
--
-- Model bisnis (dikonfirmasi user, jangan diubah tanpa diskusi ulang):
--   - Escrow: pembeli bayar ke akun payment gateway PLATFORM (bukan ke
--     seller langsung). Hasil jualan seller dicatat sebagai saldo di
--     sistem ini, BUKAN uang yang benar-benar berpindah ke rekening
--     seller sampai dia mengajukan penarikan dan admin approve+transfer
--     manual.
--   - Self-register: siapapun (user biasa) bisa daftar jadi seller
--     sendiri, langsung bisa jualan (TIDAK perlu approval admin dulu --
--     tapi lihat catatan risiko di bawah).
--   - Listing TERPISAH per seller: kalau 2 seller jual "produk yang
--     sama", itu dua baris `products` yang independen (masing-masing
--     seller_id sendiri) -- BUKAN satu listing gabungan/buy-box.
--
-- Kenapa "pending -> available" balance itu DIHITUNG (bukan disimpan
-- sebagai counter yang di-update background job/cron): supaya tidak
-- butuh Vercel Cron yang bisa lewat/gagal jalan dan bikin saldo nyangkut
-- di 'pending' padahal harusnya sudah cair. seller_balance() di bawah
-- menjumlahkan langsung dari reseller_keys tiap dipanggil -- jumlah baris
-- per seller di skala ini murah untuk di-scan tiap request.
-- ══════════════════════════════════════════════════════════════════

-- 1. Profil seller -- SATU baris per akun yang "juga jadi seller".
--    Sengaja bukan ubah kolom users.role: seorang seller tetap punya
--    users.balance (saldo BELI dia sendiri, kalau jajan produk platform/
--    seller lain) yang terpisah total dari uang hasil JUALAN dia (dihitung
--    dari reseller_keys.seller_earning, lihat seller_balance() di bawah).
--    Mencampur dua itu di satu kolom bakal susah diaudit ("ini saldo topup
--    atau saldo jualan?").
create table if not exists public.sellers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references public.users(id) on delete cascade,
  store_name text not null,
  store_slug text not null unique,
  bank_name text,
  bank_account_number text,
  bank_account_holder text,
  status text not null default 'active' check (status in ('active', 'suspended')),
  -- null = pakai default_commission_percent di app_settings('marketplace').
  -- Override per-seller ini buat kalau nanti admin mau kasih rate beda
  -- (mis. seller lama/terpercaya dapat potongan lebih kecil) -- fase 2,
  -- tapi kolomnya disiapkan dari awal biar gak perlu migration lagi.
  commission_percent numeric check (commission_percent is null or (commission_percent >= 0 and commission_percent <= 100)),
  created_at timestamptz not null default now()
);

create index if not exists sellers_user_id_idx on public.sellers (user_id);
create index if not exists sellers_status_idx on public.sellers (status);

-- 2. products/key_stock -- seller_id NULL artinya produk itu tetap milik
--    platform sendiri (perilaku LAMA, tidak berubah). seller_id terisi =
--    listing marketplace milik seller itu.
alter table public.products
  add column if not exists seller_id uuid references public.sellers(id) on delete cascade;
create index if not exists products_seller_id_idx on public.products (seller_id);

alter table public.key_stock
  add column if not exists seller_id uuid references public.sellers(id) on delete cascade;
create index if not exists key_stock_seller_id_idx on public.key_stock (seller_id) where seller_id is not null;

-- Anti-penipuan: satu key_string hanya boleh ada SATU kali di seluruh
-- key_stock (termasuk yang sudah terpakai, used=true, barisnya tetap
-- disimpan). Tanpa ini seller bisa menempel key yang sama ke banyak
-- listing/berkali-kali dan menjualnya ke banyak pembeli. Kalau database
-- yang dipakai sudah punya duplikat lama, index ini gagal dibuat -- bersihkan
-- duplikatnya dulu (database heroitbest baru, jadi tidak diharapkan terjadi).
create unique index if not exists key_stock_key_string_uniq on public.key_stock (key_string);

-- 3. reseller_keys -- catat siapa seller-nya (kalau ada) + berapa yang
--    jadi hak seller vs potongan platform di transaksi itu SAAT TERJADI
--    (bukan dihitung ulang nanti dari commission_percent seller SEKARANG
--    -- kalau commission_percent diubah admin belakangan, riwayat lama
--    tidak boleh ikut berubah).
alter table public.reseller_keys
  add column if not exists seller_id uuid references public.sellers(id),
  add column if not exists seller_earning bigint,
  add column if not exists commission_amount bigint,
  -- Saldo dari penjualan ini baru boleh masuk hitungan "available" (bisa
  -- ditarik) setelah waktu ini lewat, DAN tidak sedang ada dispute
  -- terbuka untuk key ini. Diisi saat insert = now() + hold_hours dari
  -- app_settings('marketplace') pada saat itu.
  add column if not exists held_until timestamptz,
  -- HANYA diisi untuk listing seller stock_mode='auto': ongkos real yang
  -- kepotong dari saldo vipbestmods PLATFORM buat order ini (balance_before
  -- - balance_after dari response /v2/orders, lihat generate_key_seller_auto
  -- di bawah). Bukan bagian dari rumus seller_earning (itu tetap flat
  -- commission_percent dari harga jual, biar 1 formula konsisten dengan
  -- listing manual) -- ini murni buat AUDIT/analitik admin, supaya kelihatan
  -- kalau ada listing auto yang marginnya udah tergerus harga vipbestmods
  -- naik sejak seller pasang harga (guard batas minimum cuma dicek SAAT
  -- listing dibuat/diedit, bukan tiap transaksi -- lihat catatan di route
  -- pembuatan listing auto).
  add column if not exists provider_cost bigint,
  -- Diisi saat admin memutuskan dispute dengan refund ke pembeli. Key yang
  -- sudah di-refund TIDAK dihitung lagi di seller_balance() (pendapatan
  -- seller dari key itu hilang). Kalau seller sudah terlanjur menarik
  -- uangnya, selisihnya otomatis "dipotong" dari penjualan berikutnya
  -- karena available = earned - reserved - paid (lihat seller_balance).
  add column if not exists refunded_at timestamptz;

create index if not exists reseller_keys_seller_id_idx on public.reseller_keys (seller_id) where seller_id is not null;

-- 4. Permintaan penarikan saldo seller.
create table if not exists public.withdrawal_requests (
  id uuid primary key default gen_random_uuid(),
  seller_id uuid not null references public.sellers(id) on delete cascade,
  amount bigint not null check (amount > 0),
  status text not null default 'pending' check (status in ('pending', 'approved', 'paid', 'rejected')),
  -- Salin info rekening SAAT request dibuat -- kalau seller ubah info
  -- rekening setelahnya, request lama tetap nunjuk ke rekening yang
  -- benar waktu itu (bukan ke-timpa info baru).
  bank_snapshot jsonb not null,
  admin_note text,
  requested_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index if not exists withdrawal_requests_seller_id_idx on public.withdrawal_requests (seller_id, requested_at desc);
create index if not exists withdrawal_requests_status_idx on public.withdrawal_requests (status) where status = 'pending';

-- 5. Dispute dari buyer atas 1 key yang dibeli dari seller (key gak
--    jalan/salah/dll). Selama status = 'open', seller_earning key
--    tersebut TIDAK dihitung 'available' (lihat seller_balance()) --
--    walau held_until sudah lewat -- supaya seller tidak bisa buru-buru
--    tarik saldo sebelum dispute selesai.
create table if not exists public.order_disputes (
  id uuid primary key default gen_random_uuid(),
  reseller_key_id uuid not null references public.reseller_keys(id) on delete cascade,
  buyer_id uuid not null references public.users(id),
  seller_id uuid references public.sellers(id),
  reason text not null,
  status text not null default 'open' check (status in ('open', 'resolved_refund', 'resolved_release', 'dismissed')),
  admin_note text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index if not exists order_disputes_status_idx on public.order_disputes (status) where status = 'open';
create index if not exists order_disputes_key_idx on public.order_disputes (reseller_key_id);

-- 6. Pengaturan marketplace global -- reuse pola app_settings yang sudah
--    ada (key/value), row baru key='marketplace':
--    {
--      "default_commission_percent": 10,
--      "pending_hold_hours": 48,
--      "min_auto_markup_percent": 20
--    }
--    Diisi lewat admin panel; kalau baris ini belum ada sama sekali,
--    fungsi di bawah pakai angka default aman (10%, 48 jam).
--
--    min_auto_markup_percent KHUSUS listing stock_mode='auto' (seller
--    jualan lewat provider vipbestmods yang PLATFORM (bukan seller) yang
--    tanggung ongkosnya tiap ada penjualan) -- di-enforce di API ROUTE
--    pembuatan/edit listing itu (BUKAN di SQL, karena butuh fetch harga
--    katalog vipbestmods LIVE lewat HTTP saat itu, Postgres function tidak
--    bisa manggil HTTP): harga jual seller wajib >=
--    harga_katalog_vipbestmods * (1 + min_auto_markup_percent/100), supaya
--    komisi platform dari penjualan itu gak keok sama ongkos beli ke
--    vipbestmods. Dicek SAAT listing disimpan saja, bukan tiap transaksi --
--    kalau harga vipbestmods naik SETELAH listing dibuat, margin bisa
--    menipis sampai admin/seller update harga lagi (risiko yang sama
--    persis sudah ada di produk admin sendiri di heroitbest (project asal) hari ini,
--    bukan risiko baru).

-- ══════════════════════════════════════════════════════════════════
-- RLS -- sama persis pola key_stock/app_settings di 0003: akses HANYA
-- lewat service-role (dipanggil dari API route Next.js kita, bukan
-- langsung dari browser/client Supabase). Jangan widen GRANT ke
-- anon/authenticated untuk tabel-tabel ini.
-- ══════════════════════════════════════════════════════════════════
alter table public.sellers enable row level security;
alter table public.withdrawal_requests enable row level security;
alter table public.order_disputes enable row level security;
revoke all on public.sellers, public.withdrawal_requests, public.order_disputes from anon, authenticated;

-- ══════════════════════════════════════════════════════════════════
-- seller_balance(seller_id) -- sumber kebenaran TUNGGAL untuk saldo
-- pending vs available seorang seller. Dipanggil dari dashboard seller
-- DAN dari request_seller_withdrawal() di bawah -- jangan ada tempat
-- lain yang menghitung ulang logic ini secara terpisah (risiko dua
-- rumus beda hasil).
-- ══════════════════════════════════════════════════════════════════
create or replace function public.seller_balance(p_seller_id uuid)
returns table (pending bigint, available bigint, paid_out bigint)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_earned_and_cleared bigint; -- held_until lewat DAN tidak ada dispute open
  v_earned_pending bigint;     -- held_until belum lewat ATAU ada dispute open
  v_reserved bigint;           -- withdrawal pending/approved (belum 'paid', tapi sudah "dijanjikan")
  v_paid bigint;               -- withdrawal yang sudah 'paid'
begin
  select
    coalesce(sum(t.seller_earning) filter (where t.held_until <= now() and not t.has_open_dispute), 0),
    coalesce(sum(t.seller_earning) filter (where t.held_until > now() or t.has_open_dispute), 0)
  into v_earned_and_cleared, v_earned_pending
  from (
    select rk.seller_earning, rk.held_until,
           exists (
             select 1 from public.order_disputes d
             where d.reseller_key_id = rk.id and d.status = 'open'
           ) as has_open_dispute
    from public.reseller_keys rk
    where rk.seller_id = p_seller_id
      and rk.refunded_at is null
  ) t;

  select coalesce(sum(amount) filter (where status in ('pending', 'approved')), 0),
         coalesce(sum(amount) filter (where status = 'paid'), 0)
    into v_reserved, v_paid
  from public.withdrawal_requests
  where seller_id = p_seller_id;

  return query select
    v_earned_pending,
    greatest(v_earned_and_cleared - v_reserved - v_paid, 0),
    v_paid;
end;
$$;

-- ══════════════════════════════════════════════════════════════════
-- register_seller() -- self-register, sesuai keputusan "bebas daftar
-- sendiri, langsung bisa jualan". store_slug WAJIB unik (dipakai di URL
-- /toko/<slug> nantinya) -- di-generate dari store_name kalau bentrok,
-- ditambah angka.
-- ══════════════════════════════════════════════════════════════════
create or replace function public.register_seller(
  p_user_id uuid,
  p_store_name text,
  p_bank_name text,
  p_bank_account_number text,
  p_bank_account_holder text
)
returns public.sellers
language plpgsql
security definer
set search_path = public
as $$
declare
  v_base_slug text;
  v_slug text;
  v_suffix int := 0;
  v_row public.sellers;
begin
  perform public.assert_not_banned(p_user_id);

  if exists (select 1 from public.sellers where user_id = p_user_id) then
    raise exception 'already_a_seller';
  end if;

  if coalesce(trim(p_store_name), '') = '' then
    raise exception 'store_name_required';
  end if;

  v_base_slug := lower(regexp_replace(trim(p_store_name), '[^a-zA-Z0-9]+', '-', 'g'));
  v_base_slug := trim(both '-' from v_base_slug);
  if v_base_slug = '' then v_base_slug := 'toko'; end if;
  v_slug := v_base_slug;

  while exists (select 1 from public.sellers where store_slug = v_slug) loop
    v_suffix := v_suffix + 1;
    v_slug := v_base_slug || '-' || v_suffix;
  end loop;

  insert into public.sellers (user_id, store_name, store_slug, bank_name, bank_account_number, bank_account_holder)
  values (p_user_id, trim(p_store_name), v_slug, p_bank_name, p_bank_account_number, p_bank_account_holder)
  returning * into v_row;

  return v_row;
end;
$$;

-- ══════════════════════════════════════════════════════════════════
-- generate_key_seller_manual() -- versi generate_key_manual() KHUSUS untuk
-- listing seller stock_mode='manual' (key sudah ada di key_stock milik
-- seller itu, tidak ada biaya beli ke provider apapun -- key-nya emang
-- sudah punya seller). Untuk listing seller stock_mode='auto', lihat
-- generate_key_seller_auto() di bawah -- itu punya alur beda karena ada
-- panggilan HTTP ke vipbestmods.com yang HARUS terjadi di Next.js (Postgres
-- function tidak bisa manggil HTTP), baru setelah key-nya didapat RPC ini
-- dipanggil buat mencatat.
--
-- Produk milik platform sendiri (seller_id null) TETAP pakai
-- generate_key()/generate_key_manual() yang lama, TIDAK lewat sini.
--
-- SENGAJA tidak pakai effective_key_price() (tier/custom price) -- itu
-- konsep harga platform-ke-reseller-platform, tidak relevan buat listing
-- seller yang harganya seller tentukan sendiri di product_durations.price.
-- ══════════════════════════════════════════════════════════════════
create or replace function public.generate_key_seller_manual(
  p_buyer_id uuid,
  p_product_id text,
  p_duration_id text
)
returns public.reseller_keys
language plpgsql
security definer
set search_path = public
as $$
declare
  v_price bigint;
  v_label text;
  v_product_name text;
  v_seller_id uuid;
  v_stock_mode text;
  v_seller_status text;
  v_balance bigint;
  v_stock_id uuid;
  v_key_string text;
  v_commission_percent numeric;
  v_default_commission numeric;
  v_hold_hours numeric;
  v_commission_amount bigint;
  v_seller_earning bigint;
  v_row public.reseller_keys;
begin
  perform public.assert_not_banned(p_buyer_id);

  select pd.price, pd.label, p.name, p.seller_id, pd.stock_mode
    into v_price, v_label, v_product_name, v_seller_id, v_stock_mode
  from public.product_durations pd
  join public.products p on p.id = pd.product_id
  where pd.product_id = p_product_id and pd.id = p_duration_id;

  if v_price is null then
    raise exception 'invalid_product_or_duration';
  end if;
  if v_seller_id is null then
    -- Produk platform sendiri kepanggil lewat RPC yang salah -- ini bug
    -- di sisi pemanggil (harusnya generate_key_manual), bukan skenario
    -- yang boleh diteruskan diam-diam.
    raise exception 'not_a_marketplace_listing';
  end if;
  if v_stock_mode <> 'manual' then
    -- stock_mode='auto' HARUS lewat generate_key_seller_auto() (butuh
    -- panggilan HTTP ke vipbestmods sebelum RPC ini bisa dipanggil).
    raise exception 'wrong_rpc_for_stock_mode';
  end if;

  select status into v_seller_status from public.sellers where id = v_seller_id for update;
  if v_seller_status is null or v_seller_status <> 'active' then
    raise exception 'seller_unavailable';
  end if;

  select balance into v_balance from public.users where id = p_buyer_id for update;
  if v_balance is null then
    raise exception 'user_not_found';
  end if;
  if v_balance < v_price then
    raise exception 'insufficient_balance';
  end if;

  select id, key_string into v_stock_id, v_key_string
  from public.key_stock
  where product_id = p_product_id and duration_id = p_duration_id
    and seller_id = v_seller_id and used = false
  order by created_at asc
  limit 1
  for update skip locked;

  if v_stock_id is null then
    raise exception 'out_of_stock';
  end if;

  select (value->>'default_commission_percent')::numeric, (value->>'pending_hold_hours')::numeric
    into v_default_commission, v_hold_hours
  from public.app_settings where key = 'marketplace';

  v_default_commission := coalesce(v_default_commission, 10);  -- fallback 10% kalau admin belum pernah isi
  v_hold_hours := coalesce(v_hold_hours, 48);                  -- fallback 48 jam

  select coalesce(commission_percent, v_default_commission) into v_commission_percent
  from public.sellers where id = v_seller_id;

  v_commission_amount := round(v_price * v_commission_percent / 100);
  v_seller_earning := v_price - v_commission_amount;

  update public.key_stock
    set used = true, used_by = p_buyer_id, used_at = now()
    where id = v_stock_id;

  update public.users set balance = balance - v_price where id = p_buyer_id;

  insert into public.reseller_keys (
    user_id, product_id, product_name, duration_label, price, key_string,
    seller_id, seller_earning, commission_amount, held_until
  )
  values (
    p_buyer_id, p_product_id, v_product_name, v_label, v_price, v_key_string,
    v_seller_id, v_seller_earning, v_commission_amount, now() + (v_hold_hours * interval '1 hour')
  )
  returning * into v_row;

  return v_row;
end;
$$;

-- ══════════════════════════════════════════════════════════════════
-- generate_key_seller_auto() -- untuk listing seller stock_mode='auto'.
-- BEDA dari generate_key_seller_manual(): key_string dan p_provider_cost
-- SUDAH didapat dari panggilan HTTP ke vipbestmods.com (orderProviderKey(),
-- pakai kredensial PLATFORM yang sama dengan produk admin sendiri, BUKAN
-- kredensial seller) yang dilakukan di Next.js SEBELUM RPC ini dipanggil
-- -- persis pola generate_key() (bukan generate_key_manual()) yang sudah
-- ada di 0006_reseller_ops.sql untuk produk platform sendiri. RPC ini
-- HANYA mencatat & motong saldo pembeli, TIDAK memanggil provider apapun.
--
-- p_provider_cost = balance_before - balance_after dari response order
-- vipbestmods (ongkos REAL yang baru saja kepotong dari saldo platform)
-- -- dicatat apa adanya buat audit, TIDAK dipakai untuk hitung
-- seller_earning (lihat catatan di kolom provider_cost di atas).
-- ══════════════════════════════════════════════════════════════════
create or replace function public.generate_key_seller_auto(
  p_buyer_id uuid,
  p_product_id text,
  p_duration_id text,
  p_key_string text,
  p_provider_cost bigint
)
returns public.reseller_keys
language plpgsql
security definer
set search_path = public
as $$
declare
  v_price bigint;
  v_label text;
  v_product_name text;
  v_seller_id uuid;
  v_stock_mode text;
  v_seller_status text;
  v_balance bigint;
  v_default_commission numeric;
  v_hold_hours numeric;
  v_commission_percent numeric;
  v_commission_amount bigint;
  v_seller_earning bigint;
  v_row public.reseller_keys;
begin
  perform public.assert_not_banned(p_buyer_id);

  select pd.price, pd.label, p.name, p.seller_id, pd.stock_mode
    into v_price, v_label, v_product_name, v_seller_id, v_stock_mode
  from public.product_durations pd
  join public.products p on p.id = pd.product_id
  where pd.product_id = p_product_id and pd.id = p_duration_id;

  if v_price is null then
    raise exception 'invalid_product_or_duration';
  end if;
  if v_seller_id is null then
    raise exception 'not_a_marketplace_listing';
  end if;
  if v_stock_mode <> 'auto' then
    raise exception 'wrong_rpc_for_stock_mode';
  end if;

  select status into v_seller_status from public.sellers where id = v_seller_id for update;
  if v_seller_status is null or v_seller_status <> 'active' then
    raise exception 'seller_unavailable';
  end if;

  select balance into v_balance from public.users where id = p_buyer_id for update;
  if v_balance is null then
    raise exception 'user_not_found';
  end if;
  if v_balance < v_price then
    raise exception 'insufficient_balance';
  end if;

  select (value->>'default_commission_percent')::numeric, (value->>'pending_hold_hours')::numeric
    into v_default_commission, v_hold_hours
  from public.app_settings where key = 'marketplace';

  v_default_commission := coalesce(v_default_commission, 10);
  v_hold_hours := coalesce(v_hold_hours, 48);

  select coalesce(commission_percent, v_default_commission) into v_commission_percent
  from public.sellers where id = v_seller_id;

  v_commission_amount := round(v_price * v_commission_percent / 100);
  v_seller_earning := v_price - v_commission_amount;

  update public.users set balance = balance - v_price where id = p_buyer_id;

  insert into public.reseller_keys (
    user_id, product_id, product_name, duration_label, price, key_string,
    seller_id, seller_earning, commission_amount, held_until, provider_cost
  )
  values (
    p_buyer_id, p_product_id, v_product_name, v_label, v_price, p_key_string,
    v_seller_id, v_seller_earning, v_commission_amount,
    now() + (v_hold_hours * interval '1 hour'), p_provider_cost
  )
  returning * into v_row;

  return v_row;
end;
$$;

-- ══════════════════════════════════════════════════════════════════
-- request_seller_withdrawal() -- pakai seller_balance() di atas sebagai
-- SATU-SATUNYA sumber kebenaran "berapa yang boleh ditarik". `for update`
-- di sellers mengunci baris seller ini supaya dua request withdrawal
-- yang nembak bersamaan (double-submit) tidak bisa dua-duanya lolos
-- validasi dari angka available yang sama.
-- ══════════════════════════════════════════════════════════════════
create or replace function public.request_seller_withdrawal(
  p_seller_id uuid,
  p_amount bigint
)
returns public.withdrawal_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  v_seller public.sellers;
  v_available bigint;
  v_row public.withdrawal_requests;
begin
  select * into v_seller from public.sellers where id = p_seller_id for update;
  if v_seller is null then
    raise exception 'seller_not_found';
  end if;
  if v_seller.status <> 'active' then
    raise exception 'seller_suspended';
  end if;
  if p_amount <= 0 then
    raise exception 'invalid_amount';
  end if;

  select available into v_available from public.seller_balance(p_seller_id);
  if p_amount > v_available then
    raise exception 'insufficient_available_balance';
  end if;

  if v_seller.bank_account_number is null or trim(v_seller.bank_account_number) = '' then
    raise exception 'bank_info_missing';
  end if;

  insert into public.withdrawal_requests (seller_id, amount, bank_snapshot)
  values (
    p_seller_id,
    p_amount,
    jsonb_build_object(
      'bank_name', v_seller.bank_name,
      'bank_account_number', v_seller.bank_account_number,
      'bank_account_holder', v_seller.bank_account_holder
    )
  )
  returning * into v_row;

  return v_row;
end;
$$;


-- ══════════════════════════════════════════════════════════════════
-- create_order_dispute() -- pembeli melaporkan key dari listing seller
-- yang bermasalah. Hanya boleh SELAMA masa tahan (held_until) belum lewat:
-- setelah itu saldo seller sudah boleh ditarik, jadi komplain harus masuk
-- dalam jendela itu. Satu komplain per key (cegah spam/duplikat).
-- ══════════════════════════════════════════════════════════════════
create or replace function public.create_order_dispute(
  p_buyer_id uuid,
  p_key_id uuid,
  p_reason text
)
returns public.order_disputes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key public.reseller_keys;
  v_row public.order_disputes;
begin
  perform public.assert_not_banned(p_buyer_id);

  if coalesce(trim(p_reason), '') = '' then
    raise exception 'reason_required';
  end if;

  select * into v_key from public.reseller_keys where id = p_key_id for update;
  if v_key.id is null or v_key.user_id <> p_buyer_id then
    raise exception 'key_not_found';
  end if;
  if v_key.seller_id is null then
    raise exception 'not_a_marketplace_listing';
  end if;
  if v_key.refunded_at is not null then
    raise exception 'already_refunded';
  end if;
  if v_key.held_until is null or v_key.held_until < now() then
    raise exception 'dispute_window_closed';
  end if;
  if exists (select 1 from public.order_disputes where reseller_key_id = p_key_id) then
    raise exception 'dispute_already_filed';
  end if;

  insert into public.order_disputes (reseller_key_id, buyer_id, seller_id, reason)
  values (p_key_id, p_buyer_id, v_key.seller_id, left(trim(p_reason), 1000))
  returning * into v_row;

  return v_row;
end;
$$;

-- ══════════════════════════════════════════════════════════════════
-- resolve_order_dispute() -- keputusan admin. 'resolved_refund' =
-- saldo beli pembeli dikembalikan penuh (users.balance += price) dan key
-- ditandai refunded (pendapatan seller dari key itu hilang). Catatan: untuk
-- listing Auto, ongkos yang sudah dibayar platform ke supplier TIDAK ikut
-- kembali (risiko platform). 'resolved_release' / 'dismissed' = seller
-- tetap dapat pendapatannya (saldo jadi tersedia begitu masa tahan lewat).
-- ══════════════════════════════════════════════════════════════════
create or replace function public.resolve_order_dispute(
  p_dispute_id uuid,
  p_resolution text,
  p_admin_note text
)
returns public.order_disputes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_d public.order_disputes;
  v_key public.reseller_keys;
begin
  if p_resolution not in ('resolved_refund', 'resolved_release', 'dismissed') then
    raise exception 'invalid_resolution';
  end if;

  select * into v_d from public.order_disputes where id = p_dispute_id for update;
  if v_d.id is null then
    raise exception 'dispute_not_found';
  end if;
  if v_d.status <> 'open' then
    raise exception 'dispute_not_open';
  end if;

  if p_resolution = 'resolved_refund' then
    select * into v_key from public.reseller_keys where id = v_d.reseller_key_id for update;
    if v_key.refunded_at is not null then
      raise exception 'already_refunded';
    end if;
    update public.users set balance = balance + v_key.price where id = v_key.user_id;
    update public.reseller_keys set refunded_at = now() where id = v_key.id;
  end if;

  update public.order_disputes
    set status = p_resolution, admin_note = nullif(trim(coalesce(p_admin_note, '')), ''), resolved_at = now()
    where id = p_dispute_id
    returning * into v_d;

  return v_d;
end;
$$;


-- ══════════════════════════════════════════════════════════════════
-- Penjaga di level DATABASE: key dari listing seller HANYA boleh tercatat
-- lewat generate_key_seller_manual()/generate_key_seller_auto() (yang
-- mengisi seller_id + pendapatan seller). Tanpa ini, RPC lama milik platform
-- (generate_key / generate_key_manual -- dipakai Partner API & admin) yang
-- tidak sengaja dipanggil ke produk seller akan menjual key seller TANPA
-- mengkredit seller sama sekali (ditemukan lewat tes: seller_id kosong,
-- stok seller terpakai, uang tidak ke mana-mana).
-- Karena RPC-RPC itu menandai stok terpakai & memotong saldo di transaksi
-- yang SAMA dengan insert ini, exception di sini me-rollback semuanya.
-- ══════════════════════════════════════════════════════════════════
create or replace function public.reseller_keys_guard_seller_listing()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_product_seller uuid;
begin
  select seller_id into v_product_seller from public.products where id = new.product_id;

  if new.seller_id is null and v_product_seller is not null then
    raise exception 'seller_listing_requires_marketplace_rpc';
  end if;
  if new.seller_id is not null and new.seller_id is distinct from v_product_seller then
    raise exception 'seller_listing_mismatch';
  end if;
  return new;
end;
$$;

drop trigger if exists reseller_keys_guard_seller_listing on public.reseller_keys;
create trigger reseller_keys_guard_seller_listing
  before insert on public.reseller_keys
  for each row execute function public.reseller_keys_guard_seller_listing();


-- >>>>>>>>>> 0014_all_fixes.sql
-- ══════════════════════════════════════════════════════════════════
-- 0014_topup_integrity.sql -- top-up tidak boleh nyangkut 'pending' &
-- tidak boleh kredit ganda / hilang. Idempotent. Jalankan SEBELUM 0015.
--
--  1. status 'expired' sekarang sah (sebelumnya CHECK cuma pending/
--     success/failed, padahal UI & API sudah mengenal 'expired').
--  2. settle_topup (signature SAMA, 4 param): kunci baris (FOR UPDATE)
--     sehingga webhook retry paralel tidak balapan; pembayaran yang
--     datang TERLAMBAT (baris sudah expired/failed) tetap dikreditkan;
--     jalur fallback insert kebal unique_violation (kembalikan baris lama).
--  3. mark_topup_final(): tandai pending -> expired/failed (dipanggil
--     webhook EXPIRED/FAILED & create-route saat gateway menolak).
--  4. expire_stale_topups(): pending yang terlalu lama -> expired (lazy,
--     dipanggil saat user buka riwayat / polling; tanpa cron).
-- ══════════════════════════════════════════════════════════════════

alter table public.topups drop constraint if exists topups_status_check;
alter table public.topups
  add constraint topups_status_check
  check (status in ('pending', 'success', 'failed', 'expired'));

create index if not exists topups_pending_idx
  on public.topups (created_at) where status = 'pending';

create or replace function public.settle_topup(
  p_provider_ref text,
  p_user_id uuid,
  p_nominal bigint,
  p_bonus bigint
)
returns public.topups
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.topups;
begin
  -- Kunci baris checkout (merchant_ref == provider order_id). Request
  -- webhook paralel untuk order yang sama antre di sini; yang kedua
  -- melihat status 'success' dan jadi no-op.
  select * into v_row from public.topups
    where merchant_ref = p_provider_ref
    for update;

  if found then
    if v_row.status = 'success' then
      return v_row; -- idempotent
    end if;
    -- Sumber kebenaran user/nominal/bonus = baris checkout, bukan argumen.
    perform public.assert_not_banned(v_row.user_id);
    update public.topups
      set status = 'success',
          provider_ref = p_provider_ref,
          settled_at = now()
      where id = v_row.id
      returning * into v_row;
  else
    -- Tidak ada baris checkout (settle manual/debug). Tetap idempotent.
    select * into v_row from public.topups where provider_ref = p_provider_ref and status = 'success';
    if found then
      return v_row;
    end if;
    perform public.assert_not_banned(p_user_id);
    begin
      insert into public.topups (user_id, nominal, bonus, total, status, provider_ref, merchant_ref, settled_at)
      values (p_user_id, p_nominal, p_bonus, p_nominal + p_bonus, 'success', p_provider_ref, p_provider_ref, now())
      returning * into v_row;
    exception when unique_violation then
      select * into v_row from public.topups
        where provider_ref = p_provider_ref or merchant_ref = p_provider_ref limit 1;
      return v_row;
    end;
  end if;

  update public.users
    set balance = balance + v_row.total, total_topup = total_topup + v_row.total
    where id = v_row.user_id;

  return v_row;
end;
$$;

create or replace function public.mark_topup_final(p_merchant_ref text, p_status text)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n int;
begin
  if p_status not in ('expired', 'failed') then
    raise exception 'invalid_status';
  end if;
  update public.topups set status = p_status
    where merchant_ref = p_merchant_ref and status = 'pending';
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

create or replace function public.expire_stale_topups(p_user_id uuid default null, p_minutes int default 30)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n int;
begin
  update public.topups set status = 'expired'
    where status = 'pending'
      and created_at < now() - make_interval(mins => greatest(p_minutes, 5))
      and (p_user_id is null or user_id = p_user_id);
  get diagnostics v_n = row_count;

  -- Housekeeping gratis-tier (Supabase 500MB): ~5% panggilan ikut membersihkan
  -- tabel log yang tumbuh tanpa batas (spam webhook palsu, rate-limit bucket
  -- user yang sudah tidak aktif). Tanpa pg_cron.
  if random() < 0.05 then
    delete from public.rate_limit_hits where created_at < now() - interval '1 day';
    delete from public.webhook_log where created_at < now() - interval '30 days';
    delete from public.provider_error_log where created_at < now() - interval '30 days';
  end if;

  return v_n;
end;
$$;

revoke all on function public.mark_topup_final(text, text) from public, anon, authenticated;
revoke all on function public.expire_stale_topups(uuid, int) from public, anon, authenticated;
revoke all on function public.settle_topup(text, uuid, bigint, bigint) from public, anon, authenticated;
grant execute on function public.mark_topup_final(text, text) to service_role;
grant execute on function public.expire_stale_topups(uuid, int) to service_role;
grant execute on function public.settle_topup(text, uuid, bigint, bigint) to service_role;


-- ══════════════════════════════════════════════════════════════════
-- 0015_marketplace_integrity.sql -- perbaikan integritas uang di sisi
-- marketplace + pembelian key. Idempotent (create or replace / if not
-- exists / drop ... if exists). TIDAK menyentuh settle_topup / webhook /
-- topup (itu 0014_topup_integrity.sql). Jalankan SETELAH 0014 supaya
-- blok REVOKE di paling bawah juga mencakup fungsi baru dari 0014.
--
-- Isi:
--   1. Constraint konsistensi data penjualan seller + 1 dispute per key.
--   2. seller_balances_bulk() set-based (hapus N+1 di /api/admin/sellers);
--      seller_balance() jadi wrapper tipis -> rumus tetap SATU tempat.
--   3. generate_key_seller_manual/auto: blok self-buy (cuci saldo topup
--      -> saldo seller), produk nonaktif, key_stock "beracun" (key_string
--      sudah ada di reseller_keys -> sebelumnya insert gagal berulang dan
--      baris itu macet di kepala antrean selamanya), provider_cost
--      negatif, key kosong; lock seller jadi FOR SHARE (penjualan paralel
--      tidak saling antre; withdrawal tetap FOR UPDATE jadi tetap serial).
--   4. request_seller_withdrawal: tolak amount NULL, akun banned.
--   5. Mutex pembelian Auto per akun (auto_order_locks) + log key yatim
--      (provider_orphan_keys) -- lihat catatan di route generate-key.
--   6. effective_key_prices(): harga efektif semua produk platform dalam
--      1 query (hapus N+1 di halaman Generate & Partner API).
--   7. REVOKE EXECUTE dari PUBLIC/anon/authenticated untuk SEMUA fungsi
--      di schema public (semua pemanggil sah = service_role).
-- ══════════════════════════════════════════════════════════════════

-- ── 1. Constraint ────────────────────────────────────────────────
-- NOT VALID: hanya baris BARU yang dicek (data lama tidak diblok).
alter table public.reseller_keys drop constraint if exists reseller_keys_seller_sale_consistent;
alter table public.reseller_keys
  add constraint reseller_keys_seller_sale_consistent
  check (
    seller_id is null
    or (
      seller_earning is not null and commission_amount is not null and held_until is not null
      and seller_earning >= 0 and commission_amount >= 0
      and seller_earning + commission_amount = price
    )
  ) not valid;

-- Satu dispute per key sudah dijaga create_order_dispute() (lock baris key),
-- ini sabuk pengaman di level index.
do $$
begin
  create unique index if not exists order_disputes_one_per_key on public.order_disputes (reseller_key_id);
exception when unique_violation then
  raise notice 'order_disputes_one_per_key tidak dibuat: ada dispute ganda lama, bersihkan manual lalu jalankan ulang.';
end $$;

-- ── 2. Saldo seller set-based ────────────────────────────────────
create or replace function public.seller_balances_bulk(p_seller_ids uuid[])
returns table (seller_id uuid, pending bigint, available bigint, paid_out bigint)
language sql
stable
security definer
set search_path = public
as $$
  with ids as (
    select distinct u.id from unnest(p_seller_ids) as u(id)
  ),
  open_disputes as (
    select distinct d.reseller_key_id from public.order_disputes d where d.status = 'open'
  ),
  earn as (
    select rk.seller_id as sid,
           coalesce(sum(rk.seller_earning) filter (where rk.held_until <= now() and od.reseller_key_id is null), 0) as cleared,
           coalesce(sum(rk.seller_earning) filter (where rk.held_until > now() or od.reseller_key_id is not null), 0) as pend
    from public.reseller_keys rk
    left join open_disputes od on od.reseller_key_id = rk.id
    where rk.seller_id in (select id from ids)
      and rk.refunded_at is null
    group by rk.seller_id
  ),
  wd as (
    select w.seller_id as sid,
           coalesce(sum(w.amount) filter (where w.status in ('pending', 'approved')), 0) as reserved,
           coalesce(sum(w.amount) filter (where w.status = 'paid'), 0) as paid
    from public.withdrawal_requests w
    where w.seller_id in (select id from ids)
    group by w.seller_id
  )
  select ids.id,
         coalesce(e.pend, 0)::bigint,
         greatest(coalesce(e.cleared, 0) - coalesce(w.reserved, 0) - coalesce(w.paid, 0), 0)::bigint,
         coalesce(w.paid, 0)::bigint
  from ids
  left join earn e on e.sid = ids.id
  left join wd w on w.sid = ids.id;
$$;

create or replace function public.seller_balance(p_seller_id uuid)
returns table (pending bigint, available bigint, paid_out bigint)
language sql
stable
security definer
set search_path = public
as $$
  select b.pending, b.available, b.paid_out
  from public.seller_balances_bulk(array[p_seller_id]) b;
$$;

-- ── 3. Pembelian listing seller ──────────────────────────────────
create or replace function public.generate_key_seller_manual(
  p_buyer_id uuid,
  p_product_id text,
  p_duration_id text
)
returns public.reseller_keys
language plpgsql
security definer
set search_path = public
as $$
declare
  v_price bigint;
  v_label text;
  v_product_name text;
  v_product_active boolean;
  v_seller_id uuid;
  v_stock_mode text;
  v_seller_status text;
  v_seller_user uuid;
  v_balance bigint;
  v_stock_id uuid;
  v_key_string text;
  v_commission_percent numeric;
  v_default_commission numeric;
  v_hold_hours numeric;
  v_commission_amount bigint;
  v_seller_earning bigint;
  v_row public.reseller_keys;
begin
  perform public.assert_not_banned(p_buyer_id);

  select pd.price, pd.label, p.name, p.active, p.seller_id, pd.stock_mode
    into v_price, v_label, v_product_name, v_product_active, v_seller_id, v_stock_mode
  from public.product_durations pd
  join public.products p on p.id = pd.product_id
  where pd.product_id = p_product_id and pd.id = p_duration_id;

  if v_price is null or v_price < 0 then
    raise exception 'invalid_product_or_duration';
  end if;
  if v_seller_id is null then
    raise exception 'not_a_marketplace_listing';
  end if;
  if v_stock_mode <> 'manual' then
    raise exception 'wrong_rpc_for_stock_mode';
  end if;
  if not v_product_active then
    raise exception 'invalid_product_or_duration';
  end if;

  -- FOR SHARE: penjualan paralel ke seller yang sama tidak saling antre,
  -- tapi tetap menahan perubahan status seller & withdrawal (FOR UPDATE).
  select status, user_id into v_seller_status, v_seller_user from public.sellers where id = v_seller_id for share;
  if v_seller_status is null or v_seller_status <> 'active' then
    raise exception 'seller_unavailable';
  end if;
  if v_seller_user = p_buyer_id then
    raise exception 'self_purchase_not_allowed';
  end if;

  select balance into v_balance from public.users where id = p_buyer_id for update;
  if v_balance is null then
    raise exception 'user_not_found';
  end if;
  if v_balance < v_price then
    raise exception 'insufficient_balance';
  end if;

  -- Karantina stok "beracun": key_string sudah pernah tercatat di
  -- reseller_keys (unique) -> tidak mungkin terjual lagi dan sebelumnya
  -- bikin setiap pembelian gagal di baris yang sama.
  update public.key_stock ks
     set used = true, used_at = now()
   where ks.product_id = p_product_id and ks.duration_id = p_duration_id
     and ks.seller_id = v_seller_id and ks.used = false
     and exists (select 1 from public.reseller_keys rk where rk.key_string = ks.key_string);

  select ks.id, ks.key_string into v_stock_id, v_key_string
  from public.key_stock ks
  where ks.product_id = p_product_id and ks.duration_id = p_duration_id
    and ks.seller_id = v_seller_id and ks.used = false
  order by ks.created_at asc
  limit 1
  for update of ks skip locked;

  if v_stock_id is null then
    raise exception 'out_of_stock';
  end if;

  select (value->>'default_commission_percent')::numeric, (value->>'pending_hold_hours')::numeric
    into v_default_commission, v_hold_hours
  from public.app_settings where key = 'marketplace';

  v_default_commission := coalesce(v_default_commission, 10);
  v_hold_hours := coalesce(v_hold_hours, 48);

  select coalesce(commission_percent, v_default_commission) into v_commission_percent
  from public.sellers where id = v_seller_id;
  v_commission_percent := least(greatest(coalesce(v_commission_percent, 10), 0), 100);
  v_hold_hours := greatest(v_hold_hours, 0);

  v_commission_amount := round(v_price * v_commission_percent / 100);
  v_seller_earning := v_price - v_commission_amount;

  update public.key_stock
    set used = true, used_by = p_buyer_id, used_at = now()
    where id = v_stock_id;

  update public.users set balance = balance - v_price where id = p_buyer_id;

  insert into public.reseller_keys (
    user_id, product_id, product_name, duration_label, price, key_string,
    seller_id, seller_earning, commission_amount, held_until
  )
  values (
    p_buyer_id, p_product_id, v_product_name, v_label, v_price, v_key_string,
    v_seller_id, v_seller_earning, v_commission_amount, now() + (v_hold_hours * interval '1 hour')
  )
  returning * into v_row;

  return v_row;
end;
$$;

create or replace function public.generate_key_seller_auto(
  p_buyer_id uuid,
  p_product_id text,
  p_duration_id text,
  p_key_string text,
  p_provider_cost bigint
)
returns public.reseller_keys
language plpgsql
security definer
set search_path = public
as $$
declare
  v_price bigint;
  v_label text;
  v_product_name text;
  v_product_active boolean;
  v_seller_id uuid;
  v_stock_mode text;
  v_seller_status text;
  v_seller_user uuid;
  v_balance bigint;
  v_default_commission numeric;
  v_hold_hours numeric;
  v_commission_percent numeric;
  v_commission_amount bigint;
  v_seller_earning bigint;
  v_row public.reseller_keys;
begin
  perform public.assert_not_banned(p_buyer_id);

  if coalesce(trim(p_key_string), '') = '' then
    raise exception 'invalid_key';
  end if;

  select pd.price, pd.label, p.name, p.active, p.seller_id, pd.stock_mode
    into v_price, v_label, v_product_name, v_product_active, v_seller_id, v_stock_mode
  from public.product_durations pd
  join public.products p on p.id = pd.product_id
  where pd.product_id = p_product_id and pd.id = p_duration_id;

  if v_price is null or v_price < 0 then
    raise exception 'invalid_product_or_duration';
  end if;
  if v_seller_id is null then
    raise exception 'not_a_marketplace_listing';
  end if;
  if v_stock_mode <> 'auto' then
    raise exception 'wrong_rpc_for_stock_mode';
  end if;
  if not v_product_active then
    raise exception 'invalid_product_or_duration';
  end if;

  select status, user_id into v_seller_status, v_seller_user from public.sellers where id = v_seller_id for share;
  if v_seller_status is null or v_seller_status <> 'active' then
    raise exception 'seller_unavailable';
  end if;
  if v_seller_user = p_buyer_id then
    raise exception 'self_purchase_not_allowed';
  end if;

  select balance into v_balance from public.users where id = p_buyer_id for update;
  if v_balance is null then
    raise exception 'user_not_found';
  end if;
  if v_balance < v_price then
    raise exception 'insufficient_balance';
  end if;

  select (value->>'default_commission_percent')::numeric, (value->>'pending_hold_hours')::numeric
    into v_default_commission, v_hold_hours
  from public.app_settings where key = 'marketplace';

  v_default_commission := coalesce(v_default_commission, 10);
  v_hold_hours := coalesce(v_hold_hours, 48);

  select coalesce(commission_percent, v_default_commission) into v_commission_percent
  from public.sellers where id = v_seller_id;
  v_commission_percent := least(greatest(coalesce(v_commission_percent, 10), 0), 100);
  v_hold_hours := greatest(v_hold_hours, 0);

  v_commission_amount := round(v_price * v_commission_percent / 100);
  v_seller_earning := v_price - v_commission_amount;

  update public.users set balance = balance - v_price where id = p_buyer_id;

  insert into public.reseller_keys (
    user_id, product_id, product_name, duration_label, price, key_string,
    seller_id, seller_earning, commission_amount, held_until, provider_cost
  )
  values (
    p_buyer_id, p_product_id, v_product_name, v_label, v_price, trim(p_key_string),
    v_seller_id, v_seller_earning, v_commission_amount,
    now() + (v_hold_hours * interval '1 hour'),
    case when p_provider_cost is null or p_provider_cost < 0 then null else p_provider_cost end
  )
  returning * into v_row;

  return v_row;
end;
$$;

-- ── 4. Withdrawal ────────────────────────────────────────────────
create or replace function public.request_seller_withdrawal(
  p_seller_id uuid,
  p_amount bigint
)
returns public.withdrawal_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  v_seller public.sellers;
  v_available bigint;
  v_row public.withdrawal_requests;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'invalid_amount';
  end if;

  -- Kunci baris seller: dua request bersamaan diserialkan, request kedua
  -- melihat reserved dari request pertama (statement baru = snapshot baru).
  select * into v_seller from public.sellers where id = p_seller_id for update;
  if v_seller is null then
    raise exception 'seller_not_found';
  end if;
  if v_seller.status <> 'active' then
    raise exception 'seller_suspended';
  end if;

  perform public.assert_not_banned(v_seller.user_id);

  select available into v_available from public.seller_balance(p_seller_id);
  if p_amount > v_available then
    raise exception 'insufficient_available_balance';
  end if;

  if v_seller.bank_account_number is null or trim(v_seller.bank_account_number) = '' then
    raise exception 'bank_info_missing';
  end if;

  insert into public.withdrawal_requests (seller_id, amount, bank_snapshot)
  values (
    p_seller_id,
    p_amount,
    jsonb_build_object(
      'bank_name', v_seller.bank_name,
      'bank_account_number', v_seller.bank_account_number,
      'bank_account_holder', v_seller.bank_account_holder
    )
  )
  returning * into v_row;

  return v_row;
end;
$$;

-- ── 5. Mutex pembelian Auto + log key yatim ──────────────────────
-- Pembelian Auto memanggil provider (uang platform keluar) SEBELUM RPC
-- debit. Tanpa mutex, N request paralel dengan saldo cukup untuk 1 order
-- semuanya lolos pre-check saldo -> N key dibeli, hanya 1 yang bisa
-- didebit (sisanya hilang jadi kerugian platform).
create table if not exists public.auto_order_locks (
  user_id uuid primary key references public.users (id) on delete cascade,
  locked_at timestamptz not null default now()
);
alter table public.auto_order_locks enable row level security;
revoke all on public.auto_order_locks from anon, authenticated;

create or replace function public.acquire_auto_order_lock(p_user_id uuid, p_ttl_seconds int default 60)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n int;
begin
  insert into public.auto_order_locks as l (user_id, locked_at)
  values (p_user_id, now())
  on conflict (user_id) do update set locked_at = now()
    where l.locked_at < now() - make_interval(secs => greatest(p_ttl_seconds, 1));
  get diagnostics v_n = row_count;
  return v_n > 0;
end;
$$;

create or replace function public.release_auto_order_lock(p_user_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.auto_order_locks where user_id = p_user_id;
$$;

-- Key yang SUDAH dibeli dari provider tapi RPC debit gagal -- disimpan
-- supaya bisa direkonsiliasi admin (bukan hanya hilang di console.error).
create table if not exists public.provider_orphan_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  product_id text,
  duration_id text,
  key_string text not null,
  provider_cost bigint,
  error_message text,
  source text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index if not exists provider_orphan_keys_open_idx on public.provider_orphan_keys (created_at desc) where resolved_at is null;
alter table public.provider_orphan_keys enable row level security;
revoke all on public.provider_orphan_keys from anon, authenticated;

-- ── 6. Harga efektif set-based ───────────────────────────────────
-- Semantik identik effective_key_price(): custom > tier tertinggi yang
-- terpenuhi > harga default. Hanya produk platform (seller_id null).
create or replace function public.effective_key_prices(p_user_id uuid)
returns table (product_id text, duration_id text, price bigint)
language sql
stable
security definer
set search_path = public
as $$
  select pd.product_id, pd.id,
         coalesce(
           (select cp.price from public.custom_prices cp
             where cp.user_id = p_user_id and cp.product_id = pd.product_id and cp.duration_id = pd.id),
           (select pt.price from public.price_tiers pt
             where pt.product_id = pd.product_id and pt.duration_id = pd.id
               and pt.min_total_topup <= coalesce((select u.total_topup from public.users u where u.id = p_user_id), 0)
             order by pt.min_total_topup desc limit 1),
           pd.price
         )::bigint
  from public.product_durations pd
  join public.products p on p.id = pd.product_id
  where p.seller_id is null;
$$;

-- ── 7. REVOKE EXECUTE ────────────────────────────────────────────
-- Postgres memberi EXECUTE ke PUBLIC secara default, dan semua fungsi
-- SECURITY DEFINER di 0001-0013 menerima p_user_id dari pemanggil -> lewat
-- PostgREST (/rest/v1/rpc/...) user mana pun bisa memanggil
-- admin_adjust_balance / settle_topup / resolve_order_dispute / dst.
-- 0010 bahkan meng-GRANT admin_set_total_topup ke authenticated.
-- Semua pemanggil sah di app memakai service_role (createAdminSupabase).
-- Loop dinamis supaya fungsi baru (mis. dari 0014) ikut tercakup; fungsi
-- milik extension dilewati.
do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.prokind = 'f'
      and not exists (
        select 1 from pg_depend d
        where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e'
      )
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
  end loop;
end $$;

-- Fungsi yang dibuat migrasi berikutnya juga tidak otomatis terbuka.
alter default privileges revoke execute on functions from public;
alter default privileges in schema public revoke execute on functions from anon, authenticated;

