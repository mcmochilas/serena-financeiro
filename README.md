# Financeiro · Serena

Painel financeiro da Serena Puxadores. Primeiro módulo: extrato da conta Bradesco (depois Stone), com configurações de API e usuários.

## Estrutura

- `public/` — o que a Vercel publica (HTML, CSS, JS, logos e ícone)
- `supabase/functions/fin-api/` — Edge Function da API (projeto Supabase do Picking, tabelas `fin_*`)
- `api/bradesco.js` — função da Vercel que conversa com o Bradesco usando o certificado da empresa (mTLS); só a `fin-api` chama, com a chave interna `FIN_PROXY_KEY`
- `supabase/migrations/` — tabelas e funções `fin_*`

## Publicação

Cada push no `main` publica automaticamente na Vercel (projeto `serena-financeiro`).

A Edge Function é publicada separadamente no Supabase (`fin-api`, sem verificação de JWT; a autenticação é feita por usuário + PIN).

## Segurança

- Nenhuma chave ou certificado entra neste repositório (ele é público).
- As credenciais dos bancos são gravadas pela `fin-api` no Supabase Vault; a tabela `fin_credenciais` guarda só os campos não secretos e o id de cada segredo.
- As tabelas `fin_*` têm RLS ligado e nenhuma política: só a `fin-api` (service role) lê e escreve.
