/* Botão "Atualizar agora": pede ao robô do Azure que rode fora da hora marcada.
 *
 * Compartilhado pelos painéis porque a parte difícil não é o pedido — é saber quando
 * terminou, e isso é igual nos dois. Duas cópias divergiriam no tratamento de erro, que é
 * justamente o que ninguém testa à mão.
 *
 * COMO SE SABE QUE TERMINOU
 * -------------------------
 * Não pela resposta do pedido. O Azure só ENFILEIRA e responde na hora; o trabalho leva de
 * dez segundos (Saldo Bancário) a dois minutos (Controle de Pagamentos). Então aqui se
 * relê o carimbo de geração do arquivo até ele mudar.
 *
 * Isso tem uma vantagem sobre esperar uma resposta: sobrevive a fechar a aba. Quem clicar
 * e sair volta e vê o painel novo, porque o que manda é o arquivo publicado, não uma
 * conexão aberta.
 *
 * O PEDIDO NÃO VAI DIRETO AO AZURE. Vai para a Edge Function `reprocessar` do Supabase,
 * que confere o hub_can() de quem clicou e só então chama o Azure com a chave. Chave
 * nenhuma passa por aqui: este arquivo é público.
 */
window.HUB_REPROCESSAR = (function () {
  'use strict';

  var INTERVALO = 5000;      // de quanto em quanto se relê o carimbo
  var LIMITE = 5 * 60000;    // quando desistir de esperar (o CP leva ~2 min)

  function cliente() {
    if (!window.supabase || !window.SUPABASE_URL) {
      throw new Error('supabase-js não carregou');
    }
    return window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
  }

  function esperar(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  /* ligar({painel, botao, status, lerCarimbo, aoConcluir})
   *
   *   lerCarimbo()  -> Promise<string|null>  quando o arquivo publicado foi gerado.
   *                    O painel implementa porque cada um guarda isso num lugar
   *                    (meta.gerado_em num, gerado_em na raiz no outro) — e porque assim
   *                    este módulo não precisa saber o nome do arquivo no bucket.
   *   aoConcluir()  -> redesenha a tela com o dado novo.
   */
  function ligar(opcoes) {
    var botao = opcoes.botao;
    if (!botao) return;
    /* Os painéis chamam ligar() ao fim de cada render. O elemento costuma ser novo (o
     * render refaz o #content), mas quando não for, ligar duas vezes daria dois pedidos
     * por clique. */
    if (botao.dataset.reprocLigado) return;
    botao.dataset.reprocLigado = '1';

    var rodando = false;

    /* O status é procurado pelo id a cada uso, e não guardado numa variável: `aoConcluir`
     * redesenha a tela e o elemento de antes deixa de estar no documento. Escrever nele
     * não daria erro — a mensagem simplesmente não apareceria, que é o pior jeito de
     * falhar depois de dois minutos de espera. */
    var statusId = opcoes.status && opcoes.status.id;

    function dizer(txt, erro) {
      var el = statusId && document.getElementById(statusId);
      if (!el) return;
      el.textContent = txt || '';
      el.classList.toggle('erro', !!erro);
    }

    botao.addEventListener('click', async function () {
      /* Uma vez por vez NESTA aba. Não impede duas pessoas de pedirem ao mesmo tempo —
       * e não precisa: o segundo pedido republica o mesmo resultado. Bloquear de verdade
       * exigiria estado compartilhado para evitar um problema que não faz estrago. */
      if (rodando) return;
      rodando = true;

      var rotulo = botao.textContent;
      botao.disabled = true;
      botao.textContent = 'atualizando…';
      dizer('');

      try {
        var antes = await opcoes.lerCarimbo();

        var r = await cliente().functions.invoke('reprocessar', {
          body: { painel: opcoes.painel }
        });
        if (r.error) {
          /* A mensagem útil (sem acesso, painel desconhecido, Azure fora) vem no CORPO da
           * resposta de erro; r.error.message sozinho diz só "non-2xx status code". */
          var detalhe = '';
          try { detalhe = (await r.error.context.json()).erro || ''; } catch (e) { }
          throw new Error(detalhe || r.error.message);
        }

        dizer('pedido enviado, aguardando o robô…');

        var limite = Date.now() + LIMITE;
        while (Date.now() < limite) {
          await esperar(INTERVALO);
          var agora = await opcoes.lerCarimbo();
          if (agora && agora !== antes) {
            await opcoes.aoConcluir();
            /* Depois de redesenhar, não antes: o render recria o elemento de status, e
               escrever no de antes deixaria a confirmação invisível. */
            dizer('atualizado agora.');
            return;
          }
        }
        /* Estourou o tempo. O pedido continua na fila — não se cancela nada aqui, porque
         * cancelar depois de o ETL ter começado deixaria um arquivo pela metade. */
        dizer('está demorando mais que o previsto. O pedido continua na fila — '
              + 'recarregue daqui a pouco.', true);
      } catch (e) {
        dizer('não foi possível atualizar: ' + e.message, true);
      } finally {
        rodando = false;
        if (botao.isConnected) {
          botao.disabled = false;
          botao.textContent = rotulo;
        }
      }
    });
  }

  return { ligar: ligar };
})();
