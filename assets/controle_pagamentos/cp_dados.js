/* Monta o estado do painel de Controle de Pagamentos a partir das duas origens.
 *
 *   resultado     meses já batidos          -> bucket (ETL publica)
 *   fornecedores  cadastro dos fixos        -> app_state (a tela de edição grava)
 *
 * `montar` é PURA: recebe os dois e devolve o estado. Nada de rede aqui — é o que
 * permite testar a tela inteira com dados falsos, e o que mantém a origem trocável sem
 * tocar na lógica.
 *
 * O BATIMENTO NÃO ESTÁ AQUI, de propósito: ele é `nucleo.bater()` em Python e roda no
 * ETL. Ver o cabeçalho de cp_fonte.js para o porquê.
 */
var CP_DADOS = (function () {
  'use strict';

  var MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago',
               'set', 'out', 'nov', 'dez'];

  var MESES_LONGOS = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
                      'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];

  function num(v) {
    if (v === null || v === undefined || v === '') return null;
    var n = Number(v);
    return isNaN(n) ? null : n;
  }

  /* Um registro do cadastro, com todo campo presente. Campo ausente vira o vazio certo
   * para o tipo — `meses` array, `ativo` true, texto string — para a tela nunca ter de
   * perguntar "isto é undefined ou é vazio de verdade?". */
  function normalizar(f, ano) {
    return {
      ano: f.ano || ano || new Date().getFullYear(),
      cod: String(f.cod === undefined || f.cod === null ? '' : f.cod).trim(),
      empresa: String(f.empresa || '').trim(),
      contagem: f.contagem || 1,
      fornecedor: String(f.fornecedor || '').trim(),
      valor_usual_txt: f.valor_usual_txt === undefined || f.valor_usual_txt === null
        ? '' : String(f.valor_usual_txt),
      valor_usual: num(f.valor_usual),
      venc_orig: f.venc_orig === undefined || f.venc_orig === null
        ? '' : String(f.venc_orig),
      obs: f.obs === undefined || f.obs === null ? '' : String(f.obs),
      reajuste: f.reajuste === undefined || f.reajuste === null ? '' : String(f.reajuste),
      meses: Array.isArray(f.meses) ? f.meses.slice() : [],
      ativo: f.ativo !== false,
      obs_interna: f.obs_interna === undefined || f.obs_interna === null
        ? '' : String(f.obs_interna),
      atualizado_em: f.atualizado_em || null,
      atualizado_por: f.atualizado_por || null
    };
  }

  function montar(resultado, fornecedores) {
    var publicadoEm = (resultado && resultado.gerado_em) || null;
    var lista = (fornecedores || []).map(function (f) { return normalizar(f); });

    /* Quantos registros foram editados DEPOIS da última publicação. É a resposta para
     * "editei o cadastro e o número não mudou": o batimento roda no ETL, então a edição
     * só chega ao painel na próxima execução. Sem esse aviso, a tela parece quebrada. */
    var pendentes = publicadoEm
      ? lista.filter(function (f) {
          return f.atualizado_em && f.atualizado_em > publicadoEm;
        }).length
      : 0;

    var anos = {};
    lista.forEach(function (f) { anos[f.ano] = true; });

    return {
      resultado: resultado,
      publicadoEm: publicadoEm,
      fornecedores: lista,
      anos: Object.keys(anos).map(Number).sort(),
      pendentes: pendentes,
      // sem resultado publicado não há painel para mostrar, só o cadastro
      temPainel: !!(resultado && resultado.meses && resultado.meses.length)
    };
  }

  /* O contrato que o painel consome (window.CP_DATA_API).
   *
   * O painel foi construído e validado sobre a saída do `extrair_dados_modelo_novo.py`.
   * Manter o mesmo contrato é o que permite reaproveitá-lo inteiro — filtros, ordenação,
   * cards, prazos — trocando só de onde vêm os números. Aqui é quase passagem direta,
   * porque o ETL publica exatamente essa forma. */
  function paraCpData(estado) {
    var r = estado.resultado;
    if (!r) return null;
    return {
      id: r.id || 'modelo_novo',
      rotulo: r.rotulo || 'Modelo novo',
      // no hub a origem é o arquivo do bucket, não uma pasta no disco de alguém
      fonte: 'controle_pagamentos.json',
      gerado_em: r.gerado_em || null,
      meses: r.meses || []
    };
  }

  /* Ordem de exibição do cadastro: empresa, fornecedor, ocorrência. É a ordem em que a
   * equipe confere — por empresa, porque o batimento é por empresa. */
  function ordenar(lista) {
    return lista.slice().sort(function (a, b) {
      return a.empresa.localeCompare(b.empresa, 'pt-BR')
        || a.fornecedor.localeCompare(b.fornecedor, 'pt-BR')
        || (a.contagem - b.contagem);
    });
  }

  /* Problemas que impedem o batimento de funcionar. Não é validação de formulário: é a
   * lista do que faria o ETL errar em silêncio, que é o modo de falha que a auditoria
   * encontrou. */
  function problemas(lista) {
    var out = [];
    var vistos = {};
    (lista || []).forEach(function (f, i) {
      var onde = f.fornecedor || f.empresa || ('linha ' + (i + 1));
      if (!f.cod) out.push({ onde: onde, erro: 'sem código' });
      if (!f.empresa) out.push({ onde: onde, erro: 'sem empresa' });
      if (!f.fornecedor) out.push({ onde: onde, erro: 'sem nome do fornecedor' });
      if (!f.meses.length && f.ativo) {
        out.push({ onde: onde, erro: 'ativo mas sem nenhum mês marcado' });
      }
      var k = [f.ano, f.cod, f.empresa, f.contagem].join('|');
      if (vistos[k]) {
        out.push({ onde: onde,
                   erro: 'chave repetida (ano+código+empresa+ocorrência) — o batimento ' +
                         'casa a N-ésima linha com o N-ésimo título e não saberia qual é qual' });
      }
      vistos[k] = true;
    });
    return out;
  }

  return { MESES: MESES, MESES_LONGOS: MESES_LONGOS,
           montar: montar, normalizar: normalizar, paraCpData: paraCpData,
           ordenar: ordenar, problemas: problemas };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = CP_DADOS;
