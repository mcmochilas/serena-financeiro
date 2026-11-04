// Conciliação: regras de aproximação entre pré-vendas (Picking) e recebimentos (extrato dos bancos).
// Funções puras, sem banco de dados, para poder testar à parte.

export type Pedido = { id: string; num: string; data: string; cliente: string; cliente_cod?: string | null; total: number };
export type Lanc = { id: string; banco: string; data: string; descricao: string; valor: number };
export type Candidato = Lanc & {
  pagador: string; diff: number; dias: number; nome: number; score: number; nivel: "alta" | "media" | "baixa"; motivos: string[];
};

// Recebimentos que não vêm de cliente (resgate de aplicação, rendimento, transferência entre contas da própria empresa)
const NAO_CLIENTE = /SERENA PUX|RESGATE|RENTAB|INVEST FACIL|APLIC/i;
export const ehRecebimentoDeCliente = (l: { valor: number; descricao: string; categoria?: string | null }) =>
  l.valor > 0 && l.categoria !== "Investimentos" && l.categoria !== "Cartão cancelado" && !NAO_CLIENTE.test(l.descricao || "");

// Nome de quem pagou, tirado da descrição do extrato ("PIX RECEBIDO · REM: RAQUEL DE ARAUJO      04/11")
export function pagador(desc: string) {
  const m = String(desc || "").match(/(?:REM|DE|ORIGEM|PAGADOR)\s*:\s*(.+?)(?:\s+\d{2}\/\d{2}(?:\/\d{2,4})?)?\s*$/i);
  return m ? m[1].replace(/\s+/g, " ").trim() : "";
}

// Palavras que não identificam ninguém: artigos, tipo de empresa e termos comuns do ramo moveleiro
const STOP = new Set(["DE", "DA", "DO", "DAS", "DOS", "E", "LTDA", "ME", "EPP", "EIRELI", "SA", "MEI", "CIA", "COM", "IND", "COMERCIO", "INDUSTRIA", "SERVICOS",
  "MOVEIS", "MOVEL", "MOVELARIA", "PLANEJADOS", "PLANEJADO", "PLANEJAD", "AMBIENTES", "AMBIENTE", "MARCENARIA", "MARCENARIAS", "MARCENAR", "MARCENARI",
  "INTERIORES", "DESIGN", "DECORACOES", "DECORACAO", "EMPREENDIMENTOS", "REPRESENTACOES", "CONSTRUTORA", "CONSTRUCOES", "ARQUITETURA", "PROJETOS",
  "SOB", "MEDIDA", "MADEIRA", "MADEIRAS", "ESQUADRIAS", "CONSUMIDOR", "AO", "PJ"]);
const tokens = (s: string) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase()
  .replace(/[^A-Z0-9 ]/g, " ").split(/\s+/).filter((t) => t.length > 1 && !STOP.has(t));
function lev(a: string, b: string) {
  if (Math.abs(a.length - b.length) > 2) return 9;
  const d = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0]; d[0] = i;
    for (let j = 1; j <= b.length; j++) { const t = d[j]; d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = t; }
  }
  return d[b.length];
}
// 0 a 1: quanto o nome do pagador combina com o do cliente. O banco corta o nome em ~21 letras,
// então a última palavra do pagador pode estar pela metade; aceita também pequenos erros de digitação.
export function simNome(cliente: string, pag: string) {
  const c = tokens(cliente), p = tokens(pag);
  if (!c.length || !p.length) return 0;
  let ok = 0, forte = false;
  const cortado = String(pag).trim().length >= 19; // o Bradesco corta o nome do pagador em ~21 letras
  p.forEach((t, i) => {
    const ultima = i === p.length - 1;
    // igual, ou começo da última palavra (nome cortado pelo banco): conta inteiro
    if (c.some((x) => x === t || (ultima && (t.length >= 5 || (cortado && t.length >= 3)) && x.startsWith(t)))) { ok++; if (t.length >= 4) forte = true; return; }
    // erro de digitação (palavras de 6+ letras): conta só 3/4, para não juntar nomes diferentes
    if (c.some((x) => Math.min(x.length, t.length) >= 6 && x[0] === t[0] && lev(x, t) <= (Math.min(x.length, t.length) >= 7 ? 2 : 1))) ok += 0.75;
  });
  if (!forte) return 0;
  return Math.min(1, ok / Math.min(c.length, p.length));
}

const diasEntre = (de: string, ate: string) => Math.round((Date.parse(ate + "T12:00:00Z") - Date.parse(de + "T12:00:00Z")) / 864e5);
const brl = (v: number) => "R$ " + Math.abs(v).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Pontua um recebimento para uma pré-venda (0 a 100). Entra como candidato se o valor estiver dentro da
// margem ou se o nome do pagador combinar com o do cliente (pagamento parcial, ou valor bem diferente).
export function avaliar(p: Pedido, l: Lanc, margem: number): Candidato | null {
  if (!(p.total > 0)) return null;
  const diff = Math.round((l.valor - p.total) * 100) / 100;
  const ad = Math.abs(diff);
  const pag = pagador(l.descricao);
  const nome = simNome(p.cliente, pag);
  const dias = diasEntre(p.data, l.data);
  const dentro = ad <= margem + 0.001;
  if (!dentro && nome < 0.5) return null;
  const motivos: string[] = [];
  let pts = 0;
  if (ad < 0.005) { pts += 60; motivos.push("Valor exato"); }
  else if (dentro) { pts += 5 + 45 * (1 - ad / Math.max(margem, 0.01)); motivos.push(diff < 0 ? `Pagou ${brl(ad)} a menos` : `Pagou ${brl(ad)} a mais`); }
  else motivos.push(diff < 0 ? `Valor ${brl(ad)} abaixo` : `Valor ${brl(ad)} acima`);
  if (nome >= 0.5) { pts += 35 * nome; motivos.push(nome >= 0.8 ? "Nome confere" : "Nome parecido"); }
  if (dias >= 0 && dias <= 3) pts += 5; else if (dias >= -2 && dias <= 10) pts += 3;
  if (dias < 0) motivos.push(`Pago ${-dias} dia${dias === -1 ? "" : "s"} antes da pré-venda`);
  else if (dias > 7) motivos.push(`Pago ${dias} dias depois`);
  const score = Math.round(Math.min(100, pts));
  return { ...l, pagador: pag, diff, dias, nome: Math.round(nome * 100) / 100, score, nivel: score >= 85 ? "alta" : score >= 55 ? "media" : "baixa", motivos };
}

// Janela de datas em que um recebimento pode ser de uma pré-venda
export const JANELA = { antes: 5, depois: 45 };
export function candidatos(p: Pedido, lancs: Lanc[], margem: number, limite = 12) {
  return lancs
    .filter((l) => { const d = diasEntre(p.data, l.data); return d >= -JANELA.antes && d <= JANELA.depois; })
    .map((l) => avaliar(p, l, margem))
    .filter((c): c is Candidato => !!c)
    .sort((a, b) => b.score - a.score || Math.abs(a.diff) - Math.abs(b.diff) || Math.abs(a.dias) - Math.abs(b.dias))
    .slice(0, limite);
}
