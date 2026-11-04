-- Ordem do lançamento dentro do dia, como veio do banco (para o saldo do fim do dia)
alter table public.fin_lancamentos add column if not exists ordem integer;
