/* Regras PURAS do cadastro de naturezas do Fluxo de Caixa Tarituba.
 *
 * Nada de rede nem de DOM aqui: é o que deixa testar a regra sem abrir tela, e o que
 * mantém a tela e o Azure concordando sobre o que é um cadastro válido.
 *
 * O ESPELHO: `problemas()` repete `validar()` do `shared_tarituba/cadastro.py` (repo
 * Automacoes), que o job roda antes de publicar. Lá um cadastro inválido derruba a
 * publicação; aqui ele impede de GRAVAR. Se uma das duas regras mudar, a outra muda junto.
 *
 * Forma do documento (app_state, id 'tarituba'):
 *
 *   { versao: 1,
 *     naturezas: [{ ordem, aba, cod, nome, bimer, path: [grupo, ...],
 *                   atualizado_em, atualizado_por }] }
 *
 *   `aba`    'receitas' ou 'despesas' — a página do painel. Sai da RAIZ do grupo: cada aba
 *            tem um total só (Receita Total / Despesas Total - Tarituba).
 *   `bimer`  o código da natureza no Bimer, em texto com os zeros ('001842'): é a ponte
 *            entre o lançamento e o cadastro.
 *   `path`   grupos da raiz até o pai. Grupos NÃO são cadastrados à parte: saem daqui.
 *   `ordem`  só serve para ordenar; de 10 em 10, para caber uma natureza no meio.
 */
var TT_DADOS = (function () {
  'use strict';

  var SEP = ' › ';
  var ABAS = ['receitas', 'despesas'];
  var PREFIXO = { receitas: '13.1', despesas: '13.2' };
  var GRUPO_PENDENTES = 'Pendentes — fora do cadastro';
  var COD = /^13\.\d+(\.\d+)*$/;
  var BIMER = /^\d{1,10}$/;

  function texto(v) {
    return String(v === null || v === undefined ? '' : v).trim();
  }

  /* Documento vazio ('{}', a linha inicial) vira cadastro vazio; FORMA errada não — um
   * `naturezas` que não é lista viraria uma tela vazia e o próximo "Gravar" apagaria o
   * que estava lá. Melhor recusar com a razão. */
  function normalizar(doc) {
    doc = doc || {};
    if (doc.naturezas !== undefined && doc.naturezas !== null && !Array.isArray(doc.naturezas)) {
      throw new Error('o cadastro no banco está com formato inválido: `naturezas` não é uma ' +
                      'lista — corrija o documento antes de abrir');
    }
    return Object.assign({}, doc, {
      versao: doc.versao || 1,
      naturezas: (doc.naturezas || []).map(function (n) {
        return Object.assign({}, n, {
          cod: n.cod === undefined ? '' : n.cod, nome: n.nome === undefined ? '' : n.nome,
          bimer: n.bimer === undefined ? '' : n.bimer,
          path: Array.isArray(n.path) ? n.path.slice() : (n.path === undefined ? [] : n.path)
        });
      })
    });
  }

  function porOrdem(nats) {
    return nats.slice().sort(function (a, b) { return (a.ordem || 0) - (b.ordem || 0); });
  }

  function caminho(path) { return (path || []).join(SEP); }

  function lerCaminho(s) {
    return String(s || '').split(/[>›]/).map(texto).filter(Boolean);
  }

  /* Caminhos distintos, na ordem do painel. */
  function caminhos(nats) {
    var vistos = {}, saida = [];
    porOrdem(nats).forEach(function (n) {
      var k = caminho(n.path);
      if (Array.isArray(n.path) && n.path.length && !vistos[k]) { vistos[k] = true; saida.push(n.path.slice()); }
    });
    return saida;
  }

  /* {receitas: 'Receita Total', despesas: '...'} — a raiz de cada aba, tirada do cadastro. */
  function raizes(nats) {
    var r = {};
    porOrdem(nats).forEach(function (n) {
      if (ABAS.indexOf(n.aba) >= 0 && Array.isArray(n.path) && n.path.length && !r[n.aba]) {
        r[n.aba] = texto(n.path[0]);
      }
    });
    return r;
  }

  /* A aba de um caminho, pela raiz; null se a raiz não é de nenhuma aba. */
  function abaDoCaminho(nats, path) {
    var r = raizes(nats), raiz = texto((path || [])[0]);
    for (var i = 0; i < ABAS.length; i++) if (r[ABAS[i]] === raiz) return ABAS[i];
    return null;
  }

  function foraDoBloco(n) {
    return ABAS.indexOf(n.aba) >= 0 && texto(n.cod) !== '' && texto(n.cod).indexOf(PREFIXO[n.aba]) !== 0;
  }

  /* ----------------------------------------------------------- validação */

  function repetidos(erros, rotulo, valores) {
    var cont = {};
    valores.forEach(function (v) {
      if (v === '' || v === null || v === undefined) return;
      cont[v] = (cont[v] || 0) + 1;
    });
    Object.keys(cont).forEach(function (v) {
      if (cont[v] > 1) erros.push({ onde: rotulo, erro: 'repetido em ' + cont[v] + ' naturezas: ' + v });
    });
  }

  /* [{onde, erro}]; vazio = pode gravar. As MESMAS regras do validar() do Python. */
  function problemas(doc) {
    if (!doc || typeof doc !== 'object' || !Array.isArray(doc.naturezas)) {
      return [{ onde: 'documento', erro: 'sem a lista `naturezas`' }];
    }
    var erros = [], nats = doc.naturezas, raiz = {};
    if (!nats.length) erros.push({ onde: 'documento', erro: 'o cadastro não tem nenhuma natureza' });

    nats.forEach(function (n, i) {
      if (!n || typeof n !== 'object') { erros.push({ onde: 'natureza #' + (i + 1), erro: 'não é um objeto' }); return; }
      var rot = 'natureza #' + (i + 1) + ' (' + (texto(n.cod) || '?') + ')';
      /* texto, e não "qualquer coisa que vire texto": um 13.1 numérico passaria no formato e
       * o Azure quebraria no `.strip()` ao montar o painel */
      if (typeof n.cod !== 'string' || !COD.test(n.cod.trim())) {
        erros.push({ onde: rot, erro: 'código fora do formato 13.x.x.xx.xx' });
      }
      if (typeof n.nome !== 'string' || !n.nome.trim()) erros.push({ onde: rot, erro: 'nome vazio' });
      if (typeof n.bimer !== 'string' || !BIMER.test(n.bimer.trim())) {
        erros.push({ onde: rot, erro: 'código do Bimer precisa ser só dígitos (ex.: 001842)' });
      }
      if (ABAS.indexOf(n.aba) < 0) erros.push({ onde: rot, erro: 'aba precisa ser receitas ou despesas' });
      if (!Array.isArray(n.path) || !n.path.length ||
          !n.path.every(function (p) { return typeof p === 'string' && p.trim(); })) {
        erros.push({ onde: rot, erro: 'sem grupo' });
      } else if (ABAS.indexOf(n.aba) >= 0) {
        if (n.path.map(texto).indexOf(GRUPO_PENDENTES) >= 0) {
          erros.push({ onde: rot, erro: '«' + GRUPO_PENDENTES + '» é reservado para o painel' });
        }
        raiz[n.aba] = raiz[n.aba] || {};
        raiz[n.aba][texto(n.path[0])] = true;
      }
      if (typeof n.ordem !== 'number' || !isFinite(n.ordem)) erros.push({ onde: rot, erro: '`ordem` não numérica' });
    });

    var obj = nats.filter(function (n) { return n && typeof n === 'object'; });
    // um código tem de pertencer a UMA natureza: é por ele que o lançamento acha o grupo
    repetidos(erros, 'código', obj.map(function (n) { return texto(n.cod); }));
    repetidos(erros, 'código do Bimer', obj.map(function (n) { return texto(n.bimer); }));
    repetidos(erros, 'ordem', obj.map(function (n) { return n.ordem; }));
    Object.keys(raiz).forEach(function (aba) {
      var rs = Object.keys(raiz[aba]);
      if (rs.length > 1) {
        erros.push({ onde: 'aba ' + aba, erro: 'mais de um grupo raiz: ' + rs.sort().join(', ') +
                     ' (toda natureza da aba começa pelo mesmo total)' });
      }
    });
    return erros;
  }

  /* ----------------------------------------------------------- pendentes */

  /* Lista que o job publicou (D.pendentes), menos o que já foi cadastrado AQUI depois da
   * publicação — senão quem classifica continuaria vendo a pendente até a segunda seguinte. */
  function pendentesVivos(itens, nats) {
    var bim = {}, cod = {};
    nats.forEach(function (n) { bim[texto(n.bimer)] = true; cod[texto(n.cod)] = true; });
    return (itens || []).filter(function (p) {
      return !(texto(p.bimer) && bim[texto(p.bimer)]) && !cod[texto(p.cod)];
    });
  }

  /* ----------------------------------------------------------- ordem */

  function ordemApos(nats, ref) {
    var seg = nats.map(function (n) { return n.ordem; }).filter(function (o) { return o > ref; });
    if (!seg.length) return ref + 10;
    var prox = Math.min.apply(null, seg);
    return prox - ref > 1 ? ref + Math.floor((prox - ref) / 2) : null;
  }

  function renumerar(nats) {
    porOrdem(nats).forEach(function (n, i) { n.ordem = (i + 1) * 10; });
    return nats;
  }

  /* Ordem para pôr a natureza no FIM do grupo `path` (ou no fim da aba, se o grupo é novo):
   * mantém o grupo contíguo. `exceto` é a própria natureza, que sai de onde estava. */
  function ordemNoFimDoGrupo(nats, path, exceto) {
    var outras = nats.filter(function (n) { return n !== exceto; });
    var k = caminho(path), raiz = texto((path || [])[0]);
    var doGrupo = outras.filter(function (n) { return caminho(n.path) === k; });
    var daAba = outras.filter(function (n) { return texto((n.path || [])[0]) === raiz; });
    var base = doGrupo.length ? doGrupo : (daAba.length ? daAba : outras);
    var ref = base.length ? Math.max.apply(null, base.map(function (n) { return n.ordem; })) : 0;
    var o = ordemApos(outras, ref);
    if (o !== null) return o;
    renumerar(nats);
    return ordemNoFimDoGrupo(nats, path, exceto);
  }

  /* Vizinha de cima (-1) ou de baixo (+1) NO MESMO GRUPO: trocar com outro grupo racharia
   * os dois em blocos separados. Para mudar de grupo, troca-se o grupo da natureza. */
  function vizinha(nats, n, dir) {
    var ord = porOrdem(nats), i = ord.indexOf(n), j = i + dir;
    if (i < 0 || j < 0 || j >= ord.length) return null;
    return caminho(ord[j].path) === caminho(n.path) ? ord[j] : null;
  }

  function mover(nats, n, dir) {
    var v = vizinha(nats, n, dir);
    if (!v) return false;
    var t = n.ordem; n.ordem = v.ordem; v.ordem = t;
    return true;
  }

  return {
    SEP: SEP, ABAS: ABAS, GRUPO_PENDENTES: GRUPO_PENDENTES,
    normalizar: normalizar, porOrdem: porOrdem, caminho: caminho, lerCaminho: lerCaminho,
    caminhos: caminhos, raizes: raizes, abaDoCaminho: abaDoCaminho, foraDoBloco: foraDoBloco,
    problemas: problemas, pendentesVivos: pendentesVivos,
    ordemApos: ordemApos, renumerar: renumerar, ordemNoFimDoGrupo: ordemNoFimDoGrupo,
    vizinha: vizinha, mover: mover
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = TT_DADOS;
