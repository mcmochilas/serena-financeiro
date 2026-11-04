// Serena Financeiro — ponte mTLS com o Bradesco (API de Saldo e Extrato).
// Só a Edge Function fin-api (Supabase) chama esta rota, com a chave interna FIN_PROXY_KEY.
// Recebe as credenciais já descriptografadas do cofre, apresenta o certificado da empresa na
// conexão (mTLS), pede o token e consulta o extrato. Nada é gravado nem registrado aqui.
const https = require('https');
const tls = require('tls');
const crypto = require('crypto');

const BASE = { producao: 'https://openapi.bradesco.com.br', sandbox: 'https://openapisandbox.prebanco.com.br' };
const TOKEN = { producao: '/auth/server-mtls/v1/token', sandbox: '/auth/server-mtls/v2/token' };
const curto = (s, n = 300) => String(s || '').replace(/\s+/g, ' ').slice(0, n);

function pedir(agent, url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((ok) => {
    const req = https.request(url, { method, headers, agent, timeout: 25000 }, (res) => {
      let dados = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { dados += c; });
      res.on('end', () => ok({ status: res.statusCode, texto: dados }));
    });
    req.on('timeout', () => req.destroy(new Error('tempo esgotado')));
    req.on('error', (e) => ok({ status: 0, texto: 'falha de conexão: ' + (e.code || '') + ' ' + e.message }));
    try { if (body) req.write(body); req.end(); } catch (e) { ok({ status: 0, texto: 'falha de conexão: ' + e.message }); }
  });
}
const json = (t) => { try { return JSON.parse(t); } catch { return null; } };
const iguais = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.status(405).json({ erro: 'Use POST.' }); return; }
  const chave = process.env.FIN_PROXY_KEY;
  if (!chave || !iguais(req.headers['x-fin-proxy'] || '', chave)) { res.status(401).json({ erro: 'Não autorizado.' }); return; }

  const b = typeof req.body === 'object' && req.body ? req.body : json(req.body) || {};
  const amb = b.amb === 'sandbox' ? 'sandbox' : 'producao';
  if (!b.client_id || !b.client_secret || !b.pfx) { res.status(400).json({ erro: 'Faltam credenciais.' }); return; }

  let agent;
  const pfx = Buffer.from(String(b.pfx), 'base64'), passphrase = b.senha || undefined;
  try {
    tls.createSecureContext({ pfx, passphrase }); // valida arquivo e senha antes de conectar
    agent = new https.Agent({ pfx, passphrase, keepAlive: false });
  } catch (e) {
    const senha = /mac verify|bad decrypt|password/i.test(e.message);
    res.status(200).json({ etapa: 'certificado', ok: false, texto: senha ? 'A senha do certificado não confere.' : 'Não consegui abrir o certificado (' + curto(e.message, 120) + '). Envie o arquivo .pfx ou .p12.' });
    return;
  }

  // 1) token (client_credentials sobre a conexão com certificado)
  const form = new URLSearchParams({ grant_type: 'client_credentials', client_id: b.client_id, client_secret: b.client_secret }).toString();
  const t = await pedir(agent, BASE[amb] + TOKEN[amb], {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'Content-Length': Buffer.byteLength(form) },
    body: form,
  });
  if (/mac verify failure|bad decrypt|unsupported pkcs12/i.test(t.texto)) {
    res.status(200).json({ etapa: 'certificado', ok: false, texto: 'A senha do certificado não confere ou o arquivo não é um .pfx válido.' });
    return;
  }
  const tj = json(t.texto);
  if (t.status !== 200 || !tj || !tj.access_token) {
    res.status(200).json({ etapa: 'token', ok: false, status: t.status, texto: curto(t.texto) || '(sem corpo)' });
    return;
  }
  if (b.so_token) { res.status(200).json({ etapa: 'token', ok: true, via: TOKEN[amb] }); return; }

  // 2) extrato
  const q = new URLSearchParams({ agencia: String(b.agencia || ''), conta: String(b.conta || ''), tipo: 'cc', dataInicio: String(b.dataInicio || ''), dataFim: String(b.dataFim || '') });
  const url = BASE[amb] + '/v1/fornecimento-extratos-contas/extratos?' + q.toString();
  let e = await pedir(agent, url, { headers: { Authorization: 'Bearer ' + tj.access_token, Accept: 'application/json' } });
  if (e.status === 401 || e.status === 403) e = await pedir(agent, url, { headers: { Authorization: tj.access_token, Accept: 'application/json' } });
  const ej = json(e.texto);
  res.status(200).json({ etapa: 'extrato', ok: e.status === 200 && !!ej, via: TOKEN[amb], status: e.status, json: e.status === 200 ? ej : null, texto: e.status === 200 ? '' : curto(e.texto, 400) || '(sem corpo)' });
};
