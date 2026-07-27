/* Luxor P&C Hub — porteiro da casca.
   Ordem: sessão Supabase -> allowlist + permissões -> baixa os snapshots do
   bucket privado -> só então o app.js monta o hub (window.hubBoot).

   A aba Projetos roda em iframe do MESMO origin, então reaproveita a sessão
   gravada no localStorage — não pede login de novo.

   file:// (demo local) pula tudo: usa os assets/data/*.js do build local. */
'use strict';

window.HUB = { sb:null, email:null, role:null, dashboards:[], offline:false };

const HUB_OFFLINE = location.protocol === 'file:';
// Cada dashboard e o arquivo que ele precisa no bucket (null = não usa snapshot).
const HUB_DATASETS = { indicadores:'indicadores.json', dre:'dre.json',
                       inadimplencia:null, projetos:null };

/* Erro devolvido pelo GoTrue vem na URL (hash no fluxo implícito, query no PKCE)
   e o supabase-js limpa isso na inicialização. Capturar AGORA, antes disso,
   senão o link falho vira "voltou pro login e não disse nada". */
const HUB_URL_ERR = (function(){
  const p = new URLSearchParams(location.hash.replace(/^#/,''));
  const q = new URLSearchParams(location.search);
  const code = p.get('error_code') || q.get('error_code');
  const desc = p.get('error_description') || q.get('error_description')
            || p.get('error') || q.get('error');
  if(!code && !desc) return null;
  return { code, desc: (desc||'').replace(/\+/g,' ') };
})();

const HUB_TRAD = {
  otp_expired:      'Link expirado ou já usado. Peça um novo — cada link vale uma vez só.',
  access_denied:    'Link inválido ou já usado. Peça um novo.',
  server_error:     'O Supabase recusou o login. Confira Site URL e Redirect URLs.',
  validation_failed:'A URL de retorno não está liberada no Supabase (Redirect URLs).',
};

/* ---------- overlay de login ---------- */
function gateEl(){
  let o = document.getElementById('hub-gate');
  if(o) return o;
  o = document.createElement('div');
  o.id = 'hub-gate';
  o.innerHTML =
    '<div class="gate-box">'+
      '<img src="assets/luxor-logo.png" alt="Luxor" height="34">'+
      '<h2>Planejamento &amp; Controle</h2>'+
      '<p>Entre com seu e-mail corporativo. Enviamos um link de acesso.</p>'+
      '<input id="gate-email" type="email" placeholder="voce@luxor.com.br" autocomplete="email">'+
      '<button id="gate-send" type="button">Enviar link</button>'+
      '<div id="gate-msg"></div>'+
    '</div>';
  document.body.appendChild(o);
  o.querySelector('#gate-send').addEventListener('click', sendLink);
  o.querySelector('#gate-email').addEventListener('keydown', e=>{ if(e.key==='Enter') sendLink(); });
  return o;
}
function showGate(msg, showForm){
  const o = gateEl();
  o.style.display = 'flex';
  // Erro que veio no link tem prioridade sobre a mensagem padrão: é a única
  // pista de por que o login não fechou.
  if(!msg && HUB_URL_ERR){
    msg = HUB_TRAD[HUB_URL_ERR.code] || HUB_URL_ERR.desc || 'Falha no link de acesso.';
    console.warn('[hub] erro no link:', HUB_URL_ERR.code, '—', HUB_URL_ERR.desc);
  }
  o.querySelector('#gate-msg').textContent = msg || '';
  const hide = showForm === false;
  o.querySelector('#gate-email').style.display = hide ? 'none' : '';
  o.querySelector('#gate-send').style.display  = hide ? 'none' : '';
}
function hideGate(){ const o=document.getElementById('hub-gate'); if(o) o.style.display='none'; }

function sendLink(){
  const email = (document.getElementById('gate-email').value||'').trim().toLowerCase();
  const msg = document.getElementById('gate-msg');
  if(!/^[^@\s]+@luxor\.com\.br$/.test(email)){ msg.textContent='Use um e-mail @luxor.com.br.'; return; }
  msg.textContent = 'Enviando...';
  // shouldCreateUser:false — o hub é invite-only; magic-link não cria conta.
  // A resposta é a MESMA pra e-mail liberado e não liberado: o site é público,
  // então não pode servir de oráculo pra descobrir quem tem conta na Luxor.
  // Quem não está na allowlist descobre depois de autenticar, não antes.
  window.HUB.sb.auth.signInWithOtp({ email, options:{ shouldCreateUser:false,
                                                      emailRedirectTo: location.origin + '/' } })
    .then(r => {
      const e = r.error;
      // Rate limit é do projeto inteiro, não diz nada sobre este e-mail —
      // pode aparecer sem virar oráculo, e evita a pessoa clicar 10x achando
      // que travou.
      if(e && (e.status === 429 || /rate limit/i.test(e.message))){
        msg.textContent = 'Muitos envios agora há pouco. Tente de novo em alguns minutos.';
        return;
      }
      if(e && !/not allowed|not found|signups? not allowed/i.test(e.message))
        console.warn('[hub] signInWithOtp:', e.status, e.message);
      msg.textContent = 'Se este e-mail estiver liberado, o link de acesso chegou na caixa de entrada.';
    });
}

/* ---------- permissões ---------- */
async function loadAccess(email){
  const sb = window.HUB.sb;
  const [{ data:me, error:meErr }, { data:acc, error:accErr }] = await Promise.all([
    sb.from('allowed_users').select('role,ativo,nome').eq('email', email).maybeSingle(),
    sb.from('user_dashboard_access').select('dashboard').eq('email', email),
  ]);
  // Consulta quebrada (tabela faltando, policy errada) não é a mesma coisa que
  // "não está na lista" — sem separar, um erro de setup parece falta de convite.
  if(meErr) return { erro: 'Não consegui ler a allowlist: ' + meErr.message };
  if(accErr) return { erro: 'Não consegui ler as permissões: ' + accErr.message };
  if(!me)       return { erro: null };                   // autenticou, mas fora da lista
  if(!me.ativo) return { erro: null, inativo: true };
  const all = Object.keys(HUB_DATASETS);
  return { role: me.role, nome: me.nome,
           dashboards: me.role === 'admin' ? all : (acc||[]).map(r=>r.dashboard) };
}

/* ---------- snapshots do bucket privado ---------- */
async function loadData(dashboards){
  const sb = window.HUB.sb, bucket = window.HUB_BUCKET;
  const target = { indicadores:'IND_DATA', dre:'DRE_DATA' };
  await Promise.all(dashboards.map(async d => {
    const file = HUB_DATASETS[d];
    if(!file || window[target[d]]) return;              // sem snapshot ou já veio do build local
    const { data, error } = await sb.storage.from(bucket).download(file);
    if(error){ console.warn('[hub] snapshot ausente:', file, error.message); return; }
    try { window[target[d]] = JSON.parse(await data.text()); }
    catch(e){ console.warn('[hub] snapshot inválido:', file, e); }
  }));
}

/* ---------- boot ---------- */
async function start(){
  if(HUB_OFFLINE){                                       // demo local via file://
    window.HUB.offline = true;
    window.HUB.dashboards = Object.keys(HUB_DATASETS).filter(d=>{
      if(d==='indicadores') return !!window.IND_DATA;
      if(d==='dre')         return !!window.DRE_DATA;
      return true;
    });
    hideGate(); window.hubBoot(); return;
  }

  if(!window.supabase || !window.SUPABASE_URL){
    showGate('Configuração do Supabase ausente (assets/config.js).', false); return;
  }
  const sb = window.HUB.sb = window.supabase.createClient(
    window.SUPABASE_URL, window.SUPABASE_ANON_KEY,
    { auth:{ flowType:'pkce', detectSessionInUrl:true, persistSession:true, autoRefreshToken:true } });

  async function onSession(session){
    if(!session){ window.HUB.email=null; showGate('', true); return; }
    const email = (session.user.email||'').toLowerCase();
    const access = await loadAccess(email);
    if(access.erro){                                     // problema de setup, não de convite
      console.error('[hub]', access.erro);
      showGate(access.erro, false); return;
    }
    if(!access.role){
      showGate(access.inativo ? 'Seu acesso ao hub está desativado.'
                              : 'Seu e-mail não está liberado no hub.', false);
      return;
    }
    Object.assign(window.HUB, { email, role:access.role, nome:access.nome,
                                dashboards:access.dashboards });
    await loadData(access.dashboards);
    hideGate();
    window.hubBoot();
  }

  const { data, error } = await sb.auth.getSession();
  if(error) console.error('[hub] getSession:', error.message);
  console.info('[hub] sessão:', data.session ? data.session.user.email : 'nenhuma',
               '| erro no link:', HUB_URL_ERR ? HUB_URL_ERR.code : 'nenhum');
  await onSession(data.session);
  sb.auth.onAuthStateChange((ev, session)=>{
    if(ev==='SIGNED_IN' || ev==='SIGNED_OUT') onSession(session);
  });
}

window.hubSignOut = function(){
  if(window.HUB.sb) window.HUB.sb.auth.signOut().then(()=>location.reload());
};

document.addEventListener('DOMContentLoaded', start);
