-- Chave interna (Vault 'fin_proxy_key') usada pela fin-api para chamar o proxy mTLS na Vercel
create or replace function public.fin_proxy_key()
returns text language sql security definer set search_path = public, vault as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'fin_proxy_key' limit 1;
$$;
revoke execute on function public.fin_proxy_key() from public, anon, authenticated;
grant execute on function public.fin_proxy_key() to service_role;
-- o valor é criado direto no Vault (nunca no repositório): select vault.create_secret('<chave>', 'fin_proxy_key');
