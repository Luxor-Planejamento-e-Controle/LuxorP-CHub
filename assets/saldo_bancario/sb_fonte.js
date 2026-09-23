/* De onde o painel de Saldo Bancário lê e onde ele grava.
 *
 * Usa só o que o hub já tem — nenhuma tabela nova, nenhum caminho de escrita novo:
 *
 *   fatos     bucket privado `hub-data`, arquivo `saldo_bancario.json`
 *             publicado semanalmente pelo ETL (títulos a pagar da semana, por conta).
 *             A policy de leitura é hub_can(split_part(name,'.',1)), então quem abre o
 *             painel já tem, pelo mesmo porteiro, direito de baixar o arquivo.
 *
 *   input     tabela `app_state`, id 'saldo_bancario' — a mesma tabela que o painel de
 *             Projetos usa, com policies por hub_can('saldo_bancario').
 *             Um documento jsonb com o cadastro das contas e as entradas por semana.
 *
 * O painel não sabe de nada disso: ele só chama carregar() e salvar(). É o mesmo
 * contrato que o teste com dados falsos usa, e é por isso que dá para provar a tela
 * inteira sem credencial (ver test_painel_com_dados_falsos.py no repo Automacoes).
 *
 * Forma do documento em app_state:
 *
 *   { "contas":    [ {chave, conta, banco, colchao, ativa, investimentos, a_receber_fixo} ],
 *     "entradas":  { "2026-09-09": [ {chave, saldo, a_receber, por, em} ] },
 *     "provisoes": { "2026-09-09": [ {chave, descricao, valor, vencimento, por, em} ] } }
 *
 * `provisoes` são as saídas que ainda NÃO estão no Bimer — na planilha eram linhas da
 * Base CAP com título vazio. Lista, e não campo da conta: são várias por conta, cada
 * uma com a sua data.
 *
 * As entradas são guardadas POR SEMANA (a quarta-feira de referência) porque conferir o
 * que foi projetado semana passada contra o que aconteceu é o uso natural desse dado —
 * sobrescrever perderia isso.
 */
window.SB_FONTE = (function () {
  'use strict';

  var DOC = 'saldo_bancario';
  var ARQUIVO = 'saldo_bancario.json';
  var BUCKET = 'hub-data';
  var _sb = null;

  function cliente() {
    if (_sb) return _sb;
    /* Dentro do iframe o hub já tem uma sessão no mesmo domínio; o client criado aqui a
     * reaproveita (mesmo storageKey), como faz o app de Projetos. Sem sessão, a RLS
     * recusa tudo — o painel mostra o erro em vez de uma tela vazia. */
    if (!window.supabase || !window.SUPABASE_URL) {
      throw new Error('supabase-js não carregou (veja config.js e ../vendor/supabase.min.js)');
    }
    _sb = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
    return _sb;
  }

  /* A semana é a do DADO PUBLICADO, não a do relógio de quem abre.
   *
   * O ETL roda na terça e publica a janela que começa na quarta. Pelo relógio, quem
   * abrisse na terça cairia na semana anterior: veria a projeção de 23/09 e digitaria os
   * saldos no compartimento de 16/09 — e na quarta eles sumiriam, sem erro nenhum.
   *
   * Amarrar à janela publicada também tira do caminho o fuso e o relógio errado da
   * máquina de quem usa. Sem fatos publicados ainda, cai no relógio: é o único palpite
   * disponível, e aí não há projeção para divergir dele. */
  var _semana = null;

  /* `updated_at` da linha no instante em que ESTA tela carregou. O UPDATE só casa se a
   * linha ainda estiver nessa versão — ver a guarda em gravar(). */
  var _versao = null;

  function semanaDe(fatos) {
    return (fatos && fatos.meta && fatos.meta.janela_inicio)
      || SB_DADOS.iso(SB_DADOS.quartaDaSemana(new Date()));
  }

  function semanaAtual() {
    return _semana || SB_DADOS.iso(SB_DADOS.quartaDaSemana(new Date()));
  }

  async function lerEstado(sb) {
    var r = await sb.from('app_state').select('data, updated_at').eq('id', DOC).maybeSingle();
    if (r.error) throw new Error('app_state: ' + r.error.message);
    return { doc: (r.data && r.data.data) || {}, versao: r.data && r.data.updated_at };
  }

  /* Gravação com guarda de concorrência, usada pelas duas telas que escrevem.
   *
   * `app_state` guarda o documento inteiro, então toda gravação daqui é read-modify-write
   * e "último a salvar ganha" apaga o do outro sem erro. A guarda casa a versão que a TELA
   * leu (`_versao`), e não a releitura feita dentro de cada função: a releitura já enxerga
   * a gravação alheia e faria a guarda passar sempre.
   *
   * O formulário de saldos e o editor de provisões escrevem compartimentos diferentes do
   * mesmo documento, então um bloqueia o outro. É o comportamento certo: os dois releem o
   * documento inteiro antes de montar o novo, e seguir com uma leitura velha apagaria o
   * compartimento do outro. */
  async function gravar(sb, novo, agora) {
    var r = await sb.from('app_state')
      .update({ data: novo, updated_at: agora })
      .eq('id', DOC)
      .eq('updated_at', _versao)
      .select('id, updated_at');
    if (r.error) throw new Error('não foi possível gravar: ' + r.error.message);
    if (!r.data || !r.data.length) {
      throw new Error('outra pessoa gravou enquanto esta tela estava aberta. ' +
                      'Nada foi sobrescrito — recarregue o painel e refaça a alteração.');
    }
    /* A versão vem da resposta: quem decide o valor gravado é o banco. */
    _versao = r.data[0].updated_at || agora;
  }

  async function carregar() {
    var sb = cliente();

    /* O download do bucket pode falhar legitimamente: o ETL semanal ainda não rodou
     * nesta semana. Isso NÃO é erro — o painel abre no formulário e mostra o a pagar
     * zerado, em vez de uma tela de erro que não diz o que fazer. */
    var fatos = null;
    try {
      var dl = await sb.storage.from(BUCKET).download(ARQUIVO);
      if (dl.data) fatos = JSON.parse(await dl.data.text());
    } catch (e) {
      console.warn('[saldo_bancario] fatos da semana ainda não publicados:', e.message);
    }

    var lido = await lerEstado(sb);
    var estado = lido.doc;
    _versao = lido.versao;     // gravar() recusa se a linha mudou desde esta leitura
    var semana = semanaDe(fatos);
    _semana = semana;          // salvar() grava na MESMA semana que a tela mostrou
    return {
      fatos: fatos,
      semana: semana,
      contas: estado.contas || [],
      entradas: (estado.entradas || {})[semana] || [],
      provisoes: (estado.provisoes || {})[semana] || [],
      ajustes: (estado.ajustes || {})[semana] || []
    };
  }

  async function salvar(linhas, provisoes) {
    var sb = cliente();
    var estado = (await lerEstado(sb)).doc;
    var semana = semanaAtual();

    /* Lê antes de gravar e mexe só na semana corrente: `app_state` guarda o documento
     * inteiro, então escrever só o que veio do formulário apagaria o cadastro das contas
     * e o histórico das outras semanas. */
    var entradas = estado.entradas || {};
    var email = (window.HUB && window.HUB.email) || null;
    var agora = new Date().toISOString();
    entradas[semana] = linhas.map(function (l) {
      return {
        chave: l.chave, semana: semana,
        saldo: l.saldo, a_receber: l.a_receber,
        por: email, em: agora
      };
    });

    /* As provisões vão numa lista separada, e não como campo da conta, porque são
     * MUITAS por conta e cada uma tem data própria — é o formato das linhas da Base CAP
     * da planilha, de onde elas vêm. Guardar como campo obrigaria a uma provisão só por
     * conta, que é menos do que o processo já faz hoje.
     *
     * `undefined` quer dizer "não mexi nas provisões" e preserva o que está gravado;
     * lista vazia quer dizer "apaguei todas". Sem essa distinção — e ela faltava aqui —
     * o formulário de saldos, que chama `salvar(linhas)` sem segundo argumento, APAGAVA
     * todas as provisões da semana. Corrigir um saldo levava junto o trabalho de
     * provisão de outra pessoa, sem nada na tela dizendo.
     *
     * A mesma distinção já estava escrita em `salvarProvisoes` para os ajustes. Ela
     * precisa valer nos dois lados: qualquer gravação que substitua uma lista inteira
     * tem de saber diferenciar "vazio" de "não informado". */
    var novo = Object.assign({}, estado, { entradas: entradas });
    if (provisoes !== undefined) {
      var provs = estado.provisoes || {};
      provs[semana] = (provisoes || []).map(function (p) {
        return {
          chave: p.chave, semana: semana,
          descricao: p.descricao || '',
          valor: p.valor, vencimento: p.vencimento,
          por: email, em: agora
        };
      });
      novo.provisoes = provs;
    }
    await gravar(sb, novo, agora);
  }

  /* Grava SÓ as provisões, preservando os saldos digitados.
   *
   * Separado de `salvar` porque as duas telas são independentes: o formulário de saldos
   * e o editor de provisões podem ser usados em momentos diferentes, e cada um só pode
   * escrever o que é dele. Uma função só, recebendo as duas listas, faria o editor
   * apagar os saldos toda vez que gravasse uma provisão. */
  /* Grava provisões e ajustes numa tacada.
   *
   * Juntos porque saem da MESMA tela: quem edita as saídas da semana mexe nas duas
   * coisas no mesmo formulário, e gravar em duas chamadas deixaria a guarda de
   * concorrência recusar a segunda — ela compara com a versão que a tela leu, e a
   * primeira gravação já teria mudado essa versão. Seria um erro de "outra pessoa
   * gravou" contra a própria pessoa.
   *
   * AJUSTES são por SEMANA, como as provisões: o ETL busca os títulos que vencem na
   * janela, então a lista muda toda quarta e um ajuste da semana passada não teria onde
   * se aplicar. Semana nova começa limpa. */
  async function salvarProvisoes(provisoes, ajustes) {
    var sb = cliente();
    var estado = (await lerEstado(sb)).doc;
    var semana = semanaAtual();
    var email = (window.HUB && window.HUB.email) || null;
    var agora = new Date().toISOString();

    var provs = estado.provisoes || {};
    provs[semana] = (provisoes || []).map(function (pr) {
      return {
        chave: pr.chave, semana: semana,
        descricao: pr.descricao || '',
        valor: pr.valor, vencimento: pr.vencimento,
        por: email, em: agora
      };
    });

    var novo = Object.assign({}, estado, { provisoes: provs });

    /* `undefined` quer dizer "não mexi nos ajustes" e preserva o que está gravado;
     * lista vazia quer dizer "apaguei todos". Tratar os dois como a mesma coisa faria
     * qualquer gravação de provisão apagar os ajustes da semana, sem aviso. */
    if (ajustes !== undefined) {
      var ajs = estado.ajustes || {};
      ajs[semana] = (ajustes || []).map(function (a) {
        var out = { ref: a.ref, semana: semana, por: email, em: agora };
        if (a.removido) { out.removido = true; return out; }
        if (a.valor !== undefined && a.valor !== null) out.valor = a.valor;
        if (a.vencimento) out.vencimento = a.vencimento;
        if (a.chave) out.chave = a.chave;
        return out;
      });
      novo.ajustes = ajs;
    }

    await gravar(sb, novo, agora);
    return provs[semana];
  }

  /* `cliente` sai daqui para quem mais precisar falar com o Supabase nesta página —
   * hoje o botão "Atualizar agora". Criar um segundo client faria dois GoTrueClient no
   * mesmo contexto, disputando o mesmo storage de sessão e o lock de renovação de token:
   * quando esse lock trava, o fetch falha ANTES de sair, e o supabase-js reporta
   * "Failed to send a request to the Edge Function" — erro de rede para um problema que
   * não é de rede. Um client por página. */
  return { carregar: carregar, salvar: salvar, salvarProvisoes: salvarProvisoes,
           cliente: cliente };
})();
