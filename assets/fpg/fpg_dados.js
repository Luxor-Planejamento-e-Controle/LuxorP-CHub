/* Regras PURAS do cadastro de naturezas do Fluxo de Caixa da Fazenda Pao Grande (FPG).
 *
 * Cópia do `sh_dados.js` do Shiva (que veio do Passivo e do `tt_dados.js` do Tarituba),
 * com o que é deste ramo:
 *   - códigos `10.x` (Shiva `11.x`, Passivo `03.x`, Tarituba `13.x`), e o bloco esperado
 *     de cada código sai de `abaDoCodigo` — o plano 10.x é o da EMPRESA e não separa
 *     receita de despesa pelo 2º nível (espelho de `aba_do_codigo` do cadastro.py);
 *   - `bimer` é uma LISTA (do Passivo): uma linha recebe vários códigos — o 1º é o da
 *     própria linha, os demais são de-para. Na FPG não há de-para hoje;
 *   - o documento tem `resumo`: as linhas que a página Resumo mostra abaixo de Receita
 *     Total e Despesa Total, cada uma apontando para uma natureza ou um grupo — e o grupo
 *     aceita `exceto` (códigos tirados dele; veio do Shiva, a FPG não usa hoje).
 *
 * Nada de rede nem de DOM aqui: é o que deixa testar a regra sem abrir tela.
 *
 * O ESPELHO: `problemas()` repete `validar()` do `shared_fpg/cadastro.py`, que o
 * extrator roda antes de montar. Lá um cadastro inválido derruba a montagem; aqui ele
 * impede de GRAVAR. Se uma das duas regras mudar, a outra muda junto — o teste
 * `_teste_cadastro.py` roda as duas sobre os mesmos documentos.
 */
var FPG_DADOS = (function () {
  'use strict';

  var SEP = ' › ';
  var ABAS = ['receitas', 'despesas'];
  var PREFIXOS_RECEITA = ['10.1.1.', '10.2.1.', '10.4.1.'];
  var GRUPO_PENDENTES = 'Pendentes — fora do cadastro';
  var COD = /^10\.\d+(\.\d+)*$/;
  /* 6 dígitos EXATOS: a ponte compara texto, e "1875" não casa com o "001875" que a API
   * devolve — a natureza viraria pendente sem motivo aparente. */
  var BIMER = /^\d{6}$/;

  function texto(v) {
    return String(v === null || v === undefined ? '' : v).trim();
  }

  /* Lista de códigos do Bimer a partir do que se digita: "000150, 001875". */
  function lerBimer(s) {
    return String(s || '').split(/[,;\s]+/).map(texto).filter(Boolean);
  }

  function normalizar(doc) {
    doc = doc || {};
    if (doc.naturezas !== undefined && doc.naturezas !== null && !Array.isArray(doc.naturezas)) {
      throw new Error('o cadastro está com formato inválido: `naturezas` não é uma lista');
    }
    var resumo = doc.resumo || {};
    // cópia funda do `exceto`: com Object.assign a lista seria a MESMA do documento de
    // origem, e editar a linha na tela mexeria no que foi carregado
    var linha = function (l) {
      var ref = Object.assign({}, l.ref);
      if (Array.isArray(ref.exceto)) ref.exceto = ref.exceto.slice();
      return { rotulo: l.rotulo, ref: ref };
    };
    return Object.assign({}, doc, {
      versao: doc.versao || 1,
      naturezas: (doc.naturezas || []).map(function (n) {
        return Object.assign({}, n, {
          cod: n.cod === undefined ? '' : n.cod, nome: n.nome === undefined ? '' : n.nome,
          bimer: Array.isArray(n.bimer) ? n.bimer.slice() : (n.bimer ? [n.bimer] : []),
          path: Array.isArray(n.path) ? n.path.slice() : (n.path === undefined ? [] : n.path)
        });
      }),
      resumo: {
        receitas: (resumo.receitas || []).map(linha),
        despesas: (resumo.despesas || []).map(linha)
      }
    });
  }

  function porOrdem(nats) {
    return nats.slice().sort(function (a, b) { return (a.ordem || 0) - (b.ordem || 0); });
  }

  function caminho(path) { return (path || []).join(SEP); }

  function lerCaminho(s) {
    return String(s || '').split(/[>›]/).map(texto).filter(Boolean);
  }

  function caminhos(nats) {
    var vistos = {}, saida = [];
    porOrdem(nats).forEach(function (n) {
      var k = caminho(n.path);
      if (Array.isArray(n.path) && n.path.length && !vistos[k]) { vistos[k] = true; saida.push(n.path.slice()); }
    });
    return saida;
  }

  function raizes(nats) {
    var r = {};
    porOrdem(nats).forEach(function (n) {
      if (ABAS.indexOf(n.aba) >= 0 && Array.isArray(n.path) && n.path.length && !r[n.aba]) {
        r[n.aba] = texto(n.path[0]);
      }
    });
    return r;
  }

  function abaDoCaminho(nats, path) {
    var r = raizes(nats), raiz = texto((path || [])[0]);
    for (var i = 0; i < ABAS.length; i++) if (r[ABAS[i]] === raiz) return ABAS[i];
    return null;
  }

  function abaDoCodigo(cod) {
    var c = texto(cod);
    for (var i = 0; i < PREFIXOS_RECEITA.length; i++) if (c.indexOf(PREFIXOS_RECEITA[i]) === 0) return 'receitas';
    return 'despesas';
  }

  function foraDoBloco(n) {
    return ABAS.indexOf(n.aba) >= 0 && texto(n.cod) !== '' && abaDoCodigo(n.cod) !== n.aba;
  }

  /* Grupos (nomes) de uma aba — os que as linhas do Resumo podem referenciar. */
  function gruposDaAba(nats, aba) {
    var g = {}, saida = [];
    porOrdem(nats).forEach(function (n) {
      if (n.aba !== aba || !Array.isArray(n.path)) return;
      n.path.forEach(function (p) { var t = texto(p); if (t && !g[t]) { g[t] = true; saida.push(t); } });
    });
    return saida;
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
      if (typeof n.cod !== 'string' || !COD.test(n.cod.trim())) {
        erros.push({ onde: rot, erro: 'código fora do formato 11.x.x.xx.xx' });
      }
      if (typeof n.nome !== 'string' || !n.nome.trim()) erros.push({ onde: rot, erro: 'nome vazio' });
      if (!Array.isArray(n.bimer) || !n.bimer.length) {
        erros.push({ onde: rot, erro: 'sem código do Bimer' });
      } else if (!n.bimer.every(function (b) { return typeof b === 'string' && BIMER.test(b.trim()); })) {
        erros.push({ onde: rot, erro: 'código do Bimer precisa ter 6 dígitos, com os zeros (ex.: 001875)' });
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
    // um código pertence a UMA linha: é por ele que o lançamento acha o grupo
    repetidos(erros, 'código', obj.map(function (n) { return texto(n.cod); }));
    repetidos(erros, 'código do Bimer', [].concat.apply([], obj.map(function (n) {
      return Array.isArray(n.bimer) ? n.bimer.map(texto) : [];
    })));
    repetidos(erros, 'ordem', obj.map(function (n) { return n.ordem; }));
    Object.keys(raiz).forEach(function (aba) {
      var rs = Object.keys(raiz[aba]);
      if (rs.length > 1) {
        erros.push({ onde: 'aba ' + aba, erro: 'mais de um grupo raiz: ' + rs.sort().join(', ') +
                     ' (toda natureza da aba começa pelo mesmo total)' });
      }
    });

    // linhas do Resumo: cada uma aponta para natureza ou grupo QUE EXISTE na aba; o
    // `exceto` de um grupo só tira naturezas de DENTRO dele, e nunca todas
    var resumo = doc.resumo || {};
    ABAS.forEach(function (aba) {
      var cods = {}, grupos = {};
      obj.forEach(function (n) {
        if (n.aba !== aba) return;
        cods[texto(n.cod)] = true;
        (Array.isArray(n.path) ? n.path : []).forEach(function (p) {
          var g = texto(p);
          (grupos[g] = grupos[g] || {})[texto(n.cod)] = true;
        });
      });
      (resumo[aba] || []).forEach(function (l, i) {
        var rot = 'linha ' + (i + 1) + ' do Resumo (' + aba + ')';
        if (!l || typeof l.rotulo !== 'string' || !l.rotulo.trim()) { erros.push({ onde: rot, erro: 'sem rótulo' }); return; }
        rot += ' «' + l.rotulo + '»';
        var ref = l.ref || {};
        if ('cod' in ref) {
          if (!cods[texto(ref.cod)]) erros.push({ onde: rot, erro: 'a natureza ' + ref.cod + ' não está na aba ' + aba });
          if ('exceto' in ref) erros.push({ onde: rot, erro: '«exceto» só vale para grupo, não para natureza' });
        } else if ('grupo' in ref) {
          var dentro = grupos[texto(ref.grupo)];
          if (!dentro) {
            erros.push({ onde: rot, erro: 'o grupo «' + ref.grupo + '» não existe mais na aba ' + aba });
          } else if ('exceto' in ref) {
            var exc = ref.exceto;
            if (!Array.isArray(exc) || !exc.every(function (c) { return typeof c === 'string'; })) {
              erros.push({ onde: rot, erro: '«exceto» precisa ser uma lista de códigos' });
            } else {
              var fora = exc.filter(function (c) { return !dentro[c]; });
              if (fora.length) {
                erros.push({ onde: rot, erro: 'tira ' + fora.join(', ') + ', que não está no grupo «' + ref.grupo + '»' });
              } else if (!Object.keys(dentro).some(function (c) { return exc.indexOf(c) < 0; })) {
                erros.push({ onde: rot, erro: 'tira todas as naturezas do grupo' });
              }
            }
          }
        } else {
          erros.push({ onde: rot, erro: 'não aponta para natureza nem grupo' });
        }
      });
    });
    return erros;
  }

  /* ----------------------------------------------------------- pendentes */

  /* Lista que o extrator publicou (D.pendentes), menos o que já foi cadastrado AQUI depois
   * — senão quem classifica continuaria vendo a pendente até a próxima montagem. */
  function pendentesVivos(itens, nats) {
    var bim = {}, cod = {};
    nats.forEach(function (n) {
      (Array.isArray(n.bimer) ? n.bimer : []).forEach(function (b) { bim[texto(b)] = true; });
      cod[texto(n.cod)] = true;
    });
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
    normalizar: normalizar, lerBimer: lerBimer, porOrdem: porOrdem, caminho: caminho,
    lerCaminho: lerCaminho, caminhos: caminhos, raizes: raizes, abaDoCaminho: abaDoCaminho,
    foraDoBloco: foraDoBloco, gruposDaAba: gruposDaAba,
    problemas: problemas, pendentesVivos: pendentesVivos,
    ordemApos: ordemApos, renumerar: renumerar, ordemNoFimDoGrupo: ordemNoFimDoGrupo,
    vizinha: vizinha, mover: mover
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = FPG_DADOS;
