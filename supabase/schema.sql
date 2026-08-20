-- SAGE store schema.
-- Run once in the Supabase SQL editor (Dashboard -> SQL Editor -> New query).
--
-- The bot connects with the SERVICE ROLE key from a trusted server process, so
-- it bypasses RLS. RLS is still enabled on every table with no permissive
-- policy, which means the anon/public key can read nothing — if the anon key
-- ever leaks, these tables stay closed.

create table if not exists sage_users (
  telegram_id   text primary key,
  owner_address text,
  vault_address text,
  updated_at    timestamptz not null default now()
);

create table if not exists sage_rules (
  id                 text primary key,
  telegram_id        text not null,
  vault_address      text,
  kind               text not null,             -- 'dca' | 'conditional' | 'copy'
  token_in_symbol    text,
  token_out_symbol   text,                      -- null for copy rules (discovered per mirrored swap)
  amount_in          text,                      -- raw units, kept as text to avoid float/bigint loss
  schedule           text,                      -- 'daily' | 'weekly', dca only
  condition          jsonb,                     -- {type, token, value}, conditional only
  follow_address     text,                      -- copy only
  last_checked_block bigint,                    -- copy only
  active             boolean not null default true,
  created_at         timestamptz not null default now(),
  last_triggered_at  timestamptz
);

create index if not exists sage_rules_telegram_id_idx on sage_rules (telegram_id);
create index if not exists sage_rules_active_idx on sage_rules (active) where active;

create table if not exists sage_trades (
  id           bigserial primary key,
  telegram_id  text not null,
  rule_id      text,
  token_in     text,
  token_out    text,
  amount_in    text,
  tx_hash      text,
  created_at   timestamptz not null default now()
);

create index if not exists sage_trades_telegram_id_idx on sage_trades (telegram_id, created_at desc);

-- Which of a followed wallet's txs a copy rule has already mirrored.
-- The primary key is what makes a re-scan idempotent: a duplicate insert
-- conflicts instead of producing a second buy.
create table if not exists sage_copy_txs (
  rule_id    text not null,
  tx_hash    text not null,
  created_at timestamptz not null default now(),
  primary key (rule_id, tx_hash)
);

alter table sage_users    enable row level security;
alter table sage_rules    enable row level security;
alter table sage_trades   enable row level security;
alter table sage_copy_txs enable row level security;
