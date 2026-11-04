-- Stone Banking API: a chave pública (par da chave privada guardada no Vault) fica visível para enviar à Stone
alter table public.fin_credenciais add column if not exists chave_publica text;
update public.fin_credenciais set ambiente = 'producao' where banco = 'stone' and client_id is null;
