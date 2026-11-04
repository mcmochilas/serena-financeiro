/* Serena Financeiro — app (login, extrato, configurações) */
'use strict';
const API = 'https://dtrfujxhfcyefbipkcwz.supabase.co/functions/v1/fin-api';
const TK = 'fin_token';

/* ---------- utilidades ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}
const meses = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const brlCurto = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', notation: 'compact', maximumFractionDigits: 1 });
const int = new Intl.NumberFormat('pt-BR');
const dia = (s) => { const p = String(s).slice(0, 10).split('-'); return `${+p[2]} ${meses[+p[1] - 1]}`; };
const diaAno = (s) => { const p = String(s).slice(0, 10).split('-'); return `${+p[2]} ${meses[+p[1] - 1]} ${p[0]}`; };
const quando = (iso) => { if (!iso) return ''; const d = new Date(iso); return d.toLocaleDateString('pt-BR') + ' às ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }); };
const parse = (s) => new Date(String(s).slice(0, 10) + 'T00:00:00Z');
const COR = { entrada: '#16658A', saida: '#C79136', muted: '#D9CFBF' };
const DIAS = { '7d': 7, '30d': 30, '90d': 90 };
let toastT;
function toast(msg, err) {
  const t = $('#toast'); t.textContent = msg; t.className = err ? 'err' : ''; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 3800);
}

async function api(op, body = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const t = localStorage.getItem(TK); if (t) headers['x-fin-token'] = t;
  let r;
  try { r = await fetch(API, { method: 'POST', headers, body: JSON.stringify({ op, ...body }) }); }
  catch (e) { throw new Error('Sem conexão com o servidor. Verifique a internet.'); }
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && op !== 'login') { localStorage.removeItem(TK); S.me = null; render(); throw new Error(j.erro || 'Sessão expirada.'); }
  if (!r.ok) throw new Error(j.erro || `Erro ${r.status}`);
  return j;
}

/* ---------- estado ---------- */
const S = {
  me: null, tela: location.hash === '#configuracoes' ? 'configuracoes' : 'extrato', cfg: 'apis',
  periodo: '30d', tipo: 'todos', busca: '',
  ext: null, cred: null, users: null,
};

/* ---------- login ---------- */
function telaLogin() {
  const err = h('div', { class: 'lg-err' });
  const u = h('input', { autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false' });
  const p = h('input', { type: 'password', inputmode: 'numeric', autocomplete: 'current-password' });
  const btn = h('button', { class: 'btn', type: 'submit' }, 'Entrar');
  const entrar = async (ev) => {
    ev.preventDefault(); err.textContent = ''; btn.disabled = true;
    try {
      const r = await api('login', { login: u.value, pin: p.value });
      localStorage.setItem(TK, r.token); S.me = r.me; S.ext = S.cred = S.users = null; render();
    } catch (e) { err.textContent = e.message; btn.disabled = false; p.select(); }
  };
  const f = h('form', { class: 'lg-box', onsubmit: entrar },
    h('img', { class: 'lg-logo', src: '/logo-claro.png', alt: 'Serena Puxadores' }),
    h('div', { class: 'lg-tag' }, 'Financeiro'),
    h('label', {}, 'Usuário'), u, h('label', {}, 'PIN'), p, btn, err);
  setTimeout(() => u.focus(), 0);
  return h('div', { class: 'lg' }, f);
}

/* ---------- topo ---------- */
const GEAR = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8.9 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.54 15a1.7 1.7 0 0 0-1.56-1.03H2.9a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 8.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1.03-1.56V2.9a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9c.26.6.86 1 1.52 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.56 1.03z"/></svg>';
function ir(tela) { S.tela = tela; history.replaceState(null, '', tela === 'extrato' ? '#' : '#configuracoes'); render(); }
function topo() {
  const gear = h('button', { class: 'gear', type: 'button', title: 'Configurações', 'aria-label': 'Configurações', 'aria-current': S.tela === 'configuracoes' ? 'page' : null, onclick: () => ir('configuracoes') });
  gear.innerHTML = GEAR;
  return h('div', { class: 'top' },
    h('div', { class: 'brand' }, h('img', { src: '/logo-escuro.png', alt: 'Serena Puxadores' }), h('span', { class: 'div' }), h('span', { class: 'tag' }, 'Financeiro')),
    h('nav', { class: 'mods', 'aria-label': 'Módulos' },
      h('button', { type: 'button', 'aria-current': S.tela === 'extrato' ? 'page' : null, onclick: () => ir('extrato') }, 'Extrato'),
      ['Conciliação', 'Contas a pagar e receber', 'Fluxo de caixa', 'DRE'].map((m) => h('button', { type: 'button', disabled: true }, m + ' ', h('small', {}, '· em breve'))),
      gear,
      h('span', { class: 'who' }, S.me.nome),
      h('button', { type: 'button', class: 'sair', onclick: sair }, 'Sair')));
}
async function sair() { try { await api('logout'); } catch (e) { /* ignora */ } localStorage.removeItem(TK); S.me = null; render(); }

async function sincronizar(btn, dias) {
  const t = btn.textContent; btn.disabled = true; btn.textContent = 'Sincronizando…';
  try { const r = await api('sync', { dias }); S.ext = null; S.cred = null; toast(`${r.n} lançamentos sincronizados${r.saldo != null ? ' · saldo ' + brl.format(r.saldo) : ''}.`); render(); }
  catch (e) { toast(e.message, true); btn.disabled = false; btn.textContent = t; }
}

/* ---------- extrato: cálculos ---------- */
function ordenados(rows) { return rows.map((r) => ({ ...r, valor: Number(r.valor), saldo: r.saldo == null ? null : Number(r.saldo), data: String(r.data).slice(0, 10) })); }
function corte(rows) {
  const fim = rows.reduce((m, r) => (r.data > m ? r.data : m), '');
  return new Date(Date.parse(fim + 'T00:00:00Z') - (DIAS[S.periodo] - 1) * 864e5).toISOString().slice(0, 10);
}
function saldoAte(rows, i) { // saldo após a linha i (usa o do banco; se faltar, soma)
  if (rows[i].saldo != null) return rows[i].saldo;
  let s = 0; for (let k = 0; k <= i; k++) s += rows[k].valor; return Math.round(s * 100) / 100;
}
function resumo(rows) {
  const c = corte(rows), r2 = (v) => Math.round(v * 100) / 100;
  const dentro = rows.filter((r) => r.data >= c);
  const iAntes = rows.findIndex((r) => r.data >= c) - 1;
  const entradas = dentro.filter((r) => r.valor > 0).reduce((s, r) => s + r.valor, 0);
  const saidas = -dentro.filter((r) => r.valor < 0).reduce((s, r) => s + r.valor, 0);
  const ini = iAntes >= 0 ? saldoAte(rows, iAntes) : (rows[0].saldo != null ? rows[0].saldo - rows[0].valor : 0);
  return { inicio: c, entradas: r2(entradas), saidas: r2(saidas), resultado: r2(entradas - saidas), saldo_inicial: r2(ini), saldo_final: saldoAte(rows, rows.length - 1), n: dentro.length };
}
function diario(rows) {
  const m = new Map();
  rows.forEach((r, i) => {
    const d = m.get(r.data) || { dia: r.data, e: 0, s: 0, saldo: 0 };
    if (r.valor > 0) d.e += r.valor; else d.s -= r.valor;
    d.saldo = saldoAte(rows, i); m.set(r.data, d);
  });
  const c = corte(rows);
  return [...m.values()].filter((d) => d.dia >= c);
}
function categorias(rows) {
  const c = corte(rows), m = new Map();
  rows.filter((r) => r.data >= c && r.valor < 0).forEach((r) => m.set(r.categoria, (m.get(r.categoria) || 0) - r.valor));
  return [...m.entries()].map(([categoria, v]) => ({ categoria, v: Math.round(v * 100) / 100 })).sort((a, b) => b.v - a.v);
}

/* ---------- extrato: tela ---------- */
function telaExtrato() {
  const wrap = h('div', { class: 'body' });
  if (!S.ext) {
    wrap.append(h('div', { class: 'loading' }, 'Carregando extrato…'));
    api('extrato', { banco: 'bradesco' }).then((r) => { S.ext = r; render(); }).catch((e) => toast(e.message, true));
    return wrap;
  }
  const rows = ordenados(S.ext.rows || []);
  wrap.append(h('header', { class: 'head' }, h('h1', {}, 'Extrato financeiro'),
    rows.length ? frase(rows) : h('p', {}, 'Conta corrente PJ Bradesco.')));
  wrap.append(h('div', { class: 'bar' },
    h('div', { class: 'chips', role: 'group', 'aria-label': 'Conta' }, h('span', { class: 'lbl' }, 'Conta'),
      h('button', { type: 'button', 'aria-pressed': 'true' }, 'Bradesco · conta corrente PJ'),
      h('button', { type: 'button', disabled: true }, 'Stone ', h('small', {}, '· em breve'))),
    rows.length ? h('div', { class: 'chips' },
      S.me.role === 'admin' ? h('button', { type: 'button', class: 'btn sec small', onclick: (ev) => sincronizar(ev.currentTarget, 90) }, 'Sincronizar') : null,
      h('div', { class: 'seg', role: 'group', 'aria-label': 'Período' },
        Object.keys(DIAS).map((p) => h('button', { type: 'button', 'aria-pressed': String(S.periodo === p), onclick: () => { S.periodo = p; render(); } }, `${DIAS[p]} dias`)))) : null));

  if (!rows.length) {
    const admin = S.me.role === 'admin';
    wrap.append(h('div', { class: 'card empty' },
      h('h2', {}, 'Ainda não há lançamentos'),
      h('p', {}, S.ext.configurado
        ? 'As credenciais do Bradesco já estão guardadas. Clique em sincronizar para puxar o extrato do banco.'
        : 'Para puxar o extrato, cadastre em Configurações › APIs o Client ID, o Client Secret, a agência, a conta e o certificado digital (.pfx) do Bradesco.'),
      admin && !S.ext.configurado ? h('button', { class: 'btn', type: 'button', onclick: () => { S.cfg = 'apis'; ir('configuracoes'); } }, 'Abrir configurações de API') : null,
      admin && S.ext.configurado ? h('button', { class: 'btn', type: 'button', onclick: (ev) => sincronizar(ev.currentTarget, 90) }, 'Sincronizar últimos 90 dias') : null));
    return wrap;
  }

  const r = resumo(rows);
  const tile = (k, v, s, cls) => h('div', { class: 'card tile' }, h('div', { class: 'k' }, k), h('b', { class: 'v ' + (cls || '') }, v), h('div', { class: 's' }, s));
  wrap.append(h('section', { class: 'tiles' },
    (() => {
      const sd = S.ext.saldo;
      if (!sd || sd.total == null) return tile('Saldo atual', brl.format(r.saldo_final), `Era ${brl.format(r.saldo_inicial)} em ${diaAno(r.inicio)}`);
      const it = (cod) => (sd.itens || []).find((i) => i.codigo === cod && i.secao === 'saldoCC');
      const cc = it(998), inv = (sd.itens || []).filter((i) => i.secao !== 'saldoCC' && i.valor).reduce((t, i) => t + i.valor, 0);
      const partes = [cc ? `Conta ${brl.format(cc.valor)}` : null, inv ? `Invest Fácil ${brl.format(inv)}` : null].filter(Boolean).join(' + ');
      return tile('Saldo atual', brl.format(Number(sd.total)), `${partes ? partes + ' · ' : ''}consultado ${quando(sd.em)}`);
    })(),
    tile(`Entradas · últimos ${DIAS[S.periodo]} dias`, brl.format(r.entradas), 'PIX, boletos, TEDs e repasses'),
    tile(`Saídas · últimos ${DIAS[S.periodo]} dias`, brl.format(r.saidas), 'Fornecedores, folha, impostos e despesas'),
    tile('Resultado do período', brl.format(r.resultado), `Entradas menos saídas · ${int.format(r.n)} lançamentos`, r.resultado >= 0 ? 'pos' : 'neg')));

  const cSaldo = h('div', { class: 'chart' }), cFluxo = h('div', { class: 'chart short' }), cCats = h('div', { class: 'cats' });
  wrap.append(h('section', { class: 'grid' },
    h('div', { class: 'card wide' }, h('h2', {}, 'Saldo ao fim do dia'), h('p', { class: 'note' }, 'Saldo da conta após o último lançamento de cada dia com movimento.'), cSaldo),
    h('div', { class: 'card' }, h('h2', {}, 'Entradas e saídas por dia'), h('p', { class: 'note' }, 'Entradas acima da linha, saídas abaixo.'),
      h('div', { class: 'legend' }, h('span', {}, h('i', { class: 'sw', style: `background:${COR.entrada}` }), 'Entradas'), h('span', {}, h('i', { class: 'sw', style: `background:${COR.saida}` }), 'Saídas')), cFluxo),
    h('div', { class: 'card' }, h('h2', {}, 'Saídas por categoria'), h('p', { class: 'note' }, 'Para onde foi o dinheiro no período escolhido.'), cCats)));

  const tbody = h('tbody');
  const busca = h('input', { type: 'search', placeholder: 'Buscar descrição, categoria ou documento', 'aria-label': 'Buscar', value: S.busca, oninput: () => { S.busca = busca.value; tabela(rows, tbody); } });
  const tipo = h('select', { 'aria-label': 'Tipo', onchange: () => { S.tipo = tipo.value; tabela(rows, tbody); } },
    [['todos', 'Entradas e saídas'], ['Entrada', 'Só entradas'], ['Saída', 'Só saídas']].map(([v, t]) => h('option', { value: v, selected: S.tipo === v }, t)));
  wrap.append(h('section', { class: 'card' }, h('h2', {}, 'Lançamentos'), h('p', { class: 'note' }, 'Extrato da conta, do mais recente ao mais antigo.'),
    h('div', { class: 'tools' }, busca, tipo),
    h('div', { class: 'scroll' }, h('table', { class: 'tb' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Data'), h('th', {}, 'Descrição'), h('th', { class: 'hide-n' }, 'Categoria'), h('th', { class: 'hide-n' }, 'Doc.'), h('th', { class: 'num' }, 'Valor'), h('th', { class: 'num hide-n' }, 'Saldo'))),
      tbody))));
  tabela(rows, tbody);

  requestAnimationFrame(() => { grafSaldo(cSaldo, diario(rows)); grafFluxo(cFluxo, diario(rows)); grafCats(cCats, categorias(rows)); });
  return wrap;
}
function frase(rows) {
  const r = resumo(rows), top = categorias(rows)[0];
  return h('p', {}, `Nos últimos ${DIAS[S.periodo]} dias, entraram `, h('b', {}, brl.format(r.entradas)), ' e saíram ', h('b', {}, brl.format(r.saidas)), '.',
    top ? [' O maior grupo de saídas foi ', h('b', {}, top.categoria.toLowerCase()), ', com ', h('b', {}, brl.format(top.v)), '.'] : null);
}
function tabela(rows, tbody) {
  const c = corte(rows), b = S.busca.trim().toLowerCase();
  tbody.replaceChildren(...rows.map((r, i) => ({ ...r, s: saldoAte(rows, i) }))
    .filter((r) => r.data >= c && (S.tipo === 'todos' || r.tipo === S.tipo) && (!b || `${r.descricao} ${r.categoria} ${r.documento || ''}`.toLowerCase().includes(b)))
    .reverse()
    .map((r) => h('tr', {}, h('td', {}, dia(r.data)), h('td', {}, r.descricao), h('td', { class: 'hide-n' }, r.categoria), h('td', { class: 'doc hide-n' }, r.documento || ''),
      h('td', { class: 'num' + (r.valor > 0 ? ' pos' : '') }, (r.valor > 0 ? '+ ' : '− ') + brl.format(Math.abs(r.valor))), h('td', { class: 'num hide-n' }, brl.format(r.s)))));
}

/* ---------- gráficos ---------- */
function tip(el) {
  const t = h('div', { class: 'tip', hidden: true }); el.append(t);
  return {
    show(x, y, titulo, linhas) {
      t.replaceChildren(h('div', { class: 'd' }, titulo), ...linhas.map(([cor, n, v]) => h('div', {}, cor ? h('i', { class: 'sw', style: `background:${cor}` }) : null, `${n}: ${v}`)));
      t.hidden = false;
      const w = t.offsetWidth, hh = t.offsetHeight, W = el.clientWidth;
      let l = x + 12; if (l + w > W) l = Math.max(0, x - w - 12);
      t.style.left = l + 'px'; t.style.top = Math.max(0, y - hh - 8) + 'px';
    },
    hide() { t.hidden = true; },
  };
}
function medir(svg, textos) { const t = svg.append('text').attr('opacity', 0); const w = d3.max(textos, (s) => t.text(s).node().getComputedTextLength()) || 0; t.remove(); return w; }
function grafSaldo(el, dias) {
  el.replaceChildren(); if (!dias.length) return;
  const pts = dias.map((d) => ({ x: parse(d.dia), y: d.saldo, dia: d.dia }));
  const W = el.clientWidth || 600, H = 240, top = 12, bottom = 26, right = 8;
  const svg = d3.select(el).append('svg').attr('width', '100%').attr('viewBox', `0 0 ${W} ${H}`).attr('height', H);
  const [lo, hi] = d3.extent(pts, (d) => d.y), pad = (hi - lo) * 0.12 || Math.abs(hi) * 0.1 || 1;
  const y = d3.scaleLinear([Math.min(0, lo) < 0 ? lo - pad : Math.max(0, lo - pad), hi + pad], [H - bottom, top]).nice();
  const ticks = y.ticks(4), left = medir(svg, ticks.map((t) => brlCurto.format(t))) + 10;
  const x = d3.scaleUtc(pts.length > 1 ? d3.extent(pts, (d) => d.x) : [d3.utcDay.offset(pts[0].x, -1), pts[0].x], [left, W - right]);
  ticks.forEach((t) => {
    svg.append('line').attr('x1', left).attr('x2', W - right).attr('y1', y(t)).attr('y2', y(t)).attr('stroke', 'var(--grid)');
    svg.append('text').attr('x', left - 8).attr('y', y(t)).attr('dy', '0.32em').attr('text-anchor', 'end').text(brlCurto.format(t));
  });
  x.ticks(Math.max(2, Math.min(6, Math.floor((W - left) / 90)))).forEach((t) => svg.append('text').attr('x', x(t)).attr('y', H - 6).attr('text-anchor', 'middle').text(dia(t.toISOString())));
  const g = svg.append('defs').append('linearGradient').attr('id', 'gs').attr('x1', 0).attr('x2', 0).attr('y1', 0).attr('y2', 1);
  [[0, .26], [.25, .16], [.5, .08], [.75, .03], [1, 0]].forEach(([o, a]) => g.append('stop').attr('offset', o).attr('style', `stop-color:${COR.entrada};stop-opacity:${a}`));
  svg.append('path').datum(pts).attr('fill', 'url(#gs)').attr('d', d3.area().x((d) => x(d.x)).y0(H - bottom).y1((d) => y(d.y)));
  svg.append('path').datum(pts).attr('fill', 'none').attr('stroke', COR.entrada).attr('stroke-width', 2).attr('stroke-linejoin', 'round').attr('stroke-linecap', 'round').attr('d', d3.line().x((d) => x(d.x)).y((d) => y(d.y)));
  const dot = svg.append('circle').attr('r', 4).attr('fill', COR.entrada).attr('opacity', 0);
  const rule = svg.append('line').attr('y1', top).attr('y2', H - bottom).attr('stroke', '#8A6526').attr('opacity', 0);
  const tt = tip(el), bis = d3.bisector((d) => d.x).center;
  svg.append('rect').attr('x', left).attr('width', Math.max(0, W - left - right)).attr('height', H).attr('fill', 'transparent')
    .on('pointermove', (ev) => {
      const d = pts[bis(pts, x.invert(d3.pointer(ev)[0]))]; if (!d) return;
      dot.attr('cx', x(d.x)).attr('cy', y(d.y)).attr('opacity', 1); rule.attr('x1', x(d.x)).attr('x2', x(d.x)).attr('opacity', 1);
      const k = el.clientWidth / W; tt.show(x(d.x) * k, y(d.y) * k, diaAno(d.dia), [[null, 'Saldo', brl.format(d.y)]]);
    })
    .on('pointerleave', () => { dot.attr('opacity', 0); rule.attr('opacity', 0); tt.hide(); });
}
function grafFluxo(el, dias) {
  el.replaceChildren(); if (!dias.length) return;
  const W = el.clientWidth || 400, H = 200, top = 8, bottom = 24;
  const svg = d3.select(el).append('svg').attr('width', '100%').attr('viewBox', `0 0 ${W} ${H}`).attr('height', H);
  const m = d3.max(dias, (d) => Math.max(d.e, d.s)) || 1;
  const y = d3.scaleLinear([-m, m], [H - bottom, top]).nice(), ticks = y.ticks(4), fmt = (t) => brlCurto.format(Math.abs(t));
  const left = medir(svg, ticks.map(fmt)) + 10;
  const x = d3.scaleBand(dias.map((d) => d.dia), [left, W - 4]).padding(0.25);
  ticks.forEach((t) => {
    svg.append('line').attr('x1', left).attr('x2', W - 4).attr('y1', y(t)).attr('y2', y(t)).attr('stroke', t === 0 ? 'var(--axis)' : 'var(--grid)');
    svg.append('text').attr('x', left - 8).attr('y', y(t)).attr('dy', '0.32em').attr('text-anchor', 'end').text(fmt(t));
  });
  const bw = Math.min(32, x.bandwidth()), off = (x.bandwidth() - bw) / 2, rx = Math.min(3, bw / 2), gb = svg.append('g');
  dias.forEach((d) => {
    gb.append('rect').attr('x', x(d.dia) + off).attr('width', bw).attr('y', y(d.e)).attr('height', Math.max(0, y(0) - y(d.e))).attr('rx', rx).attr('fill', COR.entrada);
    gb.append('rect').attr('x', x(d.dia) + off).attr('width', bw).attr('y', y(0)).attr('height', Math.max(0, y(-d.s) - y(0))).attr('rx', rx).attr('fill', COR.saida);
  });
  const passo = Math.max(1, Math.ceil(dias.length / Math.max(2, Math.min(5, Math.floor((W - left) / 80)))));
  dias.forEach((d, i) => { if (i % passo === 0) svg.append('text').attr('x', x(d.dia) + x.bandwidth() / 2).attr('y', H - 6).attr('text-anchor', 'middle').text(dia(d.dia)); });
  const tt = tip(el);
  svg.append('rect').attr('x', left).attr('width', Math.max(0, W - left - 4)).attr('height', H).attr('fill', 'transparent')
    .on('pointermove', (ev) => {
      const i = Math.max(0, Math.min(dias.length - 1, Math.floor((d3.pointer(ev)[0] - left) / x.step()))), d = dias[i];
      gb.selectAll('rect').attr('opacity', (_, j) => (Math.floor(j / 2) === i ? 1 : 0.45));
      const k = el.clientWidth / W;
      tt.show((x(d.dia) + x.bandwidth() / 2) * k, y(d.e) * k, diaAno(d.dia), [[COR.entrada, 'Entradas', brl.format(d.e)], [COR.saida, 'Saídas', brl.format(d.s)]]);
    })
    .on('pointerleave', () => { gb.selectAll('rect').attr('opacity', 1); tt.hide(); });
}
function grafCats(el, cats) {
  el.replaceChildren();
  if (!cats.length) { el.append(h('p', { class: 'note' }, 'Sem saídas no período.')); return; }
  const total = cats.reduce((s, r) => s + r.v, 0) || 1, m = cats[0].v || 1, tt = tip(el);
  cats.forEach((r, i) => {
    const linha = h('div', { class: 'cat' }, h('span', { class: 'l' }, r.categoria),
      h('span', { class: 't' }, h('span', { class: 'b', style: `width:${(r.v / m) * 100}%;background:${i === 0 ? COR.saida : COR.muted}` })),
      h('span', { class: 'vv' }, brl.format(r.v)));
    linha.addEventListener('pointermove', (ev) => { const b = el.getBoundingClientRect(); tt.show(ev.clientX - b.left, ev.clientY - b.top, r.categoria, [[null, 'Saídas', brl.format(r.v)], [null, 'Participação', (r.v / total * 100).toFixed(1).replace('.', ',') + '%']]); });
    linha.addEventListener('pointerleave', () => tt.hide());
    el.append(linha);
  });
}

/* ---------- configurações ---------- */
const MENU = [
  ['Sistema', [['geral', 'Geral'], ['contas', 'Contas bancárias']]],
  ['Integrações', [['apis', 'APIs'], ['webhooks', 'Webhooks', 'em breve']]],
  ['Acesso', [['usuarios', 'Usuários e permissões'], ['notificacoes', 'Notificações']]],
];
function telaConfig() {
  const side = h('nav', { class: 'side', 'aria-label': 'Categorias de configuração' },
    MENU.map(([grupo, itens]) => [h('div', { class: 'h' }, grupo),
      itens.map(([id, nome, extra]) => h('button', { type: 'button', 'aria-current': S.cfg === id ? 'page' : null, onclick: () => { S.cfg = id; render(); } }, nome, extra ? h('small', {}, extra) : null))]));
  const painel = ({ apis: painelApis, usuarios: painelUsuarios }[S.cfg] || painelVazio)();
  return h('div', { class: 'body' },
    h('header', { class: 'head' }, h('h1', {}, 'Configurações'), h('p', {}, 'Ajustes do sistema Serena Financeiro.')),
    h('div', { class: 'cfg' }, side, painel));
}
function painelVazio() {
  const t = {
    geral: ['Geral', 'Nome da empresa, CNPJ, fuso horário e moeda. Em construção.'],
    contas: ['Contas bancárias', 'Cadastro das contas exibidas no painel (Bradesco PJ, Stone) e o apelido de cada uma. Em construção.'],
    webhooks: ['Webhooks', 'Avisos automáticos dos bancos sobre novos lançamentos. Em breve.'],
    notificacoes: ['Notificações', 'Alertas de saldo baixo e de saídas acima de um valor. Em construção.'],
  }[S.cfg];
  return h('section', { class: 'panel' }, h('h2', {}, t[0]), h('div', { class: 'card ph' }, t[1]));
}

const BANCO_UI = {
  bradesco: {
    nome: 'Bradesco', sub: 'API de Saldo e Extrato · Client ID e Client Secret gerados no portal Bradesco Developers',
    campos: [['client_id', 'Client ID', 'text', 'Fornecido pelo Bradesco ao cadastrar a aplicação'], ['agencia', 'Agência (sem dígito)', 'text', 'ex.: 3995'], ['conta', 'Conta (sem dígito)', 'text', 'ex.: 75557']],
    segredos: [['client_secret', 'Client Secret', 'password'], ['cert', 'Certificado digital A1 (.pfx)', 'file', 'O arquivo .pfx (ou .p12) do certificado usado para criar a credencial'], ['cert_senha', 'Senha do certificado', 'password']],
  },
  stone: {
    nome: 'Stone', sub: 'API Stone Conta · extrato e saldo da conta Stone',
    campos: [['client_id', 'Client ID', 'text', 'Fornecido pela Stone ao cadastrar a aplicação'], ['conta', 'ID da conta', 'text', '']],
    segredos: [['api_key', 'Chave privada / API key', 'password']],
  },
};
function painelApis() {
  const p = h('section', { class: 'panel' }, h('h2', {}, 'APIs'),
    h('p', {}, 'Credenciais usadas para puxar o extrato de cada banco. Cada banco libera essas credenciais no seu portal de desenvolvedores.'),
    h('div', { class: 'info' }, 'As chaves e o certificado são criptografados e guardados no cofre do servidor. Depois de salvos, eles não aparecem mais aqui: os campos secretos ficam em branco. Para trocar, é só digitar ou escolher um novo.'));
  if (!S.cred) {
    p.append(h('div', { class: 'loading' }, 'Carregando…'));
    api('cred_get').then((r) => { S.cred = r; render(); }).catch((e) => toast(e.message, true));
    return p;
  }
  for (const c of S.cred.bancos) p.append(cardBanco(c, S.cred.admin));
  return p;
}
function cardBanco(c, admin) {
  const ui = BANCO_UI[c.banco], ro = !admin;
  const msg = h('span', { class: 'msg' });
  const ambiente = h('select', { disabled: ro }, [['sandbox', 'Sandbox (homologação)'], ['producao', 'Produção']].map(([v, t]) => h('option', { value: v, selected: c.ambiente === v }, t)));
  const ins = {};
  const campos = ui.campos.map(([k, rot, tipo, dica]) => {
    ins[k] = h('input', { type: tipo, value: c[k] || '', disabled: ro, autocomplete: 'off', spellcheck: 'false', placeholder: dica && dica.startsWith('ex.') ? dica : '' });
    return h('label', { class: 'field' }, rot, ins[k], dica && !dica.startsWith('ex.') ? h('span', { class: 'hint' }, dica) : null);
  });
  const sec = {};
  const segredos = ui.segredos.map(([k, rot, tipo, dica]) => {
    const tem = c.segredos.includes(k);
    sec[k] = tipo === 'file'
      ? h('input', { type: 'file', accept: '.pfx,.p12', disabled: ro })
      : h('input', { type: 'password', disabled: ro, autocomplete: 'new-password', placeholder: tem ? '•••••••• guardado' : '' });
    const st = tipo === 'file' ? (tem ? `Guardado: ${c.cert_nome || 'certificado'}. Escolha outro arquivo só para trocar.` : dica) : (tem ? 'Guardado. Deixe em branco para manter.' : dica);
    return h('label', { class: 'field' }, rot, sec[k], st ? h('span', { class: 'hint' }, st) : null);
  });
  const lerArquivo = (f) => new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1] || ''); r.onerror = () => no(new Error('Não consegui ler o arquivo.')); r.readAsDataURL(f); });
  const salvar = h('button', { class: 'btn', type: 'button', disabled: ro }, 'Salvar credenciais');
  salvar.onclick = async () => {
    salvar.disabled = true; msg.className = 'msg'; msg.textContent = 'Salvando…';
    try {
      const body = { banco: c.banco, ambiente: ambiente.value, segredos: {} };
      for (const k of Object.keys(ins)) body[k] = ins[k].value;
      for (const [k, el] of Object.entries(sec)) {
        if (el.type === 'file') { const f = el.files[0]; if (f) { if (f.size > 200000) throw new Error('O certificado passa de 200 KB.'); body.segredos[k] = await lerArquivo(f); body.cert_nome = f.name; } }
        else if (el.value) body.segredos[k] = el.value;
      }
      const r = await api('cred_save', body);
      S.cred.bancos = r.bancos; S.ext = null; render(); toast(`Credenciais ${ui.nome} salvas.`);
    } catch (e) { msg.className = 'msg err'; msg.textContent = e.message; salvar.disabled = false; }
  };
  const testar = h('button', { class: 'btn sec', type: 'button', disabled: ro }, 'Testar conexão');
  testar.onclick = async () => {
    testar.disabled = true; msg.className = 'msg'; msg.textContent = 'Verificando…';
    try { const r = await api('cred_test', { banco: c.banco }); S.cred.bancos = r.bancos; render(); }
    catch (e) { msg.className = 'msg err'; msg.textContent = e.message; testar.disabled = false; }
  };
  let armado = false;
  const apagar = h('button', { class: 'btn dang', type: 'button', disabled: ro || (!c.client_id && !c.segredos.length) }, 'Apagar credenciais');
  apagar.onclick = async () => {
    if (!armado) { armado = true; apagar.textContent = 'Clique de novo para apagar'; setTimeout(() => { armado = false; apagar.textContent = 'Apagar credenciais'; }, 4000); return; }
    apagar.disabled = true;
    try { const r = await api('cred_clear', { banco: c.banco }); S.cred.bancos = r.bancos; S.ext = null; render(); toast(`Credenciais ${ui.nome} apagadas.`); }
    catch (e) { msg.className = 'msg err'; msg.textContent = e.message; apagar.disabled = false; }
  };
  if (c.teste_msg) { msg.className = 'msg' + (c.teste_ok === false ? ' err' : c.teste_ok ? ' ok' : ''); msg.textContent = c.teste_msg; }
  return h('div', { class: 'card', id: 'api-' + c.banco },
    h('div', { class: 'api-h' }, h('div', {}, h('h3', {}, ui.nome), h('p', {}, ui.sub)),
      h('span', { class: 'badge ' + (c.completo ? 'on' : 'off') }, c.completo ? 'Configurado' : 'Não configurado')),
    h('div', { class: 'fields' }, h('label', { class: 'field' }, 'Ambiente', ambiente), campos, segredos),
    ro ? h('p', { class: 'meta' }, 'Só administradores podem alterar as credenciais.') : null,
    h('div', { class: 'actions' }, salvar, testar,
      c.banco === 'bradesco' && admin && c.completo ? h('button', { class: 'btn sec', type: 'button', onclick: (ev) => sincronizar(ev.currentTarget, 90) }, 'Sincronizar extrato') : null,
      apagar),
    h('p', { class: 'meta', style: 'word-break:break-word;line-height:1.5' }, msg),
    c.atualizado ? h('p', { class: 'meta' }, `Última alteração em ${quando(c.atualizado)} por ${c.atualizado_por}.`) : null);
}

function painelUsuarios() {
  const p = h('section', { class: 'panel' }, h('h2', {}, 'Usuários e permissões'),
    h('p', {}, 'Cada pessoa entra com usuário e PIN próprios. Administradores alteram credenciais e usuários; leitura só vê o painel.'));
  // meu PIN (qualquer usuário)
  const meuPin = h('input', { type: 'password', inputmode: 'numeric', placeholder: 'Novo PIN (4 a 8 números)', autocomplete: 'new-password' });
  const btnPin = h('button', { class: 'btn sec small', type: 'button' }, 'Trocar meu PIN');
  btnPin.onclick = async () => {
    btnPin.disabled = true;
    try { await api('user_set', { login: S.me.login, pin: meuPin.value }); meuPin.value = ''; toast('PIN alterado.'); }
    catch (e) { toast(e.message, true); } btnPin.disabled = false;
  };
  p.append(h('div', { class: 'card' }, h('h3', { style: 'margin:0 0 10px;font-family:var(--display);color:var(--petrol-d)' }, `Meu acesso · ${S.me.nome} (${S.me.login})`), h('div', { class: 'row-in' }, meuPin, btnPin)));
  if (S.me.role !== 'admin') return p;
  if (!S.users) {
    p.append(h('div', { class: 'loading' }, 'Carregando…'));
    api('users').then((r) => { S.users = r.users; render(); }).catch((e) => toast(e.message, true));
    return p;
  }
  const set = async (login, body) => { try { const r = await api('user_set', { login, ...body }); S.users = r.users; render(); toast('Usuário atualizado.'); } catch (e) { toast(e.message, true); } };
  const linhas = S.users.map((u) => {
    const pin = h('input', { type: 'password', inputmode: 'numeric', placeholder: 'novo PIN', style: 'width:7rem', autocomplete: 'new-password' });
    const role = h('select', { onchange: () => set(u.login, { role: role.value }) }, [['admin', 'Administrador'], ['leitura', 'Leitura']].map(([v, t]) => h('option', { value: v, selected: u.role === v }, t)));
    return h('tr', {}, h('td', {}, u.nome), h('td', { class: 'doc' }, u.login), h('td', {}, role),
      h('td', {}, u.ativo ? 'Ativo' : 'Desativado'),
      h('td', {}, h('div', { class: 'row-in' }, pin, h('button', { class: 'btn sec small', type: 'button', onclick: () => set(u.login, { pin: pin.value }) }, 'Trocar PIN'),
        h('button', { class: 'btn small ' + (u.ativo ? 'dang' : 'sec'), type: 'button', onclick: () => set(u.login, { ativo: !u.ativo }) }, u.ativo ? 'Desativar' : 'Ativar'))));
  });
  p.append(h('div', { class: 'card' }, h('h3', { style: 'margin:0 0 10px;font-family:var(--display);color:var(--petrol-d)' }, 'Usuários'),
    h('div', { class: 'scroll' }, h('table', { class: 'tb' }, h('thead', {}, h('tr', {}, h('th', {}, 'Nome'), h('th', {}, 'Login'), h('th', {}, 'Perfil'), h('th', {}, 'Situação'), h('th', {}, ''))), h('tbody', {}, linhas)))));
  const nn = h('input', { placeholder: 'Nome' }), nl = h('input', { placeholder: 'login', autocapitalize: 'none', spellcheck: 'false' }),
    np = h('input', { type: 'password', inputmode: 'numeric', placeholder: 'PIN', autocomplete: 'new-password' }),
    nr = h('select', {}, h('option', { value: 'leitura' }, 'Leitura'), h('option', { value: 'admin' }, 'Administrador'));
  const add = h('button', { class: 'btn small', type: 'button' }, 'Adicionar');
  add.onclick = async () => {
    add.disabled = true;
    try { const r = await api('user_add', { nome: nn.value, login: nl.value, pin: np.value, role: nr.value }); S.users = r.users; render(); toast('Usuário criado.'); }
    catch (e) { toast(e.message, true); add.disabled = false; }
  };
  p.append(h('div', { class: 'card' }, h('h3', { style: 'margin:0 0 10px;font-family:var(--display);color:var(--petrol-d)' }, 'Novo usuário'), h('div', { class: 'row-in' }, nn, nl, np, nr, add)));
  return p;
}

/* ---------- render ---------- */
function render() {
  const app = $('#app');
  if (!S.me) { app.replaceChildren(telaLogin()); return; }
  app.replaceChildren(topo(), S.tela === 'configuracoes' ? telaConfig() : telaExtrato());
}
let rz; window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { if (S.me && S.tela === 'extrato' && S.ext) render(); }, 200); });

(async function inicio() {
  if (!localStorage.getItem(TK)) { render(); return; }
  $('#app').replaceChildren(h('div', { class: 'loading' }, 'Carregando…'));
  try { S.me = (await api('me')).me; } catch (e) { S.me = null; }
  render();
})();
