/* Tela das MOVIMENTAÇÕES MANUAIS do Fluxo de Caixa da Fazenda Pão Grande (FPG).
 *
 * O papel da aba `Base` da planilha (pedido do Leonardo, 28/10/2026, para depois valer em
 * todos os fluxos): lançar à mão o que os relatórios do Bimer não trazem certo, e isso
 * aparecer nas naturezas junto com os lançamentos. Abre DE DENTRO do painel, como o cadastro
 * ("Movimentações manuais" / "← Voltar ao painel"). Três tipos (as regras e o que cada um soma
 * moram em `shared_fpg/manuais.py`; `linhas` aqui é só a prévia na tela):
 *
 *   Avulsa .......... um valor numa natureza, num mês
 *   Reclassificação . move um valor de uma natureza para outra no mesmo mês
 *   Mudar mês ....... move um valor de uma natureza de um mês para outro
 *
 * Cada "Adicionar" e cada "Excluir" GRAVA na hora: não existe edição pela metade para perder
 * ao voltar. Onde grava não é assunto daqui: `cb.salvar` (local: abrir_painel.py; no Hub:
 * Supabase). Só o TEXTO muda com o lugar, por `ctx.remonta` (como no cadastro): o
 * abrir_painel.py remonta o painel ao gravar; no Hub a movimentação vale na próxima
 * publicação do Azure (ou no "Atualizar agora"). Este arquivo é o MESMO nos dois lugares —
 * mudou aqui, copia lá inteiro.
 */
window.FPG_MANUAIS = (function () {
  'use strict';

  var MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  var TIPOS = { avulsa: 'Avulsa', reclassificacao: 'Reclassificação', mudar_mes: 'Mudar mês' };

  var view, ctx, cb;
  var movimentos = [];
  var tipo = 'avulsa';
  var ocupado = false;

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function n2(v) {
    return Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function sig(v) { return (v > 0 ? '+' : v < 0 ? '−' : '') + n2(Math.abs(v)); }

  /* "−4.313,74", "-4313.74", "4 313,74" → número; null se não for número */
  function lerValor(txt) {
    var s = String(txt || '').trim().replace(/\s/g, '').replace(/[−–]/g, '-');
    if (!s) return null;
    if (s.indexOf(',') >= 0) s = s.replace(/\./g, '').replace(',', '.');
    if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
    return Math.round(parseFloat(s) * 100) / 100;
  }

  function nomeNat(cod) {
    var n = (ctx.nats || []).find(function (x) { return x.cod === cod; });
    return n ? n.nome : '';
  }
  function rotMes(m) { return MESES[m - 1] || '?'; }

  /* as linhas que a movimentação soma — a MESMA regra do `manuais.linhas` em Python */
  function linhas(m) {
    var v = Number(m.valor || 0);
    if (m.tipo === 'avulsa') return [[m.mes, m.cod, v]];
    if (m.tipo === 'reclassificacao') return [[m.mes, m.de, -v], [m.mes, m.para, v]];
    return [[m.de_mes, m.cod, -v], [m.para_mes, m.cod, v]];
  }

  function optMeses(sel) {
    var out = '<option value="">—</option>';
    for (var m = 1; m <= (ctx.meses_fechados || 0); m++) {
      var previa = ctx.meses && ctx.meses[m - 1] && ctx.meses[m - 1].fonte === 'api';
      out += '<option value="' + m + '"' + (sel === m ? ' selected' : '') + '>' + rotMes(m) +
        (previa ? ' (prévia)' : '') + '</option>';
    }
    return out;
  }

  function optNats() {
    var grupos = { receita: [], despesa: [] };
    (ctx.nats || []).slice().sort(function (a, b) { return a.cod.localeCompare(b.cod); })
      .forEach(function (n) { (grupos[n.bloco] || grupos.despesa).push(n); });
    return '<option value="">—</option>' + [['receita', 'Receitas'], ['despesa', 'Despesas']].map(function (g) {
      return '<optgroup label="' + g[1] + '">' + grupos[g[0]].map(function (n) {
        return '<option value="' + esc(n.cod) + '">' + esc(n.cod + ' — ' + n.nome) + '</option>';
      }).join('') + '</optgroup>';
    }).join('');
  }

  function campo(id, rotulo, html, dica) {
    return '<div class="form-campo"><label for="' + id + '">' + rotulo + '</label>' + html +
      (dica ? '<div class="form-dica">' + dica + '</div>' : '') + '</div>';
  }
  function sel(id, opts) { return '<select id="' + id + '">' + opts + '</select>'; }

  function camposDoTipo() {
    var valorDica = tipo === 'avulsa'
      ? 'No sinal do caixa: entrada positiva, saída negativa (ex.: −1.250,00 é uma despesa).'
      : 'O valor que MUDA de lugar, no sinal do caixa: para mover uma despesa, use o valor negativo ' +
        '(ex.: −4.313,74). Sai de um lado e entra no outro — o total não muda.';
    var valor = campo('mnValor', 'Valor', '<input id="mnValor" inputmode="decimal" placeholder="−1.234,56">', valorDica);
    if (tipo === 'avulsa') {
      return '<div class="mn-grade">' + campo('mnMes', 'Mês', sel('mnMes', optMeses())) +
        campo('mnCod', 'Natureza', sel('mnCod', optNats())) + valor + '</div>';
    }
    if (tipo === 'reclassificacao') {
      return '<div class="mn-grade">' + campo('mnMes', 'Mês', sel('mnMes', optMeses())) +
        campo('mnDe', 'Da natureza', sel('mnDe', optNats())) +
        campo('mnPara', 'Para a natureza', sel('mnPara', optNats())) + valor + '</div>';
    }
    return '<div class="mn-grade">' + campo('mnCod', 'Natureza', sel('mnCod', optNats())) +
      campo('mnDeMes', 'Do mês', sel('mnDeMes', optMeses())) +
      campo('mnParaMes', 'Para o mês', sel('mnParaMes', optMeses())) + valor + '</div>';
  }

  function val(id) { var el = document.getElementById(id); return el ? el.value : ''; }
  function int(id) { var v = parseInt(val(id), 10); return isNaN(v) ? null : v; }

  /* o que está no formulário, já como movimentação; e o que falta para ela valer */
  function lerForm() {
    var m = { tipo: tipo, valor: lerValor(val('mnValor')), motivo: val('mnMotivo').trim() };
    if (tipo === 'avulsa') { m.mes = int('mnMes'); m.cod = val('mnCod'); }
    if (tipo === 'reclassificacao') { m.mes = int('mnMes'); m.de = val('mnDe'); m.para = val('mnPara'); }
    if (tipo === 'mudar_mes') { m.cod = val('mnCod'); m.de_mes = int('mnDeMes'); m.para_mes = int('mnParaMes'); }
    var falta = [];
    if (tipo !== 'mudar_mes' && !m.mes) falta.push('o mês');
    if (tipo === 'mudar_mes' && (!m.de_mes || !m.para_mes)) falta.push('os dois meses');
    if (tipo !== 'reclassificacao' && !m.cod) falta.push('a natureza');
    if (tipo === 'reclassificacao' && (!m.de || !m.para)) falta.push('as duas naturezas');
    if (m.valor === null) falta.push('o valor (número, ex.: −1.234,56)');
    else if (Math.abs(m.valor) < 0.005) falta.push('um valor diferente de zero');
    if (!m.motivo) falta.push('o motivo');
    if (tipo === 'reclassificacao' && m.de && m.de === m.para) falta.push('naturezas diferentes');
    if (tipo === 'mudar_mes' && m.de_mes && m.de_mes === m.para_mes) falta.push('meses diferentes');
    return { mov: m, falta: falta };
  }

  function previa() {
    var el = document.getElementById('mnPrevia');
    if (!el) return;
    var f = lerForm();
    var pronto = f.falta.length === 0;
    document.getElementById('mnAdicionar').disabled = !pronto || ocupado;
    if (!pronto) { el.innerHTML = '<span class="muted">Falta: ' + esc(f.falta.join(', ')) + '.</span>'; return; }
    el.innerHTML = '<b>Entra no realizado:</b> ' + linhas(f.mov).map(function (l) {
      return rotMes(l[0]) + ' · ' + esc(l[1] + ' ' + nomeNat(l[1])) + ' <b class="' +
        (l[2] < 0 ? 'neg' : 'pos') + '">' + sig(l[2]) + '</b>';
    }).join(' &nbsp;|&nbsp; ');
  }

  function descricao(m) {
    if (m.tipo === 'avulsa') return rotMes(m.mes) + ' · ' + m.cod + ' ' + nomeNat(m.cod);
    if (m.tipo === 'reclassificacao')
      return rotMes(m.mes) + ' · de ' + m.de + ' ' + nomeNat(m.de) + ' para ' + m.para + ' ' + nomeNat(m.para);
    return m.cod + ' ' + nomeNat(m.cod) + ' · de ' + rotMes(m.de_mes) + ' para ' + rotMes(m.para_mes);
  }

  function quando(iso) {
    return iso ? iso.slice(8, 10) + '/' + iso.slice(5, 7) + '/' + iso.slice(0, 4) + ' ' + iso.slice(11, 16) : '';
  }

  /* As do ano do painel. As de outros anos ficam no documento (a gravação manda a lista
     inteira) e não aparecem: a movimentação guarda o mês, e cada ano soma só as suas —
     as sem `ano` são de 2026, quando as movimentações começaram (`manuais.ano_de`). */
  function doAno() {
    return movimentos.filter(function (m) { return !ctx.ano || (m.ano || 2026) === ctx.ano; });
  }

  function tabela() {
    var lista = doAno();
    if (!lista.length) return '<div class="empty muted">Nenhuma movimentação manual lançada.</div>';
    var ordem = lista.slice().sort(function (a, b) { return (b.id || 0) - (a.id || 0); });
    return '<div class="tbl-wrap"><table class="data cadastro mn-lista"><thead><tr>' +
      '<th>#</th><th>Tipo</th><th>O quê</th><th class="num">Valor</th><th>Motivo</th>' +
      '<th>Lançado por</th><th></th></tr></thead><tbody>' +
      ordem.map(function (m) {
        return '<tr><td class="nowrap">' + esc(m.id) + '</td><td class="nowrap">' + esc(TIPOS[m.tipo] || m.tipo) +
          '</td><td>' + esc(descricao(m)) + '<div class="muted">' + linhas(m).map(function (l) {
            return rotMes(l[0]) + ' ' + esc(l[1]) + ' ' + sig(l[2]);
          }).join(' · ') + '</div></td><td class="num nowrap">' + sig(m.valor) + '</td><td>' + esc(m.motivo) +
          '</td><td class="nowrap muted">' + esc(m.criado_por || '') + '<br>' + esc(quando(m.criado_em)) +
          '</td><td><button type="button" class="btn-lixo" data-excluir="' + esc(m.id) +
          '" title="Excluir esta movimentação (grava na hora)">Excluir</button></td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  function desenhar(status, erro) {
    view.innerHTML =
      '<div class="tt-cad-topo"><button type="button" class="btn-ghost" id="mnVoltar">← Voltar ao painel</button>' +
        '<h2>Movimentações manuais</h2></div>' +
      '<div class="banner"><div><b>O que se lança aqui entra no realizado</b>, nas naturezas, junto com os ' +
        'lançamentos dos relatórios do Bimer — e com isso no Resumo, no Confronto e no check do DRE. ' +
        'No detalhe de cada célula aparece marcado como <b>manual</b>. Cada movimentação grava na hora, com ' +
        'o seu usuário e a data. Só dá para lançar em mês que já tem realizado.' +
        (ctx.remonta ? '' : ' O painel é montado no Azure: o que você gravar aqui aparece na <b>próxima ' +
          'publicação</b> (segunda às 10h30) ou agora, pelo <b>Atualizar agora</b>.') + '</div></div>' +
      (erro ? '<div class="erro-box"></div>' : '') +
      '<div class="card"><div class="card-title"><div><h2>Nova movimentação</h2></div></div>' +
        '<div class="mn-tipos">' + Object.keys(TIPOS).map(function (t) {
          return '<button type="button" class="btn-ghost' + (t === tipo ? ' on' : '') + '" data-tipo="' + t + '">' +
            TIPOS[t] + '</button>';
        }).join('') + '</div>' +
        '<div class="form-dica mn-explica">' + ({
          avulsa: 'Um valor numa natureza, num mês — o que a Base da planilha faz somando na célula.',
          reclassificacao: 'Move um valor de uma natureza para outra no mesmo mês (ex.: abril/2026, ' +
            'Móveis e Utensílios → Material para Consumo na Locação).',
          mudar_mes: 'Move um valor de uma natureza de um mês para outro (ex.: lançamento com a data errada).'
        })[tipo] + '</div>' +
        camposDoTipo() +
        campo('mnMotivo', 'Motivo', '<input id="mnMotivo" maxlength="300" placeholder="por que esta movimentação existe">',
          'Obrigatório — é o que explica o número para quem olhar depois.') +
        '<div class="mn-previa" id="mnPrevia"></div>' +
        '<div class="form-acoes"><span class="muted" id="mnStatus">' + esc(status || '') + '</span>' +
          '<button type="button" class="btn-acao" id="mnAdicionar" disabled>Adicionar e gravar</button></div>' +
      '</div>' +
      '<div class="card"><div class="card-title"><div><h2>Lançadas em ' + esc(ctx.ano || '') +
        ' (' + doAno().length + ')</h2>' +
        '<div class="hint">A mais recente primeiro. Para corrigir uma, exclua e lance de novo.</div></div></div>' +
        tabela() + '</div>';
    if (erro) view.querySelector('.erro-box').textContent = erro;
    ligar();
    previa();
  }

  async function gravar(novaLista, msgOk) {
    ocupado = true;
    var b = document.getElementById('mnAdicionar');
    if (b) b.disabled = true;
    var st = document.getElementById('mnStatus');
    if (st) st.textContent = ctx.remonta ? 'gravando e remontando o painel…' : 'gravando…';
    view.querySelectorAll('[data-excluir]').forEach(function (x) { x.disabled = true; });
    try {
      var doc = await cb.salvar(novaLista);
      movimentos = (doc && doc.movimentos) || [];
      ocupado = false;
      desenhar(msgOk);
      return true;
    } catch (e) {
      ocupado = false;
      desenhar('', 'Não gravou: ' + e.message);
      return false;
    }
  }

  function ligar() {
    document.getElementById('mnVoltar').onclick = function () { cb.voltar(); };
    view.querySelectorAll('[data-tipo]').forEach(function (b) {
      b.onclick = function () {
        var motivo = val('mnMotivo');
        tipo = b.dataset.tipo;
        desenhar();
        document.getElementById('mnMotivo').value = motivo;
        previa();
      };
    });
    view.querySelectorAll('.mn-grade select, .mn-grade input, #mnMotivo').forEach(function (el) {
      el.addEventListener('input', previa);
      el.addEventListener('change', previa);
    });
    document.getElementById('mnAdicionar').onclick = function () {
      var f = lerForm();
      if (f.falta.length || ocupado) return;
      gravar(movimentos.concat([f.mov]), ctx.remonta ? 'Movimentação gravada — o painel já foi remontado.'
        : 'Movimentação gravada — aparece no painel na próxima publicação (ou no Atualizar agora).');
    };
    view.querySelectorAll('[data-excluir]').forEach(function (b) {
      b.onclick = function () {
        var id = Number(b.dataset.excluir);
        var m = movimentos.find(function (x) { return x.id === id; });
        if (!m || !window.confirm('Excluir a movimentação #' + id + ' (' + (TIPOS[m.tipo] || m.tipo) + ', ' +
          sig(m.valor) + ')?\n\n' + m.motivo)) return;
        gravar(movimentos.filter(function (x) { return x.id !== id; }), 'Movimentação #' + id + ' excluída.');
      };
    });
  }

  /* ctx: {doc, nats, meses, meses_fechados, ano, remonta}; cb: {salvar(movimentos) → Promise<doc>, voltar} */
  function abrir(el, contexto, callbacks) {
    view = el; ctx = contexto || {}; cb = callbacks || {};
    movimentos = ((ctx.doc || {}).movimentos || []).slice();
    tipo = 'avulsa';
    ocupado = false;
    desenhar();
  }

  return { abrir: abrir, linhas: linhas, lerValor: lerValor };
})();
