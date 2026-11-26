/* Aba "Estruturas Societárias": Chat · Organogramas · Empresas · Investidores.
 *
 * Fala só com o bot (window.SOCIETARIO_BOT_URL), mandando o token da sessão do hub.
 * O bot confere o token no Supabase do hub e hub_can('societario') a cada pedido.
 *
 *   POST /hub/ask                      {question} → {company, text, image, files, sources}
 *   GET  /hub/dados                    {generated_at, companies, investors}
 *   GET  /hub/procuracoes              {items, documents_total, documents_pending, ...}
 *   GET  /hub/advogados                {arquivo, atualizado_em, escritorios}
 *   GET  /hub/processos                {arquivo, atualizado_em, processos}  (só hub_can('processos'))
 *   POST /hub/documentos               ?empresa=&nome=, corpo = o PDF  (só hub_can('societario_envio'))
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
  var SECOES = ['chat', 'procuracoes', 'organogramas', 'empresas', 'investidores', 'advogados', 'processos'];
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
    if (s === 'advogados') return abrirAdvogados();
    if (s === 'processos') return abrirProcessos();
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
  var proc = null, procFiltro = { status: 'todas', empresa: '', busca: '' }, procVerExcl = false;
  var ROTULO_ST = { vencida: 'Vencida', vence_7: 'Vence em até 7 dias', vence_30: 'Vence em até 30 dias', vigente: 'Vigente' };
  async function carregarProc() {
    if (!proc) proc = await (await bot('/hub/procuracoes' + (procVerExcl ? '?excluidas=1' : ''))).json();
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
      '<th>Outorgado</th><th>Outorgante</th><th class="num">Outorga</th><th>Poderes</th><th>Documento</th>' + (podeEnviar ? '<th></th>' : '') + '</tr></thead><tbody>' +
      itens.map(function (i) {
        var emp = i.company_key ? '<button class="so-link" data-empresa="' + esc(i.company_key) + '">' + esc(i.company) + '</button>' : esc(i.company);
        return '<tr' + (i.excluida ? ' class="so-excluida"' : '') + '><td><span class="so-st ' + esc(i.status) + '">' + esc(i.excluida ? 'Excluída' : (ROTULO_ST[i.status] || i.status)) + '</span></td>' +
          '<td class="num">' + esc(dataBR(i.data_vencimento)) + '<span class="so-muted" style="display:block">' + esc(prazo(i)) + '</span></td>' +
          (comEmpresa ? '<td>' + emp + '</td>' : '') +
          '<td>' + esc(i.outorgado) + '</td><td>' + esc(i.outorgante || '') + '</td>' +
          '<td class="num">' + esc(i.data_outorga ? dataBR(i.data_outorga) : '') + '</td>' +
          '<td class="poderes">' + esc(i.poderes || '') + '</td><td>' + esc((i.documents || []).join(', ')) + '</td>' +
          (podeEnviar ? '<td>' + (i.excluida ? '<button class="so-btn ghost mini" data-rest="' + esc(i.chave) + '">Restaurar</button>'
            : i.status === 'vencida' ? '<button class="so-btn ghost mini" data-excl="' + esc(i.chave) + '">Excluir</button>' : '') + '</td>' : '') + '</tr>';
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
      if (!i.excluida) conta[i.status] = (conta[i.status] || 0) + 1;
      if (empresas.indexOf(i.company) < 0) empresas.push(i.company);
    });
    var vencidas = itens.filter(function (i) { return i.status === 'vencida' && !i.excluida; }).map(function (i) { return i.chave; });
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
      '<div class="so-topo">' + (podeEnviar ? '<button class="so-btn" id="novaProcuracao">+ Nova procuração</button>' : '') + '<select class="so-sel" id="procEmpresa"><option value="">Todas as empresas</option>' +
      empresas.map(function (e) { return '<option value="' + esc(e) + '"' + (e === f.empresa ? ' selected' : '') + '>' + esc(e) + '</option>'; }).join('') +
      '</select><input class="so-busca" id="procBusca" style="max-width:320px" placeholder="Buscar outorgado, poderes, documento" value="' + esc(f.busca) + '">' +
      (f.status !== 'todas' ? '<button class="so-btn ghost" id="procTodas">Mostrar todas</button>' : '') +
      (podeEnviar && vencidas.length ? '<button class="so-btn ghost" id="procExclVenc">Excluir vencidas (' + vencidas.length + ')</button>' : '') +
      (podeEnviar && (proc.excluidas || procVerExcl) ? '<button class="so-btn ghost" id="procVerExcl">' +
        (procVerExcl ? 'Esconder excluídas' : 'Ver excluídas (' + proc.excluidas + ')') + '</button>' : '') + lendo + '</div>' +
      (vis.length ? '<div class="card">' + tabelaProc(vis, true) + '</div>'
        : '<div class="so-muted">' + (itens.length ? 'Nenhuma procuração com esses filtros.' : 'Nenhuma procuração encontrada nos documentos.') + '</div>');
    v.querySelector('.so-kpis').onclick = function (e) {
      var k = e.target.closest('[data-st]'); if (!k) return;
      f.status = f.status === k.dataset.st ? 'todas' : k.dataset.st; desenharProc();
    };
    if ($('#novaProcuracao')) $('#novaProcuracao').onclick = formNovaProcuracao;
    $('#procEmpresa').onchange = function () { f.empresa = this.value; desenharProc(); };
    $('#procBusca').oninput = function () {
      f.busca = this.value; var pos = this.selectionStart; desenharProc();
      var i = $('#procBusca'); i.focus(); i.setSelectionRange(pos, pos);
    };
    if ($('#procTodas')) $('#procTodas').onclick = function () { f.status = 'todas'; desenharProc(); };
    v.querySelectorAll('[data-empresa]').forEach(function (a) { a.onclick = function () { irPara('empresas', a.dataset.empresa); }; });
    ligarAcoesProc(v);
    if ($('#procExclVenc')) $('#procExclVenc').onclick = function () { excluirProcs(vencidas); };
    if ($('#procVerExcl')) $('#procVerExcl').onclick = function () { procVerExcl = !procVerExcl; proc = null; abrirProcuracoes(); };
  }

  /* ---------- Advogados (GET /hub/advogados) ---------- */
  var adv = null, buscaAdv = '';
  /* Especialidades a partir da "Área de atuação" (texto livre, várias por escritório, grafias
   * com e sem acento): entram na busca, então "cível" acha quem escreveu "Cívil" ou "Civil". */
  var ESPECIALIDADES = [
    ['Societário', ['societari']], ['Tributário', ['tributari']], ['Imobiliário', ['imobiliari']],
    ['Trabalhista', ['trabalhist']], ['Cível', ['civil', 'civel']], ['Cobranças', ['cobranc']],
    ['Criminal', ['criminal', 'penal']], ['Marcas e Patentes', ['marca', 'patente']], ['M&A', ['m&a']],
    ['Sucessão familiar', ['sucess']], ['Estruturas no exterior', ['exterior']],
  ];
  function especialidadesDe(f) {
    var a = sem(f.area);
    if (!a) return [];
    var achou = ESPECIALIDADES.filter(function (e) { return e[1].some(function (k) { return a.indexOf(k) >= 0; }); })
      .map(function (e) { return e[0]; });
    return achou.length ? achou : [String(f.area).trim()];
  }
  async function abrirAdvogados() {
    var v = $('#v-advogados');
    if (!adv) {
      v.innerHTML = '<div class="so-muted">Carregando os advogados…</div>';
      try { adv = await (await bot('/hub/advogados')).json(); }
      catch (e) { v.innerHTML = '<div class="so-erro">' + esc(e.message) + '</div>'; return; }
    }
    desenharAdvogados();
  }
  function desenharAdvogados() {
    var v = $('#v-advogados'), firmas = adv.escritorios || [], b = sem(buscaAdv);
    if (!firmas.length) { v.innerHTML = '<div class="so-muted">Nenhum escritório na planilha.</div>'; return; }
    var sel = firmas[+idDoHash()] || firmas[0];
    var vis = firmas.map(function (f, i) { return { f: f, i: i }; }).filter(function (x) {
      return !b || sem([x.f.nome, x.f.area, especialidadesDe(x.f).join(' '),
                        x.f.advogados.map(function (a) { return a.nome; }).join(' ')].join(' ')).indexOf(b) >= 0;
    });
    var h = (podeEnviar ? '<div class="so-topo"><button class="so-btn" id="novoEscritorio">+ Novo escritório</button>' +
      '<button class="so-btn ghost" id="importarAdv">Importar planilha</button></div>' : '') +
      '<div class="so-duas"><div class="so-lista">' +
      '<input class="so-busca" id="advBusca" placeholder="Buscar escritório, especialidade, advogado" value="' + esc(buscaAdv) + '">' +
      (vis.length ? '' : '<div class="so-muted" style="padding:8px">Nenhum escritório encontrado.</div>') +
      vis.map(function (x) {
        return '<button class="so-item' + (x.f === sel ? ' on' : '') + '" data-i="' + x.i + '">' + esc(x.f.nome) +
          (x.f.area ? '<span class="so-muted">' + esc(x.f.area) + '</span>' : '') + '</button>';
      }).join('') + '</div><div class="so-ficha">';
    h += '<div class="card"><h2>' + esc(sel.nome) + '</h2>' + kv([['CPF / CNPJ', sel.documento], ['Área de atuação', sel.area]]) +
      (podeEnviar ? '<div class="so-acoes"><button class="so-btn ghost" id="editEscr">Editar</button>' +
        '<button class="so-btn ghost" id="exclEscr">Excluir escritório</button></div>' : '') + '</div>';
    if (sel.indicacao) {
      h += '<div class="card" style="margin-top:14px"><div class="card-title"><h2>Indicação ou referência</h2></div><p class="so-texto">' + esc(sel.indicacao) + '</p></div>';
    }
    if (sel.processos.length) {
      h += '<div class="card" style="margin-top:14px"><div class="card-title"><h2>Processos em curso</h2></div><ul class="so-lista-proc">' +
        sel.processos.map(function (p) { return '<li>' + esc(p) + '</li>'; }).join('') + '</ul></div>';
    }
    var comProc = sel.advogados.some(function (a) { return a.processo; });
    h += '<div class="card" style="margin-top:14px"><div class="card-title"><h2>Advogados</h2>' + (podeEnviar ? '<button class="so-btn ghost" id="novoAdvogado" style="margin-left:auto">+ Advogado</button>' : '') + '</div><div class="tbl-wrap"><table class="so-tab">' +
      '<thead><tr><th>Advogado</th><th>Telefone</th><th>E-mail</th>' + (comProc ? '<th>Processo em curso</th>' : '') +
      (podeEnviar ? '<th></th>' : '') + '</tr></thead><tbody>' +
      sel.advogados.map(function (a, j) {
        return '<tr><td>' + esc(a.nome || '') + '</td><td>' + esc(a.telefone || '') + '</td><td>' +
          (a.email ? '<a class="so-link" href="mailto:' + esc(a.email) + '">' + esc(a.email) + '</a>' : '') + '</td>' +
          (comProc ? '<td>' + esc(a.processo || '') + '</td>' : '') +
          (podeEnviar ? '<td class="num"><button class="so-btn ghost mini" data-adv-ed="' + j + '">Editar</button> ' +
            '<button class="so-btn ghost mini" data-adv-ex="' + j + '">Excluir</button></td>' : '') + '</tr>';
      }).join('') + '</tbody></table></div></div>';
    h += cartaoAnexos('advogados', sel.nome, podeEnviar);
    h += '<div class="so-muted" style="margin-top:10px">' + esc(adv.arquivo + ' · atualizada em ' + dataBR(adv.atualizado_em)) + '</div>';
    v.innerHTML = h + '</div></div>';
    if ($('#novoEscritorio')) $('#novoEscritorio').onclick = formNovoEscritorio;
    if ($('#novoAdvogado')) $('#novoAdvogado').onclick = function () { formNovoAdvogado(firmas.indexOf(sel), sel.nome); };
    if ($('#importarAdv')) $('#importarAdv').onclick = function () { importarPlanilha('advogados'); };
    if ($('#editEscr')) $('#editEscr').onclick = function () { formEditarEscritorio(firmas.indexOf(sel), sel); };
    if ($('#exclEscr')) $('#exclEscr').onclick = function () { excluirEscritorio(firmas.indexOf(sel), sel); };
    v.querySelectorAll('[data-adv-ed]').forEach(function (b) {
      b.onclick = function () { var j = +b.dataset.advEd; formEditarAdvogado(firmas.indexOf(sel), sel, j, sel.advogados[j]); };
    });
    v.querySelectorAll('[data-adv-ex]').forEach(function (b) {
      b.onclick = function () { var j = +b.dataset.advEx; excluirAdvogado(firmas.indexOf(sel), sel, j, sel.advogados[j]); };
    });
    ligarAnexos('advogados');
    $('#advBusca').oninput = function () {
      buscaAdv = this.value; var pos = this.selectionStart; desenharAdvogados();
      var i = $('#advBusca'); i.focus(); i.setSelectionRange(pos, pos);
    };
    v.querySelector('.so-lista').onclick = function (e) {
      var bt = e.target.closest('button[data-i]'); if (bt) irPara('advogados', bt.dataset.i);
    };
  }

  /* ---------- Processos (GET /hub/processos; só para hub_can('processos')) ---------- */
  var processosData = null, procsFiltro = { tipo: '', area: '', esfera: '', escritorio: '', empresa: '', situacao: '', risco: '', prazo: false, busca: '' };
  function tituloProc(p) { return p.objeto || [p.tipo || p.area, p.numero].filter(Boolean).join(' · ') || '(sem descrição)'; }
  function riscoClasse(r) {
    var k = sem(r);
    return k.indexOf('provav') === 0 ? 'provavel' : k.indexOf('possiv') === 0 ? 'possivel' : k.indexOf('remot') === 0 ? 'remoto' : 'sem';
  }
  function diasAte(iso) {
    if (!iso) return null;
    var hoje = new Date(); hoje.setHours(0, 0, 0, 0);
    return Math.round((new Date(iso + 'T00:00:00') - hoje) / 864e5);
  }
  function reais(v) {
    if (v == null || v === '') return '';
    return typeof v === 'number' ? v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : String(v);
  }
  async function abrirProcessos() {
    var v = $('#v-processos');
    if (!processosData) {
      v.innerHTML = '<div class="so-muted">Carregando os processos…</div>';
      try { processosData = await (await bot('/hub/processos')).json(); }
      catch (e) { v.innerHTML = '<div class="so-erro">' + esc(e.message) + '</div>'; return; }
    }
    desenharProcessos();
  }
  function desenharProcessos() {
    var v = $('#v-processos'), todos = processosData.processos || [], f = procsFiltro, b = sem(f.busca);
    if (!todos.length) { v.innerHTML = '<div class="so-muted">Nenhum processo na planilha.</div>'; return; }
    var prazo7 = function (p) { var d = diasAte(p.data_proximo_prazo); return d != null && d >= 0 && d <= 7; };
    var opcoes = function (campo) {
      var vs = [];
      todos.forEach(function (p) { if (p[campo] && vs.indexOf(p[campo]) < 0) vs.push(p[campo]); });
      return vs.sort(function (x, y) { return String(x).localeCompare(String(y), 'pt-BR'); });
    };
    // contadores: o total e um por Tipo (Processo Judicial, Administrativo, PerdComp…) — clicar filtra
    var tipos = {};
    todos.forEach(function (p) { if (p.tipo) tipos[p.tipo] = (tipos[p.tipo] || 0) + 1; });
    var tiposOrd = Object.keys(tipos).sort(function (x, y) { return tipos[y] - tipos[x] || x.localeCompare(y, 'pt-BR'); }).slice(0, 4);
    if (f.tipo && !tipos[f.tipo]) f.tipo = '';
    var nPrazo = todos.filter(prazo7).length;
    if (!nPrazo) f.prazo = false;
    var FILTROS = [['pcArea', 'area', 'Todas as classes'], ['pcEsfera', 'esfera', 'Todas as esferas'],
      ['pcEscritorio', 'escritorio', 'Todos os jurídicos'], ['pcEmpresa', 'empresa', 'Todas as estruturas'],
      ['pcSituacao', 'situacao', 'Ativos e inativos'], ['pcRisco', 'risco', 'Todos os riscos']]
      .filter(function (x) { return opcoes(x[1]).length; });
    var vis = todos.map(function (p, i) { return { p: p, i: i }; }).filter(function (x) {
      var p = x.p;
      if (f.prazo && !prazo7(p)) return false;
      if (f.tipo && p.tipo !== f.tipo) return false;
      for (var k = 0; k < FILTROS.length; k++) { var c = FILTROS[k][1]; if (f[c] && p[c] !== f[c]) return false; }
      return !b || sem([p.objeto, p.numero, p.empresa, p.documento, p.tipo, p.area, p.esfera, p.parte_contraria, p.escritorio,
        p.advogado, p.fase, p.situacao, p.observacoes].join(' ')).indexOf(b) >= 0;
    });
    var sel = todos[+idDoHash()] || (vis[0] && vis[0].p) || todos[0];
    var valor = vis.reduce(function (t, x) { return t + (typeof x.p.valor_causa === 'number' ? x.p.valor_causa : 0); }, 0);
    var kpi = function (k, rot, n, on, cls) {
      return '<div class="card kpi' + (on ? ' on' : '') + '" data-k="' + esc(k) + '"><div class="label">' + esc(rot) +
        '</div><div class="val ' + (cls || '') + '">' + n + '</div></div>';
    };
    var kpis = [kpi('todos', 'Processos', todos.length, !f.tipo && !f.prazo)]
      .concat(tiposOrd.map(function (t) { return kpi('tipo:' + t, t, tipos[t], f.tipo === t); }))
      .concat(nPrazo ? [kpi('prazo', 'Prazo em até 7 dias', nPrazo, f.prazo, 'prazo')] : [])
      .concat(['<div class="card kpi"><div class="label">Valor' + (vis.length < todos.length ? ' (filtro)' : '') +
        '</div><div class="val">' + esc(reais(valor) || 'R$ 0,00') + '</div></div>']);
    var sel_ = function (id, campo, rot) {
      return '<select class="so-sel" id="' + id + '"><option value="">' + rot + '</option>' + opcoes(campo).map(function (o) {
        return '<option value="' + esc(o) + '"' + (o === f[campo] ? ' selected' : '') + '>' + esc(o) + '</option>';
      }).join('') + '</select>';
    };
    var h = '<div class="so-kpis" style="grid-template-columns:repeat(' + kpis.length + ',minmax(0,1fr))">' + kpis.join('') + '</div>' +
      '<div class="so-topo">' + (podeEnviar ? '<button class="so-btn" id="novoProcesso">+ Novo processo</button><button class="so-btn ghost" id="importarProc">Importar planilha</button>' : '') +
      FILTROS.map(function (x) { return sel_(x[0], x[1], x[2]); }).join('') +
      '<input class="so-busca" id="pcBusca" style="max-width:300px" placeholder="Buscar processo, estrutura, assunto" value="' + esc(f.busca) + '"></div>';
    h += '<div class="so-duas"><div class="so-lista">' + (vis.length ? vis.map(function (x) {
      var sub = [x.p.empresa, x.p.escritorio, x.p.tipo].filter(Boolean).join(' · ');
      return '<button class="so-item' + (x.p === sel ? ' on' : '') + '" data-i="' + x.i + '">' + esc(tituloProc(x.p)) +
        (sub ? '<span class="so-muted">' + esc(sub) + '</span>' : '') + '</button>';
    }).join('') : '<div class="so-muted" style="padding:8px">Nenhum processo com esses filtros.</div>') + '</div><div class="so-ficha">';
    var dProx = diasAte(sel.data_proximo_prazo);
    // todo campo que a planilha tem aparece na ficha, vazio como "—" (antes só se via no Editar)
    var tem = function (ks) { var c = processosData.campos || []; return [].concat(ks).some(function (k) { return c.indexOf(k) >= 0; }); };
    var kvP = function (pares) {   // [rótulo, valor, campo(s) da planilha]
      return kv(pares.filter(function (x) { return x[1] || tem(x[2]); }).map(function (x) { return [x[0], x[1] || '—']; }));
    };
    var ANDAMENTO = ['data_ultima_movimentacao', 'observacoes', 'ultima_movimentacao', 'proximo_prazo', 'data_proximo_prazo'];
    var inativo = sem(sel.situacao).indexOf('inativ') === 0;
    h += '<div class="card"><h2>' + esc(tituloProc(sel)) +
      (sel.situacao ? '<span class="so-st ' + (inativo ? 'sem' : 'vigente') + '" style="margin-left:10px">' + esc(sel.situacao) + '</span>' : '') +
      (sel.risco ? '<span class="so-st ' + riscoClasse(sel.risco) + '" style="margin-left:8px">Risco ' + esc(sel.risco) + '</span>' : '') + '</h2>' +
      (podeEnviar && sel.id ? '<div class="so-acoes"><button class="so-btn ghost" id="editProc">Editar</button></div>' : '') +
      kvP([['Estrutura (empresa ou pessoa física)', sel.empresa, 'empresa'], ['CNPJ ou CPF', sel.documento, 'documento'],
          ['Tipo', sel.tipo, 'tipo'], ['Classe', sel.area, 'area'], ['Esfera', sel.esfera, 'esfera'], ['Número do processo', sel.numero, 'numero'],
          ['Objeto', '', sel.objeto ? [] : 'objeto'],          // preenchido, o objeto já é o título
          ['Data inicial', sel.data_inicio ? dataBR(sel.data_inicio) : '', 'data_inicio'], ['Valor', reais(sel.valor_causa), 'valor_causa'],
          ['Pessoas envolvidas', sel.parte_contraria, 'parte_contraria'], ['Advogado responsável', sel.advogado, 'advogado']]
        .concat(sel.situacao ? [] : [['Situação', '', 'situacao']]).concat(sel.risco ? [] : [['Risco', '', 'risco']]));
    if (sel.escritorio) {
      h += '<div class="so-kv"><div><div class="k">Jurídico responsável</div><div class="v"><button class="so-link" id="pcEscr">' +
        esc(sel.escritorio) + '</button></div></div></div>';
    } else h += kvP([['Jurídico responsável', '', 'escritorio']]);
    h += kvP([['Polo', sel.polo, 'polo'], ['Tribunal / vara', sel.tribunal, 'tribunal'], ['Fase', sel.fase, 'fase']]) + '</div>';
    if (tem(ANDAMENTO) || ANDAMENTO.some(function (k) { return sel[k]; })) {
      h += '<div class="card" style="margin-top:14px"><div class="card-title"><h2>Andamento</h2></div>' +
        kvP([['Data da última posição', sel.data_ultima_movimentacao ? dataBR(sel.data_ultima_movimentacao) : '', 'data_ultima_movimentacao'],
            ['Observações', sel.observacoes, 'observacoes'], ['Andamento', sel.ultima_movimentacao, 'ultima_movimentacao'],
            ['Próximo prazo / audiência', [sel.data_proximo_prazo ? dataBR(sel.data_proximo_prazo) : '', sel.proximo_prazo || ''].filter(Boolean).join(' — '),
             ['data_proximo_prazo', 'proximo_prazo']]]) +
        (dProx != null && dProx >= 0 && dProx <= 7 ? '<span class="so-st vence_7">' + (dProx === 0 ? 'hoje' : 'em ' + dProx + (dProx === 1 ? ' dia' : ' dias')) + '</span>' : '') +
        '</div>';
    }
    var cnj = sel.andamento_cnj;
    if (sel.numero_cnj && processosData.andamentos_configurado) {
      h += '<div class="card" style="margin-top:14px" id="pcCnj"><div class="card-title"><h2>Andamento no CNJ</h2>' +
        (cnj && cnj.consultado_em ? '<span class="so-muted" style="margin-left:auto">consultado em ' + esc(dataBR(cnj.consultado_em)) + '</span>' : '') + '</div>' +
        (!cnj ? '<div class="so-muted">Ainda não consultado.</div>'
          : cnj.encontrado === false ? '<span class="so-badge">não encontrado no DataJud</span>'
          : kv([['Tribunal', cnj.tribunal], ['Classe', cnj.classe], ['Órgão julgador', cnj.orgao]]) +
            '<ul class="so-docs" style="columns:1">' + (cnj.movimentos || []).map(function (m) {
              return '<li><strong>' + esc(dataBR(m.data)) + '</strong> — ' + esc(m.nome) + '</li>';
            }).join('') + '</ul>') +
        '</div>';
    }
    if (sel.id) h += cartaoAnexos('processos', sel.id, podeEnviar);
    h += '<div class="so-muted" style="margin-top:10px">' + esc(processosData.arquivo + ' · atualizada em ' + dataBR(processosData.atualizado_em)) + '</div>';
    v.innerHTML = h + '</div></div>';
    if ($('#novoProcesso')) $('#novoProcesso').onclick = formNovoProcesso;
    if ($('#importarProc')) $('#importarProc').onclick = function () { importarPlanilha('processos'); };
    if ($('#editProc')) $('#editProc').onclick = function () { formEditarProcesso(sel); };
    ligarAnexos('processos');

    v.querySelector('.so-kpis').onclick = function (e) {
      var k = e.target.closest('[data-k]'); if (!k) return;
      var id = k.dataset.k;
      if (id === 'todos') { f.tipo = ''; f.prazo = false; }
      else if (id === 'prazo') f.prazo = !f.prazo;
      else if (id.indexOf('tipo:') === 0) f.tipo = f.tipo === id.slice(5) ? '' : id.slice(5);
      desenharProcessos();
    };
    FILTROS.forEach(function (x) {
      $('#' + x[0]).onchange = function () { f[x[1]] = this.value; desenharProcessos(); };
    });
    $('#pcBusca').oninput = function () {
      f.busca = this.value; var pos = this.selectionStart; desenharProcessos();
      var i = $('#pcBusca'); i.focus(); i.setSelectionRange(pos, pos);
    };
    v.querySelector('.so-lista').onclick = function (e) {
      var bt = e.target.closest('button[data-i]'); if (bt) irPara('processos', bt.dataset.i);
    };
    if ($('#pcEscr')) $('#pcEscr').onclick = async function () {
      try { if (!adv) adv = await (await bot('/hub/advogados')).json(); } catch (e) { return aviso(e.message, true); }
      var i = acharEscritorio(sel.escritorio, adv.escritorios || []);
      if (i < 0) return aviso(sel.escritorio + ' não está na lista de advogados.', true);
      irPara('advogados', String(i));
    };
  }
  /* O nome do jurídico na lista de processos é curto ("Siqueira Castro", "Bergqvist adv", "Priscila
   * Moragas"): é o escritório cujo nome (ou o de um advogado dele) tem todas as palavras dele. */
  function acharEscritorio(nome, firmas) {
    var VAZIAS = ['adv', 'advs', 'advogados', 'advogado', 'advocacia', 'associados', 'escrit', 'escritorio', 'de', 'da', 'do', 'e', '&'];
    var palavras = function (t) { return sem(t).split(/[^a-z0-9&]+/).filter(function (w) { return w && VAZIAS.indexOf(w) < 0; }); };
    var alvo = palavras(nome);
    if (!alvo.length) return -1;
    var contem = function (texto) { var ws = palavras(texto); return alvo.every(function (w) { return ws.indexOf(w) >= 0; }); };
    var i = firmas.findIndex(function (f) { return contem(f.nome); });
    return i >= 0 ? i : firmas.findIndex(function (f) { return f.advogados.some(function (a) { return contem(a.nome); }); });
  }
  // O botão só aparece para quem tem hub_can('processos') — o bot confere de novo a cada pedido.
  (async function () {
    try {
      var r = await sb().rpc('hub_can', { dash: 'processos' });
      if (r && r.data === true) $('#btnProcessos').hidden = false;
    } catch (e) { /* sem acesso: o botão fica escondido */ }
  })();

  /* ---------- Cadastro pelo Hub: formulário, aviso, anexos ----------
   * Tudo que se cria aqui vira commit no repo (o bot grava pela API do GitHub) e chega
   * nas listas depois que o publish-documents sobe pro Azure — alguns minutos. */
  var DEMORA = ' Aparece aqui em alguns minutos.';
  /* Planilhas de advogados e processos: o bot grava também na pasta que ele lê
   * (r.espelhado) — relê na hora e a pessoa vê o que salvou. Sem isso, a tela ficava
   * com a versão de antes até recarregar a página depois do publish-documents. */
  function depois(r, qual) {
    if (!r || !r.espelhado) return DEMORA;
    if (qual === 'processos') { processosData = null; if (secaoAtual() === 'processos') abrirProcessos(); }
    else { adv = null; if (secaoAtual() === 'advogados') abrirAdvogados(); }
    return '';
  }
  function aviso(msg, erro) {
    var t = document.createElement('div');
    t.className = 'so-aviso' + (erro ? ' erro' : ''); t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 7000);
  }
  async function postJson(path, dados) {
    return (await bot(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(dados) })).json();
  }
  async function postArquivo(path, arq) {
    if (!arq) throw new Error('Escolha o arquivo.');
    if (arq.size > 25 * 1024 * 1024) throw new Error('Arquivo maior que 25 MB.');
    return (await bot(path, { method: 'POST', headers: { 'Content-Type': arq.type || 'application/octet-stream' }, body: arq })).json();
  }
  function formulario(titulo, campos, salvar) {
    var fundo = document.createElement('div');
    fundo.className = 'so-modal';
    fundo.innerHTML = '<form class="card so-form" novalidate><h2>' + esc(titulo) + '</h2>' + campos.map(function (c) {
      var id = 'f_' + c.id, ctl;
      if (c.tipo === 'textarea') ctl = '<textarea id="' + id + '" rows="3"></textarea>';
      else if (c.tipo === 'select') ctl = '<select id="' + id + '"><option value=""></option>' + (c.opcoes || []).map(function (o) {
        var v = typeof o === 'object' ? o.v : o, t = typeof o === 'object' ? o.t : o;
        return '<option value="' + esc(v) + '">' + esc(t) + '</option>';
      }).join('') + '</select>';
      else ctl = '<input id="' + id + '" type="' + (c.tipo || 'text') + '"' + (c.accept ? ' accept="' + c.accept + '"' : '') +
        (c.tipo === 'number' ? ' step="0.01" min="0"' : '') + '>';
      return '<label class="so-campo"><span>' + esc(c.rotulo) + (c.obrigatorio ? ' *' : '') + '</span>' + ctl + '</label>';
    }).join('') + '<div class="so-form-pe"><span class="so-muted" id="fStatus"></span>' +
      '<button type="button" class="so-btn ghost" id="fCancelar">Cancelar</button><button class="so-btn" id="fSalvar">Salvar</button></div></form>';
    document.body.appendChild(fundo);
    campos.forEach(function (c) { if (c.valor != null && c.tipo !== 'file') fundo.querySelector('#f_' + c.id).value = c.valor; });
    var fechar = function () { fundo.remove(); };
    fundo.querySelector('#fCancelar').onclick = fechar;
    fundo.addEventListener('mousedown', function (e) { if (e.target === fundo) fechar(); });
    fundo.querySelector('form').onsubmit = async function (e) {
      e.preventDefault();
      var vals = {}, st = fundo.querySelector('#fStatus'), bt = fundo.querySelector('#fSalvar');
      campos.forEach(function (c) {
        var el = fundo.querySelector('#f_' + c.id);
        vals[c.id] = c.tipo === 'file' ? (el.files && el.files[0]) || null : el.value.trim();
      });
      var falta = campos.filter(function (c) { return c.obrigatorio && !vals[c.id]; })[0];
      if (falta) { st.className = 'so-erro'; st.textContent = 'Preencha: ' + falta.rotulo + '.'; return; }
      bt.disabled = true; st.className = 'so-muted'; st.textContent = 'Salvando…';
      try { var msg = await salvar(vals); fechar(); aviso(msg || 'Salvo.'); }
      catch (err) { st.className = 'so-erro'; st.textContent = err.message; bt.disabled = false; }
    };
    var primeiro = fundo.querySelector('input,select,textarea');
    if (primeiro) primeiro.focus();
  }
  async function garantirDados() {
    if (!dados) { dados = await (await bot('/hub/dados')).json(); indexar(); carregado.dados = true; }
    return dados;
  }
  function redesenhar() {
    var s = secaoAtual();
    if (s === 'empresas' && carregado.dados) desenharEmpresas();
    else if (s === 'investidores' && carregado.dados) desenharInvestidores();
    else if (s === 'advogados' && adv) desenharAdvogados();
    else if (s === 'processos' && processosData) desenharProcessos();
    else if (s === 'procuracoes' && proc) desenharProc();
  }
  function cartaoAnexos(tipo, chave, podeEnviarAqui) {
    return '<div class="card" style="margin-top:14px" id="anx-' + tipo + '" data-chave="' + esc(chave) + '"><div class="card-title"><h2>Anexos</h2>' +
      (podeEnviarAqui ? '<button class="so-btn ghost" data-anx-enviar style="margin-left:auto">Enviar anexo</button><input type="file" data-anx-arq hidden>' : '') +
      '</div><div data-anx-lista class="so-muted">Carregando…</div></div>';
  }
  async function ligarAnexos(tipo) {
    var box = $('#anx-' + tipo);
    if (!box) return;
    var chave = box.dataset.chave, lista = box.querySelector('[data-anx-lista]');
    var bt = box.querySelector('[data-anx-enviar]'), inp = box.querySelector('[data-anx-arq]');
    var q = 'tipo=' + tipo + '&chave=' + encodeURIComponent(chave);
    if (bt) {
      bt.onclick = function () { inp.click(); };
      inp.onchange = async function () {
        var arq = this.files && this.files[0];
        if (!arq) return;
        bt.disabled = true;
        try {
          var r = await postArquivo('/hub/anexos?' + q + '&nome=' + encodeURIComponent(arq.name), arq);
          aviso('Anexo enviado: ' + r.arquivo + '.' + DEMORA);
        } catch (e) { aviso(e.message, true); }
        bt.disabled = false; this.value = '';
      };
    }
    try {
      var itens = await (await bot('/hub/anexos?' + q)).json();
      if (!document.body.contains(box)) return;
      lista.className = itens.length ? '' : 'so-muted';
      lista.innerHTML = itens.length ? '<ul class="so-docs">' + itens.map(function (a) {
        return '<li><button class="so-link" data-anx="' + esc(a.nome) + '">' + esc(a.nome) + '</button> <span class="so-muted">' +
          esc(dataBR(a.enviado_em)) + '</span></li>';
      }).join('') + '</ul>' : 'Nenhum anexo.';
      lista.querySelectorAll('[data-anx]').forEach(function (b) {
        b.onclick = async function () {
          try { baixarBlob(await (await bot('/hub/anexos/arquivo?' + q + '&nome=' + encodeURIComponent(b.dataset.anx))).blob(), b.dataset.anx); }
          catch (e) { aviso(e.message, true); }
        };
      });
    } catch (e) { lista.className = 'so-erro'; lista.textContent = e.message; }
  }
  var AREAS = ['Trabalhista', 'Tributário', 'Cível', 'Criminal', 'Societário', 'Imobiliário', 'Sucessório', 'Marcas e Patentes', 'Administrativo'];
  function formNovaEmpresa() {
    formulario('Nova empresa', [{ id: 'nome', rotulo: 'Nome da empresa', obrigatorio: true }], async function (v) {
      var r = await postJson('/hub/empresas', { nome: v.nome });
      return 'Empresa criada: ' + r.pasta + '. Envie os documentos dela pela ficha.' + DEMORA;
    });
  }
  async function formNovaProcuracao() {
    try { await garantirDados(); } catch (e) { return aviso(e.message, true); }
    var opcoes = dados.companies.slice().sort(function (a, b) { return nomeEmpresa(a).localeCompare(nomeEmpresa(b), 'pt-BR'); })
      .map(function (c) { return { v: c.key, t: nomeEmpresa(c) }; });
    formulario('Nova procuração', [
      { id: 'empresa', rotulo: 'Empresa', tipo: 'select', opcoes: opcoes, obrigatorio: true },
      { id: 'arquivo', rotulo: 'PDF da procuração', tipo: 'file', accept: 'application/pdf,.pdf', obrigatorio: true },
    ], async function (v) {
      var r = await postArquivo('/hub/documentos?empresa=' + encodeURIComponent(v.empresa) + '&nome=' + encodeURIComponent(v.arquivo.name), v.arquivo);
      return 'Procuração enviada para ' + r.pasta + '. Entra na lista depois que o bot ler o documento (alguns minutos).';
    });
  }
  function formNovoEscritorio() {
    formulario('Novo escritório', [
      { id: 'nome', rotulo: 'Nome / razão social', obrigatorio: true }, { id: 'documento', rotulo: 'CPF / CNPJ' },
      { id: 'area', rotulo: 'Área de atuação' }, { id: 'indicacao', rotulo: 'Indicação ou referência', tipo: 'textarea' },
      { id: 'processo', rotulo: 'Processo em curso' }, { id: 'adv_nome', rotulo: 'Advogado responsável' },
      { id: 'adv_telefone', rotulo: 'Telefone' }, { id: 'adv_email', rotulo: 'E-mail', tipo: 'email' },
    ], async function (v) {
      var r = await postJson('/hub/advogados', { nome: v.nome, documento: v.documento, area: v.area, indicacao: v.indicacao,
        processo: v.processo, advogados: [{ nome: v.adv_nome, telefone: v.adv_telefone, email: v.adv_email }] });
      return 'Escritório incluído: ' + v.nome + '.' + depois(r, 'advogados');
    });
  }
  function formNovoAdvogado(indice, escritorio) {
    formulario('Novo advogado — ' + escritorio, [
      { id: 'nome', rotulo: 'Nome', obrigatorio: true }, { id: 'telefone', rotulo: 'Telefone' },
      { id: 'email', rotulo: 'E-mail', tipo: 'email' }, { id: 'processo', rotulo: 'Processo em curso' },
    ], async function (v) {
      var r = await postJson('/hub/advogados/' + indice + '/advogados', v);
      return 'Advogado incluído: ' + v.nome + '.' + depois(r, 'advogados');
    });
  }
  // campos na ordem da lista da equipe; o formulário só oferece os que a planilha tem
  function camposProcesso(o) {
    o = o || {};
    var com = function (padrao, campo) {
      var vs = padrao.slice();
      ((processosData && processosData.processos) || []).forEach(function (p) { if (p[campo] && vs.indexOf(p[campo]) < 0) vs.push(p[campo]); });
      if (o[campo] && vs.indexOf(o[campo]) < 0) vs.push(o[campo]);
      return vs;
    };
    var todos = [
      { id: 'empresa', rotulo: 'Estrutura (empresa ou pessoa física)', valor: o.empresa }, { id: 'documento', rotulo: 'CNPJ ou CPF', valor: o.documento },
      { id: 'tipo', rotulo: 'Tipo', tipo: 'select', opcoes: com(['Processo Judicial', 'Processo Administrativo', 'PerdComp'], 'tipo'), valor: o.tipo },
      { id: 'numero', rotulo: 'Número do processo', valor: o.numero },
      { id: 'area', rotulo: 'Classe', tipo: 'select', opcoes: com(AREAS, 'area'), valor: o.area },
      { id: 'data_inicio', rotulo: 'Data inicial', tipo: 'date', valor: o.data_inicio },
      { id: 'esfera', rotulo: 'Esfera', tipo: 'select', opcoes: com(['Federal', 'Estadual', 'Municipal'], 'esfera'), valor: o.esfera },
      { id: 'escritorio', rotulo: 'Jurídico responsável', valor: o.escritorio },
      { id: 'objeto', rotulo: 'Assunto', tipo: 'textarea', valor: o.objeto },
      { id: 'valor_causa', rotulo: 'Valor (R$)', tipo: 'number', valor: o.valor_causa },
      { id: 'situacao', rotulo: 'Ativo/Inativo', tipo: 'select', opcoes: com(['Ativo', 'Inativo'], 'situacao'), valor: o.situacao },
      { id: 'data_ultima_movimentacao', rotulo: 'Data da última posição', tipo: 'date', valor: o.data_ultima_movimentacao },
      { id: 'observacoes', rotulo: 'Observações', tipo: 'textarea', valor: o.observacoes },
      { id: 'parte_contraria', rotulo: 'Pessoas envolvidas (PJ ou PF)', tipo: 'textarea', valor: o.parte_contraria },
      { id: 'advogado', rotulo: 'Advogado responsável', valor: o.advogado },
      { id: 'ultima_movimentacao', rotulo: 'Andamento', tipo: 'textarea', valor: o.ultima_movimentacao },
      { id: 'polo', rotulo: 'Polo', tipo: 'select', opcoes: com(['Autor', 'Réu', 'Terceiro interessado'], 'polo'), valor: o.polo },
      { id: 'tribunal', rotulo: 'Tribunal / vara', valor: o.tribunal },
      { id: 'risco', rotulo: 'Risco', tipo: 'select', opcoes: com(['Provável', 'Possível', 'Remoto'], 'risco'), valor: o.risco },
      { id: 'fase', rotulo: 'Fase', valor: o.fase },
      { id: 'proximo_prazo', rotulo: 'Próximo prazo / audiência', valor: o.proximo_prazo },
      { id: 'data_proximo_prazo', rotulo: 'Data do próximo prazo', tipo: 'date', valor: o.data_proximo_prazo },
    ];
    var tem = processosData && processosData.campos;
    return tem ? todos.filter(function (c) { return tem.indexOf(c.id) >= 0; }) : todos;
  }
  function identifica(v) {
    if (!v.numero && !v.area && !v.objeto) throw new Error('Informe o número, o tipo ou o objeto do processo.');
  }
  function formNovoProcesso() {
    formulario('Novo processo', camposProcesso(), async function (v) {
      identifica(v);
      v.valor_causa = v.valor_causa ? parseFloat(v.valor_causa) : null;
      var r = await postJson('/hub/processos', v);
      return 'Processo ' + r.id + ' incluído.' + depois(r, 'processos');
    });
  }

  /* ---------- Editar, excluir, importar ---------- */
  function mudou(orig, v) {          // só o que o usuário alterou vai pro bot
    var m = {};
    Object.keys(orig).forEach(function (k) { if ((v[k] || '') !== (orig[k] || '')) m[k] = v[k] || ''; });
    return m;
  }
  function modalPrevia(titulo, html, rotulo, acao) {
    var fundo = document.createElement('div');
    fundo.className = 'so-modal';
    fundo.innerHTML = '<div class="card so-form"><h2>' + esc(titulo) + '</h2><div>' + html + '</div><div class="so-form-pe">' +
      '<span class="so-muted" id="pStatus"></span><button type="button" class="so-btn ghost" id="pCancelar">' + (rotulo ? 'Cancelar' : 'Fechar') +
      '</button>' + (rotulo ? '<button class="so-btn" id="pOk">' + esc(rotulo) + '</button>' : '') + '</div></div>';
    document.body.appendChild(fundo);
    var fechar = function () { fundo.remove(); };
    fundo.querySelector('#pCancelar').onclick = fechar;
    if (rotulo) fundo.querySelector('#pOk').onclick = async function () {
      var st = fundo.querySelector('#pStatus'), bt = this;
      bt.disabled = true; st.className = 'so-muted'; st.textContent = 'Salvando…';
      try { var m = await acao(); fechar(); aviso(m); }
      catch (e) { st.className = 'so-erro'; st.textContent = e.message; bt.disabled = false; }
    };
  }
  function importarPlanilha(tipo) {
    var inp = document.createElement('input');
    inp.type = 'file'; inp.hidden = true; inp.id = 'importArq';
    inp.accept = '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    document.body.appendChild(inp);
    inp.onchange = async function () {
      var arq = inp.files && inp.files[0];
      inp.remove();
      if (!arq) return;
      var url = '/hub/' + tipo + '/importar';
      try {
        var p = await postArquivo(url + '?confirmar=0', arq);
        var linhas = tipo === 'advogados'
          ? p.escritorios.map(function (f) {
              return '<li>Escritório novo: <strong>' + esc(f.nome) + '</strong>' + (f.area ? ' — ' + esc(f.area) : '') +
                ' (' + f.advogados.length + ' advogado' + (f.advogados.length === 1 ? '' : 's') + ')</li>';
            }).concat(p.advogados.map(function (a) {
              return '<li>Advogado novo em ' + esc(a.escritorio) + ': <strong>' + esc(a.nome) + '</strong></li>';
            }))
          : p.processos.map(function (x) {
              return '<li><strong>' + esc(x.objeto) + '</strong>' + (x.numero ? ' — ' + esc(x.numero) : '') + '</li>';
            });
        var n = linhas.length;
        modalPrevia('Importar ' + tipo,
          '<p class="so-muted">' + p.lidos + ' na planilha, ' + n + ' novo' + (n === 1 ? '' : 's') + '.</p>' +
            (n ? '<ul class="so-docs" style="columns:1">' + linhas.join('') + '</ul>' : ''),
          n ? 'Importar ' + n : null,
          async function () {
            var r = await postArquivo(url + '?confirmar=1', arq);
            return n + (n === 1 ? ' item importado.' : ' itens importados.') + depois(r, tipo);
          });
      } catch (e) { aviso(e.message, true); }
    };
    inp.click();
  }
  function formEditarEmpresa(c) {
    var orig = { pasta: c.pasta || nomeEmpresa(c), name: c.name || '', cnpj: c.cnpj || '', type: c.type || '',
                 capital_social: c.capital_social && c.capital_social !== 'None' ? c.capital_social : '' };
    formulario('Editar empresa', [
      { id: 'pasta', rotulo: 'Nome da empresa (pasta)', obrigatorio: true, valor: orig.pasta },
      { id: 'name', rotulo: 'Razão social', valor: orig.name }, { id: 'cnpj', rotulo: 'CNPJ', valor: orig.cnpj },
      { id: 'type', rotulo: 'Tipo', valor: orig.type }, { id: 'capital_social', rotulo: 'Capital social', valor: orig.capital_social },
    ], async function (v) {
      var m = mudou(orig, v);
      if (!Object.keys(m).length) return 'Nada mudou.';
      var r = await postJson('/hub/empresas/' + encodeURIComponent(c.key) + '/editar', m);
      return 'Empresa salva' + (m.pasta ? ' como ' + r.pasta : '') + '.' + DEMORA;
    });
  }
  async function excluirEmpresa(c) {
    if (!window.confirm('Excluir a empresa ' + nomeEmpresa(c) + '?')) return;
    try {
      await postJson('/hub/empresas/' + encodeURIComponent(c.key) + '/excluir', {});
      aviso('Empresa excluída: ' + nomeEmpresa(c) + '.' + DEMORA);
    } catch (e) { aviso(e.message, true); }
  }
  // procurações: o bot só aceita excluir vencida; a lista daqui já reflete na hora
  function marcarProcs(chaves, excluida) {
    if (!proc) return;
    proc.items = (proc.items || []).filter(function (i) { return excluida ? (procVerExcl || chaves.indexOf(i.chave) < 0) : true; })
      .map(function (i) { return chaves.indexOf(i.chave) >= 0 ? Object.assign({}, i, { excluida: excluida }) : i; });
    proc.excluidas = Math.max(0, (proc.excluidas || 0) + (excluida ? chaves.length : -chaves.length));
    redesenhar();
  }
  async function excluirProcs(chaves) {
    var msg = chaves.length === 1 ? 'Excluir esta procuração vencida da lista? O documento continua na pasta da empresa.'
      : 'Excluir ' + chaves.length + ' procurações vencidas da lista? Os documentos continuam nas pastas.';
    if (!window.confirm(msg)) return;
    try {
      await postJson('/hub/procuracoes/excluir', { chaves: chaves });
      marcarProcs(chaves, true);
      aviso(chaves.length === 1 ? 'Procuração excluída.' : chaves.length + ' procurações excluídas.');
    } catch (e) { aviso(e.message, true); }
  }
  async function restaurarProcs(chaves) {
    try {
      await postJson('/hub/procuracoes/restaurar', { chaves: chaves });
      marcarProcs(chaves, false);
      aviso('Procuração restaurada.');
    } catch (e) { aviso(e.message, true); }
  }
  function ligarAcoesProc(box) {
    box.querySelectorAll('[data-excl]').forEach(function (b) { b.onclick = function () { excluirProcs([b.dataset.excl]); }; });
    box.querySelectorAll('[data-rest]').forEach(function (b) { b.onclick = function () { restaurarProcs([b.dataset.rest]); }; });
  }
  function formEditarEscritorio(i, f) {
    var orig = { nome: f.nome || '', documento: f.documento || '', area: f.area || '', indicacao: f.indicacao || '' };
    var campos = [{ id: 'nome', rotulo: 'Nome / razão social', obrigatorio: true, valor: orig.nome },
      { id: 'documento', rotulo: 'CPF / CNPJ', valor: orig.documento }, { id: 'area', rotulo: 'Área de atuação', valor: orig.area },
      { id: 'indicacao', rotulo: 'Indicação ou referência', tipo: 'textarea', valor: orig.indicacao }];
    if (f.processos.length || !f.advogados.some(function (a) { return a.processo; })) {
      orig.processo = f.processos[0] || '';
      campos.push({ id: 'processo', rotulo: 'Processo em curso (do escritório)', valor: orig.processo });
    }
    formulario('Editar escritório', campos, async function (v) {
      var m = mudou(orig, v);
      if (!Object.keys(m).length) return 'Nada mudou.';
      m.nome_atual = f.nome;
      return 'Escritório salvo.' + depois(await postJson('/hub/advogados/' + i + '/editar', m), 'advogados');
    });
  }
  async function excluirEscritorio(i, f) {
    if (!window.confirm('Excluir o escritório ' + f.nome + ' e os ' + f.advogados.length + ' advogado(s) dele?')) return;
    try {
      var r = await postJson('/hub/advogados/' + i + '/excluir', { nome_atual: f.nome });
      aviso('Escritório excluído: ' + f.nome + '.' + depois(r, 'advogados'));
    } catch (e) { aviso(e.message, true); }
  }
  function formEditarAdvogado(i, f, j, a) {
    var orig = { nome: a.nome || '', telefone: a.telefone || '', email: a.email || '', processo: a.processo || '' };
    formulario('Editar advogado — ' + f.nome, [
      { id: 'nome', rotulo: 'Nome', obrigatorio: true, valor: orig.nome }, { id: 'telefone', rotulo: 'Telefone', valor: orig.telefone },
      { id: 'email', rotulo: 'E-mail', tipo: 'email', valor: orig.email }, { id: 'processo', rotulo: 'Processo em curso', valor: orig.processo },
    ], async function (v) {
      var m = mudou(orig, v);
      if (!Object.keys(m).length) return 'Nada mudou.';
      m.nome_atual = a.nome || ''; m.escritorio = f.nome;
      return 'Advogado salvo.' + depois(await postJson('/hub/advogados/' + i + '/advogados/' + j + '/editar', m), 'advogados');
    });
  }
  async function excluirAdvogado(i, f, j, a) {
    if (!window.confirm('Excluir ' + (a.nome || 'este advogado') + ' do escritório ' + f.nome + '?')) return;
    try {
      var r = await postJson('/hub/advogados/' + i + '/advogados/' + j + '/excluir', { nome_atual: a.nome || '', escritorio: f.nome });
      aviso('Advogado excluído: ' + (a.nome || '') + '.' + depois(r, 'advogados'));
    } catch (e) { aviso(e.message, true); }
  }
  function formEditarProcesso(p) {
    var orig = {};
    camposProcesso().forEach(function (c) { orig[c.id] = p[c.id] == null ? '' : String(p[c.id]); });
    formulario('Editar processo ' + p.id, camposProcesso(orig), async function (v) {
      identifica(v);
      var m = mudou(orig, v);
      if (!Object.keys(m).length) return 'Nada mudou.';
      if ('valor_causa' in m) m.valor_causa = m.valor_causa ? parseFloat(m.valor_causa) : null;
      return 'Processo ' + p.id + ' salvo.' + depois(await postJson('/hub/processos/' + encodeURIComponent(p.id) + '/editar', m), 'processos');
    });
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

  // Envio de documento pela ficha da empresa: o bot commita o PDF no repo, e o
  // publish-documents.yml sobe pro Azure e reindexa. Só para hub_can('societario_envio').
  var podeEnviar = false, envioStatus = {};
  async function enviarDoc(c, arq) {
    if (!/\.pdf$/i.test(arq.name) && arq.type !== 'application/pdf') {
      envioStatus[c.key] = { erro: true, msg: 'Só PDF.' }; return desenharEmpresas();
    }
    if (arq.size > 25 * 1024 * 1024) {
      envioStatus[c.key] = { erro: true, msg: 'Arquivo maior que 25 MB.' }; return desenharEmpresas();
    }
    envioStatus[c.key] = { enviando: true, msg: 'Enviando ' + arq.name + '…' };
    desenharEmpresas();
    try {
      var r = await (await bot('/hub/documentos?empresa=' + encodeURIComponent(c.key) + '&nome=' + encodeURIComponent(arq.name),
        { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: arq })).json();
      envioStatus[c.key] = { msg: 'Enviado: ' + r.arquivo + '. Entra na lista depois que o bot reindexar (alguns minutos).' };
    } catch (e) {
      envioStatus[c.key] = { erro: true, msg: e.message };
    }
    if (secaoAtual() === 'empresas') desenharEmpresas();
  }
  (async function () {
    try {
      var r = await sb().rpc('hub_can', { dash: 'societario_envio' });
      if (r && r.data === true) {
        podeEnviar = true;
        redesenhar();
      }
    } catch (e) { /* sem permissão: sem botão */ }
  })();

  function desenharEmpresas() {
    var v = $('#v-empresas');
    var itens = dados.companies.slice().sort(function (a, b) { return nomeEmpresa(a).localeCompare(nomeEmpresa(b), 'pt-BR'); });
    var c = idx.porKey[idDoHash()] || itens.filter(function (x) { return !x.no_documents; })[0] || itens[0];
    if (!c) { v.innerHTML = '<div class="so-muted">Nenhuma empresa no quadro societário.</div>'; return; }
    var h = (podeEnviar ? '<div class="so-topo"><button class="so-btn" id="novaEmpresa">+ Nova empresa</button></div>' : '') +
      '<div class="so-duas">' + lista('empresas', itens, c, nomeEmpresa, function (x) {
      return x.no_documents ? 'sem documentos' : esc(x.type || '');
    }) + '<div class="so-ficha">';
    h += '<div class="card"><h2>' + esc(c.name || nomeEmpresa(c)) +
      (c.no_documents ? '<span class="so-badge">sem documentos</span>' : '') +
      (c.pending_documents || c.extraction_failed ? '<span class="so-badge">documentos novos não lidos</span>' : '') +
      (c.corrigido && c.corrigido.length ? '<span class="so-badge">corrigida à mão</span>' : '') + '</h2>' +
      (podeEnviar ? '<div class="so-acoes"><button class="so-btn ghost" id="editEmpresa">Editar</button>' +
        (!(c.documents || []).length ? '<button class="so-btn ghost" id="exclEmpresa">Excluir</button>' : '') + '</div>' : '') +
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
    var docs = c.documents || [], st = envioStatus[c.key];
    if (docs.length || podeEnviar) {
      h += '<div class="card" style="margin-top:14px"><div class="card-title"><h2>Documentos (' + docs.length + ')</h2>' +
        (podeEnviar ? '<button class="so-btn ghost" id="envBtn" style="margin-left:auto"' + (st && st.enviando ? ' disabled' : '') +
          '>Enviar documento</button><input type="file" id="envArq" accept="application/pdf,.pdf" hidden>' : '') + '</div>' +
        (st ? '<div class="' + (st.erro ? 'so-erro' : 'so-muted') + '" id="envStatus" style="margin-bottom:10px">' + esc(st.msg) + '</div>' : '') +
        (docs.length ? '<ul class="so-docs">' + docs.map(function (d) { return '<li><button class="so-link" data-doc="' + esc(d) + '">' + esc(d) + '</button></li>'; }).join('') + '</ul>' : '') + '</div>';
    }
    v.innerHTML = h + '</div></div>';
    ligarLista('empresas', desenharEmpresas);
    if ($('#novaEmpresa')) $('#novaEmpresa').onclick = formNovaEmpresa;
    if ($('#editEmpresa')) $('#editEmpresa').onclick = function () { formEditarEmpresa(c); };
    if ($('#exclEmpresa')) $('#exclEmpresa').onclick = function () { excluirEmpresa(c); };
    ligarAcoesProc(v);
    v.querySelectorAll('[data-doc]').forEach(function (b) {
      b.onclick = async function () {
        try {
          baixarBlob(await (await bot('/hub/documentos/arquivo?empresa=' + encodeURIComponent(c.key) + '&nome=' +
            encodeURIComponent(b.dataset.doc))).blob(), b.dataset.doc);
        } catch (e) { aviso(e.message, true); }
      };
    });
    if ($('#envBtn')) {
      $('#envBtn').onclick = function () { $('#envArq').click(); };
      $('#envArq').onchange = function () { if (this.files && this.files[0]) enviarDoc(c, this.files[0]); };
    }
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
    if (podeEnviar) h += cartaoAnexos('investidores', i.name, true);
    v.innerHTML = h + '</div></div>';
    ligarLista('investidores', desenharInvestidores);
    ligarAnexos('investidores');
  }

  desenharChat();
  mostrar();
})();
