-- Stone: vendas no cartão (maquininha e link de pagamento) pela API de Conciliação
alter table public.fin_lancamentos drop constraint if exists fin_lancamentos_banco_check;
alter table public.fin_lancamentos add constraint fin_lancamentos_banco_check check (banco in ('bradesco', 'stone', 'stone_vendas'));
alter table public.fin_credenciais drop constraint if exists fin_credenciais_banco_check;
alter table public.fin_credenciais add constraint fin_credenciais_banco_check check (banco in ('bradesco', 'stone', 'stone_vendas'));
insert into public.fin_credenciais (banco, ambiente) values ('stone_vendas', 'producao') on conflict (banco) do nothing;

-- Um registro por StoneCode e dia: se o arquivo daquele dia já foi baixado e lido
create table if not exists public.fin_stone_arquivos (
  stonecode text not null,
  data date not null,
  baixado_em timestamptz not null default now(),
  ok boolean not null,
  vendas int,
  total numeric(14,2),
  erro text,
  primary key (stonecode, data)
);
alter table public.fin_stone_arquivos enable row level security;
revoke all on public.fin_stone_arquivos from anon, authenticated;
