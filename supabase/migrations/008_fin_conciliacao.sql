-- Conciliação: pré-vendas do Picking (tabela orders, só leitura) x recebimentos do extrato (fin_lancamentos)
-- Uma conciliação junta 1+ pré-vendas com 1+ recebimentos. Cada pré-venda e cada recebimento só entra em uma.
create table if not exists public.fin_conc (
  id bigserial primary key,
  criado timestamptz not null default now(),
  por text,
  obs text,
  total_pedidos numeric(14,2),
  total_pagos numeric(14,2)
);
create table if not exists public.fin_conc_itens (
  tipo text not null check (tipo in ('pedido', 'lancamento')),
  ref text not null,
  conc_id bigint not null references public.fin_conc(id) on delete cascade,
  valor numeric(14,2),
  primary key (tipo, ref)
);
create index if not exists fin_conc_itens_conc on public.fin_conc_itens (conc_id);
alter table public.fin_conc enable row level security;
alter table public.fin_conc_itens enable row level security;
revoke all on public.fin_conc, public.fin_conc_itens from anon, authenticated;

-- Pré-vendas da venda consultiva (PV/CD com total), sem as excluídas. Lê a tabela do Picking sem alterar nada.
create or replace function public.fin_pedidos(p_de date, p_ate date)
returns table (id text, num text, data date, hora text, cliente text, cliente_cod text, vendedora text, total numeric,
               doc text, status text, cidade text, itens int, criado bigint)
language sql stable security definer set search_path = '' as $$
  select o.id, o.data->>'num', to_date(o.data->>'date', 'DD/MM/YYYY'), o.data->>'time',
         trim(o.data->>'client'), o.data->>'clientCode', trim(o.data->>'seller'), (o.data->>'total')::numeric,
         coalesce(o.data->>'docType', 'Pré-venda'), o.data->>'status', o.data->>'city',
         coalesce(jsonb_array_length(o.data->'items'), 0), (o.data->>'createdAt')::bigint
  from public.orders o
  where o.data->>'canal' = 'consultiva'
    and coalesce(o.data->>'status', '') <> 'excluido'
    and o.data->>'total' is not null
    and (o.data->>'total')::numeric > 0
    and o.data->>'date' ~ '^\d{2}/\d{2}/\d{4}$'
    and to_date(o.data->>'date', 'DD/MM/YYYY') between p_de and p_ate
$$;
revoke all on function public.fin_pedidos(date, date) from public, anon, authenticated;
grant execute on function public.fin_pedidos(date, date) to service_role;

-- As mesmas pré-vendas, buscadas pelo número (para conciliar e mostrar as já conciliadas fora do período)
create or replace function public.fin_pedidos_ids(p_ids text[])
returns table (id text, num text, data date, hora text, cliente text, cliente_cod text, vendedora text, total numeric,
               doc text, status text, cidade text, itens int, criado bigint)
language sql stable security definer set search_path = '' as $$
  select o.id, o.data->>'num', to_date(o.data->>'date', 'DD/MM/YYYY'), o.data->>'time',
         trim(o.data->>'client'), o.data->>'clientCode', trim(o.data->>'seller'), (o.data->>'total')::numeric,
         coalesce(o.data->>'docType', 'Pré-venda'), o.data->>'status', o.data->>'city',
         coalesce(jsonb_array_length(o.data->'items'), 0), (o.data->>'createdAt')::bigint
  from public.orders o
  where o.id = any(p_ids) and o.data->>'total' is not null and o.data->>'date' ~ '^\d{2}/\d{2}/\d{4}$'
$$;
revoke all on function public.fin_pedidos_ids(text[]) from public, anon, authenticated;
grant execute on function public.fin_pedidos_ids(text[]) to service_role;
