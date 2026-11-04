/* Serena Financeiro — aba Stone: vendas na maquininha e no link de pagamento (arquivo de conciliação da Stone) */
'use strict';

const SV = { dias: 30, origem: 'todas', busca: '', pagina: 1, por: 50, data: null, carregando: false, chave: '', abertos: new Set() };
const SV_DIAS = [7, 30, 90];
const svIso = (n) => new Date(Date.now() - 3 * 3600e3 - n * 864e5).toISOString().slice(0, 10);

function svRedesenha() {
  const root = document.querySelector('.body.sv');
  if (!root || S.tela !== 'extrato' || S.banco !== 'stone') { render(); return; }
  const novo = telaStoneVendas();
  const velhos = [...root.children], novos = [...novo.children];
  if (velhos.length !== novos.length) { root.replaceWith(novo); return; }
  velhos.forEach((v, i) => { if (v.contains(document.activeElement) && v.classList.contains('sv-filtros')) return; v.replaceWith(novos[i]); });
}
async function svCarrega() {
  const ate = svIso(0), de = svIso(SV.dias - 1), chave = de + ate;
  SV.carregando = true; SV.chave = chave;
  try { const r = await api('stone_vendas_lista', { de, ate }); if (SV.chave === chave) SV.data = r; }
  catch (e) { toast(e.message, true); }
  SV.carregando = false; svRedesenha();
}
function svFiltradas() {
  const t = SV.busca.trim().toUpperCase(), tn = t.replace(/\./g, '').replace(',', '.');
  return (SV.data?.itens || []).filter((v) => {
    if (SV.origem !== 'todas' && v.origem !== SV.origem) return false;
    if (!t) return true;
    const campos = [v.link?.descricao, v.link?.cliente, v.link?.code, v.cartao, v.bandeira, v.tipo_conta, v.link_id, ...(v.pvs || []), v.pv_no_link, v.stonecode].map((x) => String(x || '').toUpperCase());
    return campos.some((c) => c.includes(t)) || String(v.valor).includes(tn) || (v.valor.toFixed(2)).includes(tn);
  });
}

function telaStoneVendas() {
  const wrap = h('div', { class: 'body sv' });
  if (!SV.data && !SV.carregando) svCarrega();
  const r = SV.data?.resumo, info = SV.data?.info;
  wrap.append(h('header', { class: 'head' }, h('h1', {}, 'Vendas Stone'),
    h('p', {}, 'Pagamentos na maquininha e nos links de pagamento, lidos do arquivo diário da Stone (as vendas de cada dia chegam na manhã seguinte).')));
  wrap.append(h('div', { class: 'bar' },
    h('div', { class: 'chips', role: 'group', 'aria-label': 'Conta' }, h('span', { class: 'lbl' }, 'Conta'),
      Object.keys(BANCO_TXT).map((b) => h('button', { type: 'button', 'aria-pressed': String(S.banco === b),
        onclick: () => { if (S.banco === b) return; S.banco = b; localStorage.setItem('fin_banco', b); S.ext = null; render(); } }, BANCO_TXT[b]))),
    h('div', { class: 'seg', role: 'group', 'aria-label': 'O que ver' },
      h('button', { type: 'button', 'aria-pressed': 'true' }, 'Vendas (maquininha e link)'),
      h('button', { type: 'button', 'aria-pressed': 'false', onclick: () => { S.stoneVista = 'conta'; S.ext = null; render(); } }, 'Extrato da conta'))));

  if (!SV.data) { wrap.append(h('div', { class: 'loading' }, 'Carregando vendas…')); return wrap; }
  if (!info.vendas_ok && !SV.data.itens.length) {
    wrap.append(h('div', { class: 'card empty' }, h('h2', {}, 'Vendas da Stone ainda não conectadas'),
      h('p', {}, 'Cadastre o StoneCode e a chave da API de Conciliação em Configurações › APIs › Stone · Vendas no cartão.'),
      S.me.role === 'admin' ? h('button', { class: 'btn', type: 'button', onclick: () => { S.cfg = 'apis'; ir('configuracoes'); setTimeout(() => $('#api-stone_vendas')?.scrollIntoView({ block: 'start' }), 300); } }, 'Abrir configurações') : null));
    return wrap;
  }

  const tile = (k, v, s, cls) => h('div', { class: 'card tile ' + (cls || '') }, h('div', { class: 'k' }, k), h('b', { class: 'v' }, v), h('div', { class: 's' }, s));
  const taxas = r.bruto && r.liquido ? r.bruto - r.liquido : 0;
  wrap.append(h('section', { class: 'tiles' },
    tile(`Vendido · ${SV.dias} dias`, brl.format(r.bruto), `${int.format(r.qtd)} vendas${r.canceladas ? ` · ${r.canceladas} cancelada${r.canceladas === 1 ? '' : 's'}` : ''}`),
    tile('Líquido a receber', brl.format(r.liquido), taxas > 0 ? `Taxas ${brl.format(taxas)} (${(taxas / r.bruto * 100).toFixed(2).replace('.', ',')}%)` : 'Depois das taxas da Stone'),
    tile('Maquininha', brl.format(r.maq.bruto), `${int.format(r.maq.qtd)} vendas`),
    tile('Link de pagamento', brl.format(r.link.bruto), `${int.format(r.link.qtd)} vendas · ${int.format(r.conciliadas)} já conciliadas com pré-venda`)));

  if (!info.conta_ok || !info.links) wrap.append(h('div', { class: 'info' },
    h('b', {}, 'Descrição e cliente dos links: '),
    info.conta_ok ? 'a Conta Stone está conectada, mas a Stone ainda não devolveu nenhum link de pagamento. ' : 'aparecem quando o extrato da Conta Stone estiver conectado (Configurações › APIs › Stone, com o Client ID da Stone). ',
    'Por enquanto, cada venda por link mostra o código do link (pl_…) e da cobrança (ch_…).'));

  // filtros
  let tb;
  const busca = h('input', { type: 'search', placeholder: 'Valor, final do cartão, nº da pré-venda, descrição ou cliente do link', value: SV.busca, 'aria-label': 'Buscar venda',
    oninput: () => { clearTimeout(tb); tb = setTimeout(() => { SV.busca = busca.value; SV.pagina = 1; svRedesenha(); }, 250); } });
  const nOrig = (o) => (SV.data.itens || []).filter((v) => o === 'todas' || v.origem === o).length;
  wrap.append(h('section', { class: 'card sv-filtros' },
    h('div', { class: 'seg', role: 'group', 'aria-label': 'Período' }, SV_DIAS.map((d) => h('button', { type: 'button', 'aria-pressed': String(SV.dias === d), onclick: () => { SV.dias = d; SV.pagina = 1; SV.data = null; svRedesenha(); } }, `${d} dias`))),
    h('div', { class: 'seg', role: 'group', 'aria-label': 'Origem' },
      [['todas', 'Todas'], ['maquininha', 'Maquininha'], ['link', 'Link de pagamento']].map(([k, t]) => h('button', { type: 'button', 'aria-pressed': String(SV.origem === k), onclick: () => { SV.origem = k; SV.pagina = 1; svRedesenha(); } }, t, h('small', {}, ` ${nOrig(k)}`)))),
    busca,
    h('span', { class: 'sv-ult' }, info.ultimo_arquivo ? `Arquivo mais recente: ${diaAno(info.ultimo_arquivo)}` : '')));

  // tabela
  const lista = svFiltradas();
  const pags = Math.max(1, Math.ceil(lista.length / SV.por));
  SV.pagina = Math.min(SV.pagina, pags);
  const pg = lista.slice((SV.pagina - 1) * SV.por, SV.pagina * SV.por);
  const tbody = h('tbody');
  if (!pg.length) tbody.append(h('tr', {}, h('td', { colspan: 7, class: 'sv-vazio' }, 'Nenhuma venda com esse filtro.')));
  for (const v of pg) {
    const aberto = SV.abertos.has(v.id);
    const forma = [v.tipo_conta ? (v.tipo_conta === 'CRÉDITO' || v.tipo_conta === 'DÉBITO' ? v.tipo_conta[0] + v.tipo_conta.slice(1).toLowerCase() : v.tipo_conta.toLowerCase()) : 'Cartão', v.bandeira ? v.bandeira[0] + v.bandeira.slice(1).toLowerCase() : '', v.parcelas > 1 ? `${v.parcelas}x` : ''].filter(Boolean).join(' ');
    const descr = v.origem === 'link'
      ? (v.link ? h('div', {}, h('b', {}, v.link.descricao || 'Link sem descrição'), v.link.cliente ? h('span', { class: 's' }, ` · ${v.link.cliente}`) : null)
                : h('div', {}, h('span', { class: 's' }, 'Link '), h('code', {}, v.link_id ? v.link_id.slice(0, 14) + '…' : '—')))
      : h('div', { class: 's' }, `Maquininha · StoneCode ${v.stonecode}`);
    const pv = v.pvs.length ? h('span', { class: 'chip ok' }, '✓ ' + v.pvs.join(' + '))
      : v.pv_no_link ? h('span', { class: 'chip warn', title: 'Número encontrado na descrição do link' }, `PV ${v.pv_no_link}?`) : h('span', { class: 's' }, '—');
    tbody.append(h('tr', { class: (v.cancelada ? 'cancelada ' : '') + (aberto ? 'aberto' : ''), onclick: () => { aberto ? SV.abertos.delete(v.id) : SV.abertos.add(v.id); svRedesenha(); } },
      h('td', { class: 'dt' }, `${dDia(v.data)}`, v.hora ? h('span', { class: 's' }, ` ${v.hora}`) : null),
      h('td', {}, h('span', { class: 'org ' + v.origem }, v.origem === 'link' ? 'Link' : 'Maquininha')),
      h('td', { class: 'desc' }, descr),
      h('td', { class: 's' }, forma, v.cartao ? ` · ${v.cartao}` : ''),
      h('td', { class: 'num' }, v.cancelada ? h('s', {}, brl.format(v.valor)) : brl.format(v.valor), v.cancelada ? h('div', { class: 'canc' }, 'Cancelada') : v.cancelado ? h('div', { class: 'canc' }, `cancelado ${brl.format(v.cancelado)}`) : null),
      h('td', { class: 'num s' }, v.liquido && !v.cancelada ? brl.format(v.liquido) : '—'),
      h('td', {}, pv)));
    if (aberto) tbody.append(h('tr', { class: 'det' }, h('td', { colspan: 7 },
      h('div', { class: 'sv-det' },
        h('div', {}, h('span', {}, 'Origem'), h('b', {}, v.origem === 'link' ? 'Link de pagamento' : 'Maquininha'), h('span', {}, `StoneCode ${v.stonecode}`)),
        v.origem === 'link' ? h('div', {}, h('span', {}, 'Link'), h('b', {}, v.link?.descricao || '—'), h('span', {}, [v.link?.cliente, v.link?.code ? 'código ' + v.link.code : null, v.link_id].filter(Boolean).join(' · '))) : null,
        v.cobranca ? h('div', {}, h('span', {}, 'Cobrança'), h('b', {}, v.cobranca)) : null,
        h('div', {}, h('span', {}, 'Parcelas e repasse'), v.previsao.length ? v.previsao.map((p) => h('div', { class: 's' }, `${p.n}ª · bruto ${brl.format(p.bruto)} · líquido ${brl.format(p.liquido)}${p.data ? ' · ' + dDia(String(p.data).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3')) : ''}`)) : h('b', {}, '—'))))));
  }
  const tabela = h('div', { class: 'card sv-tab' },
    h('table', {}, h('thead', {}, h('tr', {}, ['Data', 'Origem', 'Descrição do link / cliente', 'Forma', 'Valor', 'Líquido', 'Pré-venda'].map((c, i) => h('th', { class: i >= 4 && i <= 5 ? 'num' : '' }, c)))), tbody),
    pags > 1 ? h('div', { class: 'cc-pag' }, h('span', {}, `${int.format((SV.pagina - 1) * SV.por + 1)}–${int.format(Math.min(lista.length, SV.pagina * SV.por))} de ${int.format(lista.length)}`),
      h('div', { class: 'pg' },
        h('button', { type: 'button', disabled: SV.pagina <= 1, 'aria-label': 'Página anterior', onclick: (e) => { e.stopPropagation(); SV.pagina--; svRedesenha(); } }, '‹'),
        h('span', { style: 'padding:0 8px' }, `${SV.pagina} / ${pags}`),
        h('button', { type: 'button', disabled: SV.pagina >= pags, 'aria-label': 'Próxima página', onclick: (e) => { e.stopPropagation(); SV.pagina++; svRedesenha(); } }, '›'))) : null);
  wrap.append(tabela);
  return wrap;
}
