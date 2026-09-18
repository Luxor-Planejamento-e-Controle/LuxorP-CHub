/* De onde o painel de Controle de Pagamentos lê e onde ele grava.
 *
 * Usa só o que o hub já tem — nenhuma tabela nova, nenhum caminho de escrita novo:
 *
 *   resultado   bucket privado `hub-data`, arquivo `controle_pagamentos.json`,
 *               publicado pelo ETL semanal. Traz os meses JÁ BATIDOS: cada fornecedor
 *               fixo com o status (recebido / não recebido), os títulos do Bimer
 *               agregados e o que ficou fora de competência.
 *
 *   cadastro    tabela `app_state`, id 'controle_pagamentos' — a mesma tabela que o
 *               painel de Projetos usa, com policies por hub_can('controle_pagamentos').
 *               É o que a tela de edição grava.
 *
 *
 * POR QUE O BATIMENTO NÃO VEM PARA O NAVEGADOR
 * --------------------------------------------
 * A tentação seria publicar os títulos crus e casar com o cadastro aqui, como o Saldo
 * Bancário faz com a regra de resgate. Mas a regra do Saldo Bancário cabe em 50 linhas;
 * o batimento do CP é `nucleo.bater()` — normalização de texto, competência lida da Obs,
 * vencimento por dia útil contra tabela de feriados. Portar isso criaria uma segunda
 * implementação de uma regra que decide se um pagamento foi feito, e a auditoria já
 * mostrou o que acontece quando a mesma regra existe em dois lugares: 35 resultados
 * errados no ano.
 *
 * Então o ETL lê o cadastro daqui (service_role), bate em Python e publica o resultado.
 *
 * A CONSEQUÊNCIA, que precisa estar clara na tela: editar o cadastro NÃO recalcula o
 * mês na hora. A edição aparece na tela de cadastro imediatamente; os números do painel
 * mudam na próxima execução do ETL.
 *
 *
 * Forma do documento em app_state:
 *
 *   { "fornecedores": [
 *       { ano, cod, empresa, contagem, fornecedor,
 *         valor_usual_txt, valor_usual, venc_orig, obs, reajuste,
 *         meses: ["jan","fev",...], ativo, obs_interna,
 *         atualizado_em, atualizado_por }
 *     ] }
 *
 * (cod, empresa, contagem) é a chave do batimento: o mesmo fornecedor pode ter mais de
 * um título fixo no mês, e a N-ésima linha do cadastro casa com o N-ésimo título.
 */
window.CP_FONTE = (function () {
  'use strict';

  var DOC = 'controle_pagamentos';
  var ARQUIVO = 'controle_pagamentos.json';
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

  async function lerEstado(sb) {
    var r = await sb.from('app_state').select('data').eq('id', DOC).maybeSingle();
    if (r.error) throw new Error('app_state: ' + r.error.message);
    return (r.data && r.data.data) || {};
  }

  async function carregar() {
    var sb = cliente();

    /* O download do bucket pode falhar legitimamente: o ETL ainda não rodou. Isso NÃO é
     * erro — o painel abre na tela de cadastro, que funciona sem o resultado, em vez de
     * uma tela de erro que não diz o que fazer. */
    var resultado = null;
    try {
      var dl = await sb.storage.from(BUCKET).download(ARQUIVO);
      if (dl.data) resultado = JSON.parse(await dl.data.text());
    } catch (e) {
      console.warn('[controle_pagamentos] resultado ainda não publicado:', e.message);
    }

    var estado = await lerEstado(sb);
    return {
      resultado: resultado,
      fornecedores: estado.fornecedores || []
    };
  }

  /* Grava o cadastro inteiro. Lê antes de gravar porque `app_state` guarda o documento
   * completo: escrever só a lista de fornecedores apagaria qualquer outra chave que
   * venha a existir no documento. */
  async function salvarCadastro(fornecedores) {
    var sb = cliente();
    var estado = await lerEstado(sb);
    var email = (window.HUB && window.HUB.email) || null;
    var agora = new Date().toISOString();

    /* Carimba só o que MUDOU. Carimbar tudo a cada gravação tornaria
     * `atualizado_em` inútil — ele existe para responder "quem mexeu neste
     * fornecedor e quando", que é o que a planilha nunca soube dizer. */
    var antes = {};
    (estado.fornecedores || []).forEach(function (f) { antes[chaveDe(f)] = f; });

    var novos = fornecedores.map(function (f) {
      var velho = antes[chaveDe(f)];
      if (velho && iguais(velho, f)) return velho;
      return Object.assign({}, f, { atualizado_em: agora, atualizado_por: email });
    });

    var novo = Object.assign({}, estado, { fornecedores: novos });
    var r = await sb.from('app_state')
      .update({ data: novo, updated_at: agora })
      .eq('id', DOC);
    if (r.error) throw new Error('não foi possível gravar: ' + r.error.message);
    return novos;
  }

  function chaveDe(f) {
    return [f.ano, f.cod, f.empresa, f.contagem].join('');
  }

  /* Compara só os campos de conteúdo: `atualizado_em`/`atualizado_por` são consequência
   * da mudança, não parte dela — incluí-los faria todo registro parecer alterado. */
  var CAMPOS = ['fornecedor', 'valor_usual_txt', 'valor_usual', 'venc_orig', 'obs',
                'reajuste', 'meses', 'ativo', 'obs_interna'];

  function iguais(a, b) {
    return CAMPOS.every(function (c) {
      return JSON.stringify(a[c] === undefined ? null : a[c]) ===
             JSON.stringify(b[c] === undefined ? null : b[c]);
    });
  }

  return { carregar: carregar, salvarCadastro: salvarCadastro,
           chaveDe: chaveDe, iguais: iguais };
})();
