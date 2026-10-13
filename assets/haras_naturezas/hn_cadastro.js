/* Tela do cadastro de naturezas do painel de Gastos do Haras.
 *
 * Por que ela existe
 * ------------------
 * O realizado do painel vem dos relatórios do Bimer, mas "o que entra no Controle, em
 * qual grupo, de quem é e em que ordem" morava numa planilha — e natureza nova era
 * cirurgia no Excel (linha, SUM, fórmula matricial, aba do responsável). Quando uma
 * natureza foi criada no Bimer e ninguém a pôs na planilha, o dinheiro dela sumiu do
 * painel em silêncio; só o check contra o DRE denunciou (R$ 1.181,58 em 09/2026).
 *
 * Aqui o cadastro é de quem o mantém, e natureza que o Bimer traz e ninguém decidiu
 * aparece em PENDENTES, com o valor à vista, para entrar no Controle ou ficar de fora.
 *
 * Edição in loco: `input` altera o registro em memória e NÃO re-renderiza (redesenhar a
 * cada tecla tiraria o foco). A tela só se redesenha quando a ESTRUTURA muda: mover,
 * trocar de grupo, incluir, remover, filtrar.
 */
window.HN_CADASTRO = (function () {
  'use strict';

  var D = HN_DADOS;
  var nats = [];              // cópia de trabalho; cada item tem `uid` e, às vezes, `_bimer_txt`
  var ignoradas = [];
  var pendentes = null;       // { gerado_em, pendentes: [...] } ou null
  var original = '';
  var filtro = { busca: '', grupo: '' };
  var aoSalvar = null;
  var proximoUid = 1;
  var avisoSalvo = '';
  var ignAberto = false;      // a lista de ignoradas abre sozinha depois de uma ação sobre ela

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function rs(v) {
    return 'R$ ' + Number(v || 0).toLocaleString('pt-BR',
      { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  var MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

  /* O que vai para o banco: sem `uid` e sem os campos transitórios da tela. */
  function limpo(x) {
    var c = Object.assign({}, x);
    Object.keys(c).forEach(function (k) { if (k === 'uid' || k.charAt(0) === '_') delete c[k]; });
    return c;
  }

  function doc() {
    return { naturezas: nats, ignoradas: ignoradas };
  }

  function serializar() {
    return JSON.stringify({
      n: D.porOrdem(nats).map(limpo),
      i: ignoradas.slice().sort(function (a, b) { return a.bimer - b.bimer; }).map(limpo)
    });
  }

  function mudou() { return serializar() !== original; }

  function abrir(alvo, est, cb) {
    aoSalvar = cb && cb.salvar;
    pendentes = est.pendentes || null;
    carregarDoc(est.doc);
    render(alvo);
  }

  function carregarDoc(d) {
    nats = d.naturezas.map(function (n) { return Object.assign({}, n, { uid: proximoUid++ }); });
    ignoradas = d.ignoradas.map(function (g) { return Object.assign({}, g, { uid: proximoUid++ }); });
    original = serializar();
  }

  function acha(uid) {
    return nats.find(function (n) { return String(n.uid) === String(uid); });
  }

  // ---------------------------------------------------------------- montagem

  function responsaveis() {
    var v = {};
    nats.forEach(function (n) { if (n.resp) v[n.resp] = true; });
    return Object.keys(v).sort(function (a, b) { return a.localeCompare(b, 'pt-BR'); });
  }

  function visiveis() {
    var b = filtro.busca.trim().toLowerCase();
    return D.porOrdem(nats).filter(function (n) {
      if (filtro.grupo && D.caminho(n.path) !== filtro.grupo) return false;
      if (b && (n.cod + ' ' + n.alt + ' ' + n.nome + ' ' + n.resp + ' ' +
                (n.bimer || []).join(' ')).toLowerCase().indexOf(b) < 0) return false;
      return true;
    });
  }

  function campo(uid, c, valor, largura, ph) {
    return '<input class="cpc" data-uid="' + uid + '" data-campo="' + c + '" value="' +
      esc(valor) + '" style="width:' + largura + 'px"' +
      (ph ? ' placeholder="' + esc(ph) + '"' : '') + '>';
  }

  function seletorGrupo(n) {
    var lista = D.caminhos(nats);
    var atual = D.caminho(n.path);
    var opcoes = (atual ? '' : '<option value="">— escolha o grupo —</option>') +
      lista.map(function (p) {
        var k = D.caminho(p);
        return '<option value="' + esc(k) + '"' + (k === atual ? ' selected' : '') + '>' +
          esc(k) + '</option>';
      }).join('') + '<option value="__novo__">＋ novo grupo…</option>';
    return '<select class="cpc" data-uid="' + n.uid + '" data-campo="grupo" style="width:300px">' +
      opcoes + '</select>';
  }

  function linhaHtml(n, filtrando) {
    var sobe = !filtrando && D.vizinha(nats, n, -1), desce = !filtrando && D.vizinha(nats, n, 1);
    var bimerTxt = n._bimer_txt !== undefined ? n._bimer_txt : (n.bimer || []).join(', ');
    var invalido = n._bimer_invalido && n._bimer_invalido.length;
    return '<tr data-uid="' + n.uid + '">' +
      '<td class="nowrap"><button type="button" class="btn-mv" data-mv="-1" data-uid="' + n.uid +
        '" title="subir"' + (sobe ? '' : ' disabled') + '>↑</button>' +
        '<button type="button" class="btn-mv" data-mv="1" data-uid="' + n.uid +
        '" title="descer"' + (desce ? '' : ' disabled') + '>↓</button></td>' +
      '<td>' + campo(n.uid, 'cod', n.cod, 112, 'cód') + '</td>' +
      '<td>' + campo(n.uid, 'alt', n.alt, 112, 'alt') + '</td>' +
      '<td>' + campo(n.uid, 'nome', n.nome, 230, 'nome') +
        (n.atualizado_por
          ? '<div class="sub2">alterado por ' + esc(n.atualizado_por) +
            (n.atualizado_em ? ' em ' + esc(n.atualizado_em.slice(0, 10).split('-')
              .reverse().join('/')) : '') + '</div>' : '') + '</td>' +
      '<td>' + campo(n.uid, 'resp', n.resp, 110, 'resp.') + '</td>' +
      '<td>' + seletorGrupo(n) + '</td>' +
      '<td><input class="cpc' + (invalido ? ' ruim' : '') + '" data-uid="' + n.uid +
        '" data-campo="bimer" value="' + esc(bimerTxt) + '" style="width:110px" ' +
        'placeholder="1339, 1363" title="códigos do Bimer que contam para esta natureza"></td>' +
      '<td><button type="button" class="btn-lixo" data-uid="' + n.uid +
        '" title="remover do Controle">&times;</button></td>' +
    '</tr>';
  }

  function tabelaNaturezas(lista, filtrando) {
    if (!lista.length) {
      return '<tr><td colspan="8"><div class="empty">Nenhuma natureza com esses filtros.</div></td></tr>';
    }
    var html = '', ultimo = null;
    lista.forEach(function (n) {
      var k = D.caminho(n.path);
      if (k !== ultimo) {
        var qtd = nats.filter(function (x) { return D.caminho(x.path) === k; }).length;
        html += '<tr class="grupo"><td colspan="8">' + (k ? esc(k) : 'Sem grupo') +
          ' <span class="muted">· ' + qtd + '</span></td></tr>';
        ultimo = k;
      }
      html += linhaHtml(n, filtrando);
    });
    return html;
  }

  function cardPendentes() {
    if (!pendentes) {
      return '<div class="card"><div class="card-title"><h2>Pendentes</h2></div>' +
        '<div class="muted">A lista de pendentes ainda não foi publicada. O job do painel de ' +
        'Gastos a gera a cada execução: códigos do Bimer que apareceram nos relatórios e que ' +
        'não estão no cadastro nem entre as ignoradas.</div></div>';
    }
    var vivos = D.pendentesVivos(pendentes.pendentes, doc());
    if (!vivos.length) {
      return '<div class="card"><div class="card-title"><h2>Pendentes</h2>' +
        '<span class="muted">nenhuma · lista de ' + esc(String(pendentes.gerado_em || '').slice(0, 10)
          .split('-').reverse().join('/')) + '</span></div>' +
        '<div class="muted">Todo código que o Bimer trouxe está no Controle ou fora do escopo.' +
        '</div></div>';
    }
    return '<div class="card destaque"><div class="card-title"><h2>Pendentes</h2>' +
      '<span class="muted">' + vivos.length + ' · lista de ' +
        esc(String(pendentes.gerado_em || '').slice(0, 10).split('-').reverse().join('/')) +
      '</span></div>' +
      '<div class="muted" style="margin-bottom:10px"><b>Enquanto estiver pendente, o dinheiro ' +
      'desta natureza NÃO entra no painel por grupo.</b> Decida: entra no Controle (escolha ' +
      'grupo e responsável) ou fica fora do escopo.</div>' +
      '<div class="tbl-wrap"><table class="data"><thead><tr><th>Bimer</th><th>Natureza</th>' +
      '<th class="num">Lanç.</th><th class="num">Valor</th><th>Meses</th><th></th></tr></thead>' +
      '<tbody>' + vivos.map(function (p) {
        return '<tr data-pend="' + p.bimer + '"><td>' + p.bimer + '</td><td>' + esc(p.nome) + '</td>' +
          '<td class="num">' + (p.qtd || 0) + '</td><td class="num">' + rs(p.valor) + '</td>' +
          '<td>' + (p.meses || []).map(function (m) { return MESES[m - 1]; }).join(', ') + '</td>' +
          '<td class="nowrap">' +
          '<button type="button" class="btn-ghost" data-pa="incluir" data-bimer="' + p.bimer +
            '">Incluir no Controle</button> ' +
          '<button type="button" class="btn-ghost" data-pa="fora" data-bimer="' + p.bimer +
            '">Fora do escopo</button></td></tr>';
      }).join('') + '</tbody></table></div></div>';
  }

  function cardIgnoradas() {
    var lista = ignoradas.slice().sort(function (a, b) { return a.bimer - b.bimer; });
    return '<div class="card"><details id="hnIgn"' + (ignAberto ? ' open' : '') + '>' +
      '<summary><span class="card-title" style="display:inline-flex;margin:0"><h2>Fora do escopo</h2>' +
      '<span class="muted">' + lista.length + ' códigos que o Bimer traz e o Controle não acompanha ' +
      '(aporte de sócios, rendimentos…)</span></span></summary>' +
      '<div class="tbl-wrap" style="margin-top:12px"><table class="data"><thead><tr><th>Bimer</th>' +
      '<th>Natureza</th><th></th></tr></thead><tbody>' +
      (lista.length ? lista.map(function (g) {
        return '<tr data-ign="' + g.bimer + '"><td>' + g.bimer + '</td><td>' + esc(g.nome) + '</td>' +
          '<td class="nowrap">' +
          '<button type="button" class="btn-ghost" data-ia="incluir" data-bimer="' + g.bimer +
            '">Incluir no Controle</button> ' +
          '<button type="button" class="btn-ghost" data-ia="reavaliar" data-bimer="' + g.bimer +
            '" title="tira da lista: se o Bimer ainda trouxer o código, ele volta a ser pendente">' +
            'Reavaliar</button></td></tr>';
      }).join('') : '<tr><td colspan="3"><div class="empty">Nada fora do escopo.</div></td></tr>') +
      '</tbody></table></div></details></div>';
  }

  function render(alvo) {
    var el = alvo || document.getElementById('content');
    var probs = D.problemas(doc());
    var alterados = mudou();
    var lista = visiveis();
    var filtrando = !!(filtro.busca || filtro.grupo);

    el.innerHTML = '' +
      '<div class="banner"><div><b>Este é o cadastro, não o painel.</b> O painel de Gastos é ' +
        'montado pelo job no Azure (segunda, 08:30) a partir dos relatórios do Bimer e <b>deste ' +
        'cadastro</b>: o que você gravar aqui passa a valer na <b>próxima publicação</b>, não ' +
        'na hora. A ordem das linhas é a ordem do painel.</div></div>' +

      '<div id="hnProbs">' + probsHtml(probs) + '</div>' +

      cardPendentes() +

      '<div class="toolbar">' +
        '<div class="field"><label>Grupo</label><select id="hnGrupo"><option value="">Todos</option>' +
          D.caminhos(nats).map(function (p) {
            var k = D.caminho(p);
            return '<option value="' + esc(k) + '"' + (filtro.grupo === k ? ' selected' : '') + '>' +
              esc(k) + '</option>';
          }).join('') + '</select></div>' +
        '<div class="field cresce"><label>Buscar</label><input type="search" id="hnBusca" ' +
          'placeholder="código, nome, responsável ou Bimer" value="' + esc(filtro.busca) + '"></div>' +
        '<div style="flex:1"></div>' +
        '<button class="btn-ghost" id="hnAdd" type="button">+ Natureza</button>' +
      '</div>' +

      '<div class="card">' +
        '<div class="card-title"><h2>Naturezas do Controle</h2><span class="muted">' + lista.length +
          ' de ' + nats.length + '</span></div>' +
        (filtrando ? '<div class="muted" style="margin-bottom:8px">Com filtro ativo os botões ' +
          '↑ ↓ ficam desligados: mover dentro de uma lista filtrada trocaria de lugar com uma ' +
          'linha que você não está vendo.</div>' : '') +
        '<div class="tbl-wrap"><table class="data cadastro"><thead><tr><th></th><th>Cód</th>' +
          '<th title="segunda classificação do mesmo lançamento (par .04/.05 do DRE)">Alt</th>' +
          '<th>Natureza</th><th>Resp.</th><th>Grupo</th><th>Bimer</th><th></th></tr></thead>' +
          '<tbody>' + tabelaNaturezas(lista, filtrando) + '</tbody></table></div>' +
        '<datalist id="hnResp">' + responsaveis().map(function (r) {
          return '<option value="' + esc(r) + '">';
        }).join('') + '</datalist>' +
      '</div>' +

      cardIgnoradas() +

      '<div class="cpc-acoes">' +
        '<div class="txt" id="hnStatus">' + esc(statusTexto(alterados, probs)) + '</div>' +
        '<button class="btn-acao" id="hnSalvar" type="button"' +
          (alterados && !probs.length ? '' : ' disabled') + '>Gravar cadastro</button>' +
      '</div>';

    el.querySelectorAll('input[data-campo="resp"]').forEach(function (i) { i.setAttribute('list', 'hnResp'); });
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

  // ---------------------------------------------------------------- eventos

  /* A cada tecla só se tocam o botão, o status e a caixa de problemas: todos ficam FORA da
   * tabela, então atualizá-los não tira o foco do campo que está sendo digitado. */
  function marcarEstado() {
    var probs = D.problemas(doc());
    var alterados = mudou();
    avisoSalvo = '';
    var b = document.getElementById('hnSalvar');
    var t = document.getElementById('hnStatus');
    var pb = document.getElementById('hnProbs');
    if (pb) pb.innerHTML = probsHtml(probs);
    if (b) b.disabled = !alterados || probs.length > 0;
    if (t) t.textContent = statusTexto(alterados, probs);
  }

  function novaNatureza(extra) {
    var n = Object.assign({
      ordem: D.ordemNoFimDoGrupo(nats, [], null), cod: '', alt: '', nome: '', resp: '',
      bimer: [], path: [], uid: proximoUid++
    }, extra || {});
    nats.push(n);
    return n;
  }

  function ligar(el) {
    var tb = el.querySelector('table.cadastro tbody');

    if (tb) {
      tb.addEventListener('input', function (ev) {
        var alvo = ev.target.closest('input.cpc, select.cpc');
        if (!alvo) return;
        var n = acha(alvo.getAttribute('data-uid'));
        if (!n) return;
        var c = alvo.getAttribute('data-campo');
        if (c === 'grupo') return;              // tratado no 'change', abaixo
        if (c === 'bimer') {
          var r = D.lerBimer(alvo.value);
          n._bimer_txt = alvo.value;
          n.bimer = r.ints;
          n._bimer_invalido = r.invalidos;
          alvo.classList.toggle('ruim', r.invalidos.length > 0);
        } else {
          n[c] = alvo.value;
        }
        marcarEstado();
      });

      tb.addEventListener('change', function (ev) {
        var alvo = ev.target.closest('select.cpc[data-campo="grupo"]');
        if (!alvo) return;
        var n = acha(alvo.getAttribute('data-uid'));
        var v = alvo.value, path;
        if (v === '__novo__') {
          var t = window.prompt('Caminho do novo grupo, da raiz ao grupo, separado por ">".\n' +
            'Ex.: Custos e Despesas > Custos > Sanidade');
          path = D.lerCaminho(t);
          if (!path.length) { render(el); return; }
        } else {
          path = v.split(D.SEP);
        }
        n.path = path;
        n.ordem = D.ordemNoFimDoGrupo(nats, path, n);   // fim do grupo: mantém-no contíguo
        render(el);
      });

      tb.addEventListener('click', function (ev) {
        var mv = ev.target.closest('.btn-mv');
        if (mv && !mv.disabled) {
          if (D.mover(nats, acha(mv.getAttribute('data-uid')), parseInt(mv.getAttribute('data-mv'), 10))) {
            render(el);
          }
          return;
        }
        var lixo = ev.target.closest('.btn-lixo');
        if (lixo) {
          var n = acha(lixo.getAttribute('data-uid'));
          if (window.confirm('Remover "' + (n.nome || n.cod || 'esta natureza') + '" do Controle?\n\n' +
              'Se o Bimer ainda trouxer o(s) código(s) dela, ela volta a aparecer como PENDENTE ' +
              'na próxima publicação. Para tirar do escopo de vez, use "Fora do escopo" na ' +
              'lista de pendentes.')) {
            nats = nats.filter(function (x) { return x !== n; });
            render(el);
          }
        }
      });
    }

    var gr = document.getElementById('hnGrupo');
    if (gr) gr.onchange = function (e) { filtro.grupo = e.target.value; render(el); };

    var busca = document.getElementById('hnBusca');
    if (busca) {
      var t = null;
      busca.oninput = function (e) {
        filtro.busca = e.target.value;
        clearTimeout(t);
        t = setTimeout(function () { render(el); }, 250);
      };
    }

    var add = document.getElementById('hnAdd');
    if (add) add.onclick = function () {
      /* Nova natureza nasce SEM grupo e no fim: quem cria escolhe o grupo, e é esse
       * `change` que a põe no lugar certo. Filtro limpo para ela aparecer. */
      filtro = { busca: '', grupo: '' };
      var n = novaNatureza();
      render(el);
      var c = el.querySelector('tr[data-uid="' + n.uid + '"] input[data-campo="cod"]');
      if (c) { c.scrollIntoView({ block: 'center' }); c.focus(); }
    };

    el.querySelectorAll('[data-pa]').forEach(function (b) {
      b.onclick = function () {
        var cod = parseInt(b.getAttribute('data-bimer'), 10);
        var p = (pendentes.pendentes || []).find(function (x) { return x.bimer === cod; });
        if (!p) return;
        if (b.getAttribute('data-pa') === 'fora') {
          ignoradas.push({ bimer: p.bimer, nome: p.nome, uid: proximoUid++ });
          render(el);
          return;
        }
        filtro = { busca: '', grupo: '' };
        var n = novaNatureza({ nome: p.nome, bimer: [p.bimer] });
        render(el);
        var c = el.querySelector('tr[data-uid="' + n.uid + '"] input[data-campo="cod"]');
        if (c) { c.scrollIntoView({ block: 'center' }); c.focus(); }
      };
    });

    var det = document.getElementById('hnIgn');
    if (det) det.addEventListener('toggle', function () { ignAberto = det.open; });

    el.querySelectorAll('[data-ia]').forEach(function (b) {
      b.onclick = function () {
        var cod = parseInt(b.getAttribute('data-bimer'), 10);
        var g = ignoradas.find(function (x) { return x.bimer === cod; });
        if (!g) return;
        ignoradas = ignoradas.filter(function (x) { return x !== g; });
        ignAberto = true;
        if (b.getAttribute('data-ia') === 'incluir') {
          filtro = { busca: '', grupo: '' };
          var n = novaNatureza({ nome: g.nome, bimer: [g.bimer] });
          render(el);
          var c = el.querySelector('tr[data-uid="' + n.uid + '"] input[data-campo="cod"]');
          if (c) { c.scrollIntoView({ block: 'center' }); c.focus(); }
        } else {
          render(el);
        }
      };
    });

    var salvar = document.getElementById('hnSalvar');
    if (salvar) {
      salvar.onclick = async function () {
        var probs = D.problemas(doc());
        if (probs.length) { render(el); return; }
        salvar.disabled = true;
        document.getElementById('hnStatus').textContent = 'gravando...';
        try {
          var gravado = await aoSalvar({
            naturezas: D.porOrdem(nats).map(limpo),
            ignoradas: ignoradas.map(limpo)
          });
          carregarDoc(gravado);
          avisoSalvo = 'Cadastro gravado. O painel de Gastos reflete na próxima publicação.';
          render(el);
        } catch (e) {
          salvar.disabled = false;
          document.getElementById('hnStatus').textContent = 'não foi possível gravar: ' + e.message;
        }
      };
    }
  }

  return { abrir: abrir, mudou: mudou,
           _nats: function () { return nats; }, _ignoradas: function () { return ignoradas; } };
})();
