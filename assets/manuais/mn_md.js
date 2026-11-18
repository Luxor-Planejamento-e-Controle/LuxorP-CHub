/* Markdown dos manuais → HTML. Subconjunto pequeno e SEGURO, escrito à mão (o hub não
 * tem build step nem lib de markdown vendorizada, e o texto vem do banco: tudo é escapado
 * antes de virar tag).
 *
 *   ## / ### / ####      títulos (# vira ##: o título da seção já é o h1 da página)
 *   - item / 1. item     listas, aninhadas por recuo de 2+ espaços
 *   > texto              destaque (caixa com barra laranja)
 *   ```                  bloco de código/caminho, com botão Copiar
 *   | a | b |            tabela (a 2ª linha é |---|---|)
 *   ---                  divisória
 *   ![legenda](img/x)    print; sozinho na linha vira figura com legenda
 *   `x` **x** *x* [x](url)
 *
 * Imagem só de `img/<arquivo>` (o bucket do manual) — a URL assinada vem do mapa `imgs`.
 * Link só http(s), mailto e #âncora.
 */
(function () {
  'use strict';

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function hrefOk(u) {
    return /^(https?:\/\/|mailto:|#)/i.test(u) ? u : null;
  }

  // `img/arquivo.png` → nome do arquivo; qualquer outra coisa não é imagem do manual
  function nomeImg(src) {
    var m = /^img\/([A-Za-z0-9._-]+)$/.exec(src.trim());
    return m ? m[1] : null;
  }

  function imgTag(alt, src, ctx) {
    var nome = nomeImg(src);
    if (!nome) return esc('![' + alt + '](' + src + ')');
    var url = ctx.imgs && ctx.imgs[nome];
    if (!url) return '<span class="img-falta" data-img="' + esc(nome) + '">imagem indisponível: ' + esc(nome) + '</span>';
    return '<img src="' + esc(url) + '" alt="' + esc(alt) + '" data-img="' + esc(nome) + '" loading="lazy">';
  }

  /* inline: o texto chega CRU; código é separado primeiro (nada dentro dele é formatado) */
  function inline(txt, ctx) {
    var partes = String(txt).split(/(`[^`]+`)/);
    return partes.map(function (p) {
      if (/^`[^`]+`$/.test(p)) return '<code>' + esc(p.slice(1, -1)) + '</code>';
      var out = '', re = /!\[([^\]]*)\]\(([^)\s]+)\)|\[([^\]]+)\]\(([^)\s]+)\)/g, ult = 0, m;
      while ((m = re.exec(p))) {
        out += enfase(esc(p.slice(ult, m.index)));
        if (m[2] !== undefined && m[0][0] === '!') {
          out += imgTag(m[1], m[2], ctx);
        } else {
          var h = hrefOk(m[4]);
          var ext = h && !/^#/.test(h);
          out += h ? '<a href="' + esc(h) + '"' + (ext ? ' target="_blank" rel="noopener"' : '') + '>' +
                     enfase(esc(m[3])) + '</a>'
                   : esc(m[0]);
        }
        ult = re.lastIndex;
      }
      return out + enfase(esc(p.slice(ult)));
    }).join('');
  }

  function enfase(h) {
    return h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
            .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  }

  function linhaTabela(l) {
    var s = l.trim().replace(/^\|/, '').replace(/\|$/, '');
    return s.split('|').map(function (c) { return c.trim(); });
  }
  var SEP_TABELA = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
  var ITEM = /^(\s*)([-*]|\d+[.)])\s+(.*)$/;

  /* listas por recuo: devolve [html, próxima linha] */
  function lista(ls, i, ctx) {
    var m0 = ITEM.exec(ls[i]);
    var base = m0[1].length, ordenada = /\d/.test(m0[2]);
    // lista numerada que recomeça depois de um print ou bloco de código continua a contagem
    var ini = ordenada ? parseInt(m0[2], 10) : 1;
    var html = ordenada ? (ini > 1 ? '<ol start="' + ini + '">' : '<ol>') : '<ul>';
    while (i < ls.length) {
      var m = ITEM.exec(ls[i]);
      if (!m || m[1].length < base) break;
      if (m[1].length > base) {               // sublista do item anterior
        var sub = lista(ls, i, ctx);
        html = html.replace(/<\/li>$/, sub[0] + '</li>');
        i = sub[1];
        continue;
      }
      var txt = m[3];
      i++;
      // continuação do item: linha recuada que não é item novo
      while (i < ls.length && ls[i].trim() && !ITEM.test(ls[i]) && /^\s{2,}/.test(ls[i])) {
        txt += ' ' + ls[i].trim();
        i++;
      }
      html += '<li>' + inline(txt, ctx) + '</li>';
      // linha em branco entre itens da mesma lista não quebra a lista
      if (i < ls.length && !ls[i].trim() && i + 1 < ls.length && ITEM.test(ls[i + 1]) &&
          ITEM.exec(ls[i + 1])[1].length >= base) i++;
    }
    return [html + (ordenada ? '</ol>' : '</ul>'), i];
  }

  function render(md, ctx) {
    ctx = ctx || {};
    var ls = String(md || '').replace(/\r\n?/g, '\n').split('\n');
    var out = [], i = 0;
    while (i < ls.length) {
      var l = ls[i];
      if (!l.trim()) { i++; continue; }

      if (/^\s*```/.test(l)) {
        var cod = [];
        i++;
        while (i < ls.length && !/^\s*```/.test(ls[i])) { cod.push(ls[i]); i++; }
        i++;
        out.push('<div class="cod"><button type="button" class="copiar" title="Copiar">Copiar</button>' +
                 '<pre><code>' + esc(cod.join('\n')) + '</code></pre></div>');
        continue;
      }
      var h = /^(#{1,4})\s+(.*)$/.exec(l);
      if (h) {
        var n = Math.max(2, h[1].length);
        out.push('<h' + n + '>' + inline(h[2], ctx) + '</h' + n + '>');
        i++;
        continue;
      }
      if (/^\s*(-{3,}|\*{3,})\s*$/.test(l)) { out.push('<hr>'); i++; continue; }
      if (/^\s*>/.test(l)) {
        var q = [];
        while (i < ls.length && /^\s*>/.test(ls[i])) { q.push(ls[i].replace(/^\s*>\s?/, '')); i++; }
        out.push('<blockquote>' + render(q.join('\n'), ctx) + '</blockquote>');
        continue;
      }
      if (/^\s*\|/.test(l) && i + 1 < ls.length && SEP_TABELA.test(ls[i + 1])) {
        var cab = linhaTabela(l);
        i += 2;
        var t = '<div class="tab"><table><thead><tr>' +
                cab.map(function (c) { return '<th>' + inline(c, ctx) + '</th>'; }).join('') + '</tr></thead><tbody>';
        while (i < ls.length && /^\s*\|/.test(ls[i])) {
          t += '<tr>' + linhaTabela(ls[i]).map(function (c) { return '<td>' + inline(c, ctx) + '</td>'; }).join('') + '</tr>';
          i++;
        }
        out.push(t + '</tbody></table></div>');
        continue;
      }
      if (ITEM.test(l)) {
        var r = lista(ls, i, ctx);
        out.push(r[0]);
        i = r[1];
        continue;
      }
      var fig = /^\s*!\[([^\]]*)\]\(([^)\s]+)\)\s*$/.exec(l);
      if (fig) {
        out.push('<figure>' + imgTag(fig[1], fig[2], ctx) +
                 (fig[1] ? '<figcaption>' + inline(fig[1], ctx) + '</figcaption>' : '') + '</figure>');
        i++;
        continue;
      }
      var par = [];
      while (i < ls.length && ls[i].trim() && !/^\s*(```|#{1,4}\s|>|\|)/.test(ls[i]) && !ITEM.test(ls[i]) &&
             !/^\s*!\[[^\]]*\]\([^)\s]+\)\s*$/.test(ls[i]) && !/^\s*(-{3,}|\*{3,})\s*$/.test(ls[i])) {
        par.push(ls[i].trim());
        i++;
      }
      out.push('<p>' + inline(par.join(' '), ctx) + '</p>');
    }
    return out.join('\n');
  }

  /* arquivos de imagem citados no texto (para pedir as URLs assinadas de uma vez) */
  function imagens(md) {
    var re = /!\[[^\]]*\]\(([^)\s]+)\)/g, m, nomes = {};
    while ((m = re.exec(String(md || '')))) {
      var n = nomeImg(m[1]);
      if (n) nomes[n] = 1;
    }
    return Object.keys(nomes);
  }

  /* texto puro, para a busca */
  function texto(md) {
    return String(md || '').replace(/!\[[^\]]*\]\([^)]*\)/g, ' ').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/[#>*`|_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  window.MN_MD = {render: render, imagens: imagens, texto: texto, esc: esc};
})();
