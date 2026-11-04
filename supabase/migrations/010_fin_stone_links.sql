-- Links de pagamento da Conta Stone (Stone Banking API › payment_links): descrição e cliente preenchidos na criação
create table if not exists public.fin_stone_links (
  id text primary key,              -- id do pedido do link (or_…)
  code text,
  criado timestamptz,
  atualizado timestamptz,
  valor numeric(14,2),
  status text,
  descricao text,                   -- descrição dos itens (onde costuma ir o nº da pré-venda)
  cliente text,
  metodo text,
  raw jsonb,
  visto timestamptz not null default now()
);
create index if not exists fin_stone_links_criado on public.fin_stone_links (criado desc);
alter table public.fin_stone_links enable row level security;
revoke all on public.fin_stone_links from anon, authenticated;
