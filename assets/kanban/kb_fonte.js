/* De onde o Kanban lê e onde grava: as tabelas `kanban_*` e o bucket privado `kanban`
 * (seção 8 do sql/hub_schema.sql). Nada passa por app_state nem por hub-data.
 *
 * Quem pode o quê é a RLS que decide (hub_can('kanban')); o que está aqui é só o
 * caminho. Autor de card, comentário e anexo NÃO é mandado daqui: o banco tira do
 * login (gatilho), então não há como gravar em nome de outra pessoa.
 *
 * Um client por página, como no Saldo Bancário (ver sb_fonte.js): dentro do iframe ele
 * reaproveita a sessão do hub (mesmo storageKey).
 */
window.KB_FONTE = (function () {
  'use strict';

  var BUCKET = 'kanban';
  var _sb = null;

  function cliente() {
    if (_sb) return _sb;
    if (!window.supabase || !window.SUPABASE_URL) {
      throw new Error('supabase-js não carregou (veja config.js e ../vendor/supabase.min.js)');
    }
    _sb = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
    return _sb;
  }

  function ok(r, oque) {
    if (r.error) throw new Error((oque ? oque + ': ' : '') + r.error.message);
    return r.data;
  }

  // PostgREST devolve no máximo 1000 linhas por vez: busca em páginas
  async function tudo(montar, oque) {
    var out = [], ini = 0;
    for (;;) {
      var lote = ok(await montar().range(ini, ini + 999), oque) || [];
      out = out.concat(lote);
      if (lote.length < 1000) return out;
      ini += 1000;
    }
  }

  async function sessao() {
    var r = await cliente().auth.getSession();
    var s = r && r.data && r.data.session;
    return s ? { email: (s.user.email || '').toLowerCase() } : null;
  }

  /* Garante a linha de membro de quem abriu (kanban_entrar) e devolve o id dela. */
  async function entrar() {
    return ok(await cliente().rpc('kanban_entrar'), 'entrar no board');
  }

  /* O board aberto: listas, etiquetas, membros e os cards NÃO arquivados, já com o
   * que o resumo do card precisa (etiquetas, membros, itens de checklist, contagem de
   * comentários e anexos). O arquivado vem só quando alguém abre "Arquivados". */
  var CAMPOS_CARD = 'id,lista_id,nome,descricao,pos,arquivado,arquivado_em,prazo,prazo_concluido,modelo,'
    + 'criado_por,criado_em,atualizado_em,trello_url,'
    + 'kanban_card_etiquetas(etiqueta_id),kanban_card_membros(membro_id),'
    + 'kanban_checklists(kanban_checkitens(concluido)),'
    + 'kanban_comentarios(count),kanban_anexos(count)';

  function resumo(c) {
    var itens = [];
    (c.kanban_checklists || []).forEach(function (cl) { itens = itens.concat(cl.kanban_checkitens || []); });
    return {
      id: c.id, lista_id: c.lista_id, nome: c.nome, descricao: c.descricao || '', pos: c.pos,
      arquivado: c.arquivado, arquivado_em: c.arquivado_em, prazo: c.prazo,
      prazo_concluido: c.prazo_concluido, modelo: c.modelo, criado_por: c.criado_por,
      criado_em: c.criado_em, atualizado_em: c.atualizado_em, trello_url: c.trello_url,
      etiquetas: (c.kanban_card_etiquetas || []).map(function (x) { return x.etiqueta_id; }),
      membros: (c.kanban_card_membros || []).map(function (x) { return x.membro_id; }),
      itens: KB_DADOS.progresso(itens),
      comentarios: ((c.kanban_comentarios || [])[0] || {}).count || 0,
      anexos: ((c.kanban_anexos || [])[0] || {}).count || 0
    };
  }

  async function carregarBoard() {
    var sb = cliente();
    var r = await Promise.all([
      tudo(function () { return sb.from('kanban_listas').select('*').order('pos'); }, 'listas'),
      tudo(function () { return sb.from('kanban_etiquetas').select('*').order('nome'); }, 'etiquetas'),
      tudo(function () { return sb.from('kanban_membros').select('id,nome,usuario,email').order('nome'); }, 'membros'),
      tudo(function () {
        return sb.from('kanban_cards').select(CAMPOS_CARD).eq('arquivado', false).order('pos');
      }, 'cards')
    ]);
    return { listas: r[0], etiquetas: r[1], membros: r[2], cards: r[3].map(resumo) };
  }

  async function umResumo(id) {
    var c = ok(await cliente().from('kanban_cards').select(CAMPOS_CARD).eq('id', id).maybeSingle(), 'card');
    return c ? resumo(c) : null;
  }

  /* Tudo do card aberto. O histórico vem inteiro: o card mais movimentado do Trello
   * tem algumas centenas de eventos, o que ainda é pouco. */
  async function carregarCard(id) {
    var sb = cliente();
    var r = await Promise.all([
      sb.from('kanban_cards').select(CAMPOS_CARD).eq('id', id).maybeSingle(),
      sb.from('kanban_checklists').select('id,nome,pos,kanban_checkitens(id,nome,pos,concluido,membro_id,prazo)')
        .eq('card_id', id).order('pos'),
      tudo(function () { return sb.from('kanban_comentarios').select('*').eq('card_id', id).order('criado_em', { ascending: false }); }, 'comentários'),
      sb.from('kanban_anexos').select('*').eq('card_id', id).order('pos'),
      tudo(function () { return sb.from('kanban_atividade').select('*').eq('card_id', id).order('criado_em', { ascending: false }); }, 'histórico')
    ]);
    var c = ok(r[0], 'card');
    if (!c) return null;
    var checklists = ok(r[1], 'checklists').map(function (cl) {
      return { id: cl.id, nome: cl.nome, pos: cl.pos,
               itens: (cl.kanban_checkitens || []).slice().sort(function (a, b) { return a.pos - b.pos; }) };
    });
    return { card: resumo(c), checklists: checklists, comentarios: r[2], anexos: ok(r[3], 'anexos'), atividade: r[4] };
  }

  /* Arquivados: cards arquivados e cards de lista arquivada (no Trello eles somem
   * junto com a lista). Só nome e data — abrir o card busca o resto. */
  async function arquivados(listasArquivadas) {
    var sb = cliente();
    var filtro = listasArquivadas.length
      ? 'arquivado.is.true,lista_id.in.(' + listasArquivadas.join(',') + ')' : 'arquivado.is.true';
    return tudo(function () {
      return sb.from('kanban_cards').select('id,lista_id,nome,arquivado,arquivado_em,atualizado_em')
        .or(filtro).order('arquivado_em', { ascending: false, nullsFirst: false });
    }, 'arquivados');
  }

  async function atividadeBoard(antesDe, limite) {
    var q = cliente().from('kanban_atividade').select('*,kanban_cards(nome)')
      .order('criado_em', { ascending: false }).limit(limite || 60);
    if (antesDe) q = q.lt('criado_em', antesDe);
    return ok(await q, 'atividade').map(function (a) {
      a.card_nome = a.kanban_cards ? a.kanban_cards.nome : null;
      return a;
    });
  }

  /* ---------- escrita ---------- */
  async function criarCard(listaId, nome, pos) {
    return ok(await cliente().from('kanban_cards')
      .insert({ lista_id: listaId, nome: nome, pos: pos }).select('id').single(), 'criar card').id;
  }

  async function atualizarCard(id, campos) {
    ok(await cliente().from('kanban_cards').update(campos).eq('id', id), 'gravar card');
  }

  async function renumerarLista(cards) {
    var sb = cliente(), pos = KB_DADOS.renumerar(cards.length);
    for (var i = 0; i < cards.length; i++) {
      ok(await sb.from('kanban_cards').update({ pos: pos[i] }).eq('id', cards[i].id), 'renumerar');
      cards[i].pos = pos[i];
    }
  }

  async function excluirCard(id) {
    var sb = cliente();
    // os arquivos antes da linha: a linha sumindo leva junto a referência a eles
    var anexos = ok(await sb.from('kanban_anexos').select('caminho').eq('card_id', id), 'anexos') || [];
    var caminhos = anexos.map(function (a) { return a.caminho; }).filter(Boolean);
    if (caminhos.length) ok(await sb.storage.from(BUCKET).remove(caminhos), 'apagar arquivos');
    ok(await sb.from('kanban_cards').delete().eq('id', id), 'excluir card');
  }

  async function copiarCard(origem, nome, listaId, pos, manter) {
    return ok(await cliente().rpc('kanban_copiar_card', {
      p_origem: origem, p_nome: nome, p_lista: listaId, p_pos: pos,
      p_checklists: !!manter.checklists, p_etiquetas: !!manter.etiquetas, p_membros: !!manter.membros
    }), 'copiar card');
  }

  async function alternarEtiqueta(cardId, etqId, ligar) {
    var t = cliente().from('kanban_card_etiquetas');
    ok(await (ligar ? t.insert({ card_id: cardId, etiqueta_id: etqId })
                    : t.delete().eq('card_id', cardId).eq('etiqueta_id', etqId)), 'etiqueta');
  }

  async function alternarMembro(cardId, membroId, ligar) {
    var t = cliente().from('kanban_card_membros');
    ok(await (ligar ? t.insert({ card_id: cardId, membro_id: membroId })
                    : t.delete().eq('card_id', cardId).eq('membro_id', membroId)), 'membro');
  }

  async function salvarEtiqueta(id, nome, cor) {
    var t = cliente().from('kanban_etiquetas');
    if (id) ok(await t.update({ nome: nome, cor: cor }).eq('id', id), 'etiqueta');
    else return ok(await t.insert({ nome: nome, cor: cor }).select('id').single(), 'etiqueta').id;
  }
  async function excluirEtiqueta(id) {
    ok(await cliente().from('kanban_etiquetas').delete().eq('id', id), 'excluir etiqueta');
  }

  async function criarChecklist(cardId, nome, pos) {
    ok(await cliente().from('kanban_checklists').insert({ card_id: cardId, nome: nome, pos: pos }), 'checklist');
  }
  async function renomearChecklist(id, nome) {
    ok(await cliente().from('kanban_checklists').update({ nome: nome }).eq('id', id), 'checklist');
  }
  async function excluirChecklist(id) {
    ok(await cliente().from('kanban_checklists').delete().eq('id', id), 'excluir checklist');
  }
  async function criarItem(checklistId, nome, pos) {
    ok(await cliente().from('kanban_checkitens').insert({ checklist_id: checklistId, nome: nome, pos: pos }), 'item');
  }
  async function atualizarItem(id, campos) {
    ok(await cliente().from('kanban_checkitens').update(campos).eq('id', id), 'item');
  }
  async function excluirItem(id) {
    ok(await cliente().from('kanban_checkitens').delete().eq('id', id), 'excluir item');
  }

  async function comentar(cardId, texto) {
    ok(await cliente().from('kanban_comentarios').insert({ card_id: cardId, texto: texto }), 'comentar');
  }
  async function editarComentario(id, texto) {
    var d = ok(await cliente().from('kanban_comentarios').update({ texto: texto }).eq('id', id).select('id'), 'comentário');
    if (!d || !d.length) throw new Error('só quem escreveu o comentário pode alterá-lo');
  }
  async function excluirComentario(id) {
    var d = ok(await cliente().from('kanban_comentarios').delete().eq('id', id).select('id'), 'comentário');
    if (!d || !d.length) throw new Error('só quem escreveu o comentário pode excluí-lo');
  }

  /* Anexo: primeiro o arquivo, depois a linha. Se a linha falhar, o arquivo sai de
   * novo — sobraria um arquivo sem card, que ninguém acharia para apagar. */
  async function anexar(cardId, arquivo, pos) {
    var sb = cliente();
    var caminho = 'cards/' + cardId + '/' + Date.now().toString(36) + '-'
      + Math.random().toString(36).slice(2, 8) + '/' + KB_DADOS.nomeSeguro(arquivo.name);
    ok(await sb.storage.from(BUCKET).upload(caminho, arquivo,
      { contentType: arquivo.type || 'application/octet-stream', upsert: false }), 'enviar ' + arquivo.name);
    var r = await sb.from('kanban_anexos').insert({
      card_id: cardId, nome: arquivo.name, caminho: caminho,
      mime: arquivo.type || null, bytes: arquivo.size, pos: pos
    });
    if (r.error) {
      await sb.storage.from(BUCKET).remove([caminho]);
      throw new Error('anexar ' + arquivo.name + ': ' + r.error.message);
    }
  }

  async function anexarLink(cardId, url, nome, pos) {
    ok(await cliente().from('kanban_anexos').insert({ card_id: cardId, url: url, nome: nome || url, pos: pos }), 'anexar link');
  }

  async function excluirAnexo(anexo) {
    var sb = cliente();
    if (anexo.caminho) ok(await sb.storage.from(BUCKET).remove([anexo.caminho]), 'apagar arquivo');
    ok(await sb.from('kanban_anexos').delete().eq('id', anexo.id), 'excluir anexo');
  }

  async function renomearAnexo(id, nome) {
    ok(await cliente().from('kanban_anexos').update({ nome: nome }).eq('id', id), 'renomear anexo');
  }

  /* Endereço temporário do arquivo (bucket privado). `baixar` = com o nome original. */
  async function urlArquivo(caminho, nomeParaBaixar) {
    var op = nomeParaBaixar ? { download: nomeParaBaixar } : undefined;
    return ok(await cliente().storage.from(BUCKET).createSignedUrl(caminho, 300, op), 'abrir arquivo').signedUrl;
  }

  async function criarLista(nome, pos) {
    ok(await cliente().from('kanban_listas').insert({ nome: nome, pos: pos }), 'criar lista');
  }
  async function atualizarLista(id, campos) {
    ok(await cliente().from('kanban_listas').update(campos).eq('id', id), 'gravar lista');
  }

  /* Tempo real: qualquer mudança nas tabelas do board chama `aoMudar(tabela)`. Quem
   * chama decide o que recarregar — mais simples e mais seguro que remendar o estado
   * da tela com cada evento (o DELETE nem traz a linha inteira). */
  function assinar(aoMudar) {
    // aberto por file:// é o teste (test_painel.py), com a rede interceptada: o
    // websocket iria direto ao Supabase de verdade
    if (location.protocol === 'file:') return function () {};
    var sb = cliente();
    var canal = sb.channel('kanban');
    ['kanban_listas', 'kanban_etiquetas', 'kanban_cards', 'kanban_card_etiquetas', 'kanban_card_membros',
     'kanban_checklists', 'kanban_checkitens', 'kanban_comentarios', 'kanban_anexos'].forEach(function (t) {
      canal.on('postgres_changes', { event: '*', schema: 'public', table: t },
               function (p) { aoMudar(t, p); });
    });
    canal.subscribe();
    return function () { sb.removeChannel(canal); };
  }

  return {
    cliente: cliente, sessao: sessao, entrar: entrar,
    carregarBoard: carregarBoard, umResumo: umResumo, carregarCard: carregarCard,
    arquivados: arquivados, atividadeBoard: atividadeBoard,
    criarCard: criarCard, atualizarCard: atualizarCard, renumerarLista: renumerarLista,
    excluirCard: excluirCard, copiarCard: copiarCard,
    alternarEtiqueta: alternarEtiqueta, alternarMembro: alternarMembro,
    salvarEtiqueta: salvarEtiqueta, excluirEtiqueta: excluirEtiqueta,
    criarChecklist: criarChecklist, renomearChecklist: renomearChecklist, excluirChecklist: excluirChecklist,
    criarItem: criarItem, atualizarItem: atualizarItem, excluirItem: excluirItem,
    comentar: comentar, editarComentario: editarComentario, excluirComentario: excluirComentario,
    anexar: anexar, anexarLink: anexarLink, excluirAnexo: excluirAnexo, renomearAnexo: renomearAnexo,
    urlArquivo: urlArquivo,
    criarLista: criarLista, atualizarLista: atualizarLista,
    assinar: assinar
  };
})();
