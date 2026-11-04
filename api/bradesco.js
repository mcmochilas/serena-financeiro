// Serena Financeiro — ponte mTLS com o Bradesco (API de Saldo e Extrato).
// Só a Edge Function fin-api (Supabase) chama esta rota, com a chave interna FIN_PROXY_KEY.
// Recebe as credenciais já descriptografadas do cofre, apresenta o certificado da empresa na
// conexão (mTLS), pede o token e consulta o extrato. Nada é gravado nem registrado aqui.
const https = require('https');
const crypto = require('crypto');
const forge = require('node-forge');

// Lê o .pfx (chave + certificado) e monta a cadeia completa do certificado: muitos .pfx exportados
// no Windows não trazem as ACs intermediárias, e sem elas o Bradesco não reconhece o certificado.
// As intermediárias que faltarem são baixadas do endereço público que o próprio certificado indica (AIA).
async function cadeia(pfxB64, senha) {
  const p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(forge.util.decode64(pfxB64)), false, senha || '');
  const bag = (t) => (p12.getBags({ bagType: t })[t] || []);
  const key = [...bag(forge.pki.oids.pkcs8ShroudedKeyBag), ...bag(forge.pki.oids.keyBag)].map((b) => b.key).find(Boolean);
  if (!key) throw new Error('o arquivo não tem a chave privada');
  const certs = bag(forge.pki.oids.certBag).map((b) => b.cert).filter(Boolean);
  const pub = (c) => forge.pki.publicKeyToPem(c.publicKey);
  const chavePub = forge.pki.publicKeyToPem(forge.pki.rsa.setPublicKey(key.n, key.e));
  const folha = certs.find((c) => pub(c) === chavePub) || certs[0];
  if (!folha) throw new Error('o arquivo não tem o certificado');
  const nome = (c) => (c.subject.getField('CN') || {}).value || '';
  const dn = (x) => x.attributes.map((a) => `${a.type}=${a.value}`).join(',');
  const fp = (c) => forge.md.sha1.create().update(forge.asn1.toDer(forge.pki.certificateToAsn1(c)).getBytes()).digest().toHex();
  const assina = (pai, filho) => { try { return pai.verify(filho); } catch { return false; } };
  const auto = (c) => dn(c.subject) === dn(c.issuer);
  const chain = [folha], vistos = new Set([fp(folha)]), baixadas = [];
  let atual = folha;
  for (let i = 0; i < 5 && !auto(atual); i++) {
    const cands = certs.filter((c) => !vistos.has(fp(c)) && dn(c.subject) === dn(atual.issuer));
    let pai = cands.find((c) => assina(c, atual)) || cands[0];
    if (!pai) {
      const aia = (atual.getExtension('authorityInfoAccess') || {}).value || '';
      const url = (String(aia).match(/https?:\/\/[\x21-\x7e]+?\.(?:crt|cer|p7b|p7c|der)/i) || [])[0];
      if (!url) break;
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
        const der = Buffer.from(await r.arrayBuffer()).toString('binary');
        let achados = [];
        try { achados = [forge.pki.certificateFromAsn1(forge.asn1.fromDer(der))]; }
        catch { try { achados = forge.pkcs7.messageFromAsn1(forge.asn1.fromDer(der)).certificates || []; } catch { achados = []; } }
        if (!achados.length && /BEGIN CERT/.test(der)) achados = [forge.pki.certificateFromPem(der)];
        achados = achados.filter((c) => !vistos.has(fp(c)) && dn(c.subject) === dn(atual.issuer));
        pai = achados.find((c) => assina(c, atual)) || achados[0];
        if (pai) baixadas.push(nome(pai));
      } catch { break; }
    }
    if (!pai || auto(pai)) break; // a raiz não precisa ir na conexão
    chain.push(pai); vistos.add(fp(pai)); atual = pai;
  }
  return {
    key: forge.pki.privateKeyToPem(key),
    cert: chain.map((c) => forge.pki.certificateToPem(c)).join('\n'),
    info: { titular: nome(folha), cadeia: chain.map(nome), no_pfx: certs.length, no_pfx_nomes: certs.map(nome), baixadas, serie: folha.serialNumber, sha1: fp(folha).toUpperCase(), validade: folha.validity.notAfter.toISOString().slice(0, 10) },
  };
}

const BASE = { producao: 'https://openapi.bradesco.com.br', sandbox: 'https://openapisandbox.prebanco.com.br' };
const TOKEN = { producao: '/auth/server-mtls/v1/token', sandbox: '/auth/server-mtls/v2/token' };
const curto = (s, n = 300) => String(s || '').replace(/\s+/g, ' ').slice(0, n);

function pedir(agent, url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((ok) => {
    let tlsInfo = null;
    const req = https.request(url, { method, headers, agent, timeout: 25000 }, (res) => {
      let dados = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { dados += c; });
      res.on('end', () => ok({ status: res.statusCode, texto: dados, tls: tlsInfo }));
    });
    // diagnóstico (só dados públicos): versão TLS e qual certificado foi apresentado
    req.on('socket', (sk) => sk.once('secureConnect', () => {
      const c = sk.getCertificate ? sk.getCertificate() : null;
      tlsInfo = { versao: sk.getProtocol && sk.getProtocol(), enviado: !!(c && c.subject),
        titular: c && c.subject ? (c.subject.CN || '') : '', emissor: c && c.issuer ? (c.issuer.CN || c.issuer.O || '') : '', validade: c ? c.valid_to : '' };
    }));
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

  let agent, cad;
  try {
    cad = await cadeia(String(b.pfx), b.senha || '');
    // TLS 1.2 com a cadeia completa (certificado + ACs intermediárias)
    agent = new https.Agent({ key: cad.key, cert: cad.cert, keepAlive: false, minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2' });
  } catch (e) {
    const senha = /mac|password|decrypt|Invalid password/i.test(String(e.message));
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
    res.status(200).json({ etapa: 'token', ok: false, status: t.status, texto: curto(t.texto) || '(sem corpo)', tls: { ...(t.tls || {}), cadeia: cad.info.cadeia, no_pfx: cad.info.no_pfx, no_pfx_nomes: cad.info.no_pfx_nomes, baixadas: cad.info.baixadas, serie: cad.info.serie, sha1: cad.info.sha1 } });
    return;
  }
  if (b.so_token) { res.status(200).json({ etapa: 'token', ok: true, via: TOKEN[amb] }); return; }

  // saldo do dia (tipoOperacao 2 = conta corrente + Invest Fácil)
  let saldo = null;
  if (b.saldo) {
    const qs = new URLSearchParams({ agencia: String(b.agencia || ''), conta: String(b.conta || ''), tipoOperacao: '2' });
    const urlS = BASE[amb] + '/v1/fornecimento-saldos-contas/saldos?' + qs.toString();
    let sr = await pedir(agent, urlS, { headers: { Authorization: 'Bearer ' + tj.access_token, Accept: 'application/json' } });
    if (sr.status === 401 || sr.status === 403) sr = await pedir(agent, urlS, { headers: { Authorization: tj.access_token, Accept: 'application/json' } });
    saldo = { status: sr.status, json: sr.status === 200 ? json(sr.texto) : null, texto: sr.status === 200 ? '' : curto(sr.texto, 300) };
    if (b.so_saldo) { res.status(200).json({ etapa: 'saldo', ok: sr.status === 200, saldo }); return; }
  }

  // 2) extrato
  const q = new URLSearchParams({ agencia: String(b.agencia || ''), conta: String(b.conta || ''), tipo: 'cc', dataInicio: String(b.dataInicio || ''), dataFim: String(b.dataFim || '') });
  const url = BASE[amb] + '/v1/fornecimento-extratos-contas/extratos?' + q.toString();
  let e = await pedir(agent, url, { headers: { Authorization: 'Bearer ' + tj.access_token, Accept: 'application/json' } });
  if (e.status === 401 || e.status === 403) e = await pedir(agent, url, { headers: { Authorization: tj.access_token, Accept: 'application/json' } });
  const ej = json(e.texto);
  res.status(200).json({ etapa: 'extrato', ok: e.status === 200 && !!ej, via: TOKEN[amb], status: e.status, json: e.status === 200 ? ej : null, texto: e.status === 200 ? '' : curto(e.texto, 400) || '(sem corpo)', saldo });
};
