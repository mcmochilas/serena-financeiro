-- Serena Financeiro — tabelas fin_* no projeto Supabase do Picking
-- Tudo é acessado só pela Edge Function fin-api (service_role). RLS ligado sem políticas = anon/authenticated não leem nada.

create table if not exists public.fin_users (
  login text primary key,
  nome text not null,
  pin_hash text not null,
  role text not null default 'leitura' check (role in ('admin', 'leitura')),
  ativo boolean not null default true,
  criado timestamptz not null default now()
);

create table if not exists public.fin_sessions (
  token text primary key,
  login text not null references public.fin_users(login) on delete cascade,
  expira timestamptz not null
);

create table if not exists public.fin_lancamentos (
  id text primary key,
  banco text not null check (banco in ('bradesco', 'stone')),
  conta text,
  data date not null,
  descricao text not null default '',
  categoria text not null default 'Sem categoria',
  tipo text not null check (tipo in ('Entrada', 'Saída')),
  valor numeric(14, 2) not null,
  saldo numeric(14, 2),
  documento text,
  raw jsonb,
  importado timestamptz not null default now()
);
create index if not exists fin_lancamentos_banco_data on public.fin_lancamentos (banco, data desc);

-- Credenciais: só campos não secretos aqui; os segredos ficam no Vault e esta tabela guarda o id de cada um
create table if not exists public.fin_credenciais (
  banco text primary key check (banco in ('bradesco', 'stone')),
  ambiente text not null default 'sandbox' check (ambiente in ('sandbox', 'producao')),
  client_id text,
  conta text,
  cert_nome text,
  secrets jsonb not null default '{}'::jsonb,
  atualizado timestamptz,
  atualizado_por text,
  teste_em timestamptz,
  teste_ok boolean,
  teste_msg text
);

create table if not exists public.fin_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  login text,
  msg text not null
);

alter table public.fin_users enable row level security;
alter table public.fin_sessions enable row level security;
alter table public.fin_lancamentos enable row level security;
alter table public.fin_credenciais enable row level security;
alter table public.fin_log enable row level security;
revoke all on public.fin_users, public.fin_sessions, public.fin_lancamentos, public.fin_credenciais, public.fin_log from anon, authenticated;

-- Login usuário + PIN (mesmo esquema do Envio Full)
create or replace function public.fin_login(p_login text, p_pin text)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare u public.fin_users; t text;
begin
  select * into u from public.fin_users where login = lower(trim(p_login)) and ativo;
  if u.login is null or u.pin_hash <> crypt(p_pin, u.pin_hash) then return null; end if;
  t := encode(gen_random_bytes(24), 'hex');
  insert into public.fin_sessions(token, login, expira) values (t, u.login, now() + interval '7 days');
  delete from public.fin_sessions where expira < now();
  return t;
end $$;

create or replace function public.fin_set_pin(p_login text, p_pin text)
returns void language sql security definer set search_path = public, extensions as $$
  update public.fin_users set pin_hash = crypt(p_pin, gen_salt('bf')) where login = p_login;
$$;

create or replace function public.fin_add_user(p_login text, p_nome text, p_pin text, p_role text)
returns void language sql security definer set search_path = public, extensions as $$
  insert into public.fin_users(login, nome, pin_hash, role) values (lower(trim(p_login)), p_nome, crypt(p_pin, gen_salt('bf')), p_role);
$$;

-- Grava (ou troca) um segredo de um banco no Vault
create or replace function public.fin_secret_put(p_banco text, p_nome text, p_valor text)
returns void language plpgsql security definer set search_path = public, vault as $$
declare sid uuid;
begin
  insert into public.fin_credenciais(banco) values (p_banco) on conflict do nothing;
  select (secrets->>p_nome)::uuid into sid from public.fin_credenciais where banco = p_banco;
  if sid is not null and exists (select 1 from vault.secrets where id = sid) then
    perform vault.update_secret(sid, p_valor);
  else
    sid := vault.create_secret(p_valor, 'fin_' || p_banco || '_' || p_nome || '_' || substr(md5(random()::text), 1, 6), 'Serena Financeiro');
    update public.fin_credenciais set secrets = secrets || jsonb_build_object(p_nome, sid) where banco = p_banco;
  end if;
end $$;

-- Lê um segredo (só a Edge Function usa, para falar com o banco)
create or replace function public.fin_secret_get(p_banco text, p_nome text)
returns text language sql security definer set search_path = public, vault as $$
  select s.decrypted_secret from vault.decrypted_secrets s
  where s.id = (select (secrets->>p_nome)::uuid from public.fin_credenciais where banco = p_banco);
$$;

revoke execute on function public.fin_login(text, text), public.fin_set_pin(text, text), public.fin_add_user(text, text, text, text),
  public.fin_secret_put(text, text, text), public.fin_secret_get(text, text) from public, anon, authenticated;
grant execute on function public.fin_login(text, text), public.fin_set_pin(text, text), public.fin_add_user(text, text, text, text),
  public.fin_secret_put(text, text, text), public.fin_secret_get(text, text) to service_role;

insert into public.fin_credenciais(banco) values ('bradesco'), ('stone') on conflict do nothing;

-- Primeiro administrador: o mesmo usuário gestor do Envio Full, com o mesmo PIN
insert into public.fin_users(login, nome, pin_hash, role)
select login, nome, pin_hash, 'admin' from public.full_users where login = 'admin'
on conflict do nothing;
