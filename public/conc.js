/* Serena Financeiro — Conciliação: pré-vendas do Picking x recebimentos do extrato */
'use strict';

const hojeISO = () => { const d = new Date(Date.now() - 3 * 3600e3); return d.toISOString().slice(0, 10); };
const mais = (iso, n) => new Date(Date.parse(iso + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const PRESETS = {
  hoje: ['Hoje', () => [hojeISO(), hojeISO()]],
  d7: ['7 dias', () => [mais(hojeISO(), -6), hojeISO()]],
  d30: ['30 dias', () => [mais(hojeISO(), -29), hojeISO()]],
  mes: ['Este mês', () => [hojeISO().slice(0, 8) + '01', hojeISO()]],
  ant: ['Mês passado', () => { const i = new Date(Date.parse(hojeISO().slice(0, 8) + '01T12:00:00Z')); i.setUTCMonth(i.getUTCMonth() - 1); const a = i.toISOString().slice(0, 10); return [a, mais(hojeISO().slice(0, 8) + '01', -1)]; }],
};
const MARGENS = [1, 5, 10, 20, 50, 100];
const lerLS = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch (e) { return d; } };
const C = {
  preset: 'd30', de: PRESETS.d30[1]()[0], ate: PRESETS.d30[1]()[1], status: 'pendentes', vendedora: '', busca: '',
  margem: Number(lerLS('fin_conc_margem', 10)) || 10, pagina: 1, por: Number(lerLS('fin_conc_por', 20)) || 20,
  data: null, carregando: false, chave: '',
  sel: null, det: null, detCarregando: false, marc: new Set(), extras: new Map(), buscaRec: '', obs: '',
};
const sinal = (v) => (v > 0 ? '+' : v < 0 ? '−' : '') + brl.format(Math.abs(v));
const dDia = (iso) => { const p = String(iso).slice(0, 10).split('-'); return `${+p[2]}/${p[1]}`; };
const ehAdmin = () => S.me && S.me.role === 'admin';
// Redesenha só a tela de conciliação, parte por parte, sem tirar o foco de quem está digitando nos filtros
function rr() {
  const root = document.querySelector('.body.cc');
  if (!root || S.tela !== 'conciliacao') { render(); return; }
  const novo = telaConciliacao();
  const velhos = [...root.children], novos = [...novo.children];
  if (velhos.length !== novos.length) { root.replaceWith(novo); return; }
  velhos.forEach((v, i) => { if (v.contains(document.activeElement) && v.classList.contains('cc-filtros')) return; v.replaceWith(novos[i]); });
}

/* ---------- dados ---------- */
function chaveLista() { return JSON.stringify([C.de, C.ate, C.status, C.vendedora, C.busca, C.margem, C.pagina, C.por]); }
async function carregaLista(silencioso) {
  const chave = chaveLista();
  C.carregando = true; C.chave = chave;
  if (!silencioso) rr();
  try {
    const r = await api('conc_lista', { de: C.de, ate: C.ate, status: C.status, vendedora: C.vendedora, busca: C.busca, margem: C.margem, pagina: C.pagina, por: C.por });
    if (C.chave !== chave) return; // o usuário mudou o filtro no meio
    C.data = r; C.pagina = r.pagina;
    if (C.sel && !r.itens.some((p) => p.id === C.sel)) { /* selecionada saiu da página: mantém o painel aberto */ }
    if (!C.sel && r.itens.length && window.innerWidth > 980) seleciona(r.itens[0].id, true);
  } catch (e) { toast(e.message, true); }
  C.carregando = false;
  rr();
}
async function carregaDet() {
  const id = C.sel; if (!id) return;
  C.detCarregando = true; rr();
  try {
    const r = await api('conc_sugestoes', { pedido: id, margem: C.margem, busca: C.buscaRec });
    if (C.sel !== id) return;
    C.det = r;
    // pré-marca o melhor candidato quando ele é de alta confiança
    if (!C.marc.size && r.candidatos?.[0]?.nivel === 'alta') C.marc.add(r.candidatos[0].id);
  } catch (e) { toast(e.message, true); }
  C.detCarregando = false; rr();
}
function seleciona(id, semRender) {
  if (C.sel === id) return;
  C.sel = id; C.det = null; C.marc = new Set(); C.extras = new Map(); C.buscaRec = ''; C.obs = '';
  carregaDet();
  if (!semRender) rr();
  if (window.innerWidth <= 980) setTimeout(() => document.querySelector('.cc-det')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
}
function mudaFiltro(f) { Object.assign(C, f, { pagina: f.pagina || 1 }); carregaLista(); }
// chamado pelo sino quando chega lançamento novo: atualiza sem piscar a tela
function concNovos() { carregaLista(true); if (C.sel && !C.det?.conc) carregaDet(); }

/* ---------- ações ---------- */
async function conciliar(pedidos, lancamentos, btn) {
  if (!ehAdmin()) { toast('Só administradores conciliam.', true); return; }
  if (btn) { btn.disabled = true; btn.textContent = 'Conciliando…'; }
  try {
    const r = await api('conc_criar', { pedidos, lancamentos, obs: C.obs });
    toast(Math.abs(r.diferenca) < 0.005 ? `${pedidos.join(' + ')} conciliada.` : `${pedidos.join(' + ')} conciliada (diferença ${sinal(r.diferenca)}).`);
    // segue para a próxima pendente da lista
    const it = C.data?.itens || [];
    const i = it.findIndex((p) => p.id === pedidos[0]);
    const prox = it.slice(i + 1).find((p) => !p.conc_id && !pedidos.includes(p.id)) || it.find((p) => !p.conc_id && !pedidos.includes(p.id));
    C.sel = null; C.det = null;
    await carregaLista(true);
    if (prox && C.data.itens.some((p) => p.id === prox.id)) seleciona(prox.id);
    else if (pedidos[0]) seleciona(pedidos[0]);
  } catch (e) { toast(e.message, true); if (btn) { btn.disabled = false; btn.textContent = 'Conciliar'; } }
}
async function desfazer(id, btn) {
  if (btn.dataset.armado !== '1') { btn.dataset.armado = '1'; btn.textContent = 'Clique de novo para desfazer'; setTimeout(() => { btn.dataset.armado = ''; btn.textContent = 'Desfazer conciliação'; }, 4000); return; }
  btn.disabled = true;
  try { await api('conc_desfazer', { id }); toast('Conciliação desfeita.'); const s = C.sel; C.det = null; C.sel = null; await carregaLista(true); seleciona(s); }
  catch (e) { toast(e.message, true); btn.disabled = false; }
}

/* ---------- tela ---------- */
function telaConciliacao() {
  const wrap = h('div', { class: 'body cc' });
  if (!C.data && !C.carregando) { carregaLista(true); }
  wrap.append(h('header', { class: 'head' }, h('h1', {}, 'Conciliação de pré-vendas'),
    h('p', {}, 'Ligue cada pré-venda do Picking ao recebimento que caiu no banco. As sugestões comparam o valor (com margem de ',
      h('b', {}, brl.format(C.margem)), '), o nome de quem pagou e a data.')));
  wrap.append(resumoConc(), filtrosConc());
  if (!C.data) { wrap.append(h('div', { class: 'loading' }, 'Carregando pré-vendas…')); return wrap; }
  wrap.append(h('div', { class: 'cc-grid' + (C.carregando ? ' busy' : '') }, listaConc(), painelConc()));
  return wrap;
}

function resumoConc() {
  const r = C.data?.resumo;
  const t = (k, v, s, extra, cls) => h('div', { class: 'card tile ' + (cls || '') }, h('div', { class: 'k' }, k), h('b', { class: 'v' }, v), h('div', { class: 's' }, s), extra || null);
  if (!r) return h('section', { class: 'tiles' }, ['Pré-vendas', 'Conciliadas', 'Pendentes', 'Recebimentos sem pré-venda'].map((k) => t(k, '—', ' ')));
  const pct = r.qtd ? Math.round((r.conc_qtd / r.qtd) * 100) : 0;
  return h('section', { class: 'tiles' },
    t('Pré-vendas no período', int.format(r.qtd), brl.format(r.valor)),
    t('Conciliadas', `${int.format(r.conc_qtd)}`, `${brl.format(r.conc_valor)} · ${pct}%`, h('div', { class: 'cc-prog', role: 'progressbar', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('i', { style: `width:${pct}%` })), 'ok'),
    t('Pendentes', int.format(r.pend_qtd), brl.format(r.pend_valor), null, r.pend_qtd ? 'warn' : ''),
    t('Recebimentos sem pré-venda', int.format(r.receb_soltos_qtd), `${brl.format(r.receb_soltos_valor)} em PIX, TED e boletos de clientes`));
}

function filtrosConc() {
  const de = h('input', { type: 'date', value: C.de, max: C.ate, 'aria-label': 'De', onchange: () => de.value && mudaFiltro({ de: de.value, preset: '' }) });
  const ate = h('input', { type: 'date', value: C.ate, min: C.de, 'aria-label': 'Até', onchange: () => ate.value && mudaFiltro({ ate: ate.value, preset: '' }) });
  let t;
  const busca = h('input', { type: 'search', placeholder: 'Cliente, nº da pré-venda, vendedora ou valor', value: C.busca, 'aria-label': 'Buscar pré-venda',
    oninput: () => { clearTimeout(t); t = setTimeout(() => mudaFiltro({ busca: busca.value.trim() }), 400); } });
  busca.className = 'cc-busca';
  const r = C.data?.resumo;
  const st = [['pendentes', 'Pendentes', r?.pend_qtd], ['conciliados', 'Conciliadas', r?.conc_qtd], ['todos', 'Todas', r?.qtd]];
  return h('section', { class: 'card cc-filtros' },
    h('div', { class: 'cc-f1' },
      h('div', { class: 'seg', role: 'group', 'aria-label': 'Período' },
        Object.entries(PRESETS).map(([k, [rot, f]]) => h('button', { type: 'button', 'aria-pressed': String(C.preset === k), onclick: () => { const [a, b] = f(); mudaFiltro({ preset: k, de: a, ate: b }); } }, rot))),
      h('div', { class: 'cc-datas' }, de, h('span', {}, 'até'), ate),
      h('div', { class: 'seg cc-status', role: 'group', 'aria-label': 'Situação' },
        st.map(([k, rot, n]) => h('button', { type: 'button', 'aria-pressed': String(C.status === k), onclick: () => mudaFiltro({ status: k }) }, rot, n != null ? h('small', {}, ` ${n}`) : null)))),
    h('div', { class: 'cc-f2' },
      busca,
      h('select', { 'aria-label': 'Vendedora', onchange: (e) => mudaFiltro({ vendedora: e.target.value }) },
        h('option', { value: '' }, 'Todas as vendedoras'), (C.data?.vendedoras || []).map((v) => h('option', { value: v, selected: C.vendedora === v }, v))),
      h('label', { class: 'cc-margem', title: 'Diferença aceita entre o valor da pré-venda e o valor pago' }, 'Margem ±',
        h('select', { onchange: (e) => { try { localStorage.setItem('fin_conc_margem', e.target.value); } catch (x) { /* */ } C.det = null; mudaFiltro({ margem: Number(e.target.value), pagina: C.pagina }); if (C.sel) carregaDet(); } },
          MARGENS.map((m) => h('option', { value: m, selected: C.margem === m }, brl.format(m)))))));
}

function nivelTxt(n) { return { alta: 'Alta', media: 'Média', baixa: 'Baixa' }[n] || ''; }
function listaConc() {
  const d = C.data;
  const col = h('section', { class: 'cc-lista', 'aria-label': 'Pré-vendas' });
  if (!d.itens.length) {
    col.append(h('div', { class: 'card empty' }, h('h2', {}, C.status === 'pendentes' && d.resumo.qtd ? 'Nada pendente aqui' : 'Nenhuma pré-venda encontrada'),
      h('p', {}, C.status === 'pendentes' && d.resumo.qtd ? 'Todas as pré-vendas deste período e filtro já foram conciliadas.' : 'Ajuste o período, a vendedora ou a busca.')));
    return col;
  }
  const ul = h('ul', { class: 'cc-itens', role: 'listbox', 'aria-label': 'Pré-vendas' });
  for (const p of d.itens) {
    const conc = p.conc;
    const m = p.sug?.melhor;
    const estado = conc ? 'ok' : m?.nivel === 'alta' ? 'alta' : m ? 'sug' : 'nada';
    const linhaSug = conc
      ? h('div', { class: 'cc-hint ok' }, h('span', { class: 'ic' }, '✓'),
          `Conciliada · ${conc.recebimentos.length === 1 ? (conc.recebimentos[0].pagador || 'recebimento') + ' · ' + dDia(conc.recebimentos[0].data) : conc.recebimentos.length + ' recebimentos'}`,
          Math.abs(conc.diferenca) >= 0.005 ? h('em', { class: 'dif' }, ` ${sinal(conc.diferenca)}`) : null)
      : m ? h('div', { class: 'cc-hint ' + m.nivel },
          h('span', { class: 'pill ' + m.nivel }, nivelTxt(m.nivel)),
          h('b', {}, brl.format(m.valor)), ` · ${m.pagador || 'sem nome'} · ${dDia(m.data)}`,
          h('em', {}, ` · ${m.motivos[0]}`), p.sug.n > 1 ? h('span', { class: 'mais' }, ` +${p.sug.n - 1}`) : null)
      : h('div', { class: 'cc-hint nada' }, 'Nenhum recebimento parecido ainda');
    const rapido = !conc && m?.nivel === 'alta' && ehAdmin()
      ? h('button', { type: 'button', class: 'btn small cc-rapido', title: `Conciliar com ${brl.format(m.valor)} de ${m.pagador}`, onclick: (e) => { e.stopPropagation(); conciliar([p.id], [m.id], e.currentTarget); } }, 'Conciliar')
      : null;
    const li = h('li', { class: `cc-item ${estado}${C.sel === p.id ? ' sel' : ''}`, role: 'option', tabindex: 0, 'aria-selected': String(C.sel === p.id), 'data-id': p.id,
      onclick: () => seleciona(p.id), onkeydown: (e) => navLista(e, p.id) },
      h('div', { class: 'cc-l1' },
        h('b', { class: 'num' }, p.id), p.doc && p.doc !== 'Pré-venda' ? h('span', { class: 'chip' }, p.doc) : null,
        h('span', { class: 'quando' }, `${dia(p.data)}${p.hora ? ' · ' + p.hora : ''}`),
        h('b', { class: 'tot' }, brl.format(p.total))),
      h('div', { class: 'cc-l2' }, h('span', { class: 'cli' }, p.cliente || '—'), h('span', { class: 'vend' }, [p.vendedora, p.cidade].filter(Boolean).join(' · '))),
      h('div', { class: 'cc-l3' }, linhaSug, rapido));
    ul.append(li);
  }
  col.append(ul, paginacao());
  return col;
}
function navLista(e, id) {
  const it = C.data.itens, i = it.findIndex((p) => p.id === id);
  const ir2 = (j) => { if (j < 0 || j >= it.length) return; e.preventDefault(); seleciona(it[j].id); setTimeout(() => document.querySelector(`.cc-item[data-id="${it[j].id}"]`)?.focus(), 0); };
  if (e.key === 'ArrowDown') ir2(i + 1); else if (e.key === 'ArrowUp') ir2(i - 1);
  else if (e.key === 'Enter') { e.preventDefault(); seleciona(id); }
}
function paginacao() {
  const d = C.data;
  const ini = (d.pagina - 1) * d.por + 1, fim = Math.min(d.total, d.pagina * d.por);
  const pags = [];
  for (let i = 1; i <= d.paginas; i++) if (i === 1 || i === d.paginas || Math.abs(i - d.pagina) <= 1) pags.push(i); else if (pags[pags.length - 1] !== '…') pags.push('…');
  return h('nav', { class: 'cc-pag', 'aria-label': 'Páginas' },
    h('span', {}, `${int.format(ini)}–${int.format(fim)} de ${int.format(d.total)}`),
    h('div', { class: 'pg' },
      h('button', { type: 'button', disabled: d.pagina <= 1, 'aria-label': 'Página anterior', onclick: () => mudaFiltro({ pagina: d.pagina - 1 }) }, '‹'),
      pags.map((n) => n === '…' ? h('span', { class: 'ret' }, '…') : h('button', { type: 'button', 'aria-current': n === d.pagina ? 'page' : null, onclick: () => mudaFiltro({ pagina: n }) }, String(n))),
      h('button', { type: 'button', disabled: d.pagina >= d.paginas, 'aria-label': 'Próxima página', onclick: () => mudaFiltro({ pagina: d.pagina + 1 }) }, '›')),
    h('select', { 'aria-label': 'Itens por página', onchange: (e) => { try { localStorage.setItem('fin_conc_por', e.target.value); } catch (x) { /* */ } mudaFiltro({ por: Number(e.target.value) }); } },
      [20, 50, 100].map((n) => h('option', { value: n, selected: d.por === n }, `${n} por página`))));
}

/* ---------- painel da pré-venda selecionada ---------- */
function painelConc() {
  const box = h('aside', { class: 'cc-det card', 'aria-label': 'Detalhes da pré-venda' });
  if (!C.sel) { box.append(h('div', { class: 'cc-vazio' }, h('b', {}, 'Escolha uma pré-venda'), h('p', {}, 'Clique numa pré-venda da lista para ver os recebimentos sugeridos e conciliar.'))); return box; }
  const d = C.det;
  const p = d?.pedido || C.data.itens.find((x) => x.id === C.sel);
  if (!p) { box.append(h('div', { class: 'loading' }, 'Carregando…')); return box; }
  box.append(h('div', { class: 'cc-cab' },
    h('div', {}, h('div', { class: 'k' }, `${p.id}${p.doc && p.doc !== 'Pré-venda' ? ' · ' + p.doc : ''} · ${diaAno(p.data)}${p.hora ? ' · ' + p.hora : ''}`),
      h('h2', {}, p.cliente || '—'), h('div', { class: 's' }, [p.vendedora, p.cidade, p.itens ? `${p.itens} ite${p.itens === 1 ? 'm' : 'ns'}` : null].filter(Boolean).join(' · '))),
    h('div', { class: 'cc-total' }, h('span', {}, 'Total'), h('b', {}, brl.format(Number(p.total))))));
  if (!d) { box.append(h('div', { class: 'loading' }, 'Buscando recebimentos…')); return box; }
  if (d.conc) { box.append(blocoConciliada(d.conc)); return box; }
  box.append(blocoSugestoes(d, p));
  return box;
}

function blocoConciliada(c) {
  const dif = c.diferenca;
  return h('div', { class: 'cc-feito' },
    h('div', { class: 'cc-selo' }, h('span', { class: 'ic' }, '✓'), h('div', {}, h('b', {}, 'Conciliada'), h('div', { class: 's' }, `em ${quando(c.criado)} por ${c.por}`))),
    c.pedidos_det?.length > 1 ? h('div', { class: 'cc-sub' }, h('h3', {}, 'Pré-vendas juntas'), c.pedidos_det.map((x) => h('div', { class: 'cc-linha' }, h('span', {}, `${x.id} · ${x.cliente}`), h('b', {}, brl.format(Number(x.total)))))) : null,
    h('div', { class: 'cc-sub' }, h('h3', {}, c.recebimentos.length === 1 ? 'Recebimento' : `${c.recebimentos.length} recebimentos`),
      c.recebimentos.map((r) => h('div', { class: 'cc-linha' }, h('span', {}, h('span', { class: 'bk ' + (r.banco || '') }, r.banco === 'stone' ? 'Stone' : 'Bradesco'), ` ${dDia(r.data)} · ${r.pagador || r.descricao}`), h('b', {}, brl.format(r.valor))))),
    h('div', { class: 'cc-conta' },
      h('div', {}, h('span', {}, 'Pré-venda'), h('b', {}, brl.format(c.total_pedidos))),
      h('div', {}, h('span', {}, 'Recebido'), h('b', {}, brl.format(c.total_pagos))),
      h('div', { class: Math.abs(dif) < 0.005 ? 'zero' : 'dif' }, h('span', {}, 'Diferença'), h('b', {}, Math.abs(dif) < 0.005 ? 'R$ 0,00' : sinal(dif)))),
    c.obs ? h('p', { class: 'cc-obs' }, `Obs.: ${c.obs}`) : null,
    ehAdmin() ? h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn dang', onclick: (e) => desfazer(c.id, e.currentTarget) }, 'Desfazer conciliação')) : null);
}

function blocoSugestoes(d, p) {
  const frag = h('div', { class: 'cc-sug' });
  const totalPed = Number(p.total) + [...C.extras.values()].reduce((s, x) => s + Number(x.total), 0);
  const todos = new Map((d.candidatos || []).map((c) => [c.id, c]));
  for (const cb of d.combos || []) if (!todos.has(cb.id)) todos.set(cb.id, cb);
  const marcados = [...C.marc].map((id) => todos.get(id)).filter(Boolean);
  const pago = marcados.reduce((s, c) => s + c.valor, 0);
  const dif = Math.round((pago - totalPed) * 100) / 100;

  // pagamento único que cobre esta pré-venda e outra do mesmo cliente
  if (d.combos?.length) frag.append(h('div', { class: 'cc-combo' },
    h('b', {}, 'Um pagamento parece cobrir mais de uma pré-venda'),
    d.combos.map((cb) => { const o = d.mesmo_cliente.find((x) => x.id === cb.junto); return h('div', { class: 'cc-linha' },
      h('span', {}, `${brl.format(cb.valor)} de ${cb.pagador || 'cliente'} (${dDia(cb.data)}) = ${p.id} + ${cb.junto}`),
      h('button', { type: 'button', class: 'btn small sec', onclick: () => { C.marc = new Set([cb.id]); if (o) C.extras.set(o.id, o); rr(); } }, 'Usar')); })));

  // recebimentos sugeridos
  const lista = h('div', { class: 'cc-cands', role: 'group', 'aria-label': 'Recebimentos sugeridos' });
  const cands = d.candidatos || [];
  if (!cands.length) lista.append(h('p', { class: 'cc-nada' }, `Nenhum recebimento livre com valor a ${brl.format(C.margem)} de ${brl.format(totalPed)} ou com nome parecido, entre ${dDia(mais(p.data, -5))} e ${dDia(mais(p.data, 45))}. Aumente a margem ou busque abaixo.`));
  for (const c of cands) {
    const on = C.marc.has(c.id);
    const ad = Math.abs(c.diff);
    const chipV = ad < 0.005 ? h('span', { class: 'chip ok' }, 'Valor exato') : ad <= C.margem + 0.001 ? h('span', { class: 'chip warn' }, sinal(c.diff)) : h('span', { class: 'chip off' }, sinal(c.diff));
    lista.append(h('button', { type: 'button', class: `cc-cand ${c.nivel}${on ? ' on' : ''}`, 'aria-pressed': String(on),
      onclick: () => { on ? C.marc.delete(c.id) : C.marc.add(c.id); rr(); } },
      h('span', { class: 'chk', 'aria-hidden': 'true' }, on ? '✓' : ''),
      h('span', { class: 'cc-cv' }, h('b', {}, brl.format(c.valor)), chipV),
      h('span', { class: 'cc-cp' }, h('b', {}, c.pagador || c.descricao), h('span', { class: 's' },
        h('span', { class: 'bk ' + c.banco }, c.banco === 'stone' ? 'Stone' : 'Bradesco'), ` ${dDia(c.data)}`, c.dias ? ` · ${c.dias > 0 ? c.dias + 'd depois' : -c.dias + 'd antes'}` : ' · mesmo dia')),
      h('span', { class: 'cc-cs' }, h('span', { class: 'pill ' + c.nivel }, nivelTxt(c.nivel)),
        h('span', { class: 'bar', title: `Pontuação ${c.score} de 100` }, h('i', { style: `width:${c.score}%` })),
        h('span', { class: 'mot' }, c.motivos.filter((m) => m !== 'Valor exato').join(' · ')))));
  }
  frag.append(h('h3', {}, 'Recebimentos sugeridos'), lista);

  // busca manual
  const bq = h('input', { type: 'search', placeholder: 'Nome de quem pagou ou valor (ex.: 450,00)', value: C.buscaRec, 'aria-label': 'Buscar recebimento' });
  const buscar = () => { C.buscaRec = bq.value.trim(); carregaDet(); };
  bq.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); buscar(); } });
  frag.append(h('div', { class: 'cc-busca2' }, h('span', {}, 'Não achou?'), bq, h('button', { type: 'button', class: 'btn sec small', onclick: buscar }, 'Buscar')));

  // outras pré-vendas do mesmo cliente (um PIX pagando várias)
  const outras = (d.mesmo_cliente || []);
  if (outras.length) frag.append(h('div', { class: 'cc-juntar' }, h('span', {}, 'Mesmo cliente, ainda pendentes:'),
    outras.map((o) => { const on = C.extras.has(o.id); return h('button', { type: 'button', class: 'chip-btn' + (on ? ' on' : ''), 'aria-pressed': String(on),
      onclick: () => { on ? C.extras.delete(o.id) : C.extras.set(o.id, o); rr(); } }, `${on ? '✓ ' : '+ '}${o.id} · ${brl.format(Number(o.total))}`); })));

  // rodapé com a conta e o botão
  const ok = marcados.length && Math.abs(dif) <= C.margem + 0.001;
  const obs = h('input', { type: 'text', placeholder: 'Observação (opcional)', value: C.obs, maxlength: 300, 'aria-label': 'Observação', oninput: (e) => { C.obs = e.target.value; } });
  const btn = h('button', { type: 'button', class: 'btn' + (marcados.length && !ok ? ' warn' : ''), disabled: !marcados.length || !ehAdmin(),
    onclick: (e) => conciliar([p.id, ...C.extras.keys()], [...C.marc], e.currentTarget) },
    !marcados.length ? 'Escolha o recebimento' : ok ? 'Conciliar' : 'Conciliar com diferença');
  frag.append(h('div', { class: 'cc-rodape' },
    h('div', { class: 'cc-conta' },
      h('div', {}, h('span', {}, C.extras.size ? `${1 + C.extras.size} pré-vendas` : 'Pré-venda'), h('b', {}, brl.format(totalPed))),
      h('div', {}, h('span', {}, marcados.length > 1 ? `${marcados.length} recebimentos` : 'Recebido'), h('b', {}, marcados.length ? brl.format(pago) : '—')),
      h('div', { class: !marcados.length ? '' : Math.abs(dif) < 0.005 ? 'zero' : ok ? 'perto' : 'dif' }, h('span', {}, 'Diferença'), h('b', {}, marcados.length ? (Math.abs(dif) < 0.005 ? 'R$ 0,00' : sinal(dif)) : '—'))),
    h('div', { class: 'cc-acao' }, obs, btn),
    !ehAdmin() ? h('p', { class: 'meta' }, 'Só administradores podem conciliar.') : null));
  return frag;
}
