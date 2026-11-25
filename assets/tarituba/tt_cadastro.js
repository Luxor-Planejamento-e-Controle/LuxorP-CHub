/* Tela do cadastro de naturezas do Fluxo de Caixa Tarituba.
 *
 * Cópia da tela do Shiva (`sh_cadastro.js`, que veio do `tt_cadastro.js` original do
 * Tarituba, pelo Passivo) — mesmo desenho: abre DE DENTRO do painel ("Editar cadastro de naturezas" / "← Voltar ao
 * painel"), ↑↓ para ordenar dentro do grupo, troca de grupo, "+ Natureza", pendentes
 * vindas do Bimer, "Gravar cadastro". O que veio do Passivo e o que é do Tarituba:
 *   - "Bimer" aceita VÁRIOS códigos ("001720, 001728"): o 1º é o da linha, os demais são
 *     de-para (lançamento de outra natureza do Bimer somado nesta linha);
 *   - o quadro "Linhas do Resumo": o que a página Resumo mostra abaixo de Receita Total e
 *     Despesa Total — a planilha escolhe à mão (naturezas e grupos misturados), então é
 *     cadastro também;
 *   - (do Shiva) a linha que aponta para grupo pode TIRAR naturezas dele ("menos: …"): lá o
 *     Resumo mostra os Dividendos a Pagar à parte das Despesas Administrativas.
 *
 * Onde grava não é assunto daqui: `cb.salvar` (local: abrir_painel.py; no Hub: Supabase).
 * Só o TEXTO muda com o lugar, por `est.remonta`: o abrir_painel.py remonta o painel na
 * hora ao gravar; no Hub o cadastro vale a partir da próxima publicação do Azure. Este
 * arquivo é o MESMO nos dois lugares — mudou aqui, copia lá inteiro.
 *
 * Edição in loco: `input` altera o registro em memória e NÃO re-renderiza (redesenhar a
 * cada tecla tiraria o foco). A tela só se redesenha quando a ESTRUTURA muda.
 */
window.TT_CADASTRO = (function () {
  'use strict';

  var D = window.TT_DADOS;
  var nats = [];              // cópia de trabalho; cada item tem `uid`
  var resumo = { receitas: [], despesas: [] };
  var pendentes = [];
  var origem = 'planilha';
  var geradoEm = '';
  var original = '';
  var filtro = { busca: '', grupo: '' };
  var cb = {};
  var proximoUid = 1;
  var avisoSalvo = '';
  var remonta = false;        // true = gravar já remonta o painel (local); false = Hub
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

  function doc() { return { versao: 1, naturezas: nats, resumo: resumo }; }

  function serializar() {
    return JSON.stringify({ n: D.porOrdem(nats).map(limpo), r: resumo });
  }

  function mudou() { return serializar() !== original; }

  function abrir(alvo, est, callbacks) {
    cb = callbacks || {};
    pendentes = est.pendentes || [];
    origem = est.origem || 'planilha';
    geradoEm = est.gerado_em || '';
    filtro = { busca: '', grupo: '' };
    avisoSalvo = est.aviso || '';
    remonta = !!est.remonta;
    carregarDoc(est.doc);
    render(alvo);
  }

  function carregarDoc(d) {
    nats = d.naturezas.map(function (n) { return Object.assign({}, n, { uid: proximoUid++ }); });
    resumo = JSON.parse(JSON.stringify(d.resumo || { receitas: [], despesas: [] }));
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
      if (b && (n.cod + ' ' + n.nome + ' ' + (n.bimer || []).join(' ')).toLowerCase().indexOf(b) < 0) return false;
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
    var bimer = n.bimer || [];
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
      '<td>' + campo(n.uid, 'bimer', bimer.join(', '), 132, '001875') +
        (bimer.length > 1 ? '<div class="sub2" title="lançamentos destes códigos do Bimer somam nesta linha">' +
          (bimer.length - 1) + ' de-para</div>' : '') + '</td>' +
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

  /* ---------- linhas do Resumo ---------- */

  function refValor(ref) { return ref && 'cod' in ref ? 'c:' + ref.cod : 'g:' + ((ref || {}).grupo || ''); }

  function seletorRef(aba, i, ref) {
    var atual = refValor(ref), achou = false;
    var opcGrupos = D.gruposDaAba(nats, aba).map(function (g) {
      var v = 'g:' + g; if (v === atual) achou = true;
      return '<option value="' + esc(v) + '"' + (v === atual ? ' selected' : '') + '>grupo · ' + esc(g) + '</option>';
    }).join('');
    var opcNats = D.porOrdem(nats).filter(function (n) { return n.aba === aba; }).map(function (n) {
      var v = 'c:' + n.cod; if (v === atual) achou = true;
      return '<option value="' + esc(v) + '"' + (v === atual ? ' selected' : '') + '>natureza · ' +
        esc(n.cod + ' ' + n.nome) + '</option>';
    }).join('');
    return '<select class="cpc" data-res-aba="' + aba + '" data-res-i="' + i + '" data-res-campo="ref" style="width:420px">' +
      (achou ? '' : '<option value="' + esc(atual) + '" selected>⚠ ' + esc(atual.slice(2)) + ' (não existe mais)</option>') +
      '<optgroup label="Grupos">' + opcGrupos + '</optgroup><optgroup label="Naturezas">' + opcNats + '</optgroup></select>' +
      seletorExceto(aba, i, ref);
  }

  /* Naturezas da aba que estão dentro do grupo (pelo `path`), na ordem do cadastro. */
  function membrosDoGrupo(aba, g) {
    return D.porOrdem(nats).filter(function (n) {
      return n.aba === aba && Array.isArray(n.path) && n.path.map(function (p) { return String(p).trim(); }).indexOf(g) >= 0;
    });
  }

  /* "menos: …" de uma linha que aponta para grupo: as naturezas tiradas dele (`exceto`),
     cada uma com × para devolver, e uma lista para tirar mais. É o que o Resumo do Shiva
     faz com os Dividendos a Pagar (fora de Despesas Administrativas, linha própria). */
  function seletorExceto(aba, i, ref) {
    if (!ref || !('grupo' in ref)) return '';
    var membros = membrosDoGrupo(aba, String(ref.grupo).trim());
    if (membros.length < 2) return '';
    var exc = Array.isArray(ref.exceto) ? ref.exceto : [];
    var nome = {};
    membros.forEach(function (n) { nome[n.cod] = n.nome; });
    var attrs = ' data-res-aba="' + aba + '" data-res-i="' + i + '"';
    var tiradas = exc.map(function (c) {
      return '<span class="tirada" title="' + esc(c) + '">' + esc(nome[c] || c) +
        '<button type="button" data-res-exc-del="' + esc(c) + '"' + attrs + ' title="devolver ao grupo">&times;</button></span>';
    }).join('');
    var opc = membros.filter(function (n) { return exc.indexOf(n.cod) < 0; }).map(function (n) {
      return '<option value="' + esc(n.cod) + '">' + esc(n.cod + ' ' + n.nome) + '</option>';
    }).join('');
    return '<div class="res-exc">' + (exc.length ? 'menos:' + tiradas : '') +
      (exc.length < membros.length - 1 ? '<select class="cpc" data-res-exc-add="1"' + attrs + '>' +
        '<option value="">' + (exc.length ? '+ tirar outra…' : '+ tirar uma natureza do grupo…') + '</option>' +
        opc + '</select>' : '') + '</div>';
  }

  function cardResumo() {
    var titulo = { receitas: 'Abaixo de Receita Total', despesas: 'Abaixo de Despesa Total' };
    return '<div class="card"><div class="card-title"><h2>Linhas do Resumo</h2>' +
      '<span class="muted">o que a página Resumo mostra abaixo dos totais</span></div>' +
      '<div class="muted" style="margin-bottom:10px">Cada linha soma uma natureza ou um grupo — inteiro, ' +
      'ou menos as naturezas tiradas dele. ' +
      'O total continua somando TODAS as naturezas da aba — uma natureza fora destas linhas entra no ' +
      'total e o painel avisa.</div>' +
      D.ABAS.map(function (aba) {
        var linhas = resumo[aba] || [];
        return '<div class="sub2" style="margin:12px 0 6px;font-weight:600;text-transform:uppercase;letter-spacing:.06em">' +
          titulo[aba] + '</div>' +
          '<div class="tbl-wrap"><table class="data cadastro"><thead><tr><th></th><th>Rótulo na tela</th>' +
          '<th>Soma</th><th></th></tr></thead><tbody>' +
          (linhas.length ? linhas.map(function (l, i) {
            return '<tr><td class="nowrap"><button type="button" class="btn-mv" data-res-mv="-1" data-res-aba="' + aba +
                '" data-res-i="' + i + '"' + (i > 0 ? '' : ' disabled') + ' title="subir">↑</button>' +
                '<button type="button" class="btn-mv" data-res-mv="1" data-res-aba="' + aba + '" data-res-i="' + i + '"' +
                (i < linhas.length - 1 ? '' : ' disabled') + ' title="descer">↓</button></td>' +
              '<td><input class="cpc" data-res-aba="' + aba + '" data-res-i="' + i + '" data-res-campo="rotulo" value="' +
                esc(l.rotulo) + '" style="width:300px" placeholder="rótulo"></td>' +
              '<td>' + seletorRef(aba, i, l.ref) + '</td>' +
              '<td><button type="button" class="btn-lixo" data-res-del="1" data-res-aba="' + aba + '" data-res-i="' + i +
                '" title="tirar do Resumo">&times;</button></td></tr>';
          }).join('') : '<tr><td colspan="4"><div class="empty">Nenhuma linha.</div></td></tr>') +
          '</tbody></table></div>' +
          '<button type="button" class="btn-ghost" data-res-add="' + aba + '" style="margin-top:8px">+ Linha</button>';
      }).join('') + '</div>';
  }

  function render(alvo) {
    var el = alvo || document.getElementById('view');
    var probs = D.problemas(doc());
    var alterados = mudou();
    var lista = visiveis();
    var filtrando = !!(filtro.busca || filtro.grupo);

    el.innerHTML = '' +
      '<div class="tt-cad-topo"><button type="button" class="btn-ghost" id="pcVoltar">← Voltar ao painel</button>' +
        '<h2>Cadastro de naturezas</h2></div>' +
      '<div class="banner"><div><b>Este é o cadastro, não o painel.</b> ' +
        (remonta
          ? 'O painel é montado a partir do Bimer e <b>deste cadastro</b>: ao gravar, ele é ' +
            'remontado na hora com os lançamentos que já vieram do Bimer.'
          : 'O painel é montado no Azure (toda segunda às 10h, ou pelo <b>Atualizar agora</b>) ' +
            'a partir do Bimer e <b>deste cadastro</b>: o que você gravar aqui passa a valer na ' +
            '<b>próxima publicação</b>.') +
        ' A ordem das linhas é a ordem do painel; o grupo de cima de tudo é a aba (Receitas ou ' +
        'Despesas).' +
        (origem !== 'cadastro'
          ? (remonta ? ' <b>O painel aberto ainda veio da planilha</b> — ao gravar, passa a sair ' +
                       'deste cadastro.'
                     : ' <b>O painel publicado ainda veio da planilha</b> — a próxima publicação ' +
                       'já sai deste cadastro.')
          : '') + '</div></div>' +

      '<div id="pcProbs">' + probsHtml(probs) + '</div>' +

      cardPendentes() +

      '<div class="toolbar">' +
        '<div class="field"><label>Grupo</label><select id="pcGrupo"><option value="">Todos</option>' +
          D.caminhos(nats).map(function (p) {
            var k = D.caminho(p);
            return '<option value="' + esc(k) + '"' + (filtro.grupo === k ? ' selected' : '') + '>' +
              esc(k) + '</option>';
          }).join('') + '</select></div>' +
        '<div class="field cresce"><label>Buscar</label><input type="search" id="pcBusca" ' +
          'placeholder="código, nome ou Bimer" value="' + esc(filtro.busca) + '"></div>' +
        '<div style="flex:1"></div>' +
        '<button class="btn-ghost" id="pcAdd" type="button">+ Natureza</button>' +
      '</div>' +

      '<div class="card">' +
        '<div class="card-title"><h2>Naturezas</h2><span class="muted">' + lista.length +
          ' de ' + nats.length + '</span></div>' +
        (filtrando ? '<div class="muted" style="margin-bottom:8px">Com filtro ativo os botões ' +
          '↑ ↓ ficam desligados: mover numa lista filtrada trocaria de lugar com uma linha que ' +
          'você não está vendo.</div>' : '') +
        '<div class="tbl-wrap"><table class="data cadastro" id="pcTabNats"><thead><tr><th></th><th>Código</th>' +
          '<th>Natureza</th><th>Grupo</th><th title="códigos da natureza no Bimer; mais de um = de-para">Bimer</th>' +
          '<th></th></tr></thead><tbody>' + tabelaNaturezas(lista, filtrando) + '</tbody></table></div>' +
      '</div>' +

      cardResumo() +

      '<div class="cpc-acoes">' +
        '<div class="txt" id="pcStatus">' + esc(statusTexto(alterados, probs)) + '</div>' +
        '<button class="btn-acao" id="pcSalvar" type="button"' +
          (alterados && !probs.length ? '' : ' disabled') + '>Gravar cadastro</button>' +
      '</div>';
    ligar(el);
  }

  function probsHtml(probs) {
    if (!probs.length) return '';
    return '<div class="erro-box"><b>' + probs.length + ' problema(s) — não dá para gravar ' +
      'assim:</b> um cadastro inválido impediria de montar o painel.' +
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

  /* A cada tecla só se tocam o botão, o status e a caixa de problemas — todos FORA das
   * tabelas, então atualizá-los não tira o foco do campo que está sendo digitado. */
  function marcarEstado() {
    var probs = D.problemas(doc());
    var alterados = mudou();
    avisoSalvo = '';
    var b = document.getElementById('pcSalvar');
    var t = document.getElementById('pcStatus');
    var pb = document.getElementById('pcProbs');
    if (pb) pb.innerHTML = probsHtml(probs);
    if (b) b.disabled = !alterados || probs.length > 0;
    if (t) t.textContent = statusTexto(alterados, probs);
  }

  function grupoNovo(txt) {
    var path = D.lerCaminho(txt);
    if (!path.length) return { erro: 'Informe o caminho do grupo.' };
    var aba = D.abaDoCaminho(nats, path);
    if (!aba) {
      var r = D.raizes(nats);
      return { erro: 'O caminho começa pelo total da aba: ' +
        D.ABAS.map(function (a) { return '«' + (r[a] || a) + '»'; }).join(' ou ') + '.' };
    }
    if (path.length < 2) return { erro: 'Abaixo do total da aba, diga o grupo (ex.: ' + path[0] + ' > Novo grupo).' };
    if (path.map(function (p) { return p.trim(); }).indexOf(D.GRUPO_PENDENTES) >= 0) {
      return { erro: '«' + D.GRUPO_PENDENTES + '» é reservado para o painel.' };
    }
    return { path: path, aba: aba };
  }

  // ---------------------------------------------------------------- formulário "Nova natureza"

  /* Natureza nova só entra COMPLETA e sem conflito, no fim do grupo escolhido.
   * `pre`: {cod, nome, bimer} quando vem de uma pendente (a API já traz os três). */
  function abrirFormulario(pre, el) {
    pre = pre || {};
    var fundo = document.createElement('div');
    fundo.className = 'modal-fundo';
    var r = D.raizes(nats);
    fundo.innerHTML =
      '<div class="modal" id="pcForm" role="dialog" aria-modal="true" aria-labelledby="pcFTitulo">' +
        '<h2 id="pcFTitulo">Nova natureza</h2>' +
        (pre.nome ? '<div class="muted" style="margin-bottom:12px">Vinda do Bimer: <b>' + esc(pre.nome) +
          '</b>' + (pre.bimer ? ' · código ' + esc(pre.bimer) : '') + '</div>' : '') +
        '<div class="form-campo"><label for="pcFNome">Nome</label>' +
          '<input type="text" id="pcFNome" value="' + esc(pre.nome || '') + '" placeholder="como aparece no painel">' +
          '<div class="form-erro" data-erro="nome"></div></div>' +
        '<div class="form-campo"><label for="pcFCod">Código</label>' +
          '<input type="text" id="pcFCod" value="' + esc(pre.cod || '') + '" placeholder="ex.: 13.2.1.01.10">' +
          '<div class="form-dica">A classificação no plano de contas do Bimer.</div>' +
          '<div class="form-erro" data-erro="cod"></div></div>' +
        '<div class="form-campo"><label for="pcFGrupo">Grupo</label>' +
          '<select id="pcFGrupo"><option value="">— escolha o grupo —</option>' +
          D.caminhos(nats).map(function (c) {
            var k = D.caminho(c);
            return '<option value="' + esc(k) + '">' + esc(k) + '</option>';
          }).join('') + '<option value="' + NOVO_GRUPO + '">＋ criar novo grupo…</option></select>' +
          '<input type="text" id="pcFNovoGrupo" hidden style="margin-top:8px" placeholder="' +
            esc((r.despesas || 'Total Despesas') + ' > Despesas Tarituba > Novo grupo') + '">' +
          '<div class="form-dica" id="pcFDicaGrupo" hidden>Do total da aba até o grupo, separado por ' +
            '&gt;. O total decide a página: ' + esc(r.receitas || 'Receitas') + ' ou ' +
            esc(r.despesas || 'Despesas') + '.</div>' +
          '<div class="form-erro" data-erro="grupo"></div></div>' +
        '<div class="form-campo"><label for="pcFBimer">Código do Bimer</label>' +
          '<input type="text" id="pcFBimer" value="' + esc(pre.bimer || '') + '" placeholder="ex.: 001875">' +
          '<div class="form-dica">O código da natureza no Bimer (6 dígitos, com os zeros). ' +
          'É por ele que os lançamentos chegam a esta linha. Mais de um, separados por vírgula, ' +
          'soma outras naturezas do Bimer aqui (de-para).</div>' +
          '<div class="form-erro" data-erro="bimer"></div></div>' +
        '<div class="form-falta" id="pcFFalta"></div>' +
        '<div class="form-acoes">' +
          '<button type="button" class="btn-ghost" id="pcFCancel">Cancelar</button>' +
          '<button type="button" class="btn-acao" id="pcFAdd" disabled>Adicionar ao cadastro</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(fundo);

    function v(id) { return fundo.querySelector('#' + id); }

    function grupoEscolhido() {
      var g = v('pcFGrupo').value;
      if (g === NOVO_GRUPO) return grupoNovo(v('pcFNovoGrupo').value);
      if (!g) return {};
      var path = g.split(D.SEP);
      return { path: path, aba: D.abaDoCaminho(nats, path) };
    }

    function avaliar() {
      var e = {}, falta = [];
      var nome = v('pcFNome').value.trim(), cod = v('pcFCod').value.trim();
      var bimer = D.lerBimer(v('pcFBimer').value), g = grupoEscolhido();
      if (!nome) falta.push('nome');
      if (!cod) falta.push('código');
      // a MESMA regra de `D.problemas` (ramo 13): a cópia do Passivo trazia /^03\./ aqui e
      // recusava toda natureza do Tarituba (apontado pelo Arthur no Hub #31, 25/11/2026)
      else if (!D.COD.test(cod)) e.cod = 'Fora do formato 13.x.x.xx.xx.';
      else {
        var dono = nats.find(function (n) { return String(n.cod).trim() === cod; });
        if (dono) e.cod = 'Este código já é de «' + dono.nome + '».';
      }
      if (!bimer.length) falta.push('código do Bimer');
      else if (!bimer.every(function (b) { return /^\d{6}$/.test(b); })) e.bimer = '6 dígitos, com os zeros (ex.: 001875).';
      else {
        bimer.forEach(function (b) {
          var donoB = nats.find(function (n) { return (n.bimer || []).indexOf(b) >= 0; });
          if (donoB) e.bimer = 'O código ' + b + ' já pertence a «' + donoB.nome + '».';
        });
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
      v('pcFFalta').textContent = r2.falta.length ? 'Falta preencher: ' + r2.falta.join(', ') + '.' : '';
      v('pcFAdd').disabled = Object.keys(r2.erros).length > 0 || r2.falta.length > 0;
    }

    function sujo() {
      return v('pcFNome').value !== (pre.nome || '') || v('pcFCod').value !== (pre.cod || '') ||
        !!v('pcFGrupo').value || v('pcFBimer').value !== (pre.bimer || '');
    }

    function fechar(forcado) {
      if (!forcado && sujo() && !window.confirm('Descartar o que foi preenchido?')) return;
      document.removeEventListener('keydown', teclas, true);
      fundo.remove();
    }

    function adicionar() {
      if (v('pcFAdd').disabled) return;
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
    v('pcFGrupo').addEventListener('change', function () {
      var novo = v('pcFGrupo').value === NOVO_GRUPO;
      v('pcFNovoGrupo').hidden = !novo;
      v('pcFDicaGrupo').hidden = !novo;
      if (novo) v('pcFNovoGrupo').focus();
      atualizar();
    });
    v('pcFCancel').onclick = function () { fechar(false); };
    v('pcFAdd').onclick = adicionar;
    atualizar();
    (pre.nome ? v('pcFGrupo') : v('pcFNome')).focus();
  }

  // ---------------------------------------------------------------- eventos

  function ligar(el) {
    document.getElementById('pcVoltar').onclick = function () {
      if (mudou() && !window.confirm('Há alterações não gravadas no cadastro. Voltar ao painel e descartá-las?')) return;
      if (cb.voltar) cb.voltar();
    };

    var tb = el.querySelector('#pcTabNats tbody');
    if (tb) {
      tb.addEventListener('input', function (ev) {
        var alvo = ev.target.closest('input.cpc');
        if (!alvo) return;
        var n = acha(alvo.getAttribute('data-uid'));
        if (!n) return;
        var c = alvo.getAttribute('data-campo');
        n[c] = c === 'bimer' ? D.lerBimer(alvo.value) : alvo.value;
        marcarEstado();
      });

      tb.addEventListener('change', function (ev) {
        var alvo = ev.target.closest('select.cpc[data-campo="grupo"]');
        if (!alvo) return;
        var n = acha(alvo.getAttribute('data-uid'));
        var g;
        if (alvo.value === NOVO_GRUPO) {
          var digitado = window.prompt('Caminho do novo grupo, do total da aba até o grupo, separado por ">".\n' +
            'Ex.: ' + (D.raizes(nats).despesas || 'Total Despesas') + ' > Despesas Tarituba > Novo grupo');
          if (digitado === null) { render(el); return; }
          g = grupoNovo(digitado);
          if (g.erro) { window.alert(g.erro); render(el); return; }
        } else {
          var path = alvo.value.split(D.SEP);
          g = { path: path, aba: D.abaDoCaminho(nats, path) };
        }
        n.path = g.path;
        n.aba = g.aba;
        n.ordem = D.ordemNoFimDoGrupo(nats, g.path, n);
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
              'Se o Bimer ainda trouxer lançamento com o código dela, ela volta como PENDENTE ' +
              '(o valor não some do painel).')) {
            nats = nats.filter(function (x) { return x !== n; });
            render(el);
          }
        }
      });
    }

    /* linhas do Resumo: rótulo é in loco (sem re-render); o resto mexe na estrutura */
    el.querySelectorAll('input[data-res-campo="rotulo"]').forEach(function (inp) {
      inp.addEventListener('input', function () {
        resumo[inp.getAttribute('data-res-aba')][parseInt(inp.getAttribute('data-res-i'), 10)].rotulo = inp.value;
        marcarEstado();
      });
    });
    el.querySelectorAll('select[data-res-campo="ref"]').forEach(function (s) {
      s.addEventListener('change', function () {
        var v = s.value;
        resumo[s.getAttribute('data-res-aba')][parseInt(s.getAttribute('data-res-i'), 10)].ref =
          v.indexOf('c:') === 0 ? { cod: v.slice(2) } : { grupo: v.slice(2) };
        render(el);
      });
    });
    /* `exceto`: trocar o grupo da linha (acima) recomeça sem nada tirado, de propósito —
       os códigos tirados de um grupo não têm por que valer para outro */
    var linhaRes = function (x) {
      return resumo[x.getAttribute('data-res-aba')][parseInt(x.getAttribute('data-res-i'), 10)];
    };
    el.querySelectorAll('select[data-res-exc-add]').forEach(function (s) {
      s.addEventListener('change', function () {
        if (!s.value) return;
        var ref = linhaRes(s).ref;
        ref.exceto = (Array.isArray(ref.exceto) ? ref.exceto : []).concat([s.value]);
        render(el);
      });
    });
    el.querySelectorAll('[data-res-exc-del]').forEach(function (b) {
      b.onclick = function () {
        var ref = linhaRes(b).ref, c = b.getAttribute('data-res-exc-del');
        ref.exceto = (ref.exceto || []).filter(function (x) { return x !== c; });
        if (!ref.exceto.length) delete ref.exceto;
        render(el);
      };
    });
    el.querySelectorAll('[data-res-mv]').forEach(function (b) {
      b.onclick = function () {
        var lst = resumo[b.getAttribute('data-res-aba')], i = parseInt(b.getAttribute('data-res-i'), 10);
        var j = i + parseInt(b.getAttribute('data-res-mv'), 10);
        if (j < 0 || j >= lst.length) return;
        var t = lst[i]; lst[i] = lst[j]; lst[j] = t;
        render(el);
      };
    });
    el.querySelectorAll('[data-res-del]').forEach(function (b) {
      b.onclick = function () {
        var lst = resumo[b.getAttribute('data-res-aba')], i = parseInt(b.getAttribute('data-res-i'), 10);
        if (!window.confirm('Tirar «' + lst[i].rotulo + '» do Resumo?\n\nAs naturezas dela continuam ' +
            'no total; só a linha de detalhe sai da página Resumo.')) return;
        lst.splice(i, 1);
        render(el);
      };
    });
    el.querySelectorAll('[data-res-add]').forEach(function (b) {
      b.onclick = function () {
        var aba = b.getAttribute('data-res-add');
        var g = D.gruposDaAba(nats, aba)[1] || D.gruposDaAba(nats, aba)[0];
        if (!g) return;
        resumo[aba].push({ rotulo: g, ref: { grupo: g } });
        render(el);
      };
    });

    var gr = document.getElementById('pcGrupo');
    if (gr) gr.onchange = function (e) { filtro.grupo = e.target.value; render(el); };

    var busca = document.getElementById('pcBusca');
    if (busca) {
      var t = null;
      busca.oninput = function (e) {
        filtro.busca = e.target.value;
        clearTimeout(t);
        t = setTimeout(function () {
          render(el);
          var b = document.getElementById('pcBusca');
          if (b) { b.focus(); b.setSelectionRange(b.value.length, b.value.length); }
        }, 250);
      };
    }

    var add = document.getElementById('pcAdd');
    if (add) add.onclick = function () { abrirFormulario({}, el); };

    el.querySelectorAll('[data-pa]').forEach(function (b) {
      b.onclick = function () {
        var p = D.pendentesVivos(pendentes, nats)[parseInt(b.getAttribute('data-pa'), 10)];
        if (p) abrirFormulario({ cod: p.cod, nome: p.nome, bimer: p.bimer }, el);
      };
    });

    var salvar = document.getElementById('pcSalvar');
    if (salvar) {
      salvar.onclick = async function () {
        var probs = D.problemas(doc());
        if (probs.length) { render(el); return; }
        salvar.disabled = true;
        document.getElementById('pcStatus').textContent =
          remonta ? 'gravando e remontando o painel…' : 'gravando…';
        try {
          var gravado = await cb.salvar({ naturezas: D.porOrdem(nats).map(limpo), resumo: resumo });
          carregarDoc(gravado);
          if (remonta) origem = 'cadastro';
          avisoSalvo = remonta
            ? 'Cadastro gravado e painel remontado — volte ao painel para ver.'
            : 'Cadastro gravado. O painel reflete na próxima publicação (ou agora: volte ao ' +
              'painel e use Atualizar agora).';
          render(el);
        } catch (e) {
          salvar.disabled = false;
          document.getElementById('pcStatus').textContent = 'não foi possível gravar: ' + e.message;
        }
      };
    }
  }

  return { abrir: abrir, mudou: mudou, _nats: function () { return nats; }, _resumo: function () { return resumo; } };
})();
