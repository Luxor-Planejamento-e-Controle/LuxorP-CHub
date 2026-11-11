/* As movimentações da semana — o que a gestão decidiu, ou a sugestão da regra quando
 * ninguém decidiu.
 *
 * Pedido da gestão (11/11/2026): os cards de movimentação têm de mostrar o que DE FATO
 * vai ser pedido ao banco, e não só o que a regra de colchão calcula. A regra continua
 * sendo o ponto de partida; a gestão ajusta, descarta ou inclui por cima dela.
 *
 * Onde a decisão mora: `app_state` id 'saldo_bancario', compartimento
 * `movimentacoes[semana] = { itens: [...], por, em }`.
 *
 *   compartimento AUSENTE  -> ninguém decidiu: valem as sugestões da regra
 *   `itens: []`            -> a gestão decidiu não movimentar nada nesta semana
 *
 * Sem essa distinção, "descartar todas as sugestões" não teria como ser gravado: a
 * próxima leitura as traria de volta.
 *
 * Cada item: { tipo, chave, contraparte, valor, obs }
 *   tipo         'resgate' | 'aplicar' | 'transferencia'
 *   chave        a conta corrente da movimentação (no transferir, a de ORIGEM)
 *   contraparte  resgate/aplicar: nome do investimento; transferir: chave da conta DESTINO
 *   valor        em reais, positivo
 *
 * A mensagem do Slack é montada no Azure por `shared_saldo_bancario/movimentacoes.py`,
 * que repete `daSugestao`/`normalizar`/`daSemana`/`rotulo`. A paridade é provada por
 * `test_movimentacoes_equivale_ao_js.py` (repo Automacoes): o Slack não pode anunciar
 * uma movimentação diferente da do card.
 *
 * Sem dependência e sem DOM de propósito: roda igual no navegador e no teste.
 */
var SB_MOV = (function () {
  'use strict';

  var TIPOS = ['resgate', 'aplicar', 'transferencia'];
  var VERBO = { resgate: 'Resgatar', aplicar: 'Aplicar', transferencia: 'Transferir' };

  /* Uma movimentação por conta com ação sugerida, na ordem das contas.
   * `contas` = saída de SB_REGRA.analisar / SB_DADOS (acao 'resgate' | 'Aplicar'). */
  function daSugestao(contas) {
    var out = [];
    (contas || []).forEach(function (c) {
      if (!c.acao) return;
      out.push({
        tipo: c.acao === 'resgate' ? 'resgate' : 'aplicar',
        chave: c.chave,
        contraparte: c.par_nome || '',
        valor: Number(c.valor) || 0,
        obs: ''
      });
    });
    return out;
  }

  /* O item como ele vale, ou null. Tipo desconhecido, sem conta ou sem valor é
   * descartado: a tela não deixa gravar assim, mas o documento pode ter sido mexido à
   * mão, e um card "Resgatar 0" seria pior que nenhum. */
  function normalizar(m) {
    if (!m || typeof m !== 'object') return null;
    var valor = Math.abs(Number(m.valor) || 0);
    if (TIPOS.indexOf(m.tipo) < 0 || !m.chave || !(valor > 0)) return null;
    return {
      tipo: m.tipo,
      chave: m.chave,
      contraparte: m.contraparte || '',
      valor: valor,
      obs: String(m.obs || '').trim()
    };
  }

  /* { itens, editado, por, em }. `decisao` = compartimento da semana, ou null/undefined. */
  function daSemana(contas, decisao) {
    if (!decisao || !Array.isArray(decisao.itens)) {
      return { itens: daSugestao(contas), editado: false, por: null, em: null };
    }
    return {
      itens: decisao.itens.map(normalizar).filter(Boolean),
      editado: true,
      por: decisao.por || null,
      em: decisao.em || null
    };
  }

  /* "130k" quando é milhar redondo — o idioma das anotações do gestor; senão o valor
   * inteiro em reais. NÃO é SB_REGRA.rotuloValor, que descarta os centavos: a sugestão
   * é sempre múltipla de 5k, mas o valor digitado pela gestão pode não ser, e "12.346"
   * para R$ 12.345,67 seria pedir ao banco o valor errado. */
  function rotulo(valor) {
    if (valor % 1000 === 0) return Math.floor(valor / 1000) + 'k';
    var partes = valor.toFixed(2).split('.');
    return 'R$ ' + partes[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ',' + partes[1];
  }

  /* Só a tela usa: marca cada item contra a sugestão da regra para a mesma conta e o
   * mesmo tipo, e lista as sugestões que a gestão deixou de fora. É o que deixa à vista
   * quando a decisão diverge da regra — sem isso, o card editado e o calculado seriam
   * indistinguíveis, e a tabela (que segue mostrando a sugestão) pareceria contradizê-lo.
   *
   * marca: 'sugerida' (igual à regra) | 'ajustada' (mesma conta e tipo, outro valor ou
   *        outro investimento) | 'incluida' (a regra não sugeriu isto) */
  function comparar(contas, itens) {
    var sug = daSugestao(contas);
    var usadas = {};
    var marcados = (itens || []).map(function (m) {
      var i = -1;
      for (var k = 0; k < sug.length; k++) {
        if (!usadas[k] && sug[k].chave === m.chave && sug[k].tipo === m.tipo) { i = k; break; }
      }
      if (i < 0) return Object.assign({}, m, { marca: 'incluida', sugerido: null });
      usadas[i] = true;
      var igual = sug[i].valor === m.valor && sug[i].contraparte === m.contraparte;
      return Object.assign({}, m, { marca: igual ? 'sugerida' : 'ajustada', sugerido: sug[i] });
    });
    return {
      itens: marcados,
      descartadas: sug.filter(function (s, k) { return !usadas[k]; })
    };
  }

  return {
    TIPOS: TIPOS,
    VERBO: VERBO,
    daSugestao: daSugestao,
    normalizar: normalizar,
    daSemana: daSemana,
    rotulo: rotulo,
    comparar: comparar
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SB_MOV;
