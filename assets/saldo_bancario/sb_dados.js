/* Monta o estado do painel de Saldo Bancário a partir das três origens.
 *
 *   fatos     títulos a pagar da semana, por conta   -> bucket (Azure publica semanalmente)
 *   contas    cadastro das contas e seus colchões    -> app_state, doc 'saldo_bancario'
 *   entradas  saldo e a receber digitados da semana  -> app_state, mesmo documento
 *
 * `montar` é PURA: recebe os três e devolve o estado. Nada de rede aqui — é o que
 * permite testar o painel inteiro com dados falsos, e o que mantém a origem (Supabase,
 * bucket, mock) trocável sem tocar na lógica.
 *
 * A decisão de resgate/aplicação vem de SB_REGRA (sb_regra.js), que é o porte verificado
 * de analise_resgate.py — ver test_sb_regra_equivale_ao_python.py.
 *
 *
 * O CADASTRO ESPELHA A PLANILHA, e isso não é detalhe
 * ---------------------------------------------------
 * Cada conta corrente é dona dos SEUS investimentos:
 *
 *   { chave, conta, banco, colchao, ativa,
 *     investimentos: [ {nome, tipo} ] }
 *
 * A primeira versão deste arquivo achatou isso: uma aplicação por banco, compartilhada
 * por todas as contas daquele banco. O painel ficou visivelmente mais pobre que o
 * original — sete linhas em vez de dez, "CDB ITAU" no lugar de "Luxor Investimentos -
 * Itau CDB-DI" — e o "Total aplicado" passou a somar o mesmo dinheiro uma vez por conta.
 * Com o modelo certo nada disso existe: cada aplicação pertence a uma conta e é contada
 * uma vez, e o painel original volta a funcionar sem remendo.
 *
 * `tipo` do investimento distingue o que é destino de resgate do que é só informação:
 *   'aplicacao'  entra no Total aplicado e pode ser o par de resgate/aplicação
 *   'conta'      outra conta corrente pendurada ali (o "FPG - Sicredi"), que o painel
 *                mostra marcada como "conta, não aplicação" e não trata como destino
 */
var SB_DADOS = (function () {
  'use strict';

  /* Quarta-feira da semana de `hoje`. A projeção sempre foi de quarta a quarta, e é
   * essa data que identifica a semana nas entradas digitadas. */
  function quartaDaSemana(hoje) {
    var d = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate());
    var diff = (d.getDay() - 3 + 7) % 7;   // 3 = quarta
    d.setDate(d.getDate() - diff);
    return d;
  }

  function iso(d) {
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }

  function num(v) {
    return v === undefined || v === null || v === '' ? null : Number(v);
  }

  /* Estado do painel.
   *
   * `faltando` é o que decide a tela: enquanto houver conta corrente sem saldo
   * digitado nesta semana, o painel mostra o FORMULÁRIO em vez dos números. Mostrar a
   * projeção com metade das contas zeradas seria pior que não mostrar: ela pareceria
   * completa e diria que sobra dinheiro onde ninguém informou nada. */
  /* Identidade de um título do Bimer, para um ajuste manual grudar na linha certa entre
   * uma execução do ETL e a seguinte.
   *
   * Por que tantos campos: medido nos dados reais, nem (conta, título) nem
   * (conta, título, fornecedor) é único — duas parcelas de luz dividem o número do
   * título, e há duas linhas iguais em tudo menos o valor. Sem emissão e valor na chave,
   * o ajuste de uma cairia na outra.
   *
   * Incluir o VALOR é de propósito: se o Bimer corrigir o valor, a chave muda e o ajuste
   * deixa de valer. É o comportamento certo — o ajuste existia porque o número estava
   * errado; corrigido na origem, ele não tem mais razão de ser.
   *
   * `ord` separa linhas idênticas em tudo. Qual delas recebe o ajuste é arbitrário, e
   * tudo bem: sendo idênticas, o resultado na tela é o mesmo. */
  function chaveTitulo(t, ord) {
    return [t.conta, t.titulo, t.fornecedor, t.emissao, t.vencimento, t.valor, ord || 0]
      .join('|');
  }

  /* Aplica os ajustes manuais sobre os títulos que vieram da API.
   *
   * Devolve a lista já ajustada, SEM os removidos. Quem chama não precisa saber se houve
   * ajuste — é a mesma lista de antes, com outros números. */
  function aplicarAjustes(titulos, ajustes) {
    var porRef = {};
    (ajustes || []).forEach(function (a) { if (a && a.ref) porRef[a.ref] = a; });

    /* O `ref` é anexado SEMPRE, com ou sem ajuste, e calculado sobre o título como veio
     * da API. Calculá-lo depois, a partir do título já ajustado, daria outra chave — o
     * valor entra na chave —, e a tela gravaria o próximo ajuste numa referência que não
     * existe. O primeiro ajuste funcionaria e o segundo não, que é o tipo de defeito que
     * só aparece na segunda vez que alguém usa. */
    var vistos = {};
    var out = [];
    (titulos || []).forEach(function (t) {
      var base = chaveTitulo(t, 0);
      var ord = vistos[base] || 0;
      vistos[base] = ord + 1;
      var ref = chaveTitulo(t, ord);

      /* O título COMO VEIO DO ETL viaja junto, em `bruto`.
       *
       * É o que permite a tela derivar a lista de ajustes comparando cada linha com o
       * original, em vez de com a foto de quando a edição abriu. A foto já traz os
       * ajustes aplicados, então um título ajustado numa sessão ANTERIOR e não tocado
       * nesta aparecia como "não mudou" e ficava de fora da lista — e como a gravação
       * substitui a lista inteira, o ajuste de antes era apagado. Quem gravava mexendo
       * numa conta desfazia o ajuste de outra, sem aviso. */
      var bruto = { valor: t.valor, vencimento: t.vencimento, conta: t.conta };

      var a = porRef[ref];
      if (!a) { out.push(Object.assign({}, t, { ref: ref, bruto: bruto })); return; }

      /* Removido CONTINUA NA LISTA, marcado — não é descartado aqui.
       *
       * Descartar tornava a remoção irreversível: a linha não chegava a `D.titulos`, e
       * como o editor lê de lá, o botão "Trazer de volta" nunca voltava a ser desenhado.
       * Desfazer virava editar o app_state à mão ou esperar a quarta.
       *
       * Quem tira da conta é quem soma — `montar` e o fluxo filtram por `removido`. Aqui
       * a lista é só a verdade sobre o que existe na semana. */
      if (a.removido) {
        out.push(Object.assign({}, t, { ref: ref, bruto: bruto,
                                        removido: true, ajustado: true }));
        return;
      }

      var novo = Object.assign({}, t, { ajustado: true, ref: ref, bruto: bruto });
      if (a.valor !== undefined && a.valor !== null) novo.valor = Number(a.valor);
      if (a.vencimento) novo.vencimento = a.vencimento;
      if (a.chave) novo.conta = a.chave;           // passa a sair de outra conta
      out.push(novo);
    });
    return out;
  }

  function montar(fatos, contas, entradas, hoje, provisoes, ajustes) {
    /* Mesma âncora do sb_fonte: a semana é a da janela publicada. O relógio só entra
     * quando não há fatos — e aí não existe projeção para divergir dele. */
    var semana = (fatos && fatos.meta && fatos.meta.janela_inicio)
      || iso(quartaDaSemana(hoje || new Date()));

    /* Provisões: saídas da semana que ainda não estão no Bimer. Somam ao `aPagar` da
     * conta porque é o que elas são — dinheiro que sai. Na planilha eram linhas da Base
     * CAP com título vazio, e entravam no mesmo total; manter isso é o que faz a coluna
     * "Saídas da semana" continuar querendo dizer a mesma coisa que antes. */
    var provPorConta = {};
    (provisoes || []).forEach(function (pr) {
      var v = Number(pr.valor) || 0;
      provPorConta[pr.chave] = (provPorConta[pr.chave] || 0) + v;
    });

    // As entradas são indexadas por `chave`: a chave da conta, ou o NOME do investimento
    // (únicos no cadastro). Um índice só mantém a gravação simples — uma lista de valores
    // digitados, sem duas formas de endereçar a mesma coisa.
    var digitado = {};
    (entradas || []).forEach(function (e) { digitado[e.chave] = e; });

    var ativas = (contas || []).filter(function (c) { return c.ativa !== false; });

    /* Títulos da API com os ajustes manuais já aplicados. Tudo daqui para baixo enxerga
     * só a lista ajustada — não há um caminho "com ajuste" e outro "sem". */
    var titulosAjustados = aplicarAjustes((fatos && fatos.titulos) || [], ajustes);

    /* O total por conta é RECALCULADO a partir dos títulos, e não lido do
     * `a_pagar_por_conta` que o ETL publica.
     *
     * Os dois dão o mesmo número quando não há ajuste — o ETL gera os dois da mesma
     * lista, e há teste exigindo que fechem. Mas um título ajustado ou removido muda a
     * soma, e o agregado do arquivo continuaria com o valor de antes. Seria a pior
     * divergência possível: a tabela mostrando um valor e o detalhe atrás dela mostrando
     * outro, sem erro nenhum. */
    var aPagar = {};
    titulosAjustados.forEach(function (t) {
      if (t.removido) return;        // está na lista para poder ser desfeito, não na conta
      aPagar[t.conta] = (aPagar[t.conta] || 0) + Math.abs(Number(t.valor) || 0);
    });
    /* Arredonda no FIM, como o ETL faz (`round(soma, 2)` em fatos_logic). Somar sem isso
     * deixava o total com o ruído de ponto flutuante que o ETL não tem, e criava uma
     * diferença de centavos entre dois números que a tela apresenta como o mesmo. */
    Object.keys(aPagar).forEach(function (k) {
      aPagar[k] = Math.round(aPagar[k] * 100) / 100;
    });

    var linhas = ativas.map(function (c) {
      var e = digitado[c.chave] || {};
      return {
        chave: c.chave,
        // já existe linha digitada para esta semana? decide se o formulário pré-preenche
        // com o valor fixo ou respeita o que foi informado, inclusive vazio
        semanaInformada: Object.prototype.hasOwnProperty.call(digitado, c.chave),
        conta: c.conta || c.nome || c.chave,
        nome: c.conta || c.nome || c.chave,
        banco: c.banco || SB_REGRA.bancoDe(c.conta || c.chave),
        colchao: (c.colchao === undefined ? null : c.colchao),
        saldo: num(e.saldo),
        aReceber: num(e.a_receber) || 0,
        /* Entrada recorrente do cadastro. NÃO entra na conta do restante — serve só
         * para o formulário já vir preenchido. A projeção usa o que foi digitado.
         *
         * A diferença importa: se a pessoa limpar o campo numa semana em que a entrada
         * não vai acontecer, o vazio tem de valer. Se o valor fixo alimentasse `montar`,
         * ele voltaria sozinho e a projeção contaria dinheiro que ninguém espera. */
        aReceberFixo: num(c.a_receber_fixo),
        aPagar: Number(aPagar[c.chave] || 0) + (provPorConta[c.chave] || 0),
        // separado para a tela poder dizer quanto do total é provisão, e não só o soma
        provisao: provPorConta[c.chave] || 0,
        digitadoPor: e.por || e.atualizado_por || null,
        digitadoEm: e.em || e.atualizado_em || null,
        investimentos: (c.investimentos || []).map(function (i) {
          var ei = digitado[i.nome] || {};
          return {
            nome: i.nome,
            tipo: i.tipo || 'aplicacao',
            banco: i.banco || SB_REGRA.bancoDe(i.nome),
            saldo: num(ei.saldo),
            data: (ei.em || ei.atualizado_em || '').slice(0, 10) || null
          };
        })
      };
    });

    /* Só o saldo das CONTAS trava a tela. O do investimento é opcional: sem ele a
     * projeção continua correta (investimento não entra na conta do restante), só falta
     * o contexto de quanto há disponível para resgatar. Exigir os dois deixaria a
     * projeção da semana refém de um número que muda pouco. */
    var faltando = linhas.filter(function (l) { return l.saldo === null; })
      .map(function (l) { return l.chave; });

    // Só analisa o que tem saldo: conta sem saldo entraria na conta como zero e
    // produziria uma sugestão de resgate inventada.
    var analisadas = SB_REGRA.analisar(linhas.filter(function (l) { return l.saldo !== null; }));
    var porChaveAnalise = {};
    analisadas.forEach(function (a) { porChaveAnalise[a.chave] = a; });

    return {
      semana: semana,
      janela: fatos && fatos.meta ? [fatos.meta.janela_inicio, fatos.meta.janela_fim] : null,
      fatosGeradosEm: fatos && fatos.meta ? fatos.meta.gerado_em : null,
      faltando: faltando,
      /* Sem o arquivo do bucket, `a_pagar_por_conta` vem vazio e TODA conta fica com
       * saída zero. A projeção continua fechando as contas e parece completa — só que
       * otimista pelo valor inteiro da semana. É a pior forma de errar, então a tela
       * precisa poder dizer que o ETL ainda não publicou. */
      temFatos: !!(fatos && fatos.meta && fatos.meta.janela_inicio),
      /* Saldo digitado não basta: sem os fatos não há semana, e a projeção seria a
       * soma das entradas contra saída nenhuma. Por isso `temFatos` entra aqui e não
       * só no aviso — é o que decide se existe painel a montar. */
      completo: faltando.length === 0 && linhas.length > 0
                && !!(fatos && fatos.meta && fatos.meta.janela_inicio),
      contas: linhas.map(function (l) { return porChaveAnalise[l.chave] || l; }),
      // já ajustados e sem os removidos — ver aplicarAjustes
      titulos: titulosAjustados,
      provisoes: (provisoes || []).map(function (pr) {
        return {
          chave: pr.chave, descricao: pr.descricao || '',
          valor: num(pr.valor), vencimento: pr.vencimento || null
        };
      }),
      totais: totais(analisadas),
      /* "de quando é esse saldo": a digitação mais recente da semana. O painel mostra
       * isso no cabeçalho, e é a informação que diz se a projeção está olhando para a
       * posição de hoje ou para uma que ficou para trás. */
      dataSaldo: (entradas || []).reduce(function (maior, e) {
        var q = e.em || e.atualizado_em || null;
        return q && (!maior || q > maior) ? q : maior;
      }, null)
    };
  }

  function totais(contas) {
    var t = { saldo: 0, aPagar: 0, aReceber: 0, restante: 0, resgate: 0, aplicar: 0 };
    (contas || []).forEach(function (c) {
      t.saldo += c.saldo || 0;
      t.aPagar += c.aPagar || 0;
      t.aReceber += c.aReceber || 0;
      t.restante += c.restante || 0;
      if (c.acao === 'resgate') t.resgate += c.valor || 0;
      if (c.acao === 'Aplicar') t.aplicar += c.valor || 0;
    });
    return t;
  }

  /* O painel formata datas como 'AAAA-MM-DD' e 'AAAA-MM-DDTHH:MM'. O ETL publica
   * `gerado_em` já em pt-BR ('11/09/2026 11:47'), que é o que vai no e-mail do time.
   * Traduzir aqui é mais barato do que mudar o publicador e reprocessar o que já saiu. */
  function paraIso(txt) {
    if (!txt) return null;
    var m = /^(\d{2})\/(\d{2})\/(\d{4})[ T](\d{2}:\d{2})/.exec(String(txt));
    if (m) return m[3] + '-' + m[2] + '-' + m[1] + 'T' + m[4];
    return String(txt).slice(0, 16);
  }

  /* Converte o estado para o formato que o painel consome (window.SB_DATA).
   *
   * O painel foi construído e validado sobre a saída do `extrair_dados.py`, que lia a
   * planilha. Manter o mesmo contrato é o que permite reaproveitá-lo INTEIRO — layout,
   * hierarquia de aplicações, cards de sugestão, filtros, as duas abas de detalhamento —
   * sem tocar numa linha do HTML original.
   *
   * Duas traduções de sinal acontecem aqui, e só aqui:
   *   a_pagar  a planilha registrava saída como negativo e o painel exibe
   *            "−R$ 14.033,78" contando com isso; o ETL publica positivo.
   *   titulos  mesmo motivo, e o fluxo dia a dia faz `acc += valor`: saída positiva
   *            faria o saldo crescer ao longo da semana. */
  function paraSbData(estado) {
    var publicado = paraIso(estado.fatosGeradosEm);
    return {
      gerado_em: publicado,
      janela: estado.janela,
      semana: estado.semana,
      /* Não há planilha por trás — a origem das saídas é o arquivo que o ETL semanal
       * publica no bucket do hub. O painel diz "Arquivo X, salvo em Y" e continua
       * verdadeiro: é um arquivo, só que no Storage e não no disco de alguém. */
      arquivo: 'saldo_bancario.json',
      atualizado_em: publicado,
      data_saldo: estado.dataSaldo ? String(estado.dataSaldo).slice(0, 10) : null,
      somente_leitura: true,
      contas: (estado.contas || []).map(function (c) {
        return {
          chave: c.chave,
          conta: c.conta,
          saldo: c.saldo,
          data: c.digitadoEm ? String(c.digitadoEm).slice(0, 10) : null,
          investimentos: (c.investimentos || []).map(function (i) {
            return { nome: i.nome, saldo: i.saldo, data: i.data, tipo: i.tipo };
          }),
          a_pagar: -(c.aPagar || 0),
          a_receber: c.aReceber || 0,
          restante: c.restante,
          colchao: c.colchao,
          acao: c.acao,
          valor: c.valor,
          valor_rotulo: c.valor_rotulo,
          par_nome: c.par_nome,
          par_saldo: c.par_saldo,
          descontinuada: c.descontinuada
        };
      }),

      /* O ETL publica `conta` e valor positivo; o painel identifica por `chave` e soma o
       * valor direto. Sem esta tradução a aba de títulos filtra e não acha nada — o
       * cabeçalho diz "170 títulos" e a tabela diz "Nenhum". */
      /* Títulos do Bimer e provisões entram na MESMA lista, como na planilha: lá as
       * provisões eram linhas da Base CAP com título vazio, e apareciam na coluna
       * "Saídas da semana" junto com o resto.
       *
       * `provisao` distingue a origem, e as duas são editáveis por caminhos diferentes:
       * a provisão é gravada inteira, o título do Bimer vira um AJUSTE guardado à parte
       * (`ref` é o que liga o ajuste à linha). Editar o título direto seria perdido na
       * próxima execução do ETL; guardar o ajuste, não — ele é reaplicado sobre o título
       * republicado, enquanto a semana for a mesma. */
      titulos: (estado.titulos || []).map(function (t, i) {
        return Object.assign({}, t, {
          chave: t.chave || t.conta,
          valor: -(Number(t.valor) || 0),
          provisao: false,
          ajustado: !!t.ajustado,
          // fora das somas e da projeção, mas presente para poder ser desfeito
          removido: !!t.removido,
          ref: t.ref,          // vem de aplicarAjustes, calculado sobre o dado cru
          bruto: t.bruto,      // o título como o ETL publicou — a base da comparação
          id: 't' + i
        });
      }).concat((estado.provisoes || []).map(function (pr, i) {
        return {
          id: 'p' + i,
          chave: pr.chave,
          conta: pr.chave,
          fornecedor: pr.descricao || '',
          titulo: '',                       // vazio: é a marca de provisão, como na planilha
          emissao: null,
          vencimento: pr.vencimento,
          valor: -(Number(pr.valor) || 0),
          provisao: true
        };
      })),

      /* As entradas previstas são digitadas por conta e sem data — o formulário pergunta
       * quanto, não quando. O fluxo precisa delas mesmo assim: `tabelaFluxo` exige que o
       * último dia feche com o "saldo restante" da tabela principal, e sem isto fecharia
       * menor exatamente pelo valor a receber.
       *
       * Ficam no ÚLTIMO dia da janela de propósito. Supor que o dinheiro entra cedo
       * esconderia um negativo no meio da semana — que é o que esta aba existe para
       * mostrar. */
      a_receber: (estado.contas || [])
        .filter(function (c) { return (c.aReceber || 0) > 0; })
        .map(function (c) {
          return {
            chave: c.chave, conta: c.conta, cliente: 'Entrada prevista',
            titulo: '', emissao: null,
            vencimento: estado.janela ? estado.janela[1] : null,
            valor: Number(c.aReceber) || 0
          };
        })
    };
  }

  return { montar: montar, quartaDaSemana: quartaDaSemana, iso: iso, totais: totais,
           paraSbData: paraSbData,
           // expostos para o teste: são a regra que decide onde um ajuste gruda
           chaveTitulo: chaveTitulo, aplicarAjustes: aplicarAjustes };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SB_DADOS;
