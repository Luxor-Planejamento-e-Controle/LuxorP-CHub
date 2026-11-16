/* Senhas P&C — a cifra. Sem DOM e sem rede: roda igual no navegador e no Node (teste).
 *
 * Chave: PBKDF2-SHA256 da senha mestra, com o sal e as iterações de `senhas_cofre`,
 * vira uma chave AES-256-GCM que NÃO sai da memória da página (não é exportável e não
 * vai para storage nenhum). Texto cifrado: "v1:" + base64(iv de 12 bytes || cifra+tag).
 * Arquivo: os mesmos bytes, sem o prefixo. É o mesmo formato que o
 * tools/import_trello_senhas.py grava — mexeu num, mexe no outro.
 *
 * A senha mestra confere contra o `verificador` do cofre (a palavra VERIFICADOR
 * cifrada): senha errada não decifra (a tag do GCM falha) e `abrir` devolve null.
 */
var SH_CRIPTO = (function () {
  'use strict';

  var C = (typeof globalThis !== 'undefined' && globalThis.crypto) || window.crypto;
  var enc = new TextEncoder(), dec = new TextDecoder();
  var VERIFICADOR = 'senhas-pc';
  var PREFIXO = 'v1:';

  function b64(bytes) {
    var s = '', b = new Uint8Array(bytes);
    for (var i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function deb64(s) {
    var bin = atob(s), b = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
    return b;
  }

  async function chave(senha, salB64, iteracoes) {
    var base = await C.subtle.importKey('raw', enc.encode(senha), 'PBKDF2', false, ['deriveKey']);
    return C.subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt: deb64(salB64), iterations: iteracoes },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  async function cifrarBytes(k, bytes) {
    var iv = C.getRandomValues(new Uint8Array(12));
    var ct = new Uint8Array(await C.subtle.encrypt({ name: 'AES-GCM', iv: iv }, k, bytes));
    var out = new Uint8Array(12 + ct.length);
    out.set(iv); out.set(ct, 12);
    return out;
  }
  async function decifrarBytes(k, dados) {
    var d = new Uint8Array(dados);
    return new Uint8Array(await C.subtle.decrypt({ name: 'AES-GCM', iv: d.subarray(0, 12) }, k, d.subarray(12)));
  }

  async function cifrar(k, texto) {
    return PREFIXO + b64(await cifrarBytes(k, enc.encode(texto == null ? '' : String(texto))));
  }
  async function decifrar(k, s) {
    if (typeof s !== 'string' || s.slice(0, PREFIXO.length) !== PREFIXO) throw new Error('texto fora do formato cifrado');
    return dec.decode(await decifrarBytes(k, deb64(s.slice(PREFIXO.length))));
  }

  /* Chave da senha mestra, ou null se ela não confere com o cofre. */
  async function abrir(senha, cofre) {
    var k = await chave(senha, cofre.sal, cofre.iteracoes);
    try {
      return (await decifrar(k, cofre.verificador)) === VERIFICADOR ? k : null;
    } catch (e) {
      return null;
    }
  }

  return { chave: chave, abrir: abrir, cifrar: cifrar, decifrar: decifrar,
           cifrarBytes: cifrarBytes, decifrarBytes: decifrarBytes, VERIFICADOR: VERIFICADOR };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = SH_CRIPTO;
