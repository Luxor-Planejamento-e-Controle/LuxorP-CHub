/* Aba "Estruturas Societárias": Chat · Organogramas · Empresas · Investidores.
 *
 * Fala só com o bot (window.SOCIETARIO_BOT_URL), mandando o token da sessão do hub.
 * O bot confere o token no Supabase do hub e hub_can('societario') a cada pedido.
 *
 *   POST /hub/ask                      {question} → {company, text, image, files, sources}
 *   GET  /hub/dados                    {generated_at, companies, investors}
 *   GET  /hub/procuracoes              {items, documents_total, documents_pending, ...}
 *   GET  /hub/organogramas             manifest {generated_at, charts, files}
 *   GET  /hub/organogramas/arquivo     ?path=<arquivo do manifest> → PNG/PDF
 *
 * Todo texto do bot e do dado passa por esc() antes de virar HTML.
 */
(function () {
  'use strict';

  var BOT = String(window.SOCIETARIO_BOT_URL || '').replace(/\/+$/, '');
  var $ = function (s, el) { return (el || document).querySelector(s); };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  // Texto do bot vem no formato do Slack (*negrito*, _itálico_, `código`, <url|texto>).
  function mrkdwn(t) {
    var h = esc(t);
    h = h.replace(/&lt;(https?:\/\/[^|\s]+?)\|([^\n]+?)&gt;/g, '<a href="$1" target="_blank" rel="noopener">$2</a>');
    h = h.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    h = h.replace(/(^|[\s(•])\*([^*\n]+?)\*(?=$|[\s).,;:!?])/gm, '$1<strong>$2</strong>');
    h = h.replace(/(^|[\s(])_([^_\n]+?)_(?=$|[\s).,;:!?])/gm, '$1<em>$2</em>');
    h = h.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    return h.replace(/\n/g, '<br>');
  }
  function pct(p) {
    if (p == null) return '% n/i';
    return (Math.round(p * 100) / 100).toLocaleString('pt-BR', { maximumFractionDigits: 2 }) + '%';
  }
  function dataBR(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(iso || '');
    if (!m) return '—';
    return m[3] + '/' + m[2] + '/' + m[1] + (m[4] ? ' ' + m[4] + ':' + m[5] : '');
  }
  function sem(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); }

  /* ---------- sessão do hub e chamadas ao bot ---------- */
  var _sb = null;
  function sb() {
    if (_sb) return _sb;
    if (!window.supabase || !window.SUPABASE_URL) throw new Error('supabase-js não carregou.');
    // mesmo domínio e storageKey do hub: reaproveita a sessão de quem já entrou
    _sb = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
    return _sb;
  }
  async function token() {
    var r = await sb().auth.getSession();
    var t = r && r.data && r.data.session && r.data.session.access_token;
    if (!t) throw new Error('Sua sessão do Hub expirou. Recarregue a página e entre de novo.');
    return t;
  }
  async function bot(path, opts) {
    opts = opts || {};
    var headers = Object.assign({}, opts.headers || {}, { Authorization: 'Bearer ' + (await token()) });
    var r;
    try {
      r = await fetch(BOT + path, Object.assign({}, opts, { headers: headers }));
    } catch (e) {
      throw new Error('Não consegui falar com o bot agora. Tente de novo em instantes.');
    }
    if (!r.ok) {
      var msg = '';
      try { msg = (await r.json()).error || ''; } catch (e) { /* corpo não é JSON */ }
      throw new Error(msg || ('O bot respondeu com erro (HTTP ' + r.status + ').'));
    }
    return r;
  }
  function baixarBlob(blob, nome) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = nome; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }
  function b64Blob(b64, type) {
    var bin = atob(b64), n = bin.length, u = new Uint8Array(n);
    for (var i = 0; i < n; i++) u[i] = bin.charCodeAt(i);
    return new Blob([u], { type: type });
  }
  function abrirBlob(blob) { window.open(URL.createObjectURL(blob), '_blank', 'noopener'); }

  /* ---------- seções ---------- */
  var SECOES = ['chat', 'procuracoes', 'organogramas', 'empresas', 'investidores'];
  var carregado = {};
  function secaoAtual() {
    var h = location.hash.replace(/^#/, '').split('/')[0];
    return SECOES.indexOf(h) >= 0 ? h : 'chat';
  }
  function mostrar() {
    var s = secaoAtual();
    document.querySelectorAll('#abas button').forEach(function (b) { b.classList.toggle('on', b.dataset.v === s); });
    SECOES.forEach(function (x) { $('#v-' + x).hidden = x !== s; });
    if (s === 'chat') { $('#pergunta').focus(); return; }
    if (s === 'procuracoes') return abrirProcuracoes();
    if (s === 'organogramas') return abrirOrganogramas();
    return abrirDados(s);
  }
  $('#abas').addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (b) location.hash = b.dataset.v;
  });
  window.addEventListener('hashchange', mostrar);
  function irPara(secao, id) { location.hash = secao + (id ? '/' + encodeURIComponent(id) : ''); }
  function idDoHash() { var p = location.hash.replace(/^#/, '').split('/'); return p[1] ? decodeURIComponent(p.slice(1).join('/')) : null; }

  /* ---------- Chat ---------- */
  var conversa = [];   // {quem:'eu'|'bot', texto, resp?, erro?, pendente?, inicio?}
  var ocupado = false;
  function desenharChat() {
    var box = $('#msgs');
    if (!conversa.length) { box.innerHTML = '<div class="so-vazio">Pergunte sobre sócios, participações, procurações e documentos das empresas do grupo.</div>'; return; }
    box.innerHTML = conversa.map(function (m, i) {
      if (m.quem === 'eu') return '<div class="so-msg eu">' + esc(m.texto).replace(/\n/g, '<br>') + '</div>';
      if (m.pendente) {
        var s = Math.round((Date.now() - m.inicio) / 1000);
        return '<div class="so-msg bot"><span class="so-pensando">Buscando a resposta… ' + s + 's</span></div>';
      }
      if (m.erro) return '<div class="so-msg bot erro">' + esc(m.erro) + '</div>';
      var r = m.resp, h = '<div class="so-msg bot" data-i="' + i + '">';
      if (r.company) h += '<div class="quem">' + esc(r.company) + '</div>';
      h += mrkdwn(r.text || '');
      if (r.image) h += '<img data-img="' + i + '" alt="Organograma" src="data:image/png;base64,' + r.image + '">';
      var arq = (r.files || []).filter(function (f) { return f.data; });
      if (arq.length) {
        h += '<div class="arquivos">' + arq.map(function (f, k) {
          return '<button class="so-btn ghost" data-arq="' + i + ':' + k + '">' + esc(f.name) + '</button>';
        }).join('') + '</div>';
      }
      if (r.sources && r.sources.length) {
        h += '<details><summary>Fontes (' + r.sources.length + ')</summary><ul>' +
          r.sources.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ul></details>';
      }
      return h + '</div>';
    }).join('');
    box.scrollTop = box.scrollHeight;
  }
  $('#msgs').addEventListener('click', function (e) {
    var img = e.target.closest('img[data-img]');
    if (img) return abrirBlob(b64Blob(conversa[+img.dataset.img].resp.image, 'image/png'));
    var b = e.target.closest('button[data-arq]');
    if (b) {
      var p = b.dataset.arq.split(':'), f = conversa[+p[0]].resp.files.filter(function (x) { return x.data; })[+p[1]];
      baixarBlob(b64Blob(f.data, /\.pdf$/i.test(f.name) ? 'application/pdf' : 'application/octet-stream'), f.name);
    }
  });
  async function perguntar(q) {
    ocupado = true; $('#enviar').disabled = true;
    conversa.push({ quem: 'eu', texto: q });
    var pend = { quem: 'bot', pendente: true, inicio: Date.now() };
    conversa.push(pend);
    desenharChat();
    var relogio = setInterval(desenharChat, 1000);
    try {
      var r = await bot('/hub/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                                      body: JSON.stringify({ question: q }) });
      pend.resp = await r.json();
    } catch (e) {
      pend.erro = e.message;
    } finally {
      clearInterval(relogio);
      pend.pendente = false; ocupado = false; $('#enviar').disabled = false;
      desenharChat(); $('#pergunta').focus();
    }
  }
  $('#compor').addEventListener('submit', function (e) {
    e.preventDefault();
    var t = $('#pergunta'), q = t.value.trim();
    if (!q || ocupado) return;
    t.value = ''; t.style.height = '';
    perguntar(q);
  });
  $('#pergunta').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#compor').requestSubmit(); }
  });
  $('#pergunta').addEventListener('input', function () {
    this.style.height = ''; this.style.height = Math.min(this.scrollHeight, 180) + 'px';
  });

  /* ---------- Procurações (GET /hub/procuracoes) ---------- */
  var proc = null, procFiltro = { status: 'todas', empresa: '', busca: '' };
  var ROTULO_ST = { vencida: 'Vencida', vence_7: 'Vence em até 7 dias', vence_30: 'Vence em até 30 dias', vigente: 'Vigente' };
  async function carregarProc() {
    if (!proc) proc = await (await bot('/hub/procuracoes')).json();
    return proc;
  }
  function prazo(i) {
    if (i.dias < 0) return 'há ' + (-i.dias) + (i.dias === -1 ? ' dia' : ' dias');
    if (i.dias === 0) return 'hoje';
    return 'em ' + i.dias + (i.dias === 1 ? ' dia' : ' dias');
  }
  function tabelaProc(itens, comEmpresa) {
    return '<div class="tbl-wrap"><table class="so-tab"><thead><tr><th>Status</th><th class="num">Vencimento</th>' +
      (comEmpresa ? '<th>Empresa</th>' : '') +
      '<th>Outorgado</th><th>Outorgante</th><th class="num">Outorga</th><th>Poderes</th><th>Documento</th></tr></thead><tbody>' +
      itens.map(function (i) {
        var emp = i.company_key ? '<button class="so-link" data-empresa="' + esc(i.company_key) + '">' + esc(i.company) + '</button>' : esc(i.company);
        return '<tr><td><span class="so-st ' + esc(i.status) + '">' + esc(ROTULO_ST[i.status] || i.status) + '</span></td>' +
          '<td class="num">' + esc(dataBR(i.data_vencimento)) + '<span class="so-muted" style="display:block">' + esc(prazo(i)) + '</span></td>' +
          (comEmpresa ? '<td>' + emp + '</td>' : '') +
          '<td>' + esc(i.outorgado) + '</td><td>' + esc(i.outorgante || '') + '</td>' +
          '<td class="num">' + esc(i.data_outorga ? dataBR(i.data_outorga) : '') + '</td>' +
          '<td class="poderes">' + esc(i.poderes || '') + '</td><td>' + esc((i.documents || []).join(', ')) + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }
  async function abrirProcuracoes() {
    var v = $('#v-procuracoes');
    if (!proc) {
      v.innerHTML = '<div class="so-muted">Carregando as procurações…</div>';
      try { await carregarProc(); } catch (e) { v.innerHTML = '<div class="so-erro">' + esc(e.message) + '</div>'; return; }
    }
    desenharProc();
  }
  function desenharProc() {
    var v = $('#v-procuracoes'), itens = proc.items || [], f = procFiltro, b = sem(f.busca);
    var conta = { vencida: 0, vence_7: 0, vence_30: 0, vigente: 0 };
    var empresas = [];
    itens.forEach(function (i) {
      conta[i.status] = (conta[i.status] || 0) + 1;
      if (empresas.indexOf(i.company) < 0) empresas.push(i.company);
    });
    empresas.sort(function (x, y) { return x.localeCompare(y, 'pt-BR'); });
    var vis = itens.filter(function (i) {
      if (f.status !== 'todas' && i.status !== f.status) return false;
      if (f.empresa && i.company !== f.empresa) return false;
      return !b || sem([i.outorgado, i.outorgante, i.poderes, (i.documents || []).join(' ')].join(' ')).indexOf(b) >= 0;
    });
    var kpi = function (st, rot) {
      return '<div class="card kpi' + (f.status === st ? ' on' : '') + '" data-st="' + st + '"><div class="label">' + rot +
        '</div><div class="val ' + st + '">' + conta[st] + '</div></div>';
    };
    var lendo = proc.documents_pending
      ? '<span class="so-badge">lendo documentos: ' + (proc.documents_total - proc.documents_pending) + ' de ' + proc.documents_total + '</span>' : '';
    v.innerHTML = '<div class="so-kpis">' + kpi('vencida', 'Vencidas') + kpi('vence_7', 'Vencem em até 7 dias') +
      kpi('vence_30', 'Vencem em até 30 dias') + kpi('vigente', 'Vigentes') + '</div>' +
      '<div class="so-topo"><select class="so-sel" id="procEmpresa"><option value="">Todas as empresas</option>' +
      empresas.map(function (e) { return '<option value="' + esc(e) + '"' + (e === f.empresa ? ' selected' : '') + '>' + esc(e) + '</option>'; }).join('') +
      '</select><input class="so-busca" id="procBusca" style="max-width:320px" placeholder="Buscar outorgado, poderes, documento" value="' + esc(f.busca) + '">' +
      (f.status !== 'todas' ? '<button class="so-btn ghost" id="procTodas">Mostrar todas</button>' : '') + lendo + '</div>' +
      (vis.length ? '<div class="card">' + tabelaProc(vis, true) + '</div>'
        : '<div class="so-muted">' + (itens.length ? 'Nenhuma procuração com esses filtros.' : 'Nenhuma procuração encontrada nos documentos.') + '</div>');
    v.querySelector('.so-kpis').onclick = function (e) {
      var k = e.target.closest('[data-st]'); if (!k) return;
      f.status = f.status === k.dataset.st ? 'todas' : k.dataset.st; desenharProc();
    };
    $('#procEmpresa').onchange = function () { f.empresa = this.value; desenharProc(); };
    $('#procBusca').oninput = function () {
      f.busca = this.value; var pos = this.selectionStart; desenharProc();
      var i = $('#procBusca'); i.focus(); i.setSelectionRange(pos, pos);
    };
    if ($('#procTodas')) $('#procTodas').onclick = function () { f.status = 'todas'; desenharProc(); };
    v.querySelectorAll('[data-empresa]').forEach(function (a) { a.onclick = function () { irPara('empresas', a.dataset.empresa); }; });
  }

  /* ---------- Organogramas ---------- */
  var org = null, orgSecao = null, orgSel = null, orgBusca = '', orgImg = {};
  function secoesOrg() {
    var grupos = {}, ordem = [];
    (org.files || []).forEach(function (f) {
      var i = f.indexOf('/');
      if (i < 0) return;
      var pasta = f.slice(0, i);
      if (!grupos[pasta]) { grupos[pasta] = []; ordem.push(pasta); }
      grupos[pasta].push(f);
    });
    ordem.sort();
    return { grupos: grupos, ordem: ordem };
  }
  var rotuloPasta = function (p) { return p.replace(/^\d+\s*/, ''); };
  var nomeArq = function (f) { return f.slice(f.indexOf('/') + 1).replace(/\.[^.]+$/, ''); };
  async function abrirOrganogramas() {
    var v = $('#v-organogramas');
    if (!carregado.org) {
      v.innerHTML = '<div class="so-muted">Carregando os organogramas…</div>';
      try {
        org = await (await bot('/hub/organogramas')).json();
        carregado.org = true;
      } catch (e) { v.innerHTML = '<div class="so-erro">' + esc(e.message) + '</div>'; return; }
    }
    var s = secoesOrg();
    if (!orgSecao || s.ordem.indexOf(orgSecao) < 0) orgSecao = s.ordem[0];
    desenharOrg();
  }
  function desenharOrg() {
    var v = $('#v-organogramas'), s = secoesOrg();
    var pdf = (org.files || []).filter(function (f) { return f.indexOf('/') < 0 && /\.pdf$/i.test(f); })[0];
    var lista = (s.grupos[orgSecao] || []).filter(function (f) { return !orgBusca || sem(nomeArq(f)).indexOf(sem(orgBusca)) >= 0; });
    if (!orgSel || (s.grupos[orgSecao] || []).indexOf(orgSel) < 0) orgSel = (s.grupos[orgSecao] || [])[0] || null;
    v.innerHTML =
      '<div class="so-topo"><div class="seg" id="orgSecoes">' + s.ordem.map(function (p) {
        return '<button data-p="' + esc(p) + '" class="' + (p === orgSecao ? 'on' : '') + '">' + esc(rotuloPasta(p)) + '</button>';
      }).join('') + '</div>' +
      (pdf ? '<button class="so-btn ghost" id="orgPdf">Baixar PDF com todos</button>' : '') +
      '<span class="so-muted">' + esc((org.charts || 0) + ' organogramas · gerados em ' + dataBR(org.generated_at)) + '</span></div>' +
      '<div class="so-duas"><div class="so-lista"><input class="so-busca" id="orgBusca" placeholder="Buscar" value="' + esc(orgBusca) + '">' +
      lista.map(function (f) {
        return '<button class="so-item' + (f === orgSel ? ' on' : '') + '" data-f="' + esc(f) + '">' + esc(nomeArq(f)) + '</button>';
      }).join('') + '</div><div class="card so-org" id="orgVer"></div></div>';
    $('#orgSecoes').onclick = function (e) {
      var b = e.target.closest('button'); if (!b) return;
      orgSecao = b.dataset.p; orgSel = null; orgBusca = ''; desenharOrg();
    };
    $('#orgBusca').oninput = function () {
      orgBusca = this.value; var pos = this.selectionStart; desenharOrg();
      var i = $('#orgBusca'); i.focus(); i.setSelectionRange(pos, pos);
    };
    v.querySelector('.so-lista').onclick = function (e) {
      var b = e.target.closest('button[data-f]'); if (!b) return;
      orgSel = b.dataset.f; desenharOrg();
    };
    if (pdf) $('#orgPdf').onclick = async function () {
      this.disabled = true;
      try { baixarBlob(await (await bot('/hub/organogramas/arquivo?path=' + encodeURIComponent(pdf))).blob(), pdf); }
      catch (e) { alert(e.message); }
      finally { this.disabled = false; }
    };
    verOrg();
  }
  async function verOrg() {
    var box = $('#orgVer'), f = orgSel;
    if (!f) { box.innerHTML = '<div class="so-muted">Nenhum organograma nesta seção.</div>'; return; }
    box.innerHTML = '<div class="card-title"><h2>' + esc(nomeArq(f)) + '</h2></div><div class="so-muted">Carregando…</div>';
    try {
      if (!orgImg[f]) orgImg[f] = await (await bot('/hub/organogramas/arquivo?path=' + encodeURIComponent(f))).blob();
      if (orgSel !== f) return;   // trocou de item enquanto baixava
      box.innerHTML = '<div class="card-title"><h2>' + esc(nomeArq(f)) + '</h2></div>';
      var img = document.createElement('img');
      img.alt = nomeArq(f); img.src = URL.createObjectURL(orgImg[f]);
      img.onclick = function () { abrirBlob(orgImg[f]); };
      box.appendChild(img);
    } catch (e) {
      if (orgSel === f) box.innerHTML = '<div class="so-erro">' + esc(e.message) + '</div>';
    }
  }

  /* ---------- Empresas e Investidores (GET /hub/dados) ---------- */
  var dados = null, idx = null, buscas = { empresas: '', investidores: '' };
  function nomeEmpresa(c) { return c.short_name || c.name || c.key; }
  function indexar() {
    var porKey = {}, porCnpj = {}, porNome = {};
    dados.companies.forEach(function (c) { porKey[c.key] = c; if (c.cnpj) porCnpj[c.cnpj] = c; });
    dados.investors.forEach(function (i) { porNome[sem(i.name)] = i; });
    idx = { porKey: porKey, porCnpj: porCnpj, porNome: porNome };
  }
  async function abrirDados(secao) {
    var v = $('#v-' + secao);
    if (!carregado.dados) {
      v.innerHTML = '<div class="so-muted">Carregando o quadro societário…</div>';
      // as procurações entram na ficha da empresa; se falharem, a ficha sai sem elas
      var pr = carregarProc().catch(function () { return null; });
      try {
        dados = await (await bot('/hub/dados')).json();
        indexar(); carregado.dados = true;
      } catch (e) { v.innerHTML = '<div class="so-erro">' + esc(e.message) + '</div>'; return; }
      await pr;
    }
    if (secao === 'empresas') desenharEmpresas(); else desenharInvestidores();
  }
  function lista(secao, itens, sel, rotulo, sub) {
    var b = buscas[secao];
    var vis = itens.filter(function (x) { return !b || sem(rotulo(x)).indexOf(sem(b)) >= 0; });
    return '<div class="so-lista"><input class="so-busca" data-busca="' + secao + '" placeholder="Buscar" value="' + esc(b) + '">' +
      vis.map(function (x) {
        return '<button class="so-item' + (x === sel ? ' on' : '') + '" data-id="' + esc(x.key || x.id) + '">' +
          esc(rotulo(x)) + (sub(x) ? '<span class="so-muted">' + sub(x) + '</span>' : '') + '</button>';
      }).join('') + '</div>';
  }
  function ligarLista(secao, desenhar) {
    var v = $('#v-' + secao);
    var inp = v.querySelector('[data-busca]');
    inp.oninput = function () {
      buscas[secao] = this.value; var pos = this.selectionStart; desenhar();
      var i = $('#v-' + secao + ' [data-busca]'); i.focus(); i.setSelectionRange(pos, pos);
    };
    v.querySelector('.so-lista').onclick = function (e) {
      var b = e.target.closest('button[data-id]'); if (b) irPara(secao, b.dataset.id);
    };
    v.querySelectorAll('[data-empresa]').forEach(function (a) { a.onclick = function () { irPara('empresas', a.dataset.empresa); }; });
    v.querySelectorAll('[data-investidor]').forEach(function (a) { a.onclick = function () { irPara('investidores', a.dataset.investidor); }; });
  }
  function kv(pares) {
    return '<div class="so-kv">' + pares.filter(function (p) { return p[1]; }).map(function (p) {
      return '<div><div class="k">' + esc(p[0]) + '</div><div class="v">' + esc(p[1]) + '</div></div>';
    }).join('') + '</div>';
  }
  function linkEmpresa(c) { return '<button class="so-link" data-empresa="' + esc(c.key) + '">' + esc(nomeEmpresa(c)) + '</button>'; }

  function desenharEmpresas() {
    var v = $('#v-empresas');
    var itens = dados.companies.slice().sort(function (a, b) { return nomeEmpresa(a).localeCompare(nomeEmpresa(b), 'pt-BR'); });
    var c = idx.porKey[idDoHash()] || itens.filter(function (x) { return !x.no_documents; })[0] || itens[0];
    if (!c) { v.innerHTML = '<div class="so-muted">Nenhuma empresa no quadro societário.</div>'; return; }
    var h = '<div class="so-duas">' + lista('empresas', itens, c, nomeEmpresa, function (x) {
      return x.no_documents ? 'sem documentos' : esc(x.type || '');
    }) + '<div class="so-ficha">';
    h += '<div class="card"><h2>' + esc(c.name || nomeEmpresa(c)) +
      (c.no_documents ? '<span class="so-badge">sem documentos</span>' : '') +
      (c.pending_documents || c.extraction_failed ? '<span class="so-badge">documentos novos não lidos</span>' : '') + '</h2>' +
      kv([['CNPJ', c.cnpj], ['Tipo', c.type], ['Capital social', c.capital_social && c.capital_social !== 'None' ? c.capital_social : ''],
          ['Posição em', c.position_date ? dataBR(c.position_date) : ''], ['Documento de referência', c.source]]) + '</div>';

    var socios = c.shareholders || [];
    if (socios.length) {
      h += '<div class="card" style="margin-top:14px"><div class="card-title"><h2>Sócios</h2></div><div class="tbl-wrap"><table class="so-tab">' +
        '<thead><tr><th>Sócio</th><th>Tipo</th><th>CNPJ</th><th class="num">Ações / quotas</th><th class="num">%</th></tr></thead><tbody>' +
        socios.slice().sort(function (a, b) { return (b.percent || 0) - (a.percent || 0); }).map(function (s) {
          var emp = (s.company_key && idx.porKey[s.company_key]) || (s.cnpj && idx.porCnpj[s.cnpj]);
          var inv = !emp && idx.porNome[sem(s.name)];
          var nome = emp ? linkEmpresa(emp)
            : inv ? '<button class="so-link" data-investidor="' + esc(inv.id) + '">' + esc(s.name) + '</button>' : esc(s.name);
          return '<tr><td>' + nome + '</td><td>' + esc(s.kind || '') + '</td><td>' + esc(s.cnpj || '') + '</td>' +
            '<td class="num">' + esc(s.shares || '') + '</td><td class="num">' + esc(pct(s.percent)) +
            (s.percent_calculated ? ' <span class="so-muted">(calculado)</span>' : '') + '</td></tr>';
        }).join('') + '</tbody></table></div></div>';
    }
    var procs = proc ? (proc.items || []).filter(function (i) { return i.company_key === c.key; }) : [];
    if (procs.length) {
      h += '<div class="card" style="margin-top:14px"><div class="card-title"><h2>Procurações</h2></div>' + tabelaProc(procs, false) + '</div>';
    }
    var ex = c.former_shareholders || [];
    if (ex.length) {
      h += '<div class="card" style="margin-top:14px"><div class="card-title"><h2>Ex-sócios</h2></div><div class="tbl-wrap"><table class="so-tab">' +
        '<thead><tr><th>Nome</th><th>Até</th><th>Como saiu</th><th>Documento</th></tr></thead><tbody>' +
        ex.map(function (f) {
          return '<tr><td>' + esc(f.name) + '</td><td>' + esc(f.until ? dataBR(f.until) : '') + '</td><td>' + esc(f.how || '') +
            '</td><td>' + esc(f.source || '') + '</td></tr>';
        }).join('') + '</tbody></table></div></div>';
    }
    var docs = c.documents || [];
    if (docs.length) {
      h += '<div class="card" style="margin-top:14px"><div class="card-title"><h2>Documentos (' + docs.length + ')</h2></div><ul class="so-docs">' +
        docs.map(function (d) { return '<li>' + esc(d) + '</li>'; }).join('') + '</ul></div>';
    }
    v.innerHTML = h + '</div></div>';
    ligarLista('empresas', desenharEmpresas);
  }

  function desenharInvestidores() {
    var v = $('#v-investidores');
    var itens = dados.investors;
    var i = itens.filter(function (x) { return x.id === idDoHash(); })[0] || itens[0];
    if (!i) { v.innerHTML = '<div class="so-muted">Nenhum investidor no quadro societário.</div>'; return; }
    var h = '<div class="so-duas">' + lista('investidores', itens, i, function (x) { return x.name; }, function (x) {
      var n = x.direct.length;
      return esc((x.kind || '') + (n ? ' · ' + n + (n === 1 ? ' empresa' : ' empresas') : ''));
    }) + '<div class="so-ficha">';
    h += '<div class="card"><h2>' + esc(i.name) + (i.kind ? '<span class="so-badge">' + esc(i.kind) + '</span>' : '') + '</h2>' +
      kv([['CNPJ', i.cnpj]]) + '</div>';
    var emp = function (k) { var c = idx.porKey[k]; return c ? linkEmpresa(c) : esc(k); };
    if (i.direct.length) {
      h += '<div class="card" style="margin-top:14px"><div class="card-title"><h2>Participação direta</h2></div><div class="tbl-wrap"><table class="so-tab">' +
        '<thead><tr><th>Empresa</th><th class="num">Ações / quotas</th><th class="num">%</th></tr></thead><tbody>' +
        i.direct.slice().sort(function (a, b) { return (b.percent || 0) - (a.percent || 0); }).map(function (d) {
          return '<tr><td>' + emp(d.company_key) + '</td><td class="num">' + esc(d.shares || '') + '</td><td class="num">' +
            esc(pct(d.percent)) + (d.calculated ? ' <span class="so-muted">(calculado)</span>' : '') + '</td></tr>';
        }).join('') + '</tbody></table></div></div>';
    }
    if (i.indirect.length) {
      h += '<div class="card" style="margin-top:14px"><div class="card-title"><h2>Participação indireta</h2></div><div class="tbl-wrap"><table class="so-tab">' +
        '<thead><tr><th>Empresa</th><th class="num">% efetivo</th><th>Cadeia</th></tr></thead><tbody>' +
        i.indirect.slice().sort(function (a, b) { return (b.percent || 0) - (a.percent || 0); }).map(function (d) {
          return '<tr><td>' + emp(d.company_key) + '</td><td class="num">' + esc(pct(d.percent)) + '</td><td>' +
            esc((d.path || []).join(' → ')) + '</td></tr>';
        }).join('') + '</tbody></table></div></div>';
    }
    v.innerHTML = h + '</div></div>';
    ligarLista('investidores', desenharInvestidores);
  }

  desenharChat();
  mostrar();
})();
