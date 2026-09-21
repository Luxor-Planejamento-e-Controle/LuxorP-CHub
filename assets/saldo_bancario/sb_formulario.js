/* Tela que pede os saldos antes de mostrar a projeção.
 *
 * Por que antes, e não dentro do painel: enquanto faltar o saldo de uma conta, a projeção
 * estaria incompleta — e uma projeção incompleta é pior que nenhuma, porque parece
 * completa. Ela diria que sobra dinheiro numa conta onde ninguém informou nada.
 *
 * O formulário é a MESMA TELA do painel, não uma tela de configuração à parte: usa a
 * `table.data` do painel, a mesma hierarquia `tr.inv` de conta → aplicação, o mesmo
 * `.banner` laranja e o mesmo `.btn-acao`. Quem digita aqui e clica em salvar vê a
 * tabela se preencher no lugar, com as mesmas linhas na mesma ordem — em vez de sair de
 * um formulário genérico e cair num painel que parece outro produto.
 *
 * Os CAMPOS, por outro lado, seguem o padrão de controle do hub (assets/theme.css):
 * altura --ctl-h, fundo --surface, raio --r-sm. Não o `table.data td input` do painel,
 * que é a variante compacta da edição inline e destoa do resto do hub numa tela que é
 * a principal. O CSS está no index.html, junto do resto.
 *
 * O valor é mascarado em real enquanto se digita — ver formatarMoeda().
 */
window.SB_FORM = (function () {
  'use strict';

  function brl(v) {
    if (v === null || v === undefined) return '—';
    return (v < 0 ? '−' : '') + 'R$ ' +
      Math.abs(v).toLocaleString('pt-BR', { minimumFractionDigits: 2,
                                            maximumFractionDigits: 2 });
  }

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function soDigitos(s) {
    return String(s === null || s === undefined ? '' : s).replace(/\D/g, '');
  }

  /* Máscara de real. Os dígitos entram pela DIREITA, como em caixa de banco:
   *   1 -> R$ 0,01     12 -> R$ 0,12     1234 -> R$ 12,34     123456 -> R$ 1.234,56
   *
   * É o comportamento que quem digita valor o dia inteiro já espera, e evita a briga de
   * cursor das máscaras que formatam no meio do texto: o cursor fica sempre no fim, e
   * Backspace apaga um dígito, não um separador. Como o campo já mostra o resultado
   * enquanto se digita, não há ambiguidade sobre onde ficaram os centavos. */
  function formatarMoeda(valor) {
    var d = soDigitos(valor).replace(/^0+(?=\d{3})/, '');
    if (!d) return '';
    while (d.length < 3) d = '0' + d;
    var reais = d.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    return 'R$ ' + reais + ',' + d.slice(-2);
  }

  /* O que volta para o campo quando alguém reabre para corrigir: já mascarado, idêntico
   * ao que a pessoa vai ver enquanto digita. */
  function paraCampo(v) {
    if (v === null || v === undefined || v === '') return '';
    return formatarMoeda(Math.round(Math.abs(Number(v)) * 100).toString());
  }

  /* Campo mascarado: o valor são os dígitos sobre 100. Vale também para texto colado —
   * "1.234,56", "1234.56" e "R$ 1.234,56" dão todos 1234.56, porque em qualquer um deles
   * os dígitos são os mesmos e os centavos são os dois últimos. */
  function numero(txt) {
    var d = soDigitos(txt);
    return d ? Number(d) / 100 : null;
  }

  /* `deConta` separa o saldo de uma CONTA do saldo de uma aplicação: só o primeiro é
   * obrigatório, e é ele que o contador de "faltam N" conta. */
  function campo(chave, tipoCampo, valor, placeholder, deConta) {
    var v = paraCampo(valor);
    // inputmode=numeric: no celular abre o teclado de dígitos, que é tudo que a máscara
    // aceita. `decimal` traria vírgula e ponto, que ela descarta.
    return '<input class="sbf' + (v ? ' ok' : '') + '" type="text" inputmode="numeric"' +
      ' autocomplete="off" data-campo="' + tipoCampo + '" data-chave="' + esc(chave) + '"' +
      (deConta ? ' data-conta="1"' : '') +
      ' value="' + v + '" placeholder="' + placeholder + '">';
  }


  /* Entrada prevista que vai no campo.
   *
   * Enquanto a semana não foi informada, vem do cadastro — é o caso da provisão fixa do
   * condomínio, que na planilha era uma linha parada na Base CAR e alguém só empurrava a
   * data toda quarta. Redigitar um valor que não muda é o trabalho manual que este painel
   * existe para tirar.
   *
   * Depois de informada, vale o que foi digitado — INCLUSIVE vazio. Numa semana em que a
   * entrada não vai acontecer, limpar o campo tem de significar zero; se o fixo voltasse
   * sozinho, a projeção contaria dinheiro que ninguém espera. */
  function entradaPrevista(c) {
    if (c.semanaInformada) return c.aReceber || null;
    return c.aReceber || c.aReceberFixo || null;
  }

  function usaFixo(c) {
    return !c.semanaInformada && !c.aReceber && !!c.aReceberFixo;
  }

  /* Uma conta e, logo abaixo, as aplicações dela — mesma marca `└` e mesmo recuo que a
   * tabela do painel usa. É o que faz as duas telas serem lidas como uma só. */
  function linhasDaConta(c) {
    var falta = c.saldo === null;
    var linha =
      '<tr class="conta-cc' + (falta ? ' falta-saldo' : '') + '">' +
        '<td><div class="forn">' + esc(c.conta) + '</div>' +
          '<div class="sub2">' + esc(c.chave) +
            (c.banco ? ' · ' + esc(c.banco) : '') + '</div></td>' +
        '<td class="num nowrap">' + (c.aPagar ? brl(-c.aPagar) : '—') + '</td>' +
        '<td>' + campo(c.chave, 'saldo', c.saldo, 'do extrato', true) + '</td>' +
        '<td>' + campo(c.chave, 'a_receber', entradaPrevista(c), '0,00') +
          (usaFixo(c) ? '<div class="sub2 fixo">do cadastro</div>' : '') + '</td>' +
      '</tr>';

    var invs = (c.investimentos || []).map(function (i) {
      var marca = i.tipo === 'aplicacao' ? 'aplicação' : 'conta, não aplicação';
      return '<tr class="inv">' +
        '<td><span class="marca">&#x2514;</span>' + esc(i.nome) +
          ' <span class="sub2" style="display:inline;margin:0">· ' + marca + '</span></td>' +
        '<td></td>' +
        '<td>' + campo(i.nome, 'saldo', i.saldo, 'do extrato') + '</td>' +
        '<td></td></tr>';
    }).join('');

    return linha + invs;
  }

  function html(estado) {
    if (!estado.contas.length) {
      return '<div class="card"><div class="empty">' +
        '<div class="big">&#x1F4CB;</div>' +
        '<div><b>Nenhuma conta cadastrada ainda.</b><br>' +
        'O painel lê o cadastro das contas e o colchão de cada uma de ' +
        '<code>app_state</code>, documento <code>saldo_bancario</code>.<br>' +
        'Peça a quem administra o Supabase do hub para rodar o seed — o formato está em ' +
        '<code>sql/seed_saldo_bancario.example.sql</code>.</div></div></div>';
    }

    var total = estado.contas.length;
    var faltam = estado.faltando.length;
    var prontas = total - faltam;

    /* Sem os fatos publicados, dizer "as saídas já vêm da API" seria falso: elas estão
     * ZERADAS, e a projeção fecharia as contas parecendo completa — otimista pelo valor
     * inteiro da semana. É a pior forma de errar, então a tela diz o que houve em vez
     * de deixar a pessoa confiar num número que não existe. */
    var aviso = !estado.temFatos
      ? '<b>As saídas da semana ainda não foram publicadas.</b> O robô busca os títulos ' +
        'no Bimer toda terça de manhã e publica; até lá, as saídas aparecem zeradas e a ' +
        'projeção fica <b>otimista</b> — não use para decidir resgate. Informar os ' +
        'saldos agora não tem problema: eles ficam guardados e a projeção se completa ' +
        'quando o robô rodar.'
      : faltam
      ? '<b>Informe os saldos para ver a projeção.</b> As <b>saídas</b> já vêm da API do ' +
        'Bimer; o saldo de cada conta e as entradas previstas seguem manuais até haver ' +
        'API dos bancos. O saldo das aplicações é o que mostra se há dinheiro ' +
        'disponível para o resgate sugerido.'
      : '<b>Editando os saldos desta semana.</b> O que já estava salvo continua valendo ' +
        'até você gravar.';

    return '' +
      '<div class="banner">' +
        '<svg class="ic" width="15" height="15" viewBox="0 0 24 24" fill="none" ' +
          'stroke="currentColor" stroke-width="1.8" stroke-linecap="round">' +
          '<path d="M12 8v4M12 16h.01M12 22a10 10 0 100-20 10 10 0 000 20z"/></svg>' +
        '<div>' + aviso + '</div>' +
      '</div>' +

      '<div class="card">' +
        '<div class="card-title">' +
          '<h2>Saldos da semana</h2>' +
          '<span class="muted">' + prontas + ' de ' + total + ' conta(s) informada(s)' +
            (estado.janela ? ' · janela ' + esc(estado.janela[0].split('-').reverse().join('/')) +
                             ' a ' + esc(estado.janela[1].split('-').reverse().join('/')) : '') +
          '</span>' +
        '</div>' +

        '<div class="tbl-wrap baixa"><table class="data"><thead><tr>' +
          '<th>Conta</th>' +
          '<th class="num" style="width:160px">Saídas da semana</th>' +
          '<th style="width:205px">Saldo em conta</th>' +
          '<th style="width:205px">Entradas previstas</th>' +
        '</tr></thead><tbody>' +
          estado.contas.map(linhasDaConta).join('') +
        '</tbody></table></div>' +

        '<div class="sbf-acoes">' +
          '<div class="txt" id="sbfStatus"></div>' +
          (faltam ? '' : '<button class="btn-ghost" id="sbfVoltar" type="button">Voltar</button>') +
          '<button class="btn-acao" id="sbfSalvar" type="button">' +
            'Salvar e ver a projeção</button>' +
        '</div>' +
      '</div>';
  }

  /* Liga a máscara e o contador. Chamado depois de inserir o HTML.
   *
   * O contador é atualizado a cada tecla porque com dez contas é fácil perder a conta de
   * quantas faltam — e a resposta ("faltam 3") é a única coisa que separa quem está
   * digitando do resultado que ele quer ver. */
  function ligar() {
    var campos = document.querySelectorAll('input.sbf[data-chave]');
    if (!campos.length) return;

    function contar() {
      var contas = document.querySelectorAll('input.sbf[data-campo="saldo"][data-conta]');
      var faltam = 0;
      Array.prototype.forEach.call(contas, function (el) {
        if (!soDigitos(el.value)) faltam++;
      });
      var total = contas.length;
      var alvo = document.getElementById('sbfStatus');
      if (alvo) {
        alvo.innerHTML = faltam
          ? 'Faltam <b>' + faltam + '</b> de <b>' + total + '</b> conta(s).'
          : 'Todas as <b>' + total + '</b> contas informadas.';
      }
    }

    Array.prototype.forEach.call(campos, function (el) {
      el.addEventListener('input', function () {
        el.value = formatarMoeda(el.value);
        // o cursor vai para o fim: os dígitos entram pela direita, então é onde ele
        // sempre deveria estar depois de reformatar
        try { el.setSelectionRange(el.value.length, el.value.length); } catch (e) { /* noop */ }
        el.classList.toggle('ok', !!el.value);
        var linha = el.closest('tr');
        if (linha && linha.classList.contains('conta-cc') &&
            el.getAttribute('data-campo') === 'saldo') {
          linha.classList.toggle('falta-saldo', !el.value);
        }
        contar();
      });
    });

    contar();
  }

  /* Lê os campos e devolve uma linha por conta ou aplicação. Campo vazio vira null (não
   * zero): zero é um saldo informado, vazio é "ninguém informou" — e é essa diferença que
   * decide se a tela libera a projeção. */
  function coletar(semana) {
    var por = {};
    var campos = document.querySelectorAll('input.sbf[data-chave]');
    Array.prototype.forEach.call(campos, function (el) {
      var k = el.getAttribute('data-chave');
      por[k] = por[k] || { chave: k, semana: semana };
      por[k][el.getAttribute('data-campo')] = numero(el.value);
    });
    return Object.keys(por).map(function (k) { return por[k]; })
      .filter(function (e) { return e.saldo !== null || e.a_receber !== null; });
  }

  return { html: html, coletar: coletar, ligar: ligar,
           numero: numero, formatarMoeda: formatarMoeda };
})();
