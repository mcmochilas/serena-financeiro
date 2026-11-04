// Serena Financeiro — API única (login usuário+PIN, extrato, credenciais dos bancos, usuários)
// Publicada sem verificação de JWT: a autenticação é feita aqui, por token de sessão (x-fin-token).
import { createClient } from "npm:@supabase/supabase-js@2";

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
const BANCOS = ["bradesco", "stone"] as const;
// segredos aceitos por banco (nunca voltam para a tela)
const SEGREDOS: Record<string, string[]> = {
  bradesco: ["client_secret", "cert", "cert_senha"],
  stone: ["api_key"],
};
// o que precisa estar preenchido para considerar o banco configurado
const OBRIG: Record<string, { campos: string[]; segredos: string[] }> = {
  bradesco: { campos: ["client_id", "agencia", "conta"], segredos: ["client_secret", "cert"] },
  stone: { campos: ["client_id"], segredos: ["api_key"] },
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
    segredos: tem, completo, atualizado: c.atualizado, atualizado_por: c.atualizado_por,
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

// "agora" no fuso de Brasília (o banco trabalha com datas locais; depois das 21h o UTC já é o dia seguinte)
const agoraBR = () => new Date(Date.now() - 3 * 3600e3);
const brl = (v: number) => (v < 0 ? "-" : "+") + "R$ " + Math.abs(v).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Grava o saldo: se não mudou desde a última consulta, só atualiza o horário (não acumula linhas iguais)
async function gravaSaldo(conta: string, json: any) {
  const sd = saldoItens(json);
  const ult = (await q(db.from("fin_saldos").select("id,total,itens").eq("banco", "bradesco").order("em", { ascending: false }).limit(1)))[0];
  if (ult && Number(ult.total) === Number(sd.total) && JSON.stringify(ult.itens) === JSON.stringify(sd.itens))
    await q(db.from("fin_saldos").update({ em: new Date().toISOString() }).eq("id", ult.id));
  else await q(db.from("fin_saldos").insert({ banco: "bradesco", conta, total: sd.total, itens: sd.itens, raw: json }));
  return sd;
}

// Rotina automática (a cada 15 min, pelo pg_cron): saldo + lançamentos dos últimos dias.
// Grava tudo (nada é apagado) e, se aparecer lançamento que ainda não estava no banco, cria uma notificação.
async function rotina() {
  const c = (await credenciais()).find((x) => x.banco === "bradesco");
  if (!c?.completo) return { ok: false, motivo: "Bradesco não configurado" };
  const cr = await bradCred();
  const fim = agoraBR();
  const x = await bradesco(cr, new Date(fim.getTime() - 2 * 864e5), fim, { saldo: true });
  if (!x.ok) { await log("auto", `Atualização automática falhou: ${explica(x)}`); return { ok: false, motivo: explica(x) }; }
  const rows = lancamentos(x.json, cr.conta);
  const sd = x.saldo?.json ? await gravaSaldo(cr.conta, x.saldo.json) : null;

  // o que já estava gravado nesses dias
  const dias = [...new Set(rows.map((r) => r.data))];
  const ja = dias.length ? await q(db.from("fin_lancamentos").select("id,data,valor").eq("banco", "bradesco").in("data", dias)) : [];
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
    const titulo = novos.length === 1 ? "1 novo lançamento no Bradesco" : `${novos.length} novos lançamentos no Bradesco`;
    const partes = [ent ? `Entradas ${brl(ent)}` : "", sai ? `Saídas ${brl(sai)}` : "", sd?.itens ? `Saldo ${brl((sd.itens.find((i) => i.codigo === 1005) || { valor: sd.total || 0 }).valor).replace("+", "")}` : ""].filter(Boolean);
    await q(db.from("fin_notificacoes").insert({
      banco: "bradesco", titulo, texto: partes.join(" · "),
      dados: { itens: novos.slice(0, 50).map((r) => ({ id: r.id, data: r.data, valor: r.valor, descricao: r.descricao })) },
    }));
    await log("auto", `${titulo}`);
  }
  return { ok: true, lidos: rows.length, novos: novos.length, saldo: sd?.total ?? null };
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
          const c = banco === "bradesco" ? txt(b.conta, 20).replace(/\D/g, "") : txt(b.conta, 60);
          must(banco !== "bradesco" || !c || c.length <= 7, "Conta: até 7 números, sem o dígito.", 400);
          upd.conta = c || null;
        }
        const sec = (b.segredos && typeof b.segredos === "object") ? b.segredos : {};
        const mudou: string[] = [];
        for (const [nome, valor] of Object.entries(sec)) {
          must(SEGREDOS[banco].includes(nome), `Campo secreto desconhecido: ${nome}.`, 400);
          const v = String(valor ?? "");
          if (!v) continue; // vazio = manter o que já está guardado
          must(v.length <= 300000, "Arquivo ou chave grande demais.", 400);
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
          ok = false; msg = "Falta preencher: " + falta.map((k) => ({ client_id: "Client ID", agencia: "agência", conta: "conta", client_secret: "Client Secret", cert: "certificado (.pfx)", api_key: "chave privada" } as any)[k] || k).join(", ") + ".";
        } else if (banco === "bradesco") {
          const cr = await bradCred();
          const x = await bradesco(cr, new Date(Date.now() - 6 * 864e5), new Date());
          if (x.ok) {
            const n = lancamentos(x.json, cr.conta).length;
            const ret = x.json?.extratoPorPeriodo || x.json?.extratoUltimosLancamentos || {};
            ok = true; msg = `Conexão OK. Extrato dos últimos 7 dias: ${n} lançamentos.${ret.mensagem ? " Banco: " + String(ret.mensagem).trim() : ""}`;
          } else { ok = false; msg = explica(x); }
        } else {
          ok = null; msg = "Credenciais guardadas. A conexão com a Stone entra numa próxima etapa.";
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
        await q(db.from("fin_credenciais").update({ client_id: null, agencia: null, conta: null, cert_nome: null, secrets: {}, atualizado: new Date().toISOString(), atualizado_por: me.login, teste_em: null, teste_ok: null, teste_msg: null }).eq("banco", banco));
        await log(me.login, `${me.nome} apagou as credenciais ${banco}`);
        return out({ bancos: await credenciais() });
      }


      case "sync": {
        must(admin, "Só administradores sincronizam o extrato.");
        const dias = Math.min(365, Math.max(1, Number(b.dias) || 90));
        const cr = await bradCred();
        const fim = agoraBR();
        const x = await bradesco(cr, new Date(fim.getTime() - (dias - 1) * 864e5), fim, { saldo: true });
        if (!x.ok) throw new Erro(explica(x), 502);
        const rows = lancamentos(x.json, cr.conta);
        if (x.saldo?.json) await gravaSaldo(cr.conta, x.saldo.json);
        for (let i = 0; i < rows.length; i += 500) await q(db.from("fin_lancamentos").upsert(rows.slice(i, i + 500)));
        await q(db.from("fin_credenciais").update({ teste_em: new Date().toISOString(), teste_ok: true, teste_msg: `Sincronizado: ${rows.length} lançamentos dos últimos ${dias} dias.` }).eq("banco", "bradesco"));
        await log(me.login, `${me.nome} sincronizou o extrato Bradesco: ${rows.length} lançamentos (${dias} dias)`);
        return out({ ok: true, n: rows.length, dias, saldo: x.saldo?.json ? saldoItens(x.saldo.json).total : null, saldo_erro: x.saldo && !x.saldo.json ? `HTTP ${x.saldo.status}: ${x.saldo.texto}` : null });
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
