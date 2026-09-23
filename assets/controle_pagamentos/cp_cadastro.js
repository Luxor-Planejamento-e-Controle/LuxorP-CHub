/* Tela de edição do cadastro de fornecedores fixos.
 *
 * Por que ela existe
 * ------------------
 * Hoje o cadastro é recopiado a cada mês numa planilha que também faz o batimento e a
 * calculadora. A auditoria mediu o preço disso: 35 resultados errados no ano, 16 deles
 * por chave congelada (valor colado no lugar de fórmula). E a saída de um fornecedor é
 * implícita por omissão — indistinguível de esquecimento, e sem registro do motivo.
 *
 * Esta tela separa o cadastro do batimento. O que ela dá e a planilha não dava:
 *
 *   - `ativo` explícito com motivo, em vez de sumiço silencioso
 *   - meses de competência marcados, em vez de deduzidos da ausência
 *   - `atualizado_por` / `atualizado_em` por registro: quem mexeu e quando
 *   - conferência das chaves antes de gravar, em vez de erro que só aparece no mês
 *
 * Usa as classes do próprio painel (card, tbl-wrap, table.data, seg, btn-ghost) para não
 * introduzir um segundo vocabulário visual no meio do produto.
 *
 * Edição in loco: o `input` altera o registro em memória e NÃO re-renderiza. Redesenhar
 * a cada tecla tiraria o foco do campo — é o mesmo cuidado que o modo de edição do
 * painel de Saldo Bancário toma.
 */
window.CP_CADASTRO = (function () {
  'use strict';

  var estado = null;        // { fornecedores, publicadoEm, ... }
  var linhas = [];          // cópia de trabalho, com uid
  var original = '';        // JSON do que foi carregado, para saber o que mudou
  var filtro = { empresa: '', busca: '', mostrar: 'ativos' };
  var aoSalvar = null;
  var aoSair = null;
  var proximoUid = 1;

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function semUid(l) {
    var c = Object.assign({}, l);
    delete c.uid;
    return c;
  }

  function serializar() {
    return JSON.stringify(CP_DADOS.ordenar(linhas.map(semUid)));
  }

  function mudou() {
    return serializar() !== original;
  }

  // ---------------------------------------------------------------- montagem

  function abrir(alvo, est, cb) {
    estado = est;
    aoSalvar = cb && cb.salvar;
    aoSair = cb && cb.sair;
    linhas = est.fornecedores.map(function (f) {
      return Object.assign({}, f, { uid: proximoUid++ });
    });
    original = serializar();
    render(alvo);
  }

  function empresas() {
    var vistas = {};
    linhas.forEach(function (l) { if (l.empresa) vistas[l.empresa] = true; });
    return Object.keys(vistas).sort(function (a, b) { return a.localeCompare(b, 'pt-BR'); });
  }

  function visiveis() {
    var b = filtro.busca.trim().toLowerCase();
    return CP_DADOS.ordenar(linhas).filter(function (l) {
      if (filtro.empresa && l.empresa !== filtro.empresa) return false;
      if (filtro.mostrar === 'ativos' && !l.ativo) return false;
      if (filtro.mostrar === 'inativos' && l.ativo) return false;
      if (b && (l.fornecedor + ' ' + l.empresa + ' ' + l.cod).toLowerCase().indexOf(b) < 0) {
        return false;
      }
      return true;
    });
  }

  function campoTexto(uid, campo, valor, largura, placeholder) {
    return '<input class="cpc" data-uid="' + uid + '" data-campo="' + campo + '"' +
      ' value="' + esc(valor) + '" style="width:' + largura + 'px"' +
      (placeholder ? ' placeholder="' + esc(placeholder) + '"' : '') + '>';
  }

  /* Empresa é ESCOLHA, não texto livre.
   *
   * O batimento casa fornecedor com título pelo nome da empresa, e a grafia tem de ser a
   * mesma do ETL. Digitado, "CONDOMINIO HPG" sem acento passa sem reclamar e o fornecedor
   * nunca casa com título nenhum — aparece "Não Recebido" todo mês, e nada na tela diz
   * por quê. É o erro que este campo existe para não deixar acontecer.
   *
   * Valor fora da lista NÃO é descartado: vira uma opção própria, marcada. Trocar em
   * silêncio pela primeira da lista corromperia o cadastro de quem abriu a tela por outro
   * motivo, e deixar o select vazio esconderia o que está gravado. Marcado, quem vê
   * decide. */
  function campoEmpresa(uid, valor, largura) {
    var lista = CP_DADOS.EMPRESAS.slice();
    var foraDaLista = valor && lista.indexOf(valor) < 0;
    if (foraDaLista) lista = [valor].concat(lista);

    return '<select class="cpc" data-uid="' + uid + '" data-campo="empresa"' +
      ' style="width:' + largura + 'px"' +
      (foraDaLista ? ' data-fora="1" title="Esta grafia não é a que o robô usa para casar '
                     + 'os títulos — escolha a da lista"' : '') + '>' +
      (valor ? '' : '<option value="">— escolha —</option>') +
      lista.map(function (e) {
        return '<option' + (e === valor ? ' selected' : '') + '>' + esc(e) + '</option>';
      }).join('') + '</select>';
  }

  /* Os doze meses como fichas. Doze caixinhas de seleção seriam corretas e ilegíveis:
   * a pergunta que se faz aqui é "em que meses este fornecedor aparece", e a resposta é
   * um padrão visual (todos, um a cada três, só um), não doze respostas separadas. */
  function fichasMeses(l) {
    return '<div class="meses" data-uid="' + l.uid + '">' +
      CP_DADOS.MESES.map(function (m, i) {
        var on = l.meses.indexOf(m) >= 0;
        return '<button type="button" class="m' + (on ? ' on' : '') + '" data-mes="' + m +
          '" title="' + CP_DADOS.MESES_LONGOS[i] + '">' +
          CP_DADOS.MESES_LONGOS[i][0] + '</button>';
      }).join('') + '</div>';
  }

  function linhaHtml(l) {
    return '<tr data-uid="' + l.uid + '"' + (l.ativo ? '' : ' class="inativo"') + '>' +
      '<td>' + campoEmpresa(l.uid, l.empresa, 158) + '</td>' +
      '<td>' + campoTexto(l.uid, 'fornecedor', l.fornecedor, 220, 'fornecedor') +
        (l.ativo ? '' :
          '<div style="margin-top:5px">' +
          campoTexto(l.uid, 'obs_interna', l.obs_interna, 220, 'por que saiu?') +
          '</div>') +
        (l.atualizado_por
          ? '<div class="sub2">alterado por ' + esc(l.atualizado_por) +
            (l.atualizado_em ? ' em ' + esc(l.atualizado_em.slice(0, 10).split('-')
                .reverse().join('/')) : '') + '</div>'
          : '') +
      '</td>' +
      '<td>' + campoTexto(l.uid, 'cod', l.cod, 74, 'cód') + '</td>' +
      '<td>' + campoTexto(l.uid, 'contagem', l.contagem, 44) + '</td>' +
      '<td>' + campoTexto(l.uid, 'valor_usual_txt', l.valor_usual_txt, 104, 'Variável') + '</td>' +
      '<td>' + campoTexto(l.uid, 'venc_orig', l.venc_orig, 96, 'dia') + '</td>' +
      '<td>' + campoTexto(l.uid, 'obs', l.obs, 190, 'anual (SET)…') + '</td>' +
      '<td>' + fichasMeses(l) + '</td>' +
      '<td class="nowrap">' +
        '<button type="button" class="chip-ativo' + (l.ativo ? ' on' : '') +
          '" data-uid="' + l.uid + '">' + (l.ativo ? 'ativo' : 'inativo') + '</button>' +
      '</td>' +
      '<td><button type="button" class="btn-lixo" data-uid="' + l.uid +
        '" title="remover do cadastro">&times;</button></td>' +
    '</tr>';
  }

  function render(alvo) {
    var el = alvo || document.getElementById('content');
    var lista = visiveis();
    var probs = CP_DADOS.problemas(linhas);
    var alterados = mudou();

    el.innerHTML = '' +
      '<div class="banner">' +
        '<svg class="ic" width="15" height="15" viewBox="0 0 24 24" fill="none" ' +
          'stroke="currentColor" stroke-width="1.8" stroke-linecap="round">' +
          '<path d="M12 8v4M12 16h.01M12 22a10 10 0 100-20 10 10 0 000 20z"/></svg>' +
        '<div>' +
          /* Chegar aqui tem DOIS motivos, e a tela precisa dizer qual é.
           *
           * Sem resultado publicado o painel não existe, e quem abre fica sem entender
           * por que só vê cadastro — foi o que aconteceu na primeira semana. Dizer "o
           * ETL ainda não rodou" responde a pergunta que a pessoa está fazendo; o texto
           * genérico sobre o que é o cadastro, não. */
          (estado && estado.temPainel
            ? '<b>Este é o cadastro, não o resultado.</b> O batimento roda no Azure com ' +
              'os títulos do Bimer — uma alteração aqui aparece nos números do painel ' +
              'na <b>próxima execução</b>, não na hora. '
            : '<b>O painel ainda não foi publicado.</b> O batimento roda no Azure toda ' +
              'segunda de manhã e publica o resultado; até a primeira execução, o que ' +
              'existe é este cadastro. Ele já é útil: é daqui que o batimento lê quem ' +
              'são os fornecedores fixos, então revisar agora vale para a primeira ' +
              'rodada. ') +
          'Fornecedor que saiu deve ser marcado <b>inativo</b> com o motivo, e não ' +
          'apagado: apagar perde o histórico e faz a saída voltar a ser um sumiço sem ' +
          'explicação.</div>' +
      '</div>' +

      (probs.length ? '<div class="erro-box"><b>' + probs.length +
        ' problema(s) que fariam o batimento errar:</b><ul style="margin:6px 0 0 18px">' +
        probs.slice(0, 8).map(function (p) {
          return '<li>' + esc(p.onde) + ' — ' + esc(p.erro) + '</li>';
        }).join('') +
        (probs.length > 8 ? '<li>…e mais ' + (probs.length - 8) + '</li>' : '') +
        '</ul></div>' : '') +

      '<div class="toolbar">' +
        '<div class="field"><label>Empresa</label>' +
          '<select id="cpcEmpresa"><option value="">Todas</option>' +
          empresas().map(function (e) {
            return '<option' + (filtro.empresa === e ? ' selected' : '') + '>' + esc(e) +
              '</option>';
          }).join('') + '</select></div>' +
        '<div class="field"><label>Buscar</label>' +
          '<input type="search" id="cpcBusca" placeholder="fornecedor, empresa ou código" ' +
          'value="' + esc(filtro.busca) + '"></div>' +
        '<div class="field"><label>Mostrar</label>' +
          '<div class="seg" id="cpcMostrar">' +
          [['ativos', 'Ativos'], ['inativos', 'Inativos'], ['todos', 'Todos']]
            .map(function (o) {
              return '<button type="button" data-v="' + o[0] + '"' +
                (filtro.mostrar === o[0] ? ' class="on"' : '') + '>' + o[1] + '</button>';
            }).join('') + '</div></div>' +
        '<div style="flex:1"></div>' +
        '<button class="btn-ghost" id="cpcAdd" type="button">+ Fornecedor</button>' +
      '</div>' +

      '<div class="card">' +
        '<div class="card-title"><h2>Fornecedores fixos</h2>' +
          '<span class="muted">' + lista.length + ' de ' + linhas.length + ' · ' +
          linhas.filter(function (l) { return l.ativo; }).length + ' ativos</span>' +
        '</div>' +
        '<div class="tbl-wrap"><table class="data cadastro"><thead><tr>' +
          '<th>Empresa</th><th>Fornecedor</th><th>Cód</th><th title="ocorrência: o ' +
          'mesmo fornecedor pode ter mais de um título fixo no mês">Oc.</th>' +
          '<th>Valor usual</th><th>Venc</th><th>Obs (competência)</th>' +
          '<th>Meses</th><th>Situação</th><th></th>' +
        '</tr></thead><tbody>' +
          (lista.length ? lista.map(linhaHtml).join('')
            : '<tr><td colspan="10"><div class="empty">Nenhum fornecedor com esses ' +
              'filtros.</div></td></tr>') +
        '</tbody></table></div>' +

        '<div class="cpc-acoes">' +
          '<div class="txt" id="cpcStatus">' +
            (alterados ? 'Há alterações não gravadas.' : 'Nada alterado.') +
          '</div>' +
          '<button class="btn-ghost" id="cpcSair" type="button">Voltar ao painel</button>' +
          '<button class="btn-acao" id="cpcSalvar" type="button"' +
            (alterados ? '' : ' disabled') + '>Gravar cadastro</button>' +
        '</div>' +
      '</div>';

    ligar(el);
  }

  // ---------------------------------------------------------------- eventos

  function acha(uid) {
    return linhas.find(function (l) { return String(l.uid) === String(uid); });
  }

  function marcarEstado() {
    var alterados = mudou();
    var b = document.getElementById('cpcSalvar');
    var t = document.getElementById('cpcStatus');
    if (b) b.disabled = !alterados;
    if (t) t.textContent = alterados ? 'Há alterações não gravadas.' : 'Nada alterado.';
  }

  function ligar(el) {
    var tb = el.querySelector('tbody');

    if (tb) {
      /* 'input' altera o registro em memória sem redesenhar: redesenhar a cada tecla
       * tiraria o foco do campo. A tela só se redesenha quando a ESTRUTURA muda
       * (adicionar, remover, filtrar, ativar/desativar). */
      /* `input.cpc, select.cpc`: a empresa virou lista de escolha, e `<select>` também
       * dispara 'input' ao trocar. Escutar só input deixaria a troca de empresa mudar a
       * tela sem mudar o registro — a tela mostrando uma coisa e o gravado sendo outra. */
      tb.addEventListener('input', function (ev) {
        var alvo = ev.target.closest('input.cpc, select.cpc');
        if (!alvo) return;
        var l = acha(alvo.getAttribute('data-uid'));
        if (!l) return;
        var campo = alvo.getAttribute('data-campo');
        l[campo] = campo === 'contagem' ? (parseInt(alvo.value, 10) || 1) : alvo.value;
        /* Escolhida uma da lista, o aviso de grafia fora do padrão perde a razão de
         * existir — some na hora, sem esperar o próximo redesenho. */
        if (campo === 'empresa' && alvo.dataset.fora &&
            CP_DADOS.EMPRESAS.indexOf(alvo.value) >= 0) {
          delete alvo.dataset.fora;
          alvo.removeAttribute('title');
        }
        marcarEstado();
      });

      tb.addEventListener('click', function (ev) {
        var mes = ev.target.closest('.meses button');
        if (mes) {
          var l = acha(mes.closest('.meses').getAttribute('data-uid'));
          var m = mes.getAttribute('data-mes');
          var tem = l.meses.indexOf(m) >= 0;
          /* Reconstrói em ordem de calendário em vez de empurrar para o fim. Sem isso,
             desmarcar e remarcar o mesmo mês deixava o array numa ordem diferente, e a
             comparação que decide o que mudou (cp_fonte.iguais) via alteração onde não
             houve — carimbando `atualizado_por` de quem só clicou duas vezes. */
          l.meses = CP_DADOS.MESES.filter(function (x) {
            return x === m ? !tem : l.meses.indexOf(x) >= 0;
          });
          mes.classList.toggle('on');
          marcarEstado();
          return;
        }
        var ativo = ev.target.closest('.chip-ativo');
        if (ativo) {
          var la = acha(ativo.getAttribute('data-uid'));
          la.ativo = !la.ativo;
          render(el);   // muda a linha inteira (aparece o campo de motivo)
          return;
        }
        var lixo = ev.target.closest('.btn-lixo');
        if (lixo) {
          var ll = acha(lixo.getAttribute('data-uid'));
          if (confirm('Remover "' + (ll.fornecedor || 'este fornecedor') +
                      '" do cadastro?\n\nSe ele apenas parou de aparecer, marque ' +
                      'INATIVO em vez de remover — assim o histórico e o motivo ficam.')) {
            linhas = linhas.filter(function (x) { return x !== ll; });
            render(el);
          }
        }
      });
    }

    var sel = document.getElementById('cpcEmpresa');
    if (sel) sel.onchange = function (e) { filtro.empresa = e.target.value; render(el); };

    var busca = document.getElementById('cpcBusca');
    if (busca) {
      var t = null;
      busca.oninput = function (e) {
        filtro.busca = e.target.value;
        clearTimeout(t);
        // espera a digitação parar: refiltrar a cada tecla redesenha a tabela inteira
        t = setTimeout(function () { render(el); }, 250);
      };
    }

    var seg = document.getElementById('cpcMostrar');
    if (seg) {
      seg.onclick = function (ev) {
        var b = ev.target.closest('button');
        if (!b) return;
        filtro.mostrar = b.getAttribute('data-v');
        render(el);
      };
    }

    var add = document.getElementById('cpcAdd');
    if (add) {
      add.onclick = function () {
        linhas.push(CP_DADOS.normalizar({
          ano: (estado.anos && estado.anos[estado.anos.length - 1]) ||
               new Date().getFullYear(),
          empresa: filtro.empresa || '',
          meses: CP_DADOS.MESES.slice()    // mensal é o padrão: é a maioria dos fixos
        }));
        linhas[linhas.length - 1].uid = proximoUid++;
        render(el);
        var campos = el.querySelectorAll('select.cpc[data-campo="empresa"]');
        if (campos.length) campos[campos.length - 1].focus();
      };
    }

    var sair = document.getElementById('cpcSair');
    if (sair) {
      sair.onclick = function () {
        if (mudou() && !confirm('Há alterações não gravadas. Sair mesmo assim?')) return;
        if (aoSair) aoSair();
      };
    }

    var salvar = document.getElementById('cpcSalvar');
    if (salvar) {
      salvar.onclick = async function () {
        var probs = CP_DADOS.problemas(linhas);
        if (probs.length &&
            !confirm(probs.length + ' problema(s) podem fazer o batimento errar. ' +
                     'Gravar assim mesmo?')) return;
        salvar.disabled = true;
        document.getElementById('cpcStatus').textContent = 'gravando...';
        try {
          var gravados = await aoSalvar(linhas.map(semUid));
          linhas = gravados.map(function (f) {
            return Object.assign({}, f, { uid: proximoUid++ });
          });
          original = serializar();
          render(el);
          document.getElementById('cpcStatus').textContent = 'Cadastro gravado.';
        } catch (e) {
          salvar.disabled = false;
          document.getElementById('cpcStatus').textContent =
            'não foi possível gravar: ' + e.message;
        }
      };
    }
  }

  return { abrir: abrir, mudou: mudou,
           _linhas: function () { return linhas; } };
})();
