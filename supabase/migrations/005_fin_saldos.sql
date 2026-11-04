-- Saldo do dia consultado na API de Saldos (conta corrente + Invest Fácil), um registro por sincronização
create table if not exists public.fin_saldos (
  id bigserial primary key,
  banco text not null,
  conta text,
  em timestamptz not null default now(),
  total numeric(14,2),
  itens jsonb not null default '[]'::jsonb,
  raw jsonb
);
create index if not exists fin_saldos_banco_em on public.fin_saldos (banco, em desc);
alter table public.fin_saldos enable row level security;
revoke all on public.fin_saldos from anon, authenticated;
