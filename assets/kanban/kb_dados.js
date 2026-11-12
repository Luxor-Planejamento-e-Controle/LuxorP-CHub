/* Kanban Planejamento e Controle — a parte que não fala com rede nem com a tela.
 *
 * Posição dos cards, filtros, o markdown dos textos, as frases do histórico e o estado
 * do prazo. Sem DOM e sem dependência de propósito: roda igual no navegador e no teste.
 *
 * MARKDOWN: descrição e comentário são texto digitado por gente (e 2.400 comentários
 * vieram do Trello). O renderizador escapa TUDO e só então monta as poucas marcas que o
 * board usa — título, negrito, itálico, riscado, código, citação, lista, link e imagem.
 * Link só sai para http(s), mailto e `anexo:` (arquivo do bucket do Kanban, ver
 * tools/import_trello_kanban.py, que reescreveu os links de anexo do Trello para isso).
 * Qualquer outro esquema (javascript:, data:...) vira texto.
 */
var KB_DADOS = (function () {
  'use strict';

  /* ---------- texto ---------- */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // sem acento e minúsculo: "Maurício" acha "mauricio"
  function normal(s) {
    return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  }

  function iniciais(nome) {
    var p = String(nome || '?').trim().split(/\s+/).filter(Boolean);
    if (!p.length) return '?';
    return (p[0][0] + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase();
  }

  /* Cores das etiquetas: os nomes do Trello, nos tons que o Trello usa. O texto da
   * etiqueta é sempre escuro: todas essas cores são claras o bastante para isso. */
  var COR_ETIQUETA = {
    green: '#4BCE97', yellow: '#F5CD47', orange: '#FEA362', red: '#F87168',
    purple: '#9F8FEF', blue: '#579DFF', sky: '#6CC3E0', lime: '#94C748',
    pink: '#E774BB', black: '#8590A2',
    green_dark: '#1F845A', yellow_dark: '#946F00', orange_dark: '#C25100', red_dark: '#C9372C',
    purple_dark: '#6E5DC6', blue_dark: '#0C66E4', sky_dark: '#227D9B', lime_dark: '#5B7F24',
    pink_dark: '#AE4787', black_dark: '#626F86',
    green_light: '#BAF3DB', yellow_light: '#F8E6A0', orange_light: '#FEDEC8', red_light: '#FFD5D2',
    purple_light: '#DFD8FD', blue_light: '#CCE0FF', sky_light: '#C6EDFB', lime_light: '#D3F1A7',
    pink_light: '#FDD0EC', black_light: '#DCDFE4'
  };
  var CORES = ['green', 'yellow', 'orange', 'red', 'purple', 'blue', 'sky', 'lime', 'pink', 'black'];
  function corEtiqueta(cor) { return COR_ETIQUETA[cor] || '#8590A2'; }
  function textoEtiqueta(cor) {
    return /_dark$/.test(cor || '') ? '#FFFFFF' : '#1D2125';
  }

  /* ---------- posição (o mesmo esquema do Trello) ----------
   * Número real, menor = mais em cima. O card que entra entre dois recebe o ponto médio,
   * então mover grava uma linha só. Quando os vizinhos ficam colados demais para caber
   * um número no meio (depois de muita arrumação no mesmo lugar), devolve null e quem
   * chamou renumera a lista. */
  var PASSO = 65536;
  function posEntre(antes, depois) {
    var a = (antes === null || antes === undefined) ? null : Number(antes);
    var d = (depois === null || depois === undefined) ? null : Number(depois);
    var p;
    if (a === null && d === null) p = PASSO;
    else if (a === null) p = d / 2;
    else if (d === null) p = a + PASSO;
    else p = (a + d) / 2;
    if ((a !== null && !(p > a)) || (d !== null && !(p < d)) || !isFinite(p) || p <= 0) return null;
    return p;
  }

  function renumerar(n) {
    var out = [];
    for (var i = 0; i < n; i++) out.push((i + 1) * PASSO);
    return out;
  }

  // pos repetida existe no board (296 casos no Trello): desempata pela criação e pelo id
  function porPos(a, b) {
    return (a.pos - b.pos) || String(a.criado_em || '').localeCompare(String(b.criado_em || ''))
      || String(a.id).localeCompare(String(b.id));
  }

  /* ---------- filtro ----------
   * f = { texto, membros: [ids], etiquetas: [ids], semMembro: bool, prazo: ''|'vencido'|'semana' }
   * Membros e etiquetas: basta UM dos marcados (é o "qualquer" do Trello). Entre grupos,
   * todos valem juntos. */
  function passa(card, f, agora) {
    if (!f) return true;
    if (f.texto) {
      var alvo = normal(card.nome + ' ' + (card.descricao || ''));
      var termos = normal(f.texto).split(/\s+/).filter(Boolean);
      for (var i = 0; i < termos.length; i++) if (alvo.indexOf(termos[i]) < 0) return false;
    }
    var mbr = card.membros || [];
    if ((f.membros && f.membros.length) || f.semMembro) {
      var achou = f.semMembro && !mbr.length;
      for (var j = 0; !achou && j < (f.membros || []).length; j++) achou = mbr.indexOf(f.membros[j]) >= 0;
      if (!achou) return false;
    }
    if (f.etiquetas && f.etiquetas.length) {
      var etq = card.etiquetas || [], ok = false;
      for (var k = 0; !ok && k < f.etiquetas.length; k++) ok = etq.indexOf(f.etiquetas[k]) >= 0;
      if (!ok) return false;
    }
    if (f.prazo) {
      var st = prazoEstado(card.prazo, card.prazo_concluido, agora);
      if (f.prazo === 'vencido' && st !== 'vencido') return false;
      if (f.prazo === 'semana' && st !== 'vencido' && st !== 'proximo' && st !== 'semana') return false;
    }
    return true;
  }

  function filtroAtivo(f) {
    return !!(f && (f.texto || (f.membros && f.membros.length) || f.semMembro
      || (f.etiquetas && f.etiquetas.length) || f.prazo));
  }

  /* ---------- prazo ---------- */
  function prazoEstado(prazo, concluido, agora) {
    if (!prazo) return null;
    if (concluido) return 'concluido';
    var t = new Date(prazo).getTime(), n = (agora ? new Date(agora) : new Date()).getTime();
    if (t < n) return 'vencido';
    if (t - n < 24 * 3600e3) return 'proximo';
    if (t - n < 7 * 24 * 3600e3) return 'semana';
    return 'futuro';
  }

  var MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  function dois(n) { return (n < 10 ? '0' : '') + n; }

  // "12 nov" no ano corrente, "12 nov 2025" fora dele
  function dataCurta(iso, agora) {
    if (!iso) return '';
    var d = new Date(iso), h = agora ? new Date(agora) : new Date();
    return d.getDate() + ' ' + MESES[d.getMonth()] + (d.getFullYear() !== h.getFullYear() ? ' ' + d.getFullYear() : '');
  }
  function dataHora(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    return dois(d.getDate()) + '/' + dois(d.getMonth() + 1) + '/' + d.getFullYear()
      + ' ' + dois(d.getHours()) + ':' + dois(d.getMinutes());
  }

  /* ---------- markdown ---------- */
  function urlSegura(u) {
    u = String(u || '').trim();
    if (/^anexo:[A-Za-z0-9._\/-]+$/.test(u)) return u;
    if (/^(https?:\/\/|mailto:)/i.test(u)) return u;
    return null;
  }

  function nomeDoCaminho(c) { return String(c).split('/').pop(); }

  function link(url, rotulo, ctx) {
    var seg = urlSegura(url);
    if (!seg) return rotulo;
    if (seg.indexOf('anexo:') === 0) {
      return '<a href="#" class="kb-anexo-link" data-anexo="' + esc(seg.slice(6)) + '">' + rotulo + '</a>';
    }
    return '<a href="' + esc(seg) + '" target="_blank" rel="noopener noreferrer">' + rotulo + '</a>';
  }

  function imagem(url, alt, ctx) {
    var seg = urlSegura(url);
    if (!seg) return esc(alt || '');
    if (seg.indexOf('anexo:') === 0) {
      // o endereço do arquivo é assinado na hora (bucket privado): a tela preenche depois
      return '<span class="kb-img" data-anexo="' + esc(seg.slice(6)) + '" title="' + esc(alt || '') + '">'
        + esc(alt || nomeDoCaminho(seg)) + '</span>';
    }
    return link(seg, esc(alt || seg), ctx);
  }

  // URL dentro de "[x](url)": aceita UM nível de parênteses ("arquivo(1).pdf")
  var URL_MD = '((?:[^()\\s]|\\([^()\\s]*\\))+)';
  var RX_INLINE = new RegExp([
    '(`+)([\\s\\S]*?[^`])\\1(?!`)',                                   // 1,2 código
    '!\\[([^\\]]*)\\]\\(' + URL_MD + '(?:\\s+"[^"]*")?\\)',           // 3,4 imagem
    '\\[([^\\]]+)\\]\\(' + URL_MD + '(?:\\s+"[^"]*")?\\)',            // 5,6 link
    '(https?:\\/\\/[^\\s<>"]*[^\\s<>".,;:!?\\)\\]\'])',             // 7 url solta
    '(anexo:[A-Za-z0-9._\\/-]*[A-Za-z0-9_\\/-])',                     // 8 anexo solto
    '\\*\\*(?!\\s)([\\s\\S]+?)\\*\\*',                                // 9 negrito
    '__(?!\\s)([\\s\\S]+?)__(?!\\w)',                                 // 10 negrito
    '~~(?!\\s)([\\s\\S]+?)~~',                                        // 11 riscado
    '(?<![\\w*])\\*(?![\\s*])([^*\\n]+?)\\*(?![\\w*])',              // 12 itálico
    '(?<![\\w])_(?![\\s_])([^_\\n]+?)_(?![\\w])',                     // 13 itálico
    '(?<![\\w@.])@([A-Za-z0-9_]{2,})'                                 // 14 menção
  ].join('|'), 'g');

  function inline(txt, ctx) {
    var out = '', ultimo = 0, m;
    RX_INLINE.lastIndex = 0;
    var rx = new RegExp(RX_INLINE.source, 'g');
    while ((m = rx.exec(txt))) {
      out += esc(txt.slice(ultimo, m.index));
      ultimo = rx.lastIndex;
      if (m[2] !== undefined) out += '<code>' + esc(m[2]) + '</code>';
      else if (m[4] !== undefined) out += imagem(m[4], m[3], ctx);
      else if (m[6] !== undefined) out += link(m[6], inline(m[5], ctx), ctx);
      else if (m[7] !== undefined) out += link(m[7], esc(m[7]), ctx);
      else if (m[8] !== undefined) out += link(m[8], esc(nomeDoCaminho(m[8])), ctx);
      else if (m[9] !== undefined) out += '<strong>' + inline(m[9], ctx) + '</strong>';
      else if (m[10] !== undefined) out += '<strong>' + inline(m[10], ctx) + '</strong>';
      else if (m[11] !== undefined) out += '<del>' + inline(m[11], ctx) + '</del>';
      else if (m[12] !== undefined) out += '<em>' + inline(m[12], ctx) + '</em>';
      else if (m[13] !== undefined) out += '<em>' + inline(m[13], ctx) + '</em>';
      else if (m[14] !== undefined) {
        var u = m[14], nome = ctx && ctx.usuarios && ctx.usuarios[u.toLowerCase()];
        out += '<span class="kb-mencao">@' + esc(nome || u) + '</span>';
      }
      if (m[0] === '') rx.lastIndex++;
    }
    return out + esc(txt.slice(ultimo));
  }

  var RX_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

  /* Blocos: título (#), linha (---), citação (>), lista (com recuo = lista dentro de
   * lista) e parágrafo. Linha em branco separa parágrafos; quebra simples vira <br>,
   * que é como o Trello mostra. */
  function markdown(texto, ctx) {
    var linhas = String(texto || '').replace(/\r\n?/g, '\n').split('\n');
    var html = [], par = [], i = 0;

    function fecharPar() {
      if (par.length) html.push('<p>' + par.map(function (l) { return inline(l, ctx); }).join('<br>') + '</p>');
      par = [];
    }

    while (i < linhas.length) {
      var l = linhas[i];
      var h = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l);
      if (!l.trim()) { fecharPar(); i++; continue; }
      if (h) {
        fecharPar();
        var n = Math.min(h[1].length + 2, 6);         // título do markdown é grande demais num card
        html.push('<h' + n + '>' + inline(h[2], ctx) + '</h' + n + '>');
        i++; continue;
      }
      if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(l)) { fecharPar(); html.push('<hr>'); i++; continue; }
      if (/^\s{0,3}>/.test(l)) {
        fecharPar();
        var cit = [];
        while (i < linhas.length && /^\s{0,3}>/.test(linhas[i])) {
          cit.push(linhas[i].replace(/^\s{0,3}>\s?/, '')); i++;
        }
        html.push('<blockquote>' + markdown(cit.join('\n'), ctx) + '</blockquote>');
        continue;
      }
      if (RX_ITEM.test(l)) {
        fecharPar();
        var pilha = [], saida = '';
        while (i < linhas.length && (RX_ITEM.test(linhas[i])
               || (linhas[i].trim() && /^\s{2,}/.test(linhas[i]) && pilha.length))) {
          var it = RX_ITEM.exec(linhas[i]);
          if (!it) {                                   // continuação do item anterior
            saida += '<br>' + inline(linhas[i].trim(), ctx); i++; continue;
          }
          var recuo = it[1].replace(/\t/g, '    ').length;
          var tag = /\d/.test(it[2]) ? 'ol' : 'ul';
          while (pilha.length && recuo < pilha[pilha.length - 1].recuo) {
            saida += '</li></' + pilha.pop().tag + '>';
          }
          var topo = pilha[pilha.length - 1];
          if (!topo || recuo > topo.recuo) {
            pilha.push({ recuo: recuo, tag: tag });
            saida += '<' + tag + '><li>';
          } else {
            saida += '</li><li>';
          }
          saida += inline(it[3], ctx);
          i++;
        }
        while (pilha.length) saida += '</li></' + pilha.pop().tag + '>';
        html.push(saida);
        continue;
      }
      par.push(l);
      i++;
    }
    fecharPar();
    return html.join('');
  }

  /* ---------- histórico ----------
   * Uma frase por evento. `tipo` e `dados` são os mesmos dos gatilhos do hub_schema.sql
   * (eventos do hub) e de tools/import_trello_kanban.py (eventos do Trello).
   * `noBoard`: a frase aparece na atividade do board inteiro, então diz de que card é. */
  function frase(at, noBoard) {
    var d = at.dados || {}, b = function (s) { return '<b>' + esc(s || '?') + '</b>'; };
    var card = noBoard ? (d.card || at.card_nome) : null;
    var este = card ? b(card) : 'este card';
    var deste = card ? b(card) : 'deste card';
    var neste = card ? 'em ' + b(card) : 'neste card';
    switch (at.tipo) {
      case 'criou': return 'criou ' + este + (d.lista ? ' em ' + b(d.lista) : '')
        + (d.de_item ? ' a partir de um item do checklist ' + b(d.de_item) : '');
      case 'copiou': return 'copiou ' + este + ' de ' + b(d.origem) + (d.lista ? ' para ' + b(d.lista) : '');
      case 'veio_de_outro_board': return 'trouxe ' + este + ' de outro board' + (d.lista ? ' para ' + b(d.lista) : '');
      case 'moveu': return 'moveu ' + este + ' de ' + b(d.de) + ' para ' + b(d.para);
      case 'arquivou': return 'arquivou ' + este;
      case 'restaurou': return 'restaurou ' + este;
      case 'excluiu': return 'excluiu o card ' + b(d.card) + (d.lista ? ' de ' + b(d.lista) : '');
      case 'renomeou': return 'renomeou ' + (card ? 'o card' : 'este card') + ' de ' + b(d.de) + ' para ' + b(d.para);
      case 'descricao': return 'alterou a descrição ' + (card ? 'de ' + b(card) : 'deste card');
      case 'prazo': return d.para ? 'definiu o prazo ' + (card ? 'de ' + b(card) + ' ' : '') + 'para ' + b(dataHora(d.para))
        : 'removeu o prazo ' + deste;
      case 'prazo_concluido': return (d.valor ? 'marcou como concluído o prazo ' : 'reabriu o prazo ') + deste;
      case 'item_concluido': return 'concluiu ' + b(d.item) + (card ? ' em ' + b(card) : '');
      case 'item_reaberto': return 'desmarcou ' + b(d.item) + (card ? ' em ' + b(card) : '');
      case 'membro_entrou': return (at.autor_nome && d.membro === at.autor_nome)
        ? 'entrou ' + neste : 'incluiu ' + b(d.membro) + ' ' + neste;
      case 'membro_saiu': return (at.autor_nome && d.membro === at.autor_nome)
        ? 'saiu ' + deste : 'tirou ' + b(d.membro) + ' ' + deste;
      case 'etiqueta_pos': return 'pôs a etiqueta ' + b(d.etiqueta || 'sem nome') + ' ' + neste;
      case 'etiqueta_tirou': return 'tirou a etiqueta ' + b(d.etiqueta || 'sem nome') + ' ' + deste;
      case 'anexo_incluiu': return 'anexou ' + b(d.anexo) + ' ' + neste;
      case 'anexo_excluiu': return 'excluiu o anexo ' + b(d.anexo) + ' ' + deste;
      case 'checklist_criou': return 'adicionou o checklist ' + b(d.checklist) + ' ' + neste;
      case 'checklist_excluiu': return 'removeu o checklist ' + b(d.checklist) + ' ' + deste;
      case 'checklist_renomeou': return 'renomeou o checklist ' + b(d.de) + ' para ' + b(d.para) + (card ? ' em ' + b(card) : '');
      case 'lista_criou': return 'criou a lista ' + b(d.lista);
      case 'lista_renomeou': return 'renomeou a lista ' + b(d.de) + ' para ' + b(d.para);
      case 'lista_arquivou': return 'arquivou a lista ' + b(d.lista);
      case 'lista_restaurou': return 'restaurou a lista ' + b(d.lista);
      case 'board_membro': return 'incluiu ' + b(d.membro) + ' no board';
      case 'board_criou': return 'criou o board';
      default: return 'alteração no Trello (' + esc(String(at.tipo).replace(/^trello_/, '')) + ')' + (card ? ' em ' + b(card) : '');
    }
  }

  /* ---------- resumo do card na coluna ---------- */
  function progresso(itens) {
    var feitos = 0;
    (itens || []).forEach(function (i) { if (i.concluido) feitos++; });
    return { feitos: feitos, total: (itens || []).length };
  }

  function tamanho(bytes) {
    if (bytes == null) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1).replace('.', ',') + ' MB';
  }

  function ehImagem(mime, nome) {
    return /^image\/(png|jpe?g|gif|webp|bmp)$/i.test(mime || '')
      || /\.(png|jpe?g|gif|webp|bmp)$/i.test(nome || '');
  }

  // nome aceito pelo Storage; o nome de verdade fica na linha do anexo
  function nomeSeguro(nome) {
    var base = String(nome || 'arquivo').normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+|[._]+$/g, '') || 'arquivo';
    if (base.length > 120) {
      var p = base.lastIndexOf('.'), ext = p > 0 ? base.slice(p) : '';
      base = base.slice(0, 120 - ext.length) + ext;
    }
    return base;
  }

  return {
    esc: esc, normal: normal, iniciais: iniciais,
    CORES: CORES, corEtiqueta: corEtiqueta, textoEtiqueta: textoEtiqueta,
    PASSO: PASSO, posEntre: posEntre, renumerar: renumerar, porPos: porPos,
    passa: passa, filtroAtivo: filtroAtivo,
    prazoEstado: prazoEstado, dataCurta: dataCurta, dataHora: dataHora,
    markdown: markdown, urlSegura: urlSegura, frase: frase,
    progresso: progresso, tamanho: tamanho, ehImagem: ehImagem, nomeSeguro: nomeSeguro
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = KB_DADOS;
