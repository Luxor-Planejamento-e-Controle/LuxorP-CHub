/* Tela do cadastro de naturezas do Fluxo de Caixa Tarituba.
 *
 * O "cadastro" do painel — quais naturezas aparecem, em que grupo, em que ordem, e qual
 * código do Bimer liga o lançamento a cada uma — morava nas abas Receitas/Despesas da
 * planilha e no plano de contas versionado no repo. Natureza nova no Bimer era cirurgia
 * no Excel e deploy. Aqui ele é de quem mantém o painel (decisão do Leonardo, 16/10/2026,
 * no molde do cadastro do Controle de Gastos do Haras).
 *
 * Natureza que o Bimer traz e ninguém cadastrou aparece em PENDENTES (o job publica a
 * lista em tarituba.json), com o valor à vista; no painel ela já entra no total, num grupo
 * "Pendentes", até alguém classificar.
 *
 * Edição in loco: `input` altera o registro em memória e NÃO re-renderiza (redesenhar a
 * cada tecla tiraria o foco). A tela só se redesenha quando a ESTRUTURA muda: mover,
 * trocar de grupo, incluir, remover, filtrar.
 */
window.TT_CADASTRO = (function () {
  'use strict';

  var D = window.TT_DADOS;
  var nats = [];              // cópia de trabalho; cada item tem `uid`
  var pendentes = [];
  var origem = 'planilha';
  var geradoEm = '';
  var original = '';
  var filtro = { busca: '', grupo: '' };
  var cb = {};
  var proximoUid = 1;
  var avisoSalvo = '';
  var NOVO_GRUPO = '__novo__';
  var NCOLS = 6;

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function rs(v) {
    return Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function limpo(x) {
    var c = Object.assign({}, x);
    Object.keys(c).forEach(function (k) { if (k === 'uid' || k.charAt(0) === '_') delete c[k]; });
    return c;
  }

  function doc() { return { versao: 1, naturezas: nats }; }

  function serializar() { return JSON.stringify(D.porOrdem(nats).map(limpo)); }

  function mudou() { return serializar() !== original; }

  function abrir(alvo, est, callbacks) {
    cb = callbacks || {};
    pendentes = est.pendentes || [];
    origem = est.origem || 'planilha';
    geradoEm = est.gerado_em || '';
    filtro = { busca: '', grupo: '' };
    avisoSalvo = '';
    carregarDoc(est.doc);
    render(alvo);
  }

  function carregarDoc(d) {
    nats = d.naturezas.map(function (n) { return Object.assign({}, n, { uid: proximoUid++ }); });
    original = serializar();
  }

  function acha(uid) {
    return nats.find(function (n) { return String(n.uid) === String(uid); });
  }

  // ---------------------------------------------------------------- montagem

  function visiveis() {
    var b = filtro.busca.trim().toLowerCase();
    return D.porOrdem(nats).filter(function (n) {
      if (filtro.grupo && D.caminho(n.path) !== filtro.grupo) return false;
      if (b && (n.cod + ' ' + n.nome + ' ' + n.bimer).toLowerCase().indexOf(b) < 0) return false;
      return true;
    });
  }

  function campo(uid, c, valor, largura, ph) {
    return '<input class="cpc" data-uid="' + uid + '" data-campo="' + c + '" value="' +
      esc(valor) + '" style="width:' + largura + 'px"' + (ph ? ' placeholder="' + esc(ph) + '"' : '') + '>';
  }

  function seletorGrupo(n) {
    var atual = D.caminho(n.path);
    return '<select class="cpc" data-uid="' + n.uid + '" data-campo="grupo" style="width:380px">' +
      (atual ? '' : '<option value="">— escolha o grupo —</option>') +
      D.caminhos(nats).map(function (p) {
        var k = D.caminho(p);
        return '<option value="' + esc(k) + '"' + (k === atual ? ' selected' : '') + '>' + esc(k) + '</option>';
      }).join('') + '<option value="' + NOVO_GRUPO + '">＋ novo grupo…</option></select>';
  }

  function linhaHtml(n, filtrando) {
    var sobe = !filtrando && D.vizinha(nats, n, -1), desce = !filtrando && D.vizinha(nats, n, 1);
    return '<tr data-uid="' + n.uid + '">' +
      '<td class="nowrap"><button type="button" class="btn-mv" data-mv="-1" data-uid="' + n.uid +
        '" title="subir"' + (sobe ? '' : ' disabled') + '>↑</button>' +
        '<button type="button" class="btn-mv" data-mv="1" data-uid="' + n.uid +
        '" title="descer"' + (desce ? '' : ' disabled') + '>↓</button></td>' +
      '<td>' + campo(n.uid, 'cod', n.cod, 118, 'código') +
        (D.foraDoBloco(n) ? '<div class="sub2" title="o código é de ' +
          (n.aba === 'receitas' ? 'pagamento' : 'recebimento') + ', mas a natureza está em ' +
          esc(n.aba) + '">fora do bloco</div>' : '') + '</td>' +
      '<td>' + campo(n.uid, 'nome', n.nome, 260, 'nome') +
        (n.atualizado_por ? '<div class="sub2">alterado por ' + esc(n.atualizado_por) +
          (n.atualizado_em ? ' em ' + esc(String(n.atualizado_em).slice(0, 10).split('-').reverse().join('/')) : '') +
          '</div>' : '') + '</td>' +
      '<td>' + seletorGrupo(n) + '</td>' +
      '<td>' + campo(n.uid, 'bimer', n.bimer, 92, '001842') + '</td>' +
      '<td><button type="button" class="btn-lixo" data-uid="' + n.uid +
        '" title="remover do cadastro">&times;</button></td>' +
    '</tr>';
  }

  function tabelaNaturezas(lista, filtrando) {
    if (!lista.length) {
      return '<tr><td colspan="' + NCOLS + '"><div class="empty">Nenhuma natureza com esses filtros.</div></td></tr>';
    }
    var html = '', ultimo = null;
    lista.forEach(function (n) {
      var k = D.caminho(n.path);
      if (k !== ultimo) {
        var qtd = nats.filter(function (x) { return D.caminho(x.path) === k; }).length;
        html += '<tr class="grupo"><td colspan="' + NCOLS + '">' + (k ? esc(k) : 'Sem grupo') +
          ' <span class="muted">· ' + qtd + '</span></td></tr>';
        ultimo = k;
      }
      html += linhaHtml(n, filtrando);
    });
    return html;
  }

  function cardPendentes() {
    var vivos = D.pendentesVivos(pendentes, nats);
    var quando = geradoEm ? ' · painel de ' + esc(geradoEm) : '';
    if (!vivos.length) {
      return '<div class="card"><div class="card-title"><h2>Pendentes</h2>' +
        '<span class="muted">nenhuma' + quando + '</span></div>' +
        '<div class="muted">Todo lançamento que o Bimer trouxe tem natureza no cadastro.</div></div>';
    }
    return '<div class="card destaque"><div class="card-title"><h2>Pendentes</h2>' +
      '<span class="muted">' + vivos.length + quando + '</span></div>' +
      '<div class="muted" style="margin-bottom:10px">Naturezas com lançamento no Bimer que não ' +
      'estão no cadastro. No painel elas entram no total, no grupo «' + esc(D.GRUPO_PENDENTES) +
      '» — classifique para irem para o grupo certo.</div>' +
      '<div class="tbl-wrap"><table class="data"><thead><tr><th>Código</th><th>Bimer</th>' +
      '<th>Natureza</th><th class="num">Valor no ano</th><th></th></tr></thead><tbody>' +
      vivos.map(function (p, i) {
        return '<tr data-pend="' + i + '"><td>' + esc(p.cod) + '</td><td>' + esc(p.bimer) + '</td>' +
          '<td>' + esc(p.nome) + '</td><td class="num">' + rs(p.valor) + '</td>' +
          '<td class="nowrap"><button type="button" class="btn-ghost" data-pa="' + i +
          '">Incluir no cadastro</button></td></tr>';
      }).join('') + '</tbody></table></div></div>';
  }

  function render(alvo) {
    var el = alvo || document.getElementById('view');
    var probs = D.problemas(doc());
    var alterados = mudou();
    var lista = visiveis();
    var filtrando = !!(filtro.busca || filtro.grupo);

    el.innerHTML = '' +
      '<div class="tt-cad-topo"><button type="button" class="btn-ghost" id="ttVoltar">← Voltar ao painel</button>' +
        '<h2>Cadastro de naturezas</h2></div>' +
      '<div class="banner"><div><b>Este é o cadastro, não o painel.</b> O painel é montado no ' +
        'Azure (toda segunda às 9h, ou pelo <b>Atualizar agora</b>) a partir do Bimer e <b>deste ' +
        'cadastro</b>: o que você gravar aqui passa a valer na <b>próxima publicação</b>. A ordem ' +
        'das linhas é a ordem do painel; o grupo de cima de tudo é a aba (Receitas ou Despesas).' +
        (origem !== 'cadastro' ? ' <b>O painel publicado ainda veio da planilha</b> — a próxima ' +
          'publicação já sai deste cadastro.' : '') + '</div></div>' +

      '<div id="ttProbs">' + probsHtml(probs) + '</div>' +

      cardPendentes() +

      '<div class="toolbar">' +
        '<div class="field"><label>Grupo</label><select id="ttGrupo"><option value="">Todos</option>' +
          D.caminhos(nats).map(function (p) {
            var k = D.caminho(p);
            return '<option value="' + esc(k) + '"' + (filtro.grupo === k ? ' selected' : '') + '>' +
              esc(k) + '</option>';
          }).join('') + '</select></div>' +
        '<div class="field cresce"><label>Buscar</label><input type="search" id="ttBusca" ' +
          'placeholder="código, nome ou Bimer" value="' + esc(filtro.busca) + '"></div>' +
        '<div style="flex:1"></div>' +
        '<button class="btn-ghost" id="ttAdd" type="button">+ Natureza</button>' +
      '</div>' +

      '<div class="card">' +
        '<div class="card-title"><h2>Naturezas</h2><span class="muted">' + lista.length +
          ' de ' + nats.length + '</span></div>' +
        (filtrando ? '<div class="muted" style="margin-bottom:8px">Com filtro ativo os botões ' +
          '↑ ↓ ficam desligados: mover numa lista filtrada trocaria de lugar com uma linha que ' +
          'você não está vendo.</div>' : '') +
        '<div class="tbl-wrap"><table class="data cadastro"><thead><tr><th></th><th>Código</th>' +
          '<th>Natureza</th><th>Grupo</th><th title="código da natureza no Bimer">Bimer</th>' +
          '<th></th></tr></thead><tbody>' + tabelaNaturezas(lista, filtrando) + '</tbody></table></div>' +
      '</div>' +

      '<div class="cpc-acoes">' +
        '<div class="txt" id="ttStatus">' + esc(statusTexto(alterados, probs)) + '</div>' +
        '<button class="btn-acao" id="ttSalvar" type="button"' +
          (alterados && !probs.length ? '' : ' disabled') + '>Gravar cadastro</button>' +
      '</div>';
    ligar(el);
  }

  function probsHtml(probs) {
    if (!probs.length) return '';
    return '<div class="erro-box"><b>' + probs.length + ' problema(s) — não dá para gravar ' +
      'assim:</b> um cadastro inválido derrubaria a publicação do painel.' +
      '<ul style="margin:6px 0 0 18px">' + probs.slice(0, 8).map(function (p) {
        return '<li>' + esc(p.onde) + ' — ' + esc(p.erro) + '</li>';
      }).join('') + (probs.length > 8 ? '<li>…e mais ' + (probs.length - 8) + '</li>' : '') +
      '</ul></div>';
  }

  function statusTexto(alterados, probs) {
    if (avisoSalvo) return avisoSalvo;
    if (probs.length) return 'Corrija os problemas acima para poder gravar.';
    return alterados ? 'Há alterações não gravadas.' : 'Nada alterado.';
  }

  /* A cada tecla só se tocam o botão, o status e a caixa de problemas — todos FORA da
   * tabela, então atualizá-los não tira o foco do campo que está sendo digitado. */
  function marcarEstado() {
    var probs = D.problemas(doc());
    var alterados = mudou();
    avisoSalvo = '';
    var b = document.getElementById('ttSalvar');
    var t = document.getElementById('ttStatus');
    var pb = document.getElementById('ttProbs');
    if (pb) pb.innerHTML = probsHtml(probs);
    if (b) b.disabled = !alterados || probs.length > 0;
    if (t) t.textContent = statusTexto(alterados, probs);
  }

  /* Caminho digitado para um grupo novo: tem de começar pela raiz de uma das abas, que é
   * o que decide em qual página do painel a natureza aparece. Devolve {path, aba} ou
   * {erro}. */
  function grupoNovo(txt) {
    var path = D.lerCaminho(txt);
    if (!path.length) return { erro: 'Informe o caminho do grupo.' };
    var aba = D.abaDoCaminho(nats, path);
    if (!aba) {
      var r = D.raizes(nats);
      return { erro: 'O caminho começa pelo total da aba: ' +
        D.ABAS.map(function (a) { return '«' + (r[a] || a) + '»'; }).join(' ou ') + '.' };
    }
    if (path.length < 2) return { erro: 'Abaixo do total da aba, diga o grupo (ex.: ' + path[0] + ' > Suporte).' };
    if (path.map(function (p) { return p.trim(); }).indexOf(D.GRUPO_PENDENTES) >= 0) {
      return { erro: '«' + D.GRUPO_PENDENTES + '» é reservado para o painel.' };
    }
    return { path: path, aba: aba };
  }

  // ---------------------------------------------------------------- formulário "Nova natureza"

  /* Natureza nova só entra COMPLETA e sem conflito, no fim do grupo escolhido — uma linha em
   * branco no fim da tabela deixaria a natureza existir inválida até alguém completar.
   * `pre`: {cod, nome, bimer} quando vem de uma pendente (a API já traz os três). */
  function abrirFormulario(pre, el) {
    pre = pre || {};
    var fundo = document.createElement('div');
    fundo.className = 'modal-fundo';
    var r = D.raizes(nats);
    fundo.innerHTML =
      '<div class="modal" id="ttForm" role="dialog" aria-modal="true" aria-labelledby="ttFTitulo">' +
        '<h2 id="ttFTitulo">Nova natureza</h2>' +
        (pre.nome ? '<div class="muted" style="margin-bottom:12px">Vinda do Bimer: <b>' + esc(pre.nome) +
          '</b>' + (pre.bimer ? ' · código ' + esc(pre.bimer) : '') + '</div>' : '') +
        '<div class="form-campo"><label for="ttFNome">Nome</label>' +
          '<input type="text" id="ttFNome" value="' + esc(pre.nome || '') + '" placeholder="como aparece no painel">' +
          '<div class="form-erro" data-erro="nome"></div></div>' +
        '<div class="form-campo"><label for="ttFCod">Código</label>' +
          '<input type="text" id="ttFCod" value="' + esc(pre.cod || '') + '" placeholder="ex.: 13.2.1.01.10">' +
          '<div class="form-dica">A classificação no plano de contas do Bimer.</div>' +
          '<div class="form-erro" data-erro="cod"></div></div>' +
        '<div class="form-campo"><label for="ttFGrupo">Grupo</label>' +
          '<select id="ttFGrupo"><option value="">— escolha o grupo —</option>' +
          D.caminhos(nats).map(function (c) {
            var k = D.caminho(c);
            return '<option value="' + esc(k) + '">' + esc(k) + '</option>';
          }).join('') + '<option value="' + NOVO_GRUPO + '">＋ criar novo grupo…</option></select>' +
          '<input type="text" id="ttFNovoGrupo" hidden style="margin-top:8px" placeholder="' +
            esc((r.despesas || 'Despesas Total') + ' > Despesas Tarituba > Novo grupo') + '">' +
          '<div class="form-dica" id="ttFDicaGrupo" hidden>Do total da aba até o grupo, separado por ' +
            '&gt;. O total decide a página: ' + esc(r.receitas || 'Receitas') + ' ou ' +
            esc(r.despesas || 'Despesas') + '.</div>' +
          '<div class="form-erro" data-erro="grupo"></div></div>' +
        '<div class="form-campo"><label for="ttFBimer">Código do Bimer</label>' +
          '<input type="text" id="ttFBimer" value="' + esc(pre.bimer || '') + '" placeholder="ex.: 001842">' +
          '<div class="form-dica">O código da natureza no Bimer (6 dígitos, com os zeros). ' +
          'É por ele que os lançamentos chegam a esta natureza.</div>' +
          '<div class="form-erro" data-erro="bimer"></div></div>' +
        '<div class="form-falta" id="ttFFalta"></div>' +
        '<div class="form-acoes">' +
          '<button type="button" class="btn-ghost" id="ttFCancel">Cancelar</button>' +
          '<button type="button" class="btn-acao" id="ttFAdd" disabled>Adicionar ao cadastro</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(fundo);

    function v(id) { return fundo.querySelector('#' + id); }

    function grupoEscolhido() {
      var g = v('ttFGrupo').value;
      if (g === NOVO_GRUPO) return grupoNovo(v('ttFNovoGrupo').value);
      if (!g) return {};
      var path = g.split(D.SEP);
      return { path: path, aba: D.abaDoCaminho(nats, path) };
    }

    function avaliar() {
      var e = {}, falta = [];
      var nome = v('ttFNome').value.trim(), cod = v('ttFCod').value.trim();
      var bimer = v('ttFBimer').value.trim(), g = grupoEscolhido();
      if (!nome) falta.push('nome');
      if (!cod) falta.push('código');
      else if (!/^13\.\d+(\.\d+)*$/.test(cod)) e.cod = 'Fora do formato 13.x.x.xx.xx.';
      else {
        var dono = nats.find(function (n) { return String(n.cod).trim() === cod; });
        if (dono) e.cod = 'Este código já é de «' + dono.nome + '».';
      }
      if (!bimer) falta.push('código do Bimer');
      else if (!/^\d{1,10}$/.test(bimer)) e.bimer = 'Só dígitos (ex.: 001842).';
      else {
        var donoB = nats.find(function (n) { return String(n.bimer).trim() === bimer; });
        if (donoB) e.bimer = 'O código ' + bimer + ' já pertence a «' + donoB.nome + '».';
      }
      if (g.erro) e.grupo = g.erro;
      else if (!g.path) falta.push('grupo');
      return { erros: e, falta: falta, nome: nome, cod: cod, bimer: bimer, path: g.path, aba: g.aba };
    }

    function atualizar() {
      var r2 = avaliar();
      fundo.querySelectorAll('[data-erro]').forEach(function (x) {
        x.textContent = r2.erros[x.getAttribute('data-erro')] || '';
      });
      v('ttFFalta').textContent = r2.falta.length ? 'Falta preencher: ' + r2.falta.join(', ') + '.' : '';
      v('ttFAdd').disabled = Object.keys(r2.erros).length > 0 || r2.falta.length > 0;
    }

    function sujo() {
      return v('ttFNome').value !== (pre.nome || '') || v('ttFCod').value !== (pre.cod || '') ||
        !!v('ttFGrupo').value || v('ttFBimer').value !== (pre.bimer || '');
    }

    function fechar(forcado) {
      if (!forcado && sujo() && !window.confirm('Descartar o que foi preenchido?')) return;
      document.removeEventListener('keydown', teclas, true);
      fundo.remove();
    }

    function adicionar() {
      if (v('ttFAdd').disabled) return;
      var r2 = avaliar();
      var n = { ordem: D.ordemNoFimDoGrupo(nats, r2.path, null), aba: r2.aba, cod: r2.cod,
                nome: r2.nome, bimer: r2.bimer, path: r2.path, uid: proximoUid++ };
      nats.push(n);
      filtro = { busca: '', grupo: '' };
      avisoSalvo = 'Natureza «' + n.nome + '» adicionada ao grupo «' + D.caminho(n.path) +
        '». Falta gravar o cadastro para valer.';
      fechar(true);
      render(el);
      var linha = el.querySelector('tr[data-uid="' + n.uid + '"]');
      if (linha) { linha.scrollIntoView({ block: 'center' }); linha.classList.add('nova'); }
    }

    function teclas(ev) {
      if (ev.key === 'Escape') { ev.preventDefault(); fechar(false); return; }
      if (ev.key !== 'Tab') return;
      var foc = Array.prototype.filter.call(fundo.querySelectorAll('input, select, button'),
        function (x) { return !x.disabled && !x.hidden && x.offsetParent !== null; });
      if (!foc.length) return;
      var primeiro = foc[0], ultimo = foc[foc.length - 1];
      if (ev.shiftKey && document.activeElement === primeiro) { ev.preventDefault(); ultimo.focus(); }
      else if (!ev.shiftKey && document.activeElement === ultimo) { ev.preventDefault(); primeiro.focus(); }
    }
    document.addEventListener('keydown', teclas, true);

    fundo.addEventListener('input', atualizar);
    v('ttFGrupo').addEventListener('change', function () {
      var novo = v('ttFGrupo').value === NOVO_GRUPO;
      v('ttFNovoGrupo').hidden = !novo;
      v('ttFDicaGrupo').hidden = !novo;
      if (novo) v('ttFNovoGrupo').focus();
      atualizar();
    });
    v('ttFCancel').onclick = function () { fechar(false); };
    v('ttFAdd').onclick = adicionar;
    atualizar();
    (pre.nome ? v('ttFGrupo') : v('ttFNome')).focus();
  }

  // ---------------------------------------------------------------- eventos

  function ligar(el) {
    document.getElementById('ttVoltar').onclick = function () {
      if (mudou() && !window.confirm('Há alterações não gravadas no cadastro. Voltar ao painel e descartá-las?')) return;
      if (cb.voltar) cb.voltar();
    };

    var tb = el.querySelector('table.cadastro tbody');
    if (tb) {
      tb.addEventListener('input', function (ev) {
        var alvo = ev.target.closest('input.cpc');
        if (!alvo) return;
        var n = acha(alvo.getAttribute('data-uid'));
        if (!n) return;
        n[alvo.getAttribute('data-campo')] = alvo.value;
        marcarEstado();
      });

      tb.addEventListener('change', function (ev) {
        var alvo = ev.target.closest('select.cpc[data-campo="grupo"]');
        if (!alvo) return;
        var n = acha(alvo.getAttribute('data-uid'));
        var g;
        if (alvo.value === NOVO_GRUPO) {
          var digitado = window.prompt('Caminho do novo grupo, do total da aba até o grupo, separado por ">".\n' +
            'Ex.: ' + (D.raizes(nats).despesas || 'Despesas Total') + ' > Despesas Tarituba > Novo grupo');
          if (digitado === null) { render(el); return; }          // cancelou: nada muda
          g = grupoNovo(digitado);
          if (g.erro) { window.alert(g.erro); render(el); return; }
        } else {
          var path = alvo.value.split(D.SEP);
          g = { path: path, aba: D.abaDoCaminho(nats, path) };
        }
        n.path = g.path;
        n.aba = g.aba;
        n.ordem = D.ordemNoFimDoGrupo(nats, g.path, n);   // fim do grupo: mantém-no contíguo
        render(el);
      });

      tb.addEventListener('click', function (ev) {
        var mv = ev.target.closest('.btn-mv');
        if (mv && !mv.disabled) {
          if (D.mover(nats, acha(mv.getAttribute('data-uid')), parseInt(mv.getAttribute('data-mv'), 10))) render(el);
          return;
        }
        var lixo = ev.target.closest('.btn-lixo');
        if (lixo) {
          var n = acha(lixo.getAttribute('data-uid'));
          if (window.confirm('Remover «' + (n.nome || n.cod || 'esta natureza') + '» do cadastro?\n\n' +
              'Se o Bimer ainda trouxer lançamento com o código dela, ela volta como PENDENTE na ' +
              'próxima publicação (o valor não some do painel).')) {
            nats = nats.filter(function (x) { return x !== n; });
            render(el);
          }
        }
      });
    }

    var gr = document.getElementById('ttGrupo');
    if (gr) gr.onchange = function (e) { filtro.grupo = e.target.value; render(el); };

    var busca = document.getElementById('ttBusca');
    if (busca) {
      var t = null;
      busca.oninput = function (e) {
        filtro.busca = e.target.value;
        clearTimeout(t);
        t = setTimeout(function () {
          render(el);
          var b = document.getElementById('ttBusca');
          if (b) { b.focus(); b.setSelectionRange(b.value.length, b.value.length); }
        }, 250);
      };
    }

    var add = document.getElementById('ttAdd');
    if (add) add.onclick = function () { abrirFormulario({}, el); };

    el.querySelectorAll('[data-pa]').forEach(function (b) {
      b.onclick = function () {
        var p = D.pendentesVivos(pendentes, nats)[parseInt(b.getAttribute('data-pa'), 10)];
        if (p) abrirFormulario({ cod: p.cod, nome: p.nome, bimer: p.bimer }, el);
      };
    });

    var salvar = document.getElementById('ttSalvar');
    if (salvar) {
      salvar.onclick = async function () {
        var probs = D.problemas(doc());
        if (probs.length) { render(el); return; }
        salvar.disabled = true;
        document.getElementById('ttStatus').textContent = 'gravando…';
        try {
          var gravado = await cb.salvar(D.porOrdem(nats).map(limpo));
          carregarDoc(gravado);
          avisoSalvo = 'Cadastro gravado. O painel reflete na próxima publicação (ou agora: volte ' +
            'ao painel e use Atualizar agora).';
          render(el);
        } catch (e) {
          salvar.disabled = false;
          document.getElementById('ttStatus').textContent = 'não foi possível gravar: ' + e.message;
        }
      };
    }
  }

  return { abrir: abrir, mudou: mudou, _nats: function () { return nats; } };
})();
