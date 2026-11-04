// Serena Financeiro — API única (login usuário+PIN, extrato, credenciais dos bancos, usuários)
// Publicada sem verificação de JWT: a autenticação é feita aqui, por token de sessão (x-fin-token).
import { createClient } from "npm:@supabase/supabase-js@2";
import { candidatos, ehRecebimentoDeCliente, pagador, JANELA, type Pedido } from "./conc.ts";
import { baixarArquivo, lerArquivo } from "./stone_vendas.ts";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-fin-token, authorization, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const out = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
class Erro extends Error { constructor(m: string, public s = 400) { super(m); } }
const must = (c: unknown, m: string, s = 403) => { if (!c) throw new Erro(m, s); };
const q = async <T>(p: PromiseLike<{ data: T; error: { message: string } | null }>) => { const { data, error } = await p; if (error) throw new Erro(error.message, 500); return data; };
const txt = (v: unknown, max = 200) => String(v ?? "").trim().slice(0, max);

type Me = { login: string; nome: string; role: string };
const BANCOS = ["bradesco", "stone", "stone_vendas"] as const;
// segredos aceitos por banco (nunca voltam para a tela)
const SEGREDOS: Record<string, string[]> = {
  bradesco: ["client_secret", "cert", "cert_senha"],
  stone: ["chave_privada"],
  stone_vendas: ["chave"],
};
// o que precisa estar preenchido para considerar o banco configurado
const OBRIG: Record<string, { campos: string[]; segredos: string[] }> = {
  bradesco: { campos: ["client_id", "agencia", "conta"], segredos: ["client_secret", "cert"] },
  stone: { campos: ["client_id"], segredos: ["chave_privada"] },
  stone_vendas: { campos: ["conta"], segredos: ["chave"] },
};

async function quem(req: Request): Promise<Me | null> {
  const t = req.headers.get("x-fin-token");
  if (!t) return null;
  const s = await q(db.from("fin_sessions").select("login,expira").eq("token", t).maybeSingle());
  if (!s || new Date(s.expira) < new Date()) return null;
  const u = await q(db.from("fin_users").select("login,nome,role,ativo").eq("login", s.login).maybeSingle());
  return u && u.ativo ? { login: u.login, nome: u.nome, role: u.role } : null;
}
const log = (login: string, msg: string) => db.from("fin_log").insert({ login, msg: msg.slice(0, 300) });

function resumoCred(c: any) {
  const tem = Object.keys(c.secrets || {});
  const o = OBRIG[c.banco];
  const completo = o.campos.every((k) => c[k]) && o.segredos.every((k) => tem.includes(k));
  return {
    banco: c.banco, ambiente: c.ambiente, client_id: c.client_id || "", agencia: c.agencia || "", conta: c.conta || "", cert_nome: c.cert_nome || "",
    chave_publica: c.chave_publica || "", segredos: tem, completo, atualizado: c.atualizado, atualizado_por: c.atualizado_por,
    teste_em: c.teste_em, teste_ok: c.teste_ok, teste_msg: c.teste_msg,
  };
}
const credenciais = async () => (await q(db.from("fin_credenciais").select("*").order("banco"))).map(resumoCred);


// ---------- Bradesco: API de Saldo e Extrato (manual v2.2.2) ----------
// O Bradesco exige o certificado da empresa na própria conexão (mTLS). Essa parte roda numa função
// da Vercel (/api/bradesco), que esta API chama com uma chave interna guardada no Vault.
const PROXY = "https://serena-financeiro.vercel.app/api/bradesco";
const curto = (s: string, n = 220) => String(s || "").replace(/\s+/g, " ").slice(0, n);
const ddmmaaaa = (d: Date) => `${String(d.getUTCDate()).padStart(2, "0")}${String(d.getUTCMonth() + 1).padStart(2, "0")}${d.getUTCFullYear()}`;
async function bradesco(cr: Awaited<ReturnType<typeof bradCred>>, ini: Date, fim: Date, extra: Record<string, unknown> = {}) {
  const key = await q(db.rpc("fin_proxy_key"));
  must(key, "Chave interna da ponte com o Bradesco não configurada.", 500);
  let r: Response;
  try {
    r = await fetch(PROXY, {
      method: "POST", headers: { "Content-Type": "application/json", "x-fin-proxy": key as string }, signal: AbortSignal.timeout(55000),
      body: JSON.stringify({ amb: cr.amb, client_id: cr.id, client_secret: cr.secret, pfx: cr.pfx, senha: cr.senha, agencia: cr.agencia, conta: cr.conta, dataInicio: ddmmaaaa(ini), dataFim: ddmmaaaa(fim), ...extra }),
    });
  } catch (e) { return { etapa: "ponte", ok: false, texto: "Sem resposta da ponte na Vercel: " + curto(String((e as Error)?.message || e)) } as any; }
  const j = await r.json().catch(() => null);
  if (!r.ok || !j) return { etapa: "ponte", ok: false, texto: `A ponte na Vercel respondeu HTTP ${r.status}${j?.erro ? ": " + j.erro : ""}` } as any;
  return j as { etapa: string; ok: boolean; status?: number; texto?: string; via?: string; json?: any; saldo?: any };
}
function explica(x: any) {
  if (x.etapa === "certificado") return x.texto;
  if (x.etapa === "token") {
    const c = x.tls;
    const cad = c?.cadeia?.length ? `; cadeia enviada: ${c.cadeia.join(" → ")} (no arquivo .pfx: ${(c.no_pfx_nomes || []).join(", ") || c.no_pfx}${c.baixadas?.length ? `; baixadas: ${c.baixadas.join(", ")}` : ""}); impressão digital SHA-1 ${c.sha1 || "?"}` : "";
    const diag = c ? ` [conexão ${c.versao || "?"}; certificado ${c.enviado ? `enviado: ${c.titular} (emissor ${c.emissor}, válido até ${c.validade})` : "NÃO enviado"}${cad}]` : "";
    return `O Bradesco não liberou o acesso (token): HTTP ${x.status} ${x.texto}${diag}`;
  }
  if (x.etapa === "extrato") return `Acesso liberado, mas a consulta do extrato voltou HTTP ${x.status}: ${x.texto}`;
  return x.texto || "Falha desconhecida.";
}
const num = (v: unknown) => { const s = String(v ?? "").trim(); if (!s) return 0; return Number(s.replace(/\./g, "").replace(",", ".")) || 0; };
const dataISO = (s: string) => { const m = String(s || "").match(/(\d{2})\/(\d{2})\/(\d{4})/); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };
function categoria(desc: string, valor: number) {
  const d = desc.toUpperCase();
  if (/TARIFA|TAR\.|CESTA|PACOTE/.test(d)) return "Tarifas bancárias";
  if (/PIX/.test(d)) return valor > 0 ? "PIX recebido" : "PIX enviado";
  if (/TED|DOC|TRANSF/.test(d)) return valor > 0 ? "Transferência recebida" : "Transferência enviada";
  if (/BOLETO|COBRANCA|LIQUIDACAO|TITULO/.test(d)) return valor > 0 ? "Boletos recebidos" : "Boletos pagos";
  if (/DARF|DAS|GPS|IMPOSTO|TRIBUTO|SIMPLES/.test(d)) return "Impostos";
  if (/FOLHA|SALARIO|PAGTO FUNC/.test(d)) return "Pessoal";
  if (/INVEST|RESG|APLIC|RENTAB|CDB/.test(d)) return "Investimentos";
  return valor > 0 ? "Outras entradas" : "Outras saídas";
}
// Saldo do dia (API de Saldos): junta as linhas de produto de todos os blocos (saldoCC, saldoAplicacaoCC...)
function saldoItens(j: any) {
  const itens: { secao: string; nome: string; codigo: number; valor: number }[] = [];
  const andar = (x: any, secao: string) => {
    if (Array.isArray(x)) { x.forEach((y) => andar(y, secao)); return; }
    if (!x || typeof x !== "object") return;
    if ("nomeProduto" in x) {
      const nome = String(x.nomeProduto || "").trim();
      if (nome && String(x.valorLancamento ?? "").trim() !== "" && !/LINHA EM BRANCO/i.test(nome))
        itens.push({ secao, nome, codigo: Number(x.codigoProduto), valor: num(x.valorLancamento) * (String(x.sinalSaldo).trim() === "-" ? -1 : 1) });
      return;
    }
    for (const [k, v] of Object.entries(x)) andar(v, /^saldo/i.test(k) ? k : secao);
  };
  andar(j, "");
  const doCC = itens.filter((i) => i.secao === "saldoCC");
  const total = (doCC.find((i) => i.codigo === 984) || doCC.find((i) => i.codigo === 995) || itens.find((i) => i.codigo === 984 || i.codigo === 995))?.valor ?? null;
  return { itens, total };
}
// Junta os lançamentos do extrato por período (dias já fechados) com os últimos lançamentos e os
// lançamentos do dia (dias recentes e hoje). Saldo anterior e lançamentos futuros ficam de fora.
// Um lançamento que aparece nos dois blocos entra uma vez só.
function lancamentos(j: any, conta: string) {
  const blocos: any[][] = [];
  const per = j?.extratoPorPeriodo?.lstLancamentoMensal;
  if (Array.isArray(per)) blocos.push(per.filter((l: any) => ![1, 4, 5].includes(Number(l.tipoLancamento))));
  const ult = j?.extratoUltimosLancamentos?.listaLancamentos;
  if (ult && typeof ult === "object") for (const [k, lista] of Object.entries(ult)) {
    if (/saldo anterior|futuro/i.test(k) || !Array.isArray(lista)) continue;
    blocos.push(lista as any[]);
  }
  const porChave = new Map<string, any[]>();
  for (const bloco of blocos) {
    const doBloco = new Map<string, any[]>();
    for (const l of bloco) {
      const data = dataISO(l.dataLancamento); if (!data) continue;
      const v = num(l.valorLancamento) * (String(l.sinalLancamento).trim() === "-" ? -1 : 1);
      if (!v) continue;
      const saldo = l.valorSaldoAposLancamento ? num(l.valorSaldoAposLancamento) * (String(l.sinalSaldo).trim() === "-" ? -1 : 1) : null;
      const desc = [String(l.descritivoLancamentoCompleto || l.descritivoLancamentoAbreviado || "").trim(), String(l.segundaLinhalLancamento || "").trim()].filter(Boolean).join(" · ");
      const base = `brd-${conta}-${data}-${String(l.numeroDocumento || "").trim()}-${String(l.codigoLancamento || "").trim()}-${Math.round(v * 100)}`;
      const lista = doBloco.get(base) || []; 
      lista.push({ banco: "bradesco", conta, data, descricao: desc, categoria: categoria(desc, v), tipo: v > 0 ? "Entrada" : "Saída",
        valor: Math.round(v * 100) / 100, saldo, documento: String(l.numeroDocumento || "").trim() || null, raw: l });
      doBloco.set(base, lista);
    }
    // mesmo lançamento nos dois blocos: fica a lista maior (cobre lançamentos iguais no mesmo dia)
    for (const [base, lista] of doBloco) if ((porChave.get(base) || []).length < lista.length) porChave.set(base, lista);
  }
  const rows: any[] = [];
  for (const [base, lista] of porChave) lista.forEach((r, i) => rows.push({ id: `${base}-${i + 1}`, ...r }));
  // ordem dentro do dia na sequência em que o banco mandou (o saldo após cada lançamento segue essa ordem)
  const porDia = new Map<string, number>();
  for (const r of rows) { const n = (porDia.get(r.data) || 0) + 1; porDia.set(r.data, n); r.ordem = n; }
  return rows;
}
async function bradCred() {
  const c = await q(db.from("fin_credenciais").select("*").eq("banco", "bradesco").single());
  const sec = (n: string) => q(db.rpc("fin_secret_get", { p_banco: "bradesco", p_nome: n }));
  const [secret, pfx, senha] = await Promise.all([sec("client_secret"), sec("cert"), sec("cert_senha")]);
  must(c.client_id && secret && pfx && c.agencia && c.conta, "Preencha Client ID, Client Secret, certificado, agência e conta do Bradesco antes.", 400);
  return { amb: c.ambiente as "producao" | "sandbox", id: c.client_id as string, secret: secret as string, pfx: pfx as string, senha: (senha as string) || "", agencia: c.agencia as string, conta: c.conta as string };
}


// ---------- Stone: Stone Banking API (docs.openbank.stone.com.br) ----------
// Sem certificado na conexão: a autenticação é um JWT assinado (RS256) com a chave privada do par
// cuja chave pública foi cadastrada na Stone. Tudo roda aqui mesmo, sem a ponte da Vercel.
const STONE: Record<string, { auth: string; api: string }> = {
  producao: { auth: "https://accounts.openbank.stone.com.br/auth/realms/stone_bank", api: "https://api.openbank.stone.com.br" },
  sandbox: { auth: "https://sandbox-accounts.openbank.stone.com.br/auth/realms/stone_bank", api: "https://sandbox-api.openbank.stone.com.br" },
};
const UA = "SerenaFinanceiro/1.0";
const bytesB64 = (u: Uint8Array) => { let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
const b64u = (x: ArrayBuffer | string) => bytesB64(typeof x === "string" ? new TextEncoder().encode(x) : new Uint8Array(x)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const pemDe = (tipo: string, der: ArrayBuffer) => `-----BEGIN ${tipo}-----\n${bytesB64(new Uint8Array(der)).match(/.{1,64}/g)!.join("\n")}\n-----END ${tipo}-----\n`;
const derLen = (n: number) => { if (n < 128) return [n]; const b: number[] = []; while (n) { b.unshift(n & 255); n >>= 8; } return [0x80 | b.length, ...b]; };
const der = (tag: number, body: number[]) => [tag, ...derLen(body.length), ...body];
const RSA = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
// Aceita a chave privada em PKCS#8 ("BEGIN PRIVATE KEY") ou PKCS#1 ("BEGIN RSA PRIVATE KEY", a do openssl antigo).
// Devolve a chave normalizada em PKCS#8 e a chave pública correspondente (para conferir com a cadastrada na Stone).
async function lerChave(texto: string) {
  const t = String(texto || "");
  if (/ENCRYPTED/.test(t)) throw new Erro("Essa chave privada está protegida por senha. Gere a chave sem senha (openssl genrsa -out chave.pem 4096).", 400);
  const m = t.match(/-----BEGIN (RSA )?PRIVATE KEY-----([\s\S]+?)-----END (RSA )?PRIVATE KEY-----/);
  if (!m) throw new Erro("Arquivo de chave privada inválido: esperado um .pem com BEGIN PRIVATE KEY (a chave pública .pub não serve aqui).", 400);
  let bin: Uint8Array;
  try { bin = Uint8Array.from(atob(m[2].replace(/\s+/g, "")), (c) => c.charCodeAt(0)); } catch { throw new Erro("Chave privada corrompida.", 400); }
  if (m[1]) bin = new Uint8Array(der(0x30, [0x02, 0x01, 0x00, 0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00, ...der(0x04, [...bin])]));
  let k: CryptoKey;
  try { k = await crypto.subtle.importKey("pkcs8", bin, RSA, true, ["sign"]); } catch { throw new Erro("Não consegui ler a chave privada (precisa ser RSA).", 400); }
  const jwk = await crypto.subtle.exportKey("jwk", k);
  const bits = Math.round((jwk.n!.length * 6) / 8) * 8;
  if (bits < 2000) throw new Erro("A chave é curta demais; a Stone pede RSA 4096.", 400);
  const pub = await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, RSA, true, ["verify"]);
  return { privada: pemDe("PRIVATE KEY", await crypto.subtle.exportKey("pkcs8", k)), publica: pemDe("PUBLIC KEY", await crypto.subtle.exportKey("spki", pub)), bits };
}
async function gerarChave() {
  const kp = await crypto.subtle.generateKey({ ...RSA, modulusLength: 4096, publicExponent: new Uint8Array([1, 0, 1]) }, true, ["sign", "verify"]) as CryptoKeyPair;
  return { privada: pemDe("PRIVATE KEY", await crypto.subtle.exportKey("pkcs8", kp.privateKey)), publica: pemDe("PUBLIC KEY", await crypto.subtle.exportKey("spki", kp.publicKey)) };
}
async function stoneCred() {
  const c = await q(db.from("fin_credenciais").select("*").eq("banco", "stone").single());
  const chave = await q(db.rpc("fin_secret_get", { p_banco: "stone", p_nome: "chave_privada" }));
  must(c.client_id && chave, "Preencha o Client ID e a chave privada da Stone antes.", 400);
  return { amb: (c.ambiente === "sandbox" ? "sandbox" : "producao") as string, id: c.client_id as string, chave: chave as string, conta: (c.conta as string) || "" };
}
async function stoneToken(cr: Awaited<ReturnType<typeof stoneCred>>) {
  const base = STONE[cr.amb], agora = Math.floor(Date.now() / 1000);
  const cab = b64u(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const corpo = b64u(JSON.stringify({ exp: agora + 600, nbf: agora - 30, aud: base.auth, realm: "stone_bank", sub: cr.id, clientId: cr.id, jti: crypto.randomUUID(), iat: agora - 30, iss: cr.id }));
  const pk = (await lerChave(cr.chave)).privada.replace(/-----[^-]+-----|\s/g, "");
  const k = await crypto.subtle.importKey("pkcs8", Uint8Array.from(atob(pk), (c) => c.charCodeAt(0)), RSA, false, ["sign"]);
  const sig = await crypto.subtle.sign(RSA.name, k, new TextEncoder().encode(`${cab}.${corpo}`));
  let r: Response;
  try {
    r = await fetch(`${base.auth}/protocol/openid-connect/token`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA }, signal: AbortSignal.timeout(20000),
      body: new URLSearchParams({ client_id: cr.id, grant_type: "client_credentials", client_assertion: `${cab}.${corpo}.${b64u(sig)}`, client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer" }),
    });
  } catch (e) { throw new Erro("Sem resposta da Stone (token): " + curto(String((e as Error)?.message || e)), 502); }
  const t = await r.text(); let j: any = null; try { j = JSON.parse(t); } catch { /* texto */ }
  if (!r.ok || !j?.access_token) {
    const det = curto(j?.error_description || j?.error || t);
    const dica = /invalid_client|unauthorized_client|signature|not found/i.test(det) ? " Confira se o Client ID é o que a Stone enviou e se a chave pública cadastrada lá é o par desta chave privada." : "";
    throw new Erro(`A Stone não liberou o acesso (token): HTTP ${r.status} ${det}.${dica}`, 502);
  }
  return j.access_token as string;
}
async function stoneGet(cr: { amb: string }, tok: string, path: string) {
  let r: Response;
  try { r = await fetch(STONE[cr.amb].api + path, { headers: { Authorization: `Bearer ${tok}`, "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(25000) }); }
  catch (e) { throw new Erro("Sem resposta da Stone: " + curto(String((e as Error)?.message || e)), 502); }
  const t = await r.text(); let j: any = null; try { j = JSON.parse(t); } catch { /* texto */ }
  if (!r.ok) throw new Erro(`Acesso liberado, mas a Stone respondeu HTTP ${r.status} em ${path.split("?")[0].replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, "{conta}")}: ${curto(j?.message || j?.error || j?.type || t)}`, 502);
  return j;
}
// Conta: usa a informada; se estiver em branco, descobre pela lista de contas liberadas para a aplicação e guarda.
async function stoneConta(cr: Awaited<ReturnType<typeof stoneCred>>, tok: string) {
  let lista: any[] = [];
  try { lista = (await stoneGet(cr, tok, "/api/v1/accounts?paginate=false"))?.data || []; } catch (e) { if (!cr.conta) throw e; }
  let conta = cr.conta ? lista.find((a) => a.id === cr.conta) : lista[0];
  if (cr.conta && !conta && lista.length) throw new Erro(`O ID da conta informado não está entre as contas liberadas para esta aplicação (${lista.map((a) => `${a.account_code} → ${a.id}`).join("; ")}).`, 400);
  if (!cr.conta) {
    must(conta, "A Stone não devolveu nenhuma conta para esta aplicação.", 502);
    await q(db.from("fin_credenciais").update({ conta: conta.id }).eq("banco", "stone"));
  }
  return { id: (conta?.id || cr.conta) as string, info: conta ? `conta ${conta.account_code}${conta.owner_name ? ` de ${String(conta.owner_name).trim()}` : ""}` : "conta informada", outras: Math.max(0, lista.length - 1) };
}
const isoZ = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
async function stoneExtrato(cr: { amb: string }, tok: string, conta: string, desdeISO: string) {
  const out: any[] = []; let after = "";
  for (let p = 0; p < 300; p++) {
    const qs = new URLSearchParams({ limit: "100", start_datetime: `${desdeISO}T03:00:00Z`, end_datetime: isoZ(new Date(Date.now() + 60e3)) });
    if (after) qs.set("after", after);
    const j = await stoneGet(cr, tok, `/api/v1/accounts/${conta}/statement?${qs}`);
    const d = Array.isArray(j?.data) ? j.data : [];
    out.push(...d);
    const prox = j?.cursor?.after;
    if (!d.length || !prox || prox === after) break;
    after = prox;
  }
  return out;
}
const STONE_TIPO: Record<string, [string, string]> = {
  instant_payment: ["PIX RECEBIDO", "PIX ENVIADO"], pix_payment: ["PIX RECEBIDO", "PIX ENVIADO"],
  instant_payment_refund: ["PIX DEVOLVIDO A VOCE", "PIX DEVOLVIDO"], external: ["TED RECEBIDA", "TED ENVIADA"],
  external_refund: ["TED DEVOLVIDA", "TED DEVOLVIDA"], internal: ["TRANSFERENCIA STONE RECEBIDA", "TRANSFERENCIA STONE ENVIADA"],
  payment: ["BOLETO ESTORNADO", "PAGTO BOLETO"], payment_refund: ["BOLETO ESTORNADO", "BOLETO ESTORNADO"],
  card_payment: ["CARTAO ESTORNO", "COMPRA CARTAO"], balance_block: ["DESBLOQUEIO DE SALDO", "BLOQUEIO DE SALDO"],
  salary: ["SALARIO", "SALARIO"], salary_portability: ["PORTABILIDADE SALARIO", "PORTABILIDADE SALARIO"],
};
function stoneRows(ents: any[], conta: string) {
  const vistos = new Map<string, number>();
  const rows = ents
    .filter((e) => e && e.created_at && !/fail|cancel|reject|refused|denied/i.test(String(e.status || "")))
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
    .map((e) => {
      const deb = e.operation === "debit";
      const antes = Number(e.balance_before), depois = Number(e.balance_after);
      const cent = Number.isFinite(antes) && Number.isFinite(depois) && antes !== depois ? depois - antes : (deb ? -1 : 1) * (Number(e.amount) || 0) - (deb ? Number(e.fee_amount) || 0 : 0);
      const v = Math.round(cent) / 100;
      const rot = STONE_TIPO[e.type]?.[deb ? 1 : 0] || String(e.type || "movimentacao").replace(/_/g, " ").toUpperCase();
      const nome = String(e.counter_party?.entity?.name || e.details?.recipient_name || "").trim();
      const desc = [rot, nome ? (deb ? "DES: " : "REM: ") + nome : "", String(e.description || "").trim()].filter(Boolean).join(" · ");
      const data = new Date(new Date(e.created_at).getTime() - 3 * 3600e3).toISOString().slice(0, 10);
      const base = `stn-${e.id}-${e.type}-${e.operation}`;
      const n = (vistos.get(base) || 0) + 1; vistos.set(base, n);
      return { id: n > 1 ? `${base}-${n}` : base, banco: "stone", conta, data, descricao: desc, categoria: categoria(desc, v), tipo: v > 0 ? "Entrada" : "Saída",
        valor: v, saldo: Number.isFinite(depois) ? depois / 100 : null, documento: null, raw: e };
    })
    .filter((r) => r.valor);
  const porDia = new Map<string, number>();
  for (const r of rows) { const n = (porDia.get(r.data) || 0) + 1; porDia.set(r.data, n); (r as any).ordem = n; }
  return rows;
}
function stoneSaldo(j: any) {
  const v = (x: unknown) => (Number(x) || 0) / 100;
  const itens = [
    { secao: "stone", nome: "Saldo disponível", codigo: 1, valor: v(j?.balance) },
    { secao: "stone", nome: "Saldo bloqueado", codigo: 2, valor: v(j?.blocked_balance) },
    { secao: "stone", nome: "Agendado", codigo: 3, valor: v(j?.scheduled_balance) },
  ];
  return { itens, total: itens[0].valor, raw: j };
}

// "agora" no fuso de Brasília (o banco trabalha com datas locais; depois das 21h o UTC já é o dia seguinte)
const agoraBR = () => new Date(Date.now() - 3 * 3600e3);
const brl = (v: number) => (v < 0 ? "-" : "+") + "R$ " + Math.abs(v).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Grava o saldo: se não mudou desde a última consulta, só atualiza o horário (não acumula linhas iguais)
type Saldo = { itens: { secao: string; nome: string; codigo: number; valor: number }[]; total: number | null; raw: unknown };
async function gravaSaldo(banco: string, conta: string, sd: Saldo) {
  const ult = (await q(db.from("fin_saldos").select("id,total,itens").eq("banco", banco).order("em", { ascending: false }).limit(1)))[0];
  if (ult && Number(ult.total) === Number(sd.total) && JSON.stringify(ult.itens) === JSON.stringify(sd.itens))
    await q(db.from("fin_saldos").update({ em: new Date().toISOString() }).eq("id", ult.id));
  else await q(db.from("fin_saldos").insert({ banco, conta, total: sd.total, itens: sd.itens, raw: sd.raw }));
  return sd;
}
const NOME: Record<string, string> = { bradesco: "Bradesco", stone: "Stone", stone_vendas: "Stone (cartão)" };
const NO: Record<string, string> = { bradesco: "no Bradesco", stone: "na Stone", stone_vendas: "no cartão (Stone)" };
// Busca extrato + saldo de um banco, de `dias` atrás até agora (datas de Brasília)
async function buscaBanco(banco: string, dias: number): Promise<{ conta: string; rows: any[]; saldo: Saldo | null; saldo_erro?: string | null; info?: string }> {
  const fim = agoraBR(), ini = new Date(fim.getTime() - dias * 864e5);
  if (banco === "bradesco") {
    const cr = await bradCred();
    const x = await bradesco(cr, ini, fim, { saldo: true });
    if (!x.ok) throw new Erro(explica(x), 502);
    return { conta: cr.conta, rows: lancamentos(x.json, cr.conta), saldo: x.saldo?.json ? { ...saldoItens(x.saldo.json), raw: x.saldo.json } : null,
      saldo_erro: x.saldo && !x.saldo.json ? `HTTP ${x.saldo.status}: ${x.saldo.texto}` : null };
  }
  must(banco === "stone", "Banco inválido.", 400);
  const cr = await stoneCred();
  const tok = await stoneToken(cr);
  const ct = await stoneConta(cr, tok);
  const [ents, bal] = await Promise.all([stoneExtrato(cr, tok, ct.id, ini.toISOString().slice(0, 10)), stoneGet(cr, tok, `/api/v1/accounts/${ct.id}/balance`)]);
  return { conta: ct.id, rows: stoneRows(ents, ct.id), saldo: stoneSaldo(bal), info: ct.info + (ct.outras ? ` (há mais ${ct.outras} conta(s) liberada(s); para usar outra, informe o ID dela)` : "") };
}


// ---------- Stone: vendas no cartão (API de Conciliação, arquivo diário) ----------
async function stoneVendasCred() {
  const c = await q(db.from("fin_credenciais").select("conta").eq("banco", "stone_vendas").single());
  const chave = await q(db.rpc("fin_secret_get", { p_banco: "stone_vendas", p_nome: "chave" }));
  must(c.conta && chave, "Preencha o StoneCode e a chave da API de Conciliação da Stone antes.", 400);
  return { codes: String(c.conta).split(",").map((x) => x.trim()).filter(Boolean), chave: chave as string };
}
// O arquivo do dia D fica pronto depois das 5h de D+1 (horário de Brasília); usamos 6h por folga
function ultimoDiaPronto() {
  const a = agoraBR(), hoje = a.toISOString().slice(0, 10);
  return somaDias(hoje, a.getUTCHours() >= 6 ? -1 : -2);
}
// Baixa e grava um dia de um StoneCode. Vendas entram em fin_lancamentos (banco stone_vendas); cancelamentos
// de vendas de outros dias atualizam a venda original (uma vez por arquivo). Nada é apagado.
async function processaDiaStone(sc: string, chave: string, dia: string) {
  const a = await baixarArquivo(sc, chave, dia);
  if (!a.ok) {
    await q(db.from("fin_stone_arquivos").upsert({ stonecode: sc, data: dia, ok: false, erro: a.erro, baixado_em: new Date().toISOString() }));
    return { ok: false as const, status: a.status, erro: a.erro || "Falha ao baixar o arquivo." };
  }
  let r: ReturnType<typeof lerArquivo>;
  try { r = lerArquivo(a.xml!, sc); }
  catch (e) {
    const erro = (e as Error).message;
    await q(db.from("fin_stone_arquivos").upsert({ stonecode: sc, data: dia, ok: false, erro, baixado_em: new Date().toISOString() }));
    return { ok: false as const, status: 200, erro };
  }
  const vendas = [...r.vendas].sort((x, y) => (x.data + x.hora).localeCompare(y.data + y.hora));
  const ids = vendas.map((v) => v.id);
  const ja = ids.length ? await emLotes(ids, (l) => q(db.from("fin_lancamentos").select("id,valor,categoria,descricao,raw").in("id", l))) : [];
  const exist = new Map(ja.map((x: any) => [x.id, x]));
  const porDia = new Map<string, number>();
  const rows = vendas.map(({ hora: _h, ...v }) => {
    const o = (porDia.get(v.data) || 0) + 1; porDia.set(v.data, o);
    const e: any = exist.get(v.id);
    // venda já cancelada (parcial ou total) por arquivo de outro dia: mantém o valor atualizado
    if (e?.raw?.canc_aplicados?.length) return { ...v, ordem: o, valor: Number(e.valor), categoria: e.categoria, descricao: e.descricao, raw: { ...v.raw, canc_aplicados: e.raw.canc_aplicados } };
    return { ...v, ordem: o };
  });
  for (let i = 0; i < rows.length; i += 500) await q(db.from("fin_lancamentos").upsert(rows.slice(i, i + 500)));
  for (const c of r.cancelamentos) {
    const v: any = (await q(db.from("fin_lancamentos").select("id,valor,categoria,descricao,raw").eq("id", c.id).maybeSingle()));
    if (!v) continue;
    const aplicados: string[] = v.raw?.canc_aplicados || [];
    if (aplicados.includes(dia)) continue;
    const novo = r2(Number(v.valor) - c.valor);
    const cancelada = novo <= 0.005;
    await q(db.from("fin_lancamentos").update({
      valor: cancelada ? Number(v.valor) : novo, categoria: cancelada ? "Cartão cancelado" : v.categoria,
      descricao: `${v.descricao} · ${cancelada ? "CANCELADA" : "cancelado R$ " + c.valor.toFixed(2).replace(".", ",")} em ${dia.split("-").reverse().slice(0, 2).join("/")}`,
      raw: { ...(v.raw || {}), canc_aplicados: [...aplicados, dia] },
    }).eq("id", c.id));
  }
  await q(db.from("fin_stone_arquivos").upsert({ stonecode: sc, data: dia, ok: true, vendas: r.qtd, total: r.total, erro: null, baixado_em: new Date().toISOString() }));
  const novas = rows.filter((x) => !exist.has(x.id) && x.categoria === "Vendas no cartão");
  return { ok: true as const, qtd: r.qtd, total: r.total, novas };
}
// Baixa os dias que faltam (do mais recente para o mais antigo), no máximo `limite` arquivos por chamada
async function sincStoneVendas(dias: number, limite: number, auto = false) {
  const cr = await stoneVendasCred();
  const fim = ultimoDiaPronto(), ini = somaDias(fim, -(dias - 1));
  const feitos = await q(db.from("fin_stone_arquivos").select("stonecode,data,ok,baixado_em").in("stonecode", cr.codes).gte("data", ini).lte("data", fim));
  const est = new Map(feitos.map((f: any) => [`${f.stonecode}|${f.data}`, f]));
  const fila: [string, string][] = [];
  for (let d = fim; d >= ini; d = somaDias(d, -1)) for (const sc of cr.codes) {
    const f: any = est.get(`${sc}|${d}`);
    if (f?.ok) continue;
    // na rotina automática, um dia que deu erro só é tentado de novo depois de 3 horas
    if (auto && f && Date.now() - new Date(f.baixado_em).getTime() < 3 * 3600e3) continue;
    fila.push([sc, d]);
  }
  let processados = 0, erro: string | null = null, vendas = 0, total = 0;
  const novas: any[] = [];
  for (const [sc, d] of fila.slice(0, limite)) {
    const x = await processaDiaStone(sc, cr.chave, d);
    processados++;
    if (!x.ok) { erro = x.erro; if (x.status === 401 || x.status === 403) break; continue; }
    vendas += x.qtd; total = r2(total + x.total); novas.push(...x.novas);
  }
  return { processados, faltam: Math.max(0, fila.length - processados), erro, vendas, total, novas, ate: fim, de: ini };
}
async function rotinaStoneVendas() {
  const x = await sincStoneVendas(4, 8, true);
  if (x.novas.length) {
    const tot = r2(x.novas.reduce((s, v) => s + v.valor, 0));
    const dias = [...new Set(x.novas.map((v) => v.data))].sort().map((d) => d.split("-").reverse().slice(0, 2).join("/"));
    const titulo = x.novas.length === 1 ? "1 venda no cartão (Stone)" : `${x.novas.length} vendas no cartão (Stone)`;
    await q(db.from("fin_notificacoes").insert({ banco: "stone_vendas", titulo, texto: `Total ${brl(tot).replace("+", "")} · ${dias.join(", ")}`,
      dados: { itens: x.novas.slice(0, 50).map((v) => ({ id: v.id, data: v.data, valor: v.valor, descricao: v.descricao })) } }));
    await log("auto", titulo);
  }
  if (x.erro && !x.processados) throw new Erro(x.erro, 502);
  return { arquivos: x.processados, novas: x.novas.length, faltam: x.faltam, erro: x.erro };
}

// Um banco na rotina automática: busca, grava (upsert, nunca apaga) e avisa o que ainda não estava gravado
async function rotinaBanco(banco: string) {
  const x = await buscaBanco(banco, 2);
  const rows = x.rows;
  const sd = x.saldo ? await gravaSaldo(banco, x.conta, x.saldo) : null;

  // o que já estava gravado nesses dias
  const dias = [...new Set(rows.map((r) => r.data))];
  const ja = dias.length ? await q(db.from("fin_lancamentos").select("id,data,valor").eq("banco", banco).in("data", dias)) : [];
  const ids = new Set(ja.map((r: any) => r.id));
  // conferência extra por dia+valor: evita avisar de novo um lançamento que o banco reapresentou com outro número
  const qtd = new Map<string, number>();
  for (const r of ja) { const k = `${r.data}|${Number(r.valor)}`; qtd.set(k, (qtd.get(k) || 0) + 1); }
  // primeiro descontam os que já batem pelo identificador; o que sobrar por dia+valor cobre os reapresentados
  for (const r of rows) if (ids.has(r.id)) { const k = `${r.data}|${r.valor}`; qtd.set(k, Math.max(0, (qtd.get(k) || 0) - 1)); }
  const novos: any[] = [];
  for (const r of rows) {
    if (ids.has(r.id)) continue;
    const k = `${r.data}|${r.valor}`;
    const n = qtd.get(k) || 0;
    if (n > 0) { qtd.set(k, n - 1); continue; }
    novos.push(r);
  }
  const reapresentados = new Set(rows.filter((r) => !ids.has(r.id) && !novos.includes(r)).map((r) => r.id));
  const gravar = rows.filter((r) => !reapresentados.has(r.id));
  for (let i = 0; i < gravar.length; i += 500) await q(db.from("fin_lancamentos").upsert(gravar.slice(i, i + 500)));

  if (novos.length) {
    const ent = novos.filter((r) => r.valor > 0).reduce((s, r) => s + r.valor, 0);
    const sai = novos.filter((r) => r.valor < 0).reduce((s, r) => s + r.valor, 0);
    const titulo = novos.length === 1 ? `1 novo lançamento ${NO[banco]}` : `${novos.length} novos lançamentos ${NO[banco]}`;
    const atual = sd ? (banco === "bradesco" ? (sd.itens.find((i) => i.codigo === 1005)?.valor ?? sd.total) : sd.total) : null;
    const partes = [ent ? `Entradas ${brl(ent)}` : "", sai ? `Saídas ${brl(sai)}` : "", atual != null ? `Saldo ${brl(atual).replace("+", "")}` : ""].filter(Boolean);
    await q(db.from("fin_notificacoes").insert({
      banco, titulo, texto: partes.join(" · "),
      dados: { itens: novos.slice(0, 50).map((r) => ({ id: r.id, data: r.data, valor: r.valor, descricao: r.descricao })) },
    }));
    await log("auto", titulo);
  }
  return { lidos: rows.length, novos: novos.length, saldo: sd?.total ?? null };
}
// Rotina automática (a cada 15 min, pelo pg_cron): para cada banco configurado, saldo + lançamentos dos últimos dias.
// Grava tudo (nada é apagado) e, se aparecer lançamento que ainda não estava no banco, cria uma notificação.
async function rotina() {
  const res: Record<string, unknown> = {};
  for (const c of await credenciais()) {
    if (!c.completo) { res[c.banco] = "não configurado"; continue; }
    try { res[c.banco] = c.banco === "stone_vendas" ? await rotinaStoneVendas() : await rotinaBanco(c.banco); }
    catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      await log("auto", `Atualização automática (${NOME[c.banco]}) falhou: ${m}`);
      res[c.banco] = { erro: m };
    }
  }
  return { ok: true, ...res };
}


// ---------- Conciliação: pré-vendas (Picking) x recebimentos ----------
const isoDia = (v: unknown, padrao: string) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : padrao;
const somaDias = (iso: string, n: number) => new Date(Date.parse(iso + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const r2 = (v: number) => Math.round(v * 100) / 100;
const emLotes = async <T>(ids: string[], f: (lote: string[]) => Promise<T[]>) => { const out: T[] = []; for (let i = 0; i < ids.length; i += 150) out.push(...await f(ids.slice(i, i + 150))); return out; };
const pedidoDe = (r: any): Pedido & Record<string, unknown> => ({ ...r, data: String(r.data), total: Number(r.total) });
// Recebimentos de cliente ainda livres (sem conciliação) entre duas datas
async function recebimentosLivres(de: string, ate: string, extraIds: string[] = []) {
  const rows: any[] = [];
  for (let i = 0; i < 20000; i += 1000) {
    const pg = await q(db.from("fin_lancamentos").select("id,banco,data,descricao,valor,categoria").gt("valor", 0).gte("data", de).lte("data", ate)
      .order("data").order("id").range(i, i + 999));
    rows.push(...pg); if (pg.length < 1000) break;
  }
  const lanc = rows.map((r) => ({ ...r, valor: Number(r.valor), data: String(r.data) })).filter(ehRecebimentoDeCliente);
  const usados = new Set((await emLotes(lanc.map((l) => l.id), (l) => q(db.from("fin_conc_itens").select("ref").eq("tipo", "lancamento").in("ref", l)))).map((x: any) => x.ref));
  return lanc.filter((l) => !usados.has(l.id) || extraIds.includes(l.id));
}
// Conciliações (com os recebimentos e pré-vendas de cada uma) a partir dos ids das conciliações
async function detalhesConc(ids: number[]) {
  if (!ids.length) return new Map<number, any>();
  const concs = await q(db.from("fin_conc").select("id,criado,por,obs,total_pedidos,total_pagos").in("id", ids));
  const itens = await q(db.from("fin_conc_itens").select("tipo,ref,conc_id,valor").in("conc_id", ids));
  const lancIds = itens.filter((i: any) => i.tipo === "lancamento").map((i: any) => i.ref);
  const lancs = lancIds.length ? await emLotes(lancIds, (l) => q(db.from("fin_lancamentos").select("id,banco,data,descricao,valor").in("id", l))) : [];
  const porId = new Map(lancs.map((l: any) => [l.id, l]));
  const m = new Map<number, any>();
  for (const c of concs) {
    const its = itens.filter((i: any) => i.conc_id === c.id);
    m.set(c.id, { ...c, total_pedidos: Number(c.total_pedidos), total_pagos: Number(c.total_pagos), diferenca: r2(Number(c.total_pagos) - Number(c.total_pedidos)),
      pedidos: its.filter((i: any) => i.tipo === "pedido").map((i: any) => i.ref),
      recebimentos: its.filter((i: any) => i.tipo === "lancamento").map((i: any) => { const l: any = porId.get(i.ref) || { id: i.ref, valor: i.valor, descricao: "(lançamento não encontrado)" }; return { ...l, valor: Number(l.valor), pagador: pagador(l.descricao) }; }) });
  }
  return m;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    must(req.method === "POST", "Use POST.", 405);
    const b = await req.json().catch(() => ({}));
    const op = String(b.op || "");

    if (op === "cron") {
      const k = req.headers.get("x-fin-cron") || "";
      const certa = await q(db.rpc("fin_cron_key"));
      must(k && certa && k === certa, "Não autorizado.", 401);
      return out(await rotina());
    }

    if (op === "login") {
      const tok = await q(db.rpc("fin_login", { p_login: txt(b.login, 40), p_pin: txt(b.pin, 20) }));
      if (!tok) throw new Erro("Usuário ou PIN incorreto.", 401);
      const s = await q(db.from("fin_sessions").select("login").eq("token", tok).single());
      const u = await q(db.from("fin_users").select("login,nome,role").eq("login", s.login).single());
      return out({ token: tok, me: u });
    }

    const me = await quem(req);
    if (!me) throw new Erro("Sessão expirada. Entre de novo.", 401);
    const admin = me.role === "admin";

    switch (op) {
      case "logout":
        await db.from("fin_sessions").delete().eq("token", req.headers.get("x-fin-token") || "");
        return out({ ok: true });

      case "me":
        return out({ me });

      case "extrato": {
        const banco = BANCOS.includes(b.banco) ? b.banco : "bradesco";
        const desde = new Date(Date.now() - 400 * 864e5).toISOString().slice(0, 10);
        // o Supabase devolve no máximo 1000 linhas por consulta: busca em páginas
        const rows: any[] = [];
        for (let de = 0; de < 20000; de += 1000) {
          const pg = await q(db.from("fin_lancamentos")
            .select("id,banco,conta,data,descricao,categoria,tipo,valor,saldo,documento")
            .eq("banco", banco).gte("data", desde).order("data", { ascending: true }).order("ordem", { ascending: true, nullsFirst: true }).order("id", { ascending: true }).range(de, de + 999));
          rows.push(...pg);
          if (pg.length < 1000) break;
        }
        const cred = (await credenciais()).find((c) => c.banco === banco);
        const saldo = (await q(db.from("fin_saldos").select("em,total,itens").eq("banco", banco).order("em", { ascending: false }).limit(1)))[0] || null;
        return out({ banco, rows, saldo, configurado: !!cred?.completo, ambiente: cred?.ambiente });
      }

      case "cred_get":
        return out({ bancos: await credenciais(), admin });

      case "cred_save": {
        must(admin, "Só administradores alteram as credenciais.");
        const banco = String(b.banco);
        must(BANCOS.includes(banco as any), "Banco inválido.", 400);
        const upd: Record<string, unknown> = { atualizado: new Date().toISOString(), atualizado_por: me.login, teste_em: null, teste_ok: null, teste_msg: null };
        if (b.ambiente !== undefined) { must(["sandbox", "producao"].includes(b.ambiente), "Ambiente inválido.", 400); upd.ambiente = b.ambiente; }
        if (b.client_id !== undefined) upd.client_id = txt(b.client_id, 300) || null;
        if (b.agencia !== undefined) {
          const a = txt(b.agencia, 10).replace(/\D/g, "");
          must(!a || a.length <= 4, "Agência: até 4 números, sem o dígito.", 400);
          upd.agencia = a || null;
        }
        if (b.conta !== undefined) {
          let c = banco === "bradesco" ? txt(b.conta, 20).replace(/\D/g, "") : txt(b.conta, 60);
          must(banco !== "bradesco" || !c || c.length <= 7, "Conta: até 7 números, sem o dígito.", 400);
          if (banco === "stone_vendas") {
            const codes = [...new Set(txt(b.conta, 200).split(/[,;\s]+/).map((x) => x.replace(/\D/g, "")).filter(Boolean))];
            must(codes.every((x) => x.length >= 6 && x.length <= 15), "StoneCode: só números (de 6 a 15). Mais de um? Separe por vírgula.", 400);
            c = codes.join(",");
          }
          upd.conta = c || null;
        }
        const sec = (b.segredos && typeof b.segredos === "object") ? b.segredos : {};
        const mudou: string[] = [];
        for (const [nome, valor] of Object.entries(sec)) {
          must(SEGREDOS[banco].includes(nome), `Campo secreto desconhecido: ${nome}.`, 400);
          const v = String(valor ?? "");
          if (!v) continue; // vazio = manter o que já está guardado
          must(v.length <= 300000, "Arquivo ou chave grande demais.", 400);
          if (nome === "chave_privada") {
            const k = await lerChave(v);
            await q(db.rpc("fin_secret_put", { p_banco: banco, p_nome: nome, p_valor: k.privada }));
            upd.chave_publica = k.publica;
            mudou.push(nome);
            continue;
          }
          if (nome === "cert") {
            must(/^[A-Za-z0-9+/=\s]+$/.test(v), "Certificado inválido.", 400);
            upd.cert_nome = txt(b.cert_nome, 120) || "certificado";
          }
          await q(db.rpc("fin_secret_put", { p_banco: banco, p_nome: nome, p_valor: v }));
          mudou.push(nome);
        }
        await q(db.from("fin_credenciais").update(upd).eq("banco", banco));
        await log(me.login, `${me.nome} salvou credenciais ${banco}${mudou.length ? " (" + mudou.join(", ") + ")" : ""}`);
        return out({ bancos: await credenciais() });
      }

      case "cred_test": {
        must(admin, "Só administradores testam as credenciais.");
        const banco = String(b.banco);
        must(BANCOS.includes(banco as any), "Banco inválido.", 400);
        const c = (await credenciais()).find((x) => x.banco === banco)!;
        let ok: boolean | null, msg: string;
        if (!c.completo) {
          const o = OBRIG[banco];
          const falta = [...o.campos.filter((k) => !(c as any)[k]), ...o.segredos.filter((k) => !c.segredos.includes(k))];
          ok = false; msg = "Falta preencher: " + falta.map((k) => ({ client_id: "Client ID", agencia: "agência", conta: "conta", client_secret: "Client Secret", cert: "certificado (.pfx)", chave_privada: "chave privada (.pem)", chave: "chave da API de Conciliação" } as any)[k] || k).join(", ") + ".";
        } else if (banco === "stone_vendas") {
          try {
            const cr = await stoneVendasCred();
            const partes: string[] = [];
            ok = true;
            for (const sc of cr.codes) {
              // tenta o último dia pronto e, se não houver arquivo, os anteriores
              let x: any = null, d = ultimoDiaPronto();
              for (let i = 0; i < 3; i++, d = somaDias(d, -1)) { x = await processaDiaStone(sc, cr.chave, d); if (x.ok || x.status === 401 || x.status === 403) break; }
              if (x.ok) partes.push(`StoneCode ${sc}: arquivo de ${d.split("-").reverse().join("/")} com ${x.qtd} venda${x.qtd === 1 ? "" : "s"} no cartão (${brl(x.total).replace("+", "")})`);
              else { ok = false; partes.push(`StoneCode ${sc}: ${x.erro}`); }
            }
            msg = (ok ? "Conexão OK. " : "") + partes.join(" · ") + (ok ? ". Use “Sincronizar vendas” para buscar os dias anteriores." : "");
          } catch (e) { ok = false; msg = e instanceof Error ? e.message : String(e); }
        } else if (banco === "bradesco") {
          const cr = await bradCred();
          const x = await bradesco(cr, new Date(Date.now() - 6 * 864e5), new Date());
          if (x.ok) {
            const n = lancamentos(x.json, cr.conta).length;
            const ret = x.json?.extratoPorPeriodo || x.json?.extratoUltimosLancamentos || {};
            ok = true; msg = `Conexão OK. Extrato dos últimos 7 dias: ${n} lançamentos.${ret.mensagem ? " Banco: " + String(ret.mensagem).trim() : ""}`;
          } else { ok = false; msg = explica(x); }
        } else {
          try {
            const x = await buscaBanco("stone", 6);
            ok = true; msg = `Conexão OK: ${x.info}. Saldo disponível ${brl(x.saldo?.total || 0).replace("+", "")}. Extrato dos últimos 7 dias: ${x.rows.length} lançamentos.`;
          } catch (e) { ok = false; msg = e instanceof Error ? e.message : String(e); }
        }
        await log(me.login, `Teste ${banco}: ${msg}`);
        await q(db.from("fin_credenciais").update({ teste_em: new Date().toISOString(), teste_ok: ok, teste_msg: msg }).eq("banco", banco));
        return out({ bancos: await credenciais() });
      }

      case "cred_clear": {
        must(admin, "Só administradores alteram as credenciais.");
        const banco = String(b.banco);
        must(BANCOS.includes(banco as any), "Banco inválido.", 400);
        const c = await q(db.from("fin_credenciais").select("secrets").eq("banco", banco).single());
        for (const nome of Object.keys(c.secrets || {})) await q(db.rpc("fin_secret_put", { p_banco: banco, p_nome: nome, p_valor: "" }));
        await q(db.from("fin_credenciais").update({ client_id: null, agencia: null, conta: null, cert_nome: null, chave_publica: null, secrets: {}, atualizado: new Date().toISOString(), atualizado_por: me.login, teste_em: null, teste_ok: null, teste_msg: null }).eq("banco", banco));
        await log(me.login, `${me.nome} apagou as credenciais ${banco}`);
        return out({ bancos: await credenciais() });
      }


      case "stone_chave": {
        must(admin, "Só administradores alteram as credenciais.");
        const k = await gerarChave();
        await q(db.rpc("fin_secret_put", { p_banco: "stone", p_nome: "chave_privada", p_valor: k.privada }));
        await q(db.from("fin_credenciais").update({ chave_publica: k.publica, atualizado: new Date().toISOString(), atualizado_por: me.login, teste_em: null, teste_ok: null, teste_msg: null }).eq("banco", "stone"));
        await log(me.login, `${me.nome} gerou um novo par de chaves da Stone`);
        return out({ bancos: await credenciais() });
      }

      case "sync": {
        must(admin, "Só administradores sincronizam o extrato.");
        const banco = BANCOS.includes(b.banco) ? b.banco : "bradesco";
        const dias = Math.min(365, Math.max(1, Number(b.dias) || 90));
        if (banco === "stone_vendas") {
          const x = await sincStoneVendas(dias, 12);
          if (x.erro && !x.vendas && x.processados <= 1) throw new Erro(x.erro, 502);
          const feitos = await q(db.from("fin_stone_arquivos").select("ok,vendas").gte("data", x.de).lte("data", x.ate));
          const okd = feitos.filter((f: any) => f.ok);
          const msg = `Vendas no cartão: ${okd.length} dia(s) baixados de ${x.de.split("-").reverse().join("/")} a ${x.ate.split("-").reverse().join("/")}, ${okd.reduce((s: number, f: any) => s + (f.vendas || 0), 0)} vendas.${x.faltam ? ` Faltam ${x.faltam} dia(s).` : ""}`;
          await q(db.from("fin_credenciais").update({ teste_em: new Date().toISOString(), teste_ok: true, teste_msg: msg + (x.erro ? ` Último erro: ${x.erro}` : "") }).eq("banco", "stone_vendas"));
          if (!x.faltam) await log(me.login, `${me.nome} sincronizou as vendas no cartão Stone (${dias} dias)`);
          return out({ ok: true, n: x.vendas, faltam: x.faltam, processados: x.processados, erro: x.erro });
        }
        const x = await buscaBanco(banco, dias - 1);
        if (x.saldo) await gravaSaldo(banco, x.conta, x.saldo);
        for (let i = 0; i < x.rows.length; i += 500) await q(db.from("fin_lancamentos").upsert(x.rows.slice(i, i + 500)));
        await q(db.from("fin_credenciais").update({ teste_em: new Date().toISOString(), teste_ok: true, teste_msg: `Sincronizado: ${x.rows.length} lançamentos dos últimos ${dias} dias.` }).eq("banco", banco));
        await log(me.login, `${me.nome} sincronizou o extrato ${NOME[banco]}: ${x.rows.length} lançamentos (${dias} dias)`);
        return out({ ok: true, n: x.rows.length, dias, saldo: x.saldo?.total ?? null, saldo_erro: x.saldo_erro || null });
      }

      case "conc_lista": {
        const hoje = agoraBR().toISOString().slice(0, 10);
        const ate = isoDia(b.ate, hoje), de = isoDia(b.de, somaDias(ate, -29));
        const margem = Math.min(1000, Math.max(0, Number(b.margem) || 10));
        const status = ["pendentes", "conciliados", "todos"].includes(b.status) ? b.status : "pendentes";
        const busca = txt(b.busca, 80).toUpperCase(), vend = txt(b.vendedora, 60);
        const por = Math.min(100, Math.max(5, Number(b.por) || 20));
        const todos = (await q(db.rpc("fin_pedidos", { p_de: de, p_ate: ate }))).map(pedidoDe);
        // em que conciliação está cada pré-venda
        const vinc = await emLotes(todos.map((p) => p.id), (l) => q(db.from("fin_conc_itens").select("ref,conc_id").eq("tipo", "pedido").in("ref", l)));
        const concDe = new Map(vinc.map((v: any) => [v.ref, v.conc_id as number]));
        const vendedoras = [...new Set(todos.map((p) => String(p.vendedora || "")).filter(Boolean))].sort();
        // resumo do período (todas as pré-vendas, sem os filtros de status/busca)
        const conc = todos.filter((p) => concDe.has(p.id)), pend = todos.filter((p) => !concDe.has(p.id) && p.total > 0);
        const soma = (a: any[]) => r2(a.reduce((s, p) => s + p.total, 0));
        let lista = todos.filter((p) => status === "todos" || (status === "conciliados" ? concDe.has(p.id) : !concDe.has(p.id)));
        if (vend) lista = lista.filter((p) => p.vendedora === vend);
        if (busca) lista = lista.filter((p) => [p.id, p.num, p.cliente, p.vendedora, p.cidade].some((x) => String(x || "").toUpperCase().includes(busca)) || String(p.total).includes(busca.replace(",", ".")));
        lista.sort((a, z) => z.data.localeCompare(a.data) || String(z.hora || "").localeCompare(String(a.hora || "")) || z.id.localeCompare(a.id));
        const paginas = Math.max(1, Math.ceil(lista.length / por));
        const pagina = Math.min(paginas, Math.max(1, Number(b.pagina) || 1));
        const itens: any[] = lista.slice((pagina - 1) * por, pagina * por).map((p) => ({ ...p, conc_id: concDe.get(p.id) || null }));
        // sugestões só para as pendentes desta página; detalhes das conciliadas
        const pendPag = itens.filter((p) => !p.conc_id);
        const livres = pendPag.length ? await recebimentosLivres(somaDias(pendPag.reduce((m, p) => p.data < m ? p.data : m, "9999"), -JANELA.antes), somaDias(pendPag.reduce((m, p) => p.data > m ? p.data : m, ""), JANELA.depois)) : [];
        for (const p of pendPag) {
          const c = candidatos(p, livres, margem, 50);
          const top = c[0];
          p.sug = { n: c.filter((x) => Math.abs(x.diff) <= margem + 0.001).length, nomes: c.filter((x) => x.nome >= 0.5).length,
            melhor: top ? { id: top.id, valor: top.valor, diff: top.diff, pagador: top.pagador, data: top.data, score: top.score, nivel: top.nivel, motivos: top.motivos } : null };
        }
        const det = await detalhesConc([...new Set(itens.map((p) => p.conc_id).filter(Boolean))] as number[]);
        for (const p of itens) if (p.conc_id) p.conc = det.get(p.conc_id) || null;
        // recebimentos de cliente do período que ainda não foram ligados a nenhuma pré-venda
        const soltos = await recebimentosLivres(de, ate);
        return out({
          de, ate, margem, status, pagina, paginas, total: lista.length, por, vendedoras, itens,
          resumo: { qtd: todos.length, valor: soma(todos), conc_qtd: conc.length, conc_valor: soma(conc), pend_qtd: pend.length, pend_valor: soma(pend),
            receb_soltos_qtd: soltos.length, receb_soltos_valor: r2(soltos.reduce((s, l) => s + l.valor, 0)) },
        });
      }

      case "conc_sugestoes": {
        const id = txt(b.pedido, 40);
        const margem = Math.min(1000, Math.max(0, Number(b.margem) || 10));
        const [p0] = await q(db.rpc("fin_pedidos_ids", { p_ids: [id] }));
        must(p0, "Pré-venda não encontrada.", 404);
        const p = pedidoDe(p0);
        const ci = await q(db.from("fin_conc_itens").select("conc_id").eq("tipo", "pedido").eq("ref", id).maybeSingle());
        if (ci) {
          const c = (await detalhesConc([ci.conc_id])).get(ci.conc_id);
          const outros = c.pedidos.filter((x: string) => x !== id);
          const juntos = outros.length ? (await q(db.rpc("fin_pedidos_ids", { p_ids: outros }))).map(pedidoDe) : [];
          return out({ pedido: p, conc: { ...c, pedidos_det: [p, ...juntos] }, candidatos: [] });
        }
        const livres = await recebimentosLivres(somaDias(p.data, -JANELA.antes - 10), somaDias(p.data, JANELA.depois + 30));
        let lista = candidatos(p, livres, margem, 15);
        // busca manual: por nome do pagador ou valor, em qualquer recebimento livre da janela ampliada
        const busca = txt(b.busca, 60);
        if (busca) {
          const v = Number(busca.replace(/[^\d,.-]/g, "").replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", "."));
          const t = busca.toUpperCase();
          const achados = livres.filter((l) => (v > 0 && Math.abs(l.valor - v) <= Math.max(1, margem)) || (!(v > 0) && l.descricao.toUpperCase().includes(t)));
          const ja = new Set(lista.map((c) => c.id));
          const extra = candidatos(p, achados, 1e9, 30).filter((c) => !ja.has(c.id));
          lista = [...lista, ...extra].slice(0, 40);
        }
        // outras pré-vendas pendentes do mesmo cliente (pagamento único de mais de uma pré-venda)
        const vizinhos = (await q(db.rpc("fin_pedidos", { p_de: somaDias(p.data, -30), p_ate: somaDias(p.data, 30) }))).map(pedidoDe)
          .filter((x) => x.id !== p.id && x.total > 0 && ((p.cliente_cod && x.cliente_cod === p.cliente_cod && !/CONSUMIDOR/i.test(p.cliente)) || (!/CONSUMIDOR/i.test(p.cliente) && x.cliente === p.cliente)));
        const usados = new Set(vizinhos.length ? (await q(db.from("fin_conc_itens").select("ref").eq("tipo", "pedido").in("ref", vizinhos.map((x) => x.id)))).map((x: any) => x.ref) : []);
        const mesmos = vizinhos.filter((x) => !usados.has(x.id));
        // um recebimento que bate com a soma desta pré-venda com outra do mesmo cliente
        const combos: any[] = [];
        for (const o of mesmos) {
          const alvo = { ...p, total: r2(p.total + o.total) };
          for (const c of candidatos(alvo, livres, margem, 3).filter((c) => Math.abs(c.diff) <= margem + 0.001)) combos.push({ ...c, junto: o.id, total_junto: alvo.total });
        }
        return out({ pedido: p, conc: null, candidatos: lista, mesmo_cliente: mesmos, combos: combos.slice(0, 5) });
      }

      case "conc_criar": {
        must(admin, "Só administradores conciliam.");
        const pedIds = [...new Set((Array.isArray(b.pedidos) ? b.pedidos : []).map((x: unknown) => txt(x, 40)).filter(Boolean))] as string[];
        const lancIds = [...new Set((Array.isArray(b.lancamentos) ? b.lancamentos : []).map((x: unknown) => txt(x, 200)).filter(Boolean))] as string[];
        must(pedIds.length && pedIds.length <= 20, "Escolha a pré-venda.", 400);
        must(lancIds.length && lancIds.length <= 30, "Escolha pelo menos um recebimento.", 400);
        const peds = (await q(db.rpc("fin_pedidos_ids", { p_ids: pedIds }))).map(pedidoDe);
        must(peds.length === pedIds.length, "Alguma pré-venda não foi encontrada.", 400);
        const lancs = await q(db.from("fin_lancamentos").select("id,valor,descricao").in("id", lancIds));
        must(lancs.length === lancIds.length && lancs.every((l: any) => Number(l.valor) > 0), "Algum recebimento não foi encontrado.", 400);
        const ja = await q(db.from("fin_conc_itens").select("tipo,ref").or(`and(tipo.eq.pedido,ref.in.(${pedIds.map((x) => `"${x}"`).join(",")})),and(tipo.eq.lancamento,ref.in.(${lancIds.map((x) => `"${x}"`).join(",")}))`));
        must(!ja.length, `Já conciliado: ${ja.map((x: any) => x.tipo === "pedido" ? x.ref : "um dos recebimentos").join(", ")}. Atualize a tela.`, 409);
        const tp = r2(peds.reduce((s, p) => s + p.total, 0)), tl = r2(lancs.reduce((s: number, l: any) => s + Number(l.valor), 0));
        const c = await q(db.from("fin_conc").insert({ por: me.login, obs: txt(b.obs, 300) || null, total_pedidos: tp, total_pagos: tl }).select("id").single());
        const { error } = await db.from("fin_conc_itens").insert([
          ...peds.map((p) => ({ tipo: "pedido", ref: p.id, conc_id: c.id, valor: p.total })),
          ...lancs.map((l: any) => ({ tipo: "lancamento", ref: l.id, conc_id: c.id, valor: Number(l.valor) })),
        ]);
        if (error) { await db.from("fin_conc").delete().eq("id", c.id); throw new Erro(/duplicate|unique/i.test(error.message) ? "Alguém acabou de conciliar um desses itens. Atualize a tela." : error.message, 409); }
        await log(me.login, `${me.nome} conciliou ${pedIds.join(", ")} com ${lancIds.length} recebimento(s): ${brl(tl).replace("+", "")} de ${brl(tp).replace("+", "")}`);
        return out({ ok: true, id: c.id, diferenca: r2(tl - tp) });
      }

      case "conc_desfazer": {
        must(admin, "Só administradores desfazem conciliações.");
        const id = Number(b.id);
        const c = await q(db.from("fin_conc_itens").select("ref").eq("conc_id", id).eq("tipo", "pedido"));
        must(c.length, "Conciliação não encontrada.", 404);
        await q(db.from("fin_conc").delete().eq("id", id));
        await log(me.login, `${me.nome} desfez a conciliação de ${c.map((x: any) => x.ref).join(", ")}`);
        return out({ ok: true });
      }

      case "notifs": {
        const u = await q(db.from("fin_users").select("notif_visto").eq("login", me.login).single());
        const lista = await q(db.from("fin_notificacoes").select("id,criado,banco,titulo,texto,dados").order("criado", { ascending: false }).limit(30));
        const visto = u.notif_visto ? new Date(u.notif_visto).getTime() : Date.now() - 7 * 864e5;
        const auto = (await q(db.from("fin_log").select("at,msg").eq("login", "auto").order("at",{ ascending: false }).limit(1)))[0] || null;
        return out({ lista, nao_lidas: lista.filter((n: any) => new Date(n.criado).getTime() > visto).length, ultima_id: lista[0]?.id || 0, auto });
      }
      case "notifs_visto":
        await q(db.from("fin_users").update({ notif_visto: new Date().toISOString() }).eq("login", me.login));
        return out({ ok: true });

      case "users": {
        must(admin, "Só administradores veem os usuários.");
        return out({ users: await q(db.from("fin_users").select("login,nome,role,ativo,criado").order("nome")) });
      }
      case "user_add": {
        must(admin, "Só administradores criam usuários.");
        const login = txt(b.login, 40).toLowerCase(), nome = txt(b.nome, 80), pin = txt(b.pin, 20), role = b.role === "admin" ? "admin" : "leitura";
        must(/^[a-z0-9._-]{2,40}$/.test(login), "Login: use letras minúsculas, números, ponto ou traço.", 400);
        must(nome, "Informe o nome.", 400);
        must(/^\d{4,8}$/.test(pin), "O PIN precisa ter de 4 a 8 números.", 400);
        const ja = await q(db.from("fin_users").select("login").eq("login", login).maybeSingle());
        must(!ja, "Já existe um usuário com esse login.", 400);
        await q(db.rpc("fin_add_user", { p_login: login, p_nome: nome, p_pin: pin, p_role: role }));
        await log(me.login, `${me.nome} criou o usuário ${login}`);
        return out({ users: await q(db.from("fin_users").select("login,nome,role,ativo,criado").order("nome")) });
      }
      case "user_set": {
        const login = txt(b.login, 40);
        const proprio = login === me.login;
        must(admin || (proprio && b.pin && b.ativo === undefined && b.role === undefined), "Só administradores alteram outros usuários.");
        const u = await q(db.from("fin_users").select("login,role,ativo").eq("login", login).maybeSingle());
        must(u, "Usuário não encontrado.", 404);
        if (b.role !== undefined || b.ativo !== undefined) {
          const role = b.role === undefined ? u.role : (b.role === "admin" ? "admin" : "leitura");
          const ativo = b.ativo === undefined ? u.ativo : !!b.ativo;
          if (u.role === "admin" && (role !== "admin" || !ativo)) {
            const admins = await q(db.from("fin_users").select("login").eq("role", "admin").eq("ativo", true));
            must(admins.length > 1, "Precisa ficar pelo menos um administrador ativo.", 400);
          }
          await q(db.from("fin_users").update({ role, ativo }).eq("login", login));
          if (!ativo) await db.from("fin_sessions").delete().eq("login", login);
        }
        if (b.pin) {
          const pin = txt(b.pin, 20);
          must(/^\d{4,8}$/.test(pin), "O PIN precisa ter de 4 a 8 números.", 400);
          await q(db.rpc("fin_set_pin", { p_login: login, p_pin: pin }));
        }
        await log(me.login, `${me.nome} alterou o usuário ${login}`);
        return out({ users: admin ? await q(db.from("fin_users").select("login,nome,role,ativo,criado").order("nome")) : [] });
      }

      default:
        throw new Erro("Operação desconhecida.", 400);
    }
  } catch (e) {
    const s = e instanceof Erro ? e.s : 500;
    return out({ erro: e instanceof Error ? e.message : String(e) }, s);
  }
});
