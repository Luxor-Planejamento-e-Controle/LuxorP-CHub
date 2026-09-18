/* Regra de decisão do Saldo Bancário — porte de analise_resgate.py para o navegador.
 *
 * Por que ela migrou para cá
 * --------------------------
 * O saldo de cada conta passou a ser digitado no próprio hub. Se a decisão continuasse
 * em Python, quem digita só veria o resgate sugerido na próxima execução da Function —
 * o que inviabiliza o "informe os saldos e veja o resultado".
 *
 * Não é duplicação: a regra SAIU do Python. O que roda no Azure agora entrega só os
 * fatos (títulos a pagar da semana, por conta); a decisão existe num lugar só, aqui.
 *
 * Um sinal que muda em relação ao Python
 * --------------------------------------
 * Lá, `restante = saldo + a_pagar + a_receber`, porque a planilha registrava saída como
 * NEGATIVO. Aqui `aPagar` chega positivo (fatos_logic já converte, para o painel exibir
 * como número positivo), então a conta é `saldo - aPagar + aReceber`. Trocar isso de
 * lugar sem trocar o sinal daria um restante inflado em duas vezes o valor a pagar.
 *
 * Sem dependência e sem DOM de propósito: assim roda igual no navegador e num teste.
 */
var SB_REGRA = (function () {
  'use strict';

  // Os valores anotados à mão pelo gestor são múltiplos de 5k (15k, 20k, 100k, 400k) —
  // sugerir 17.328,41 seria um número que ninguém digita no internet banking.
  var DEGRAU = 5000;

  /* Conta em descontinuação é a que tem colchão ZERO: não se mantém reserva numa conta
   * que vai fechar, mas ela também não pode ficar negativa. Colchão nulo é outra coisa —
   * conta fora da regra, para a qual o painel mostra o saldo e não sugere movimentação. */
  function descontinuada(conta) {
    return conta.colchao === 0;
  }

  function sugerir(conta, restante) {
    var colchao = conta.colchao;
    if (colchao === null || colchao === undefined) return { acao: null, valor: 0 };

    var diferenca = restante - colchao;
    if (diferenca < 0) {
      // para cima: arredondar para baixo deixaria a conta abaixo do colchão
      return { acao: 'resgate', valor: Math.ceil(-diferenca / DEGRAU) * DEGRAU };
    }
    if (descontinuada(conta)) {
      // sobra em conta que vai fechar não vira aplicação: seria pedir ao gestor uma
      // movimentação numa conta que ele está esvaziando
      return { acao: null, valor: 0 };
    }
    // para baixo: aplicar mais que o excedente invadiria o colchão.
    // excedente menor que um degrau resulta em 0 e não gera sugestão.
    var valor = Math.floor(diferenca / DEGRAU) * DEGRAU;
    return valor > 0 ? { acao: 'Aplicar', valor: valor } : { acao: null, valor: 0 };
  }

  /* "130k" — mesmo formato das anotações manuais, que o gestor já lê. */
  function rotuloValor(valor) {
    if (valor <= 0) return '';
    if (valor % 1000 === 0) return Math.floor(valor / 1000) + 'k';
    return valor.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  }

  function bancoDe(nomeConta) {
    var n = (nomeConta || '').toUpperCase();
    if (n.indexOf('ITA') >= 0) return 'ITAU';
    if (n.indexOf('BTG') >= 0) return 'BTG';
    if (n.indexOf('SICREDI') >= 0) return 'SICREDI';
    return '';
  }

  /* Investimento de onde sai/entra o dinheiro dessa conta corrente.
   *
   * No BTG o par é o Tesouro Selic, não o primeiro investimento da lista: sem isso a
   * Luxor Participação BTG cairia no Fundo Manga, que fica listado logo acima.
   *
   * `banco` explícito tem precedência sobre adivinhar pelo nome. Na planilha a conta se
   * chamava "Luxor Investimentos - Itaú" e dava para extrair o banco do texto; no
   * cadastro do hub a chave é "LUXOR INVESTIMENTOS" e o banco é coluna própria. Sem
   * esse parâmetro, bancoDe() devolvia '' e NENHUM par era encontrado — o painel
   * sugeria "resgatar 25k" sem dizer de onde, que é a informação que falta para agir. */
  function investimentoPar(nomeConta, investimentos, banco) {
    var b = banco || bancoDe(nomeConta);
    if (!b) return null;
    var procurado = b === 'BTG' ? 'TESOURO SELIC' : 'CDB';
    for (var i = 0; i < (investimentos || []).length; i++) {
      var inv = investimentos[i];
      var bancoInv = inv.banco || bancoDe(inv.nome);
      if (bancoInv === b && (inv.nome || '').toUpperCase().indexOf(procurado) >= 0) {
        return inv;
      }
    }
    return null;
  }

  /* contas = [{chave, conta, saldo, aPagar, aReceber, colchao, investimentos}]
   * Devolve a mesma lista com restante, ação, valor e o investimento par. */
  function analisar(contas) {
    return (contas || []).map(function (c) {
      var restante = (c.saldo || 0) - (c.aPagar || 0) + (c.aReceber || 0);
      var s = sugerir(c, restante);
      var par = investimentoPar(c.conta, c.investimentos, c.banco);
      return Object.assign({}, c, {
        restante: restante,
        acao: s.acao,
        valor: s.valor,
        valor_rotulo: s.acao ? rotuloValor(s.valor) : '',
        descontinuada: descontinuada(c),
        par_nome: par ? par.nome : null,
        par_saldo: par ? par.saldo : null
      });
    });
  }

  return {
    DEGRAU: DEGRAU,
    sugerir: sugerir,
    rotuloValor: rotuloValor,
    bancoDe: bancoDe,
    investimentoPar: investimentoPar,
    analisar: analisar
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SB_REGRA;
