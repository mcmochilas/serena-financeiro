-- Atualização automática a cada 15 minutos + notificações de lançamentos novos
create table if not exists public.fin_notificacoes (
  id bigserial primary key,
  criado timestamptz not null default now(),
  banco text not null,
  titulo text not null,
  texto text,
  dados jsonb
);
alter table public.fin_notificacoes enable row level security;
revoke all on public.fin_notificacoes from anon, authenticated;
create index if not exists fin_notificacoes_criado on public.fin_notificacoes (criado desc);

alter table public.fin_users add column if not exists notif_visto timestamptz;

-- chave que só a rotina agendada conhece (fica no Vault)
do $$ begin
  if not exists (select 1 from vault.secrets where name = 'fin_cron_key') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'fin_cron_key');
  end if;
end $$;

create or replace function public.fin_cron_key() returns text
language sql security definer set search_path = '' as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'fin_cron_key' limit 1
$$;
revoke all on function public.fin_cron_key() from public, anon, authenticated;
grant execute on function public.fin_cron_key() to service_role;

-- agenda: a cada 15 minutos chama a API com op=cron
select cron.unschedule('fin-bradesco-15min') where exists (select 1 from cron.job where jobname = 'fin-bradesco-15min');
select cron.schedule('fin-bradesco-15min', '*/15 * * * *', $$
  select net.http_post(
    url := 'https://dtrfujxhfcyefbipkcwz.supabase.co/functions/v1/fin-api',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-fin-cron', public.fin_cron_key()),
    body := '{"op":"cron"}'::jsonb,
    timeout_milliseconds := 60000)
$$);
