/* Exporta a tabela de Movimentações e o quadro de Sugestões para PDF — sem biblioteca.
 *
 * O QUE SAI: exatamente o que está na tela, e isso é garantido por construção — a função
 * recebe o MESMO array `contas` que `tabelaContas` renderiza, já ordenado e já filtrado.
 * Não há um segundo caminho de cálculo que possa divergir: se o número está errado no PDF,
 * está errado na tela.
 *
 * O que NÃO sai: o fluxo dia a dia e a aba de títulos. O pedido foi a tabela e as
 * sugestões (Leonardo, 30/09/2026) — que é o que se leva para a conversa com o banco.
 *
 * POR QUE À MÃO. Um PDF é texto: objetos numerados, um índice (xref) com o deslocamento
 * EM BYTES de cada um, e streams de operadores de desenho. Usando as fontes base-14
 * (Helvetica), que todo leitor já tem, não é preciso embutir fonte nenhuma. São ~250
 * linhas em vez de vendorizar 350 KB de jsPDF num repositório PÚBLICO — e o hub paga
 * cada deploy em crédito de Netlify, então o tamanho do repositório não é detalhe.
 *
 * O núcleo (WinAnsi, larguras do Helvetica, `Tela`, `montarPdf`) é o mesmo já usado no
 * painel de Gastos do Haras, copiado e não importado: são dois repositórios diferentes, e
 * um import entre eles criaria uma dependência que nenhum dos dois declara.
 */
window.SB_PDF = (function () {
  'use strict';

  /* ─────────────── texto: WinAnsi, escape e medição ─────────────── */

  /* As base-14 usam WinAnsiEncoding: um byte por caractere. O português cabe inteiro
   * (ç ã õ é í â…), porque de 0xA0 para cima WinAnsi é igual a Latin-1. O que NÃO cabe
   * são os sinais tipográficos que o painel usa — o menos U+2212, o travessão, o `└` da
   * hierarquia. Traduzidos aqui; passando direto, sairia lixo na página. */
  var WINANSI = {
    0x2212: 0x2D, 0x2013: 0x96, 0x2014: 0x97, 0x2018: 0x91, 0x2019: 0x92,
    0x201C: 0x93, 0x201D: 0x94, 0x2022: 0x95, 0x2026: 0x85, 0x20AC: 0x80
  };
  var DESCARTAR = { 0x2514: 1, 0x00A0: 1, 0x2193: 1, 0x2191: 1 };

  function paraWinAnsi(s) {
    var out = '', str = String(s == null ? '' : s);
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (DESCARTAR[c]) { out += ' '; continue; }
      var b = WINANSI[c] != null ? WINANSI[c] : c;
      out += b <= 0xFF ? String.fromCharCode(b) : '?';
    }
    return out;
  }
  /* string literal de PDF: `(`, `)` e `\` precisam de escape */
  function pdfStr(s) {
    return '(' + paraWinAnsi(s).replace(/[\\()]/g, function (m) { return '\\' + m; }) + ')';
  }

  /* Larguras do Helvetica em milésimos de em, ASCII 32..126 (tabela das base-14).
   * Servem para alinhar número à direita e decidir onde cortar o texto. */
  var W_REG = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
    1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
    333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
    556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
  var W_NEG = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
    975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
    333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
    611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];

  function larguraTexto(s, tam, negrito) {
    var tab = negrito ? W_NEG : W_REG, m = 0, t = paraWinAnsi(s);
    for (var i = 0; i < t.length; i++) {
      var c = t.charCodeAt(i);
      // acentuado: usa a largura da letra-base (maiúscula é mais larga)
      m += (c >= 32 && c <= 126) ? tab[c - 32]
        : (c >= 0xC0 && c <= 0xDE) ? (negrito ? 722 : 700)
          : (c >= 0xDF) ? (negrito ? 611 : 556) : 0;
    }
    return m / 1000 * tam;
  }
  /* corta com "…" para caber; o clip é a garantia, isto é a estética */
  function cortar(s, largura, tam, negrito) {
    if (larguraTexto(s, tam, negrito) <= largura) return String(s == null ? '' : s);
    var t = String(s);
    while (t.length > 1 && larguraTexto(t + '…', tam, negrito) > largura) t = t.slice(0, -1);
    return t + '…';
  }

  /* ─────────────── operadores de desenho ─────────────── */
  function rgb(h) {
    var n = parseInt(h.replace('#', ''), 16);
    return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]
      .map(function (v) { return v.toFixed(3); }).join(' ');
  }
  function n2(v) { return (Math.round(v * 100) / 100).toString(); }

  function Tela() { this.ops = []; }
  Tela.prototype.retangulo = function (x, y, w, h, cor) {
    this.ops.push(rgb(cor) + ' rg ' + n2(x) + ' ' + n2(y) + ' ' + n2(w) + ' ' + n2(h) + ' re f');
  };
  Tela.prototype.linha = function (x1, y1, x2, y2, cor, esp) {
    this.ops.push(rgb(cor) + ' RG ' + n2(esp || 0.4) + ' w ' + n2(x1) + ' ' + n2(y1)
      + ' m ' + n2(x2) + ' ' + n2(y2) + ' l S');
  };
  /* alinha: 'e' esquerda, 'd' direita, 'c' centro.
   * `clip` protege a coluna vizinha de um texto mais largo que a célula. Só o texto de
   * largura imprevisível leva clip; número não precisa, porque os dígitos do Helvetica
   * têm largura exata e `cortar` já garante que cabe. */
  Tela.prototype.texto = function (s, x, y, w, tam, cor, negrito, alinha, clip) {
    if (s === '' || s == null) return;
    var t = cortar(s, w - 4, tam, negrito);
    var lt = larguraTexto(t, tam, negrito);
    var px = alinha === 'd' ? x + w - 3 - lt : alinha === 'c' ? x + (w - lt) / 2 : x + 3;
    var desenho = 'BT ' + rgb(cor) + ' rg /' + (negrito ? 'F2' : 'F1') + ' ' + n2(tam)
      + ' Tf ' + n2(px) + ' ' + n2(y) + ' Td ' + pdfStr(t) + ' Tj ET';
    this.ops.push(clip
      ? 'q ' + n2(x) + ' ' + n2(y - 1) + ' ' + n2(w) + ' ' + n2(tam + 3) + ' re W n '
        + desenho + ' Q'
      : desenho);
  };
  Tela.prototype.fim = function () { return this.ops.join('\n'); };

  /* ─────────────── montagem do arquivo ─────────────── */
  /* Construído como binary string (1 caractere = 1 byte, tudo já em WinAnsi) e convertido
   * para Uint8Array só no fim: assim `s.length` é o offset verdadeiro que o xref precisa.
   * Um byte fora e alguns leitores reconstroem em silêncio, outros recusam o arquivo. */
  function montarPdf(paginas, larguraPag, alturaPag) {
    var objs = [];
    function add(corpo) { objs.push(corpo); return objs.length; }

    var nCatalogo = add(null);   // reservado: precisa do /Pages
    var nPaginas = add(null);    // reservado: precisa dos /Kids
    var nF1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica '
      + '/Encoding /WinAnsiEncoding >>');
    var nF2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold '
      + '/Encoding /WinAnsiEncoding >>');

    var kids = [];
    paginas.forEach(function (ops) {
      var nStream = add('<< /Length ' + ops.length + ' >>\nstream\n' + ops + '\nendstream');
      var nPag = add('<< /Type /Page /Parent ' + nPaginas + ' 0 R'
        + ' /MediaBox [0 0 ' + n2(larguraPag) + ' ' + n2(alturaPag) + ']'
        + ' /Resources << /Font << /F1 ' + nF1 + ' 0 R /F2 ' + nF2 + ' 0 R >> >>'
        + ' /Contents ' + nStream + ' 0 R >>');
      kids.push(nPag + ' 0 R');
    });
    objs[nCatalogo - 1] = '<< /Type /Catalog /Pages ' + nPaginas + ' 0 R >>';
    objs[nPaginas - 1] = '<< /Type /Pages /Kids [' + kids.join(' ') + '] /Count '
      + kids.length + ' >>';

    var saida = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
    var desl = [];
    for (var i = 0; i < objs.length; i++) {
      desl.push(saida.length);
      saida += (i + 1) + ' 0 obj\n' + objs[i] + '\nendobj\n';
    }
    var inicioXref = saida.length;
    saida += 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n';
    desl.forEach(function (d) {
      saida += String(d).padStart(10, '0') + ' 00000 n \n';
    });
    saida += 'trailer\n<< /Size ' + (objs.length + 1) + ' /Root ' + nCatalogo + ' 0 R >>\n'
      + 'startxref\n' + inicioXref + '\n%%EOF\n';

    var bytes = new Uint8Array(saida.length);
    for (var j = 0; j < saida.length; j++) bytes[j] = saida.charCodeAt(j) & 0xFF;
    return bytes;
  }

  /* ─────────────── layout ─────────────── */
  /* Em PAPEL, e não no tema escuro do hub: tinta preta em fundo escuro não imprime, e
   * este arquivo existe para ser impresso ou anexado num e-mail para o banco. */
  var COR = {
    cab: '#1A3C34', cabTxt: '#FFFFFF', papel: '#FFFFFF',
    conta: '#F2F7F6', inv: '#FFFFFF', total: '#DCE9E6',
    txt: '#12211E', suave: '#5B6B68', linha: '#C8D6D3',
    resgate: '#C00000', aplicar: '#1F6B3F', neutro: '#5B6B68'
  };

  var A4H = { l: 841.89, a: 595.28 };   // A4 paisagem, em pontos
  var MG = 24;
  var TAM = 7.5;
  var ALT_LIN = 13;

  /* Larguras somando 793,89 (= 841,89 − 2×24).
   *
   * Conta e Movimentação levam a folga porque são as duas de texto livre, e é onde cortar
   * dói: com 186pt na primeira, "Luxor Investimentos - Itau CDB-DI · origem do resgate"
   * saía como "…origem do re.". As colunas de número foram medidas contra o maior valor
   * que aparece — R$ 8.485.119,17, o total aplicado — e sobrava espaço em todas. */
  var COLS = [
    { k: 'conta',    t: 'Conta',              w: 240, a: 'e' },
    { k: 'saldo',    t: 'Saldo',              w: 66,  a: 'd' },
    { k: 'a_pagar',  t: 'Saídas da semana',   w: 78,  a: 'd' },
    { k: 'a_receber', t: 'Entradas previstas', w: 78, a: 'd' },
    { k: 'restante', t: 'Saldo restante',     w: 78,  a: 'd' },
    { k: 'colchao',  t: 'Colchão',            w: 60,  a: 'd' },
    // 84 e não 70: "Em descontinuação" é o rótulo mais longo e saía "Em descontinuaçã.."
    { k: 'sit',      t: 'Situação',           w: 84,  a: 'e' },
    // e 110 aqui: embaixo da ação vai o nome inteiro da aplicação par, que é o texto
    // mais longo da tabela ("Condomínio CHPG - Itau CDB-DI")
    { k: 'mov',      t: 'Movimentação',       w: 109.89, a: 'e' }
  ];

  function brl(v) {
    if (v === null || v === undefined || v === '') return '';
    var n = Number(v);
    if (!isFinite(n)) return '';
    return (n < 0 ? '-' : '') + 'R$ ' + Math.abs(n)
      .toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  var ROTULO_SIT = {
    resgate: 'Resgatar', sem_colchao: 'Sem colchão', aplicar: 'Aplicar',
    sem_acao: 'Sem ação', descontinuada: 'Em descontinuação'
  };

  /* As linhas do PDF, na ORDEM DA TELA: cada conta seguida das aplicações dela.
   * `situacao` chega de fora (é a mesma função que a tabela usa para decidir o rótulo e
   * a cor) — reimplementá-la aqui criaria uma segunda regra que diverge da primeira. */
  function linhas(contas, situacao) {
    var out = [];
    (contas || []).forEach(function (c) {
      var s = situacao(c);
      out.push({
        tipo: 'conta',
        conta: c.conta, sub: c.chave,
        saldo: brl(c.saldo),
        a_pagar: c.a_pagar ? brl(c.a_pagar) : '—',
        a_receber: c.a_receber ? brl(c.a_receber) : '—',
        restante: brl(c.restante),
        colchao: c.colchao != null ? brl(c.colchao) : '—',
        sit: ROTULO_SIT[s] || s,
        mov: c.acao
          ? (c.acao === 'resgate' ? 'Resgatar ' : 'Aplicar ') + (c.valor_rotulo || '')
          : '',
        /* Mais curto que na tela: a coluna tem 100pt no papel e a frase inteira saía
         * cortada em "sem colch…", que não diz nada. A tela tem largura elástica. */
        movSub: c.acao
          ? (c.par_nome || 'sem investimento par')
          : (s === 'descontinuada' ? 'sendo encerrada'
            : s === 'sem_colchao' ? 'colchão não definido' : 'dentro do colchão'),
        acao: c.acao || null
      });
      (c.investimentos || []).forEach(function (i) {
        var marca = i.tipo !== 'aplicacao' ? 'conta, não aplicação'
          : (c.par_nome && i.nome === c.par_nome
            ? (c.acao === 'resgate' ? 'origem do resgate'
              : c.acao ? 'destino da aplicação' : 'aplicação par')
            : 'aplicação');
        out.push({
          tipo: 'inv',
          // nome e marca na MESMA linha: a aplicação é linha de detalhe e ganha uma faixa
          // de uma linha só. Em duas, a segunda caía fora da faixa e a conta seguinte
          // desenhava o fundo por cima dela — some metade do texto, sem erro nenhum.
          conta: i.nome + '  ·  ' + marca,
          saldo: brl(i.saldo)
        });
      });
    });
    return out;
  }

  function totais(contas) {
    var t = { saldo: 0, a_pagar: 0, a_receber: 0, restante: 0, aplicado: 0 };
    (contas || []).forEach(function (c) {
      t.saldo += Number(c.saldo) || 0;
      t.a_pagar += Number(c.a_pagar) || 0;
      t.a_receber += Number(c.a_receber) || 0;
      t.restante += Number(c.restante) || 0;
      (c.investimentos || []).forEach(function (i) {
        if (i.tipo === 'aplicacao') t.aplicado += Number(i.saldo) || 0;
      });
    });
    return t;
  }

  function cabecalhoPagina(tela, meta, pag, nPags) {
    var y = A4H.a - MG - 12;
    tela.texto('Saldo Bancário — Grupo Luxor', MG, y, 500, 13, COR.cab, true, 'e');
    tela.texto('página ' + pag + ' de ' + nPags, A4H.l - MG - 120, y, 120, 8,
      COR.suave, false, 'd');
    y -= 12;
    var sub = 'Projeção de caixa da semana';
    if (meta.janela) sub += ' · janela ' + meta.janela;
    if (meta.dataSaldo) sub += ' · saldo de ' + meta.dataSaldo;
    if (meta.filtrado) sub += ' · FILTRADO';
    tela.texto(sub, MG, y, A4H.l - 2 * MG, 8, COR.suave, false, 'e');
    return y - 16;
  }

  /* TODO desenho daqui para baixo trabalha com FAIXA: `y` é o TOPO da linha e a função
   * devolve o topo da próxima. A primeira versão usava a baseline do texto como
   * referência, e o subtítulo — desenhado 6,5pt abaixo dela — caía fora do retângulo de
   * fundo: a linha seguinte pintava o fundo por cima e comia metade do texto. Some sem
   * erro nenhum, e só o raster mostra. */
  function altura(l) { return l.tipo === 'conta' ? 20 : 12.5; }

  function cabecalhoTabela(tela, y) {
    var alt = ALT_LIN + 3;
    tela.retangulo(MG, y - alt, A4H.l - 2 * MG, alt, COR.cab);
    var x = MG;
    COLS.forEach(function (c) {
      tela.texto(c.t, x, y - alt + 4.5, c.w, TAM, COR.cabTxt, true, c.a, true);
      x += c.w;
    });
    return y - alt;
  }

  function desenharLinha(tela, l, y) {
    var alt = altura(l);
    var base = y - alt;
    tela.retangulo(MG, base, A4H.l - 2 * MG, alt, l.tipo === 'conta' ? COR.conta : COR.inv);
    // duas linhas de texto na faixa da conta; uma só na da aplicação
    var yPrim = l.tipo === 'conta' ? base + 11 : base + 3.5;
    var ySub = base + 3.5;
    var x = MG;
    COLS.forEach(function (c) {
      var v = l[c.k];
      if (c.k === 'conta') {
        // o `└` da tela vira recuo de verdade: o caractere não existe em WinAnsi
        var recuo = l.tipo === 'inv' ? 14 : 0;
        tela.texto(v, x + recuo, yPrim, c.w - recuo, l.tipo === 'conta' ? TAM + 0.5 : TAM,
          l.tipo === 'conta' ? COR.txt : COR.suave, l.tipo === 'conta', 'e', true);
        if (l.sub) {
          tela.texto(l.sub, x + recuo, ySub, c.w - recuo, TAM - 1.5,
            COR.suave, false, 'e', true);
        }
      } else if (c.k === 'sit') {
        tela.texto(v, x, yPrim, c.w, TAM,
          l.acao === 'resgate' ? COR.resgate : l.acao === 'aplicar' ? COR.aplicar : COR.neutro,
          !!l.acao, c.a, true);
      } else if (c.k === 'mov') {
        /* Sem ação, o texto explicativo sobe para a linha de cima: deixado embaixo, ele
         * flutuava sozinho ao lado de uma célula vazia e parecia pertencer à linha
         * seguinte. */
        if (v) {
          tela.texto(v, x, yPrim, c.w, TAM, COR.txt, true, c.a, true);
          if (l.movSub) tela.texto(l.movSub, x, ySub, c.w, TAM - 1.5, COR.suave,
            false, 'e', true);
        } else if (l.movSub) {
          tela.texto(l.movSub, x, yPrim, c.w, TAM - 1, COR.suave, false, 'e', true);
        }
      } else {
        tela.texto(v, x, yPrim, c.w, TAM, COR.txt, false, c.a);
      }
      x += c.w;
    });
    tela.linha(MG, base, A4H.l - MG, base, COR.linha, 0.3);
    return base;
  }

  function desenharTotais(tela, t, y, filtrado) {
    var vals = {
      conta: 'Total em conta corrente' + (filtrado ? ' (filtrado)' : ''),
      saldo: brl(t.saldo), a_pagar: brl(t.a_pagar),
      a_receber: t.a_receber ? brl(t.a_receber) : '—',
      restante: brl(t.restante), colchao: '', sit: '', mov: ''
    };
    [vals, { conta: 'Total aplicado', saldo: brl(t.aplicado) }].forEach(function (linha) {
      var base = y - ALT_LIN;
      tela.retangulo(MG, base, A4H.l - 2 * MG, ALT_LIN, COR.total);
      var x = MG;
      COLS.forEach(function (c) {
        tela.texto(linha[c.k], x, base + 4, c.w, TAM, COR.txt, true, c.a, true);
        x += c.w;
      });
      y = base;
    });
    return y;
  }

  /* As sugestões como CARTÕES, e não como mais uma tabela: é o que se lê primeiro e o que
   * se leva para o banco. Em papel, a cor sozinha não basta (pode ser impresso em preto e
   * branco), então cada cartão diz RESGATAR ou APLICAR por extenso. */
  /* As sugestões ficam numa PÁGINA SÓ DELAS (decisão do Leonardo, 30/09/2026: "a tabela
   * em uma e os cards na outra"). Não é só arrumação: é a folha que se leva para pedir o
   * resgate ao banco, e nela nada mais compete por atenção. Com a página inteira, o
   * cartão cabe em três por linha e o valor sai grande o bastante para ser lido de longe.
   *
   * O custo é uma folha a mais mesmo quando sobra espaço na primeira. É o que foi pedido,
   * e a alternativa — encaixar quando coubesse — daria um documento com duas formas
   * diferentes conforme a semana. */
  var SUG_POR_LINHA = 3;
  var SUG_ALT = 74;
  var SUG_GAP = 10;

  function desenharSugestoes(tela, contas, y) {
    var comAcao = (contas || []).filter(function (c) { return c.acao; });
    var resg = comAcao.filter(function (c) { return c.acao === 'resgate'; }).length;
    var apl = comAcao.length - resg;
    tela.texto('Sugestões de Movimentação', MG, y - 13, 340, 13, COR.cab, true, 'e');
    tela.texto(comAcao.length
      ? resg + (resg === 1 ? ' resgate' : ' resgates') + ' e '
        + apl + (apl === 1 ? ' aplicação' : ' aplicações')
      : 'nada a movimentar nesta semana',
      MG + 196, y - 13, 300, 9, COR.suave, false, 'e');
    y -= 24;

    if (!comAcao.length) {
      tela.texto('Nenhuma movimentação sugerida nesta semana.', MG, y - 12, 500, 9,
        COR.suave, false, 'e');
      return y - 20;
    }

    var larg = (A4H.l - 2 * MG - (SUG_POR_LINHA - 1) * SUG_GAP) / SUG_POR_LINHA;
    comAcao.forEach(function (c, i) {
      var col = i % SUG_POR_LINHA;
      var fila = Math.floor(i / SUG_POR_LINHA);
      var topo = y - fila * (SUG_ALT + SUG_GAP);
      var base = topo - SUG_ALT;
      var x = MG + col * (larg + SUG_GAP);
      var cor = c.acao === 'resgate' ? COR.resgate : COR.aplicar;
      tela.retangulo(x, base, larg, SUG_ALT, COR.conta);
      // a barra colorida na lateral é a marca visual; em impressão preto e branco quem
      // diz o que fazer é a palavra RESGATAR/APLICAR, não a cor
      tela.linha(x + 1.5, base, x + 1.5, topo, cor, 3);
      tela.texto(c.acao === 'resgate' ? 'RESGATAR' : 'APLICAR', x + 10, topo - 15,
        larg - 16, 8.5, cor, true, 'e');
      tela.texto(c.valor_rotulo || '', x + 10, topo - 40, larg - 16, 23, COR.txt, true, 'e');
      tela.texto(c.conta, x + 10, topo - 54, larg - 16, 9, COR.txt, true, 'e', true);
      tela.texto((c.acao === 'resgate' ? 'do ' : 'no ')
        + (c.par_nome || 'sem investimento par'),
        x + 10, topo - 66, larg - 16, 8, COR.suave, false, 'e', true);
    });
    return y - Math.ceil(comAcao.length / SUG_POR_LINHA) * (SUG_ALT + SUG_GAP);
  }

  function rodape(tela, meta) {
    var txt = 'Resgate e aplicação são sugestão para o gestor solicitar ao banco: '
      + 'esta projeção não movimenta dinheiro.';
    if (meta.geradoEm) txt += ' Dados de ' + meta.geradoEm + '.';
    tela.texto(txt, MG, MG - 6, A4H.l - 2 * MG, 6.5, COR.suave, false, 'e');
  }

  /* Quantas linhas cabem numa página. Medido pelo TIPO, não por contagem: a faixa da
   * conta ocupa 20pt e a da aplicação 12,5, então contar "linhas" erraria para mais e a
   * última sairia cortada na borda.
   *
   * A conta não é separada das aplicações dela por quebra de página: uma aplicação órfã
   * no topo da folha seguinte é um saldo sem dono. */
  function paginar(ls, alturaUtil) {
    var pags = [], atual = [], resta = alturaUtil;
    var i = 0;
    while (i < ls.length) {
      var grupo = [ls[i++]];
      while (i < ls.length && ls[i].tipo === 'inv') grupo.push(ls[i++]);
      var h = grupo.reduce(function (s, l) { return s + altura(l); }, 0);
      if (h > resta && atual.length) { pags.push(atual); atual = []; resta = alturaUtil; }
      atual = atual.concat(grupo);
      resta -= h;
    }
    if (atual.length) pags.push(atual);
    return pags;
  }

  function gerar(contas, situacao, meta) {
    var ls = linhas(contas, situacao);
    var t = totais(contas);

    var topo = A4H.a - MG - 40;   // abaixo do título e do subtítulo
    var pe = MG + 14;             // acima do rodapé de procedência
    var util = topo - (ALT_LIN + 3) - pe - 2 * ALT_LIN;   // menos o cabeçalho e os totais

    /* A tabela pagina normalmente; as sugestões entram como UMA página a mais, sempre —
     * ver o comentário em `desenharSugestoes`. Os totais fecham a última página de
     * tabela, junto das linhas que eles somam. */
    var pags = paginar(ls, util);
    var nPags = pags.length + 1;

    var streams = [];
    pags.forEach(function (bloco, idx) {
      var tela = new Tela();
      tela.retangulo(0, 0, A4H.l, A4H.a, COR.papel);
      var y = cabecalhoPagina(tela, meta, idx + 1, nPags);
      y = cabecalhoTabela(tela, y);
      bloco.forEach(function (l) { y = desenharLinha(tela, l, y); });
      if (idx === pags.length - 1) desenharTotais(tela, t, y, meta.filtrado);
      rodape(tela, meta);
      streams.push(tela.fim());
    });

    var telaSug = new Tela();
    telaSug.retangulo(0, 0, A4H.l, A4H.a, COR.papel);
    var ySug = cabecalhoPagina(telaSug, meta, nPags, nPags);
    desenharSugestoes(telaSug, contas, ySug);
    rodape(telaSug, meta);
    streams.push(telaSug.fim());

    return montarPdf(streams, A4H.l, A4H.a);
  }

  function baixar(contas, situacao, meta) {
    var bytes = gerar(contas, situacao, meta);
    var nome = 'saldo-bancario' + (meta.janelaArquivo ? '-' + meta.janelaArquivo : '') + '.pdf';
    var url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    var a = document.createElement('a');
    a.href = url;
    a.download = nome;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // revoga tarde: revogar na mesma volta do laço de eventos cancela o download em
    // alguns navegadores, que ainda não leram o blob quando o <a> é removido
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    return bytes.length;
  }

  return { gerar: gerar, baixar: baixar,
           // expostos para o teste: é onde mora a regra que pode divergir da tela
           linhas: linhas, totais: totais, paraWinAnsi: paraWinAnsi };
})();
