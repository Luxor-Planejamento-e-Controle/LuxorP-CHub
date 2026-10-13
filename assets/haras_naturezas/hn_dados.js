/* Regras PURAS do cadastro de naturezas do painel de Gastos do Haras.
 *
 * Nada de rede nem de DOM aqui: é o que deixa testar a regra sem abrir tela, e o que
 * mantém a tela e o Azure concordando sobre o que é um cadastro válido.
 *
 * O ESPELHO: `problemas()` repete `validar()` do `cadastro_naturezas.py`, que é o que o
 * job do Azure roda antes de publicar. A diferença de peso é intencional — lá um cadastro
 * inválido derruba a publicação da semana; aqui ele impede de GRAVAR. Se uma das duas
 * regras mudar, a outra tem de mudar junto.
 *
 * Forma do documento (app_state, id 'haras_naturezas'):
 *
 *   { versao: 1,
 *     naturezas: [{ ordem, cod, alt, nome, resp, bimer: [int], path: [grupo, ...],
 *                   atualizado_em, atualizado_por }],
 *     ignoradas: [{ bimer, nome, atualizado_em, atualizado_por }] }
 *
 *   `bimer`  códigos numéricos do Bimer que contam para a natureza — a ponte entre o
 *            relatório e o cadastro.
 *   `path`   grupos da raiz até o pai. Grupos NÃO são cadastrados à parte: saem daqui. Os
 *            cinco homônimos (Sanidade, Reprodução, Manutenção, Volumoso e Concentrado,
 *            Despesa com Pessoal — Haras × Vassouras) só se distinguem pelo caminho inteiro.
 *   `ordem`  inteiro; só serve para ordenar. De 10 em 10, para caber uma natureza no meio
 *            sem renumerar as outras (renumerar carimbaria todo mundo como alterado).
 */
var HN_DADOS = (function () {
  'use strict';

  var SEP = ' › ';

  function texto(v) {
    return String(v === null || v === undefined ? '' : v).trim();
  }

  function ehInteiro(v) {
    return typeof v === 'number' && isFinite(v) && Math.floor(v) === v;
  }

  /* Documento vazio ('{}', o que o insert inicial grava) vira um cadastro vazio, para a
   * tela nunca ter de perguntar se `naturezas` existe. */
  function normalizar(doc) {
    doc = doc || {};
    return Object.assign({}, doc, {
      versao: doc.versao || 1,
      naturezas: (doc.naturezas || []).map(function (n) {
        return Object.assign({}, n, {
          ordem: n.ordem, cod: n.cod || '', alt: n.alt || '', nome: n.nome || '',
          resp: n.resp || '', bimer: (n.bimer || []).slice(), path: (n.path || []).slice()
        });
      }),
      ignoradas: (doc.ignoradas || []).map(function (g) { return Object.assign({}, g); })
    });
  }

  function porOrdem(nats) {
    return nats.slice().sort(function (a, b) { return (a.ordem || 0) - (b.ordem || 0); });
  }

  function caminho(path) {
    return (path || []).join(SEP);
  }

  /* "Custos e Despesas > Custos" -> [..]. Aceita ">" e "›" para quem digita. */
  function lerCaminho(s) {
    return String(s || '').split(/[>›]/).map(texto).filter(Boolean);
  }

  /* Caminhos distintos, na ordem em que aparecem. */
  function caminhos(nats) {
    var vistos = {}, saida = [];
    porOrdem(nats).forEach(function (n) {
      var k = caminho(n.path);
      if (n.path.length && !vistos[k]) { vistos[k] = true; saida.push(n.path.slice()); }
    });
    return saida;
  }

  /* "1339, 1363" -> { ints: [1339, 1363], invalidos: [] }. Texto que não é inteiro NÃO é
   * descartado em silêncio: volta em `invalidos` para a tela marcar o campo. Sumir com
   * "13a9" deixaria a natureza sem o código que a pessoa achou ter posto. */
  function lerBimer(s) {
    var ints = [], invalidos = [];
    String(s || '').split(/[,;\s]+/).filter(Boolean).forEach(function (t) {
      if (/^\d+$/.test(t)) ints.push(parseInt(t, 10)); else invalidos.push(t);
    });
    return { ints: ints, invalidos: invalidos };
  }

  /* ----------------------------------------------------------- validação */

  function repetidos(erros, chave, valores) {
    var cont = {};
    valores.forEach(function (v) {
      if (v === '' || v === null || v === undefined) return;
      cont[v] = (cont[v] || 0) + 1;
    });
    Object.keys(cont).forEach(function (v) {
      if (cont[v] > 1) erros.push({ onde: chave, erro: 'repetido em ' + cont[v] + ' naturezas: ' + v });
    });
  }

  /* Devolve [{onde, erro}]; vazio = pode gravar. Os `_bimer_invalido` são do TEXTO ainda
   * não interpretado, e só a tela os conhece. */
  function problemas(doc) {
    var erros = [];
    var nats = doc.naturezas || [];

    nats.forEach(function (n, i) {
      var rot = 'natureza #' + (i + 1) + ' (' + (texto(n.cod) || '?') + ')';
      ['cod', 'nome', 'resp'].forEach(function (c) {
        if (!texto(n[c])) erros.push({ onde: rot, erro: '`' + c + '` vazio' });
      });
      if (!n.path || !n.path.length || !n.path.every(texto)) {
        erros.push({ onde: rot, erro: 'sem grupo' });
      }
      if (!ehInteiro(n.ordem)) erros.push({ onde: rot, erro: '`ordem` não numérica' });
      if (n._bimer_invalido && n._bimer_invalido.length) {
        erros.push({ onde: rot, erro: 'código do Bimer inválido: ' + n._bimer_invalido.join(', ') });
      }
    });

    // um código tem de pertencer a UMA natureza: é por ele que o lançamento acha o grupo
    var classif = [];
    nats.forEach(function (n) { classif.push(texto(n.cod), texto(n.alt)); });
    repetidos(erros, 'classificação', classif);
    var bimers = [];
    nats.forEach(function (n) { (n.bimer || []).forEach(function (b) { bimers.push(b); }); });
    repetidos(erros, 'código do Bimer', bimers);
    repetidos(erros, 'ordem', nats.map(function (n) { return n.ordem; }));

    var ign = doc.ignoradas || [];
    var codIgn = [];
    ign.forEach(function (g, i) {
      if (!ehInteiro(g.bimer)) { erros.push({ onde: 'ignorada #' + (i + 1), erro: '`bimer` precisa ser inteiro' }); return; }
      if (!texto(g.nome)) erros.push({ onde: 'ignorada #' + (i + 1) + ' (' + g.bimer + ')', erro: '`nome` vazio' });
      codIgn.push(g.bimer);
    });
    repetidos(erros, 'código ignorado', codIgn);

    // fora do escopo E dentro do Controle: decisão ambígua
    var noControle = {};
    bimers.forEach(function (b) { noControle[b] = true; });
    codIgn.forEach(function (c) {
      if (noControle[c]) erros.push({ onde: 'código ' + c, erro: 'está no Controle E em ignoradas' });
    });
    return erros;
  }

  /* ----------------------------------------------------------- pendentes */

  /* Lista que o job publicou, menos o que já foi decidido AQUI depois da publicação.
   * Sem este filtro, quem classifica uma pendente continuaria vendo ela na lista até a
   * segunda seguinte — e a tela pareceria não ter feito nada. */
  function pendentesVivos(itens, doc) {
    var conhecidos = {};
    (doc.naturezas || []).forEach(function (n) {
      (n.bimer || []).forEach(function (b) { conhecidos[b] = true; });
    });
    (doc.ignoradas || []).forEach(function (g) { conhecidos[g.bimer] = true; });
    return (itens || []).filter(function (p) { return !conhecidos[p.bimer]; });
  }

  /* ----------------------------------------------------------- ordem */

  /* Um inteiro livre logo depois de `ref`, antes da próxima natureza; null se não cabe.
   * Com a ordem de 10 em 10 cabe quase sempre; null só depois de muitas inserções no mesmo
   * ponto — aí o chamador renumera. */
  function ordemApos(nats, ref) {
    var seguintes = nats.map(function (n) { return n.ordem; })
      .filter(function (o) { return o > ref; });
    if (!seguintes.length) return ref + 10;
    var prox = Math.min.apply(null, seguintes);
    return prox - ref > 1 ? ref + Math.floor((prox - ref) / 2) : null;
  }

  /* Renumera de 10 em 10 preservando a ordem. Só mexe em `ordem`. */
  function renumerar(nats) {
    porOrdem(nats).forEach(function (n, i) { n.ordem = (i + 1) * 10; });
    return nats;
  }

  /* Ordem para colocar uma natureza no FIM do grupo `path` (ou no fim de tudo se o grupo
   * ainda não existe). Mantém o grupo contíguo: o painel desenha um cabeçalho cada vez que
   * o caminho muda, então natureza solta no fim de outro grupo viraria um segundo bloco com
   * o mesmo nome. `exceto` é a própria natureza, que sai de onde estava. */
  function ordemNoFimDoGrupo(nats, path, exceto) {
    var outras = nats.filter(function (n) { return n !== exceto; });
    var k = caminho(path);
    var doGrupo = outras.filter(function (n) { return caminho(n.path) === k; });
    var ref = doGrupo.length
      ? Math.max.apply(null, doGrupo.map(function (n) { return n.ordem; }))
      : (outras.length ? Math.max.apply(null, outras.map(function (n) { return n.ordem; })) : 0);
    var o = ordemApos(outras, ref);
    if (o !== null) return o;
    renumerar(nats);                      // sem vão: renumera (inclui `exceto`) e tenta de novo
    return ordemNoFimDoGrupo(nats, path, exceto);
  }

  /* A vizinha de cima (-1) ou de baixo (+1) NO MESMO GRUPO, ou null. Subir e descer só
   * trocam dentro do grupo: trocar com a vizinha de outro grupo racharia os dois em
   * blocos separados (A, B, A), e o painel desenharia o mesmo grupo duas vezes. Para
   * mudar de grupo, troca-se o grupo da natureza. */
  function vizinha(nats, n, dir) {
    var ord = porOrdem(nats);
    var i = ord.indexOf(n), j = i + dir;
    if (i < 0 || j < 0 || j >= ord.length) return null;
    return caminho(ord[j].path) === caminho(n.path) ? ord[j] : null;
  }

  /* Troca a ordem com a vizinha do mesmo grupo. Só duas naturezas mudam — e só elas são
   * carimbadas como alteradas. Devolve false se não há para onde ir. */
  function mover(nats, n, dir) {
    var v = vizinha(nats, n, dir);
    if (!v) return false;
    var t = n.ordem; n.ordem = v.ordem; v.ordem = t;
    return true;
  }

  return {
    SEP: SEP, normalizar: normalizar, porOrdem: porOrdem, caminho: caminho,
    lerCaminho: lerCaminho, caminhos: caminhos, lerBimer: lerBimer,
    problemas: problemas, pendentesVivos: pendentesVivos,
    ordemApos: ordemApos, renumerar: renumerar, ordemNoFimDoGrupo: ordemNoFimDoGrupo,
    vizinha: vizinha, mover: mover
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = HN_DADOS;
