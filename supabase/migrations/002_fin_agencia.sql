-- Agência separada da conta (API de Saldo e Extrato pede agência e conta sem dígito)
alter table public.fin_credenciais add column if not exists agencia text;
