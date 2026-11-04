// Stone — API de Conciliação (vendas no cartão: maquininha e link de pagamento)
// Para o próprio lojista: chave criada no portal Stone (Chaves de autenticação › Plataforma de e-commerce / Conciliação),
// enviada em Basic Auth (usuário = chave, senha vazia) com o cabeçalho x-user-type: client.
// Um arquivo XML por dia (layout 2.2), disponível depois das 5h do dia seguinte.
import { XMLParser } from "npm:fast-xml-parser@4.5.0";
import { unzipSync, gunzipSync } from "npm:fflate@0.8.2";

export const CONC_URL = "https://conciliation.stone.com.br/v2";

export type Arquivo = { ok: boolean; status: number; xml?: string; erro?: string };

const ehZip = (b: Uint8Array) => b.length > 3 && b[0] === 0x50 && b[1] === 0x4b;
const ehGzip = (b: Uint8Array) => b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;

export async function baixarArquivo(stonecode: string, chave: string, dataISO: string): Promise<Arquivo> {
  const dia = dataISO.replace(/-/g, "");
  let r: Response;
  try {
    r = await fetch(`${CONC_URL}/merchant/${encodeURIComponent(stonecode)}/conciliation-file/${dia}?layout=XML2_2`, {
      headers: { Authorization: "Basic " + btoa(`${chave}:`), "x-user-type": "client", "Accept-Encoding": "gzip", Accept: "application/xml" },
      signal: AbortSignal.timeout(40000),
    });
  } catch (e) { return { ok: false, status: 0, erro: "Sem resposta da Stone: " + String((e as Error)?.message || e).slice(0, 160) }; }
  let bytes = new Uint8Array(await r.arrayBuffer());
  try {
    if (ehZip(bytes)) { const arqs = unzipSync(bytes); const k = Object.keys(arqs)[0]; bytes = k ? arqs[k] : new Uint8Array(); }
    else if (ehGzip(bytes)) bytes = gunzipSync(bytes);
  } catch { /* se não descompactar, segue como texto */ }
  const txt = new TextDecoder().decode(bytes);
  if (!r.ok) {
    const det = txt.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 220);
    const dica = r.status === 401 || r.status === 403
      ? " A Stone recusou a chave: confira se é a chave da aba “Plataforma de e-commerce / Conciliação”, criada para este StoneCode."
      : r.status === 404 || r.status === 400 ? " Confira o StoneCode (só números)." : "";
    return { ok: false, status: r.status, erro: `Stone respondeu HTTP ${r.status}${det ? ": " + det : ""}.${dica}` };
  }
  return { ok: true, status: r.status, xml: txt };
}

const parser = new XMLParser({
  ignoreAttributes: true, parseTagValue: false, trimValues: true,
  isArray: (nome) => ["Transaction", "Installment", "Cancellation", "Payment", "Event"].includes(nome),
});
const n = (v: unknown) => { const x = Number(String(v ?? "").replace(",", ".")); return Number.isFinite(x) ? x : 0; };
const r2 = (v: number) => Math.round(v * 100) / 100;
// aaaammddHHmmss -> { data: "aaaa-mm-dd", hora: "HH:MM" }
const dt = (s: unknown) => { const m = String(s || "").match(/^(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?/); return m ? { data: `${m[1]}-${m[2]}-${m[3]}`, hora: m[4] ? `${m[4]}:${m[5] || "00"}` : "" } : null; };

// Bandeira: os códigos 1 e 2 conferem com o exemplo da Stone (Visa e Mastercard); para o resto, pelo início do cartão.
function bandeira(brandId: unknown, cartao: string) {
  const b = String(brandId || "");
  if (b === "1") return "VISA";
  if (b === "2") return "MASTERCARD";
  const c = cartao.replace(/\D/g, "");
  if (/^(636368|438935|504175|451416|636297|5067|4576|4011|506699|509)/.test(c)) return "ELO";
  if (/^3[47]/.test(c)) return "AMEX";
  if (/^(606282|3841)/.test(c)) return "HIPERCARD";
  if (/^4/.test(c)) return "VISA";
  if (/^(5[1-5]|2[2-7])/.test(c)) return "MASTERCARD";
  return "";
}
const TIPO_CONTA: Record<string, string> = { "1": "DÉBITO", "2": "CRÉDITO", "3": "PRÉ-PAGO DÉBITO", "4": "PRÉ-PAGO CRÉDITO", "5": "VOUCHER", "10": "BOLETO" };

export type Venda = {
  id: string; banco: "stone_vendas"; conta: string; data: string; hora: string; descricao: string; categoria: string; tipo: "Entrada";
  valor: number; saldo: null; documento: string; raw: Record<string, unknown>;
};
export type Cancelamento = { id: string; atk: string; valor: number; data: string };

// Lê um arquivo do dia: vendas capturadas (com parcelas e líquido) e cancelamentos de vendas de outros dias.
export function lerArquivo(xml: string, stonecode: string) {
  const j = parser.parse(xml)?.Conciliation;
  if (!j) throw new Error("O arquivo da Stone veio num formato inesperado (sem <Conciliation>).");
  const ref = String(j.Header?.ReferenceDate || "");
  const trans: any[] = j.FinancialTransactions?.Transaction || [];
  const vendas: Venda[] = [];
  const cancelamentos: Cancelamento[] = [];
  for (const t of trans) {
    const ev = t.Events || {};
    const atk = String(t.AcquirerTransactionKey || "").trim();
    if (!atk) continue;
    const capturado = n(t.CapturedAmount), cancelado = n(t.CanceledAmount);
    const quando = dt(t.CaptureLocalDateTime) || dt(t.AuthorizationDateTime);
    const parcelas: any[] = t.Installments?.Installment || [];
    const liquido = r2(parcelas.reduce((s, p) => s + n(p.NetAmount), 0));
    const devolvido = r2((t.Cancellations?.Cancellation || []).reduce((s: number, c: any) => s + n(c.ReturnedAmount), 0));
    if (n(ev.Captures) > 0 && quando) {
      const valor = r2(capturado - cancelado);
      const cartao = String(t.CardNumber || "");
      const nParc = Math.max(1, n(t.NumberOfInstallments));
      const conta = TIPO_CONTA[String(t.AccountType || "")] || "CARTÃO";
      const band = bandeira(t.BrandId, cartao);
      const pedido = String(t.ExternalOrderId || "").trim();
      const desc = [`${conta === "BOLETO" ? "BOLETO STONE" : "CARTÃO " + conta}${band ? " " + band : ""}${nParc > 1 ? ` ${nParc}x` : ""}`,
        cartao ? `final ${cartao.slice(-4)}` : "", quando.hora, pedido ? `pedido ${pedido}` : "",
        liquido > 0 && valor > 0 ? `líquido R$ ${liquido.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "",
        valor <= 0.005 ? "CANCELADA" : cancelado > 0 ? `cancelado R$ ${cancelado.toFixed(2).replace(".", ",")}` : ""].filter(Boolean).join(" · ");
      vendas.push({
        id: `stv-${atk}`, banco: "stone_vendas", conta: stonecode, data: quando.data, hora: quando.hora, descricao: desc,
        categoria: valor <= 0.005 ? "Cartão cancelado" : "Vendas no cartão", tipo: "Entrada", valor: valor <= 0.005 ? r2(capturado) : valor,
        saldo: null, documento: atk,
        raw: { atk, itk: t.InitiatorTransactionKey ?? null, pedido: pedido || null, bandeira: band, tipo_conta: conta, parcelas: nParc, capturado, cancelado, liquido,
          cartao: cartao ? "final " + cartao.slice(-4) : null, autorizacao: t.IssuerAuthorizationCode ?? null, poi: t.Poi?.PoiType ?? null, entrada: t.EntryMode ?? null,
          previsao: parcelas.map((p) => ({ n: n(p.InstallmentNumber), bruto: n(p.GrossAmount), liquido: n(p.NetAmount), data: p.PrevisionPaymentDate || p.PaymentDate || null })),
          arquivo: ref },
      });
    } else if (n(ev.Cancellations) > 0 && (devolvido > 0 || cancelado > 0)) {
      // cancelamento de venda feita em outro dia: a venda original é atualizada
      cancelamentos.push({ id: `stv-${atk}`, atk, valor: devolvido || cancelado, data: dt(t.Cancellations?.Cancellation?.[0]?.CancellationDateTime)?.data || "" });
    }
  }
  const ativas = vendas.filter((v) => v.categoria === "Vendas no cartão");
  return { referencia: ref, vendas, cancelamentos, total: r2(ativas.reduce((s, v) => s + v.valor, 0)), qtd: ativas.length };
}

// ---------- Links de pagamento da Conta Stone (Stone Banking API) ----------
export type Link = { id: string; code: string | null; criado: string | null; atualizado: string | null; valor: number; status: string; descricao: string; cliente: string; metodo: string; raw: unknown };
// Pedido de link (GET /api/v1/payment_links/{conta}/orders) -> linha de fin_stone_links. Valores vêm em centavos.
export function linkDePedido(o: any): Link | null {
  if (!o?.id) return null;
  const itens: any[] = Array.isArray(o.items) ? o.items : [];
  const desc = [...new Set(itens.map((i) => String(i.description || i.name || "").trim()).filter(Boolean))].join(" / ") || String(o.description || o.name || "").trim();
  const pag: any = (Array.isArray(o.charges) && o.charges[0]) || (Array.isArray(o.payments) && o.payments[0]) || {};
  return {
    id: String(o.id), code: o.code ? String(o.code) : null, criado: o.created_at || null, atualizado: o.updated_at || pag.paid_at || null,
    valor: r2((Number(o.amount ?? itens.reduce((s, i) => s + Number(i.amount || 0) * Number(i.quantity || 1), 0)) || 0) / 100),
    status: String(o.status || ""), descricao: desc, cliente: String(o.customer?.name || pag.customer?.name || "").trim(),
    metodo: String(pag.payment_method || pag.last_transaction?.transaction_type || "").toLowerCase(), raw: o,
  };
}
// Venda do arquivo da Stone feita por link (e-commerce) ou na maquininha
export const ehLink = (raw: any) => /^pl_/.test(String(raw?.pedido || "")) || /^ch_/.test(String(raw?.itk || "")) || String(raw?.poi || "") === "4";
const diaDe = (iso: string | null) => String(iso || "").slice(0, 10);
const diasEntre = (a: string, b: string) => Math.abs(Date.parse(a + "T12:00:00Z") - Date.parse(b + "T12:00:00Z")) / 864e5;
// Liga cada venda por link ao pedido do link: pelo código pl_/ch_ quando o pedido o traz; senão, por valor igual e data próxima.
export function ligaLinks(vendas: { id: string; data: string; valor: number; raw: any }[], links: Link[]) {
  const usados = new Set<string>(), m = new Map<string, Link>();
  const pagos = links.filter((l) => !/cancel|expir|fail/i.test(l.status));
  for (const v of vendas) {
    const cods = [v.raw?.pedido, v.raw?.itk].filter((c) => c && /^(pl|ch)_/.test(String(c)));
    const l = cods.length ? pagos.find((l) => !usados.has(l.id) && cods.some((c) => JSON.stringify(l.raw || "").includes(String(c)))) : undefined;
    if (l) { m.set(v.id, l); usados.add(l.id); }
  }
  for (const v of vendas) {
    if (m.has(v.id) || !ehLink(v.raw)) continue;
    const l = pagos.filter((l) => !usados.has(l.id) && Math.abs(l.valor - v.valor) < 0.015 && diasEntre(diaDe(l.atualizado || l.criado), v.data) <= 3)
      .sort((a, b) => diasEntre(diaDe(a.atualizado || a.criado), v.data) - diasEntre(diaDe(b.atualizado || b.criado), v.data))[0];
    if (l) { m.set(v.id, l); usados.add(l.id); }
  }
  return m;
}
