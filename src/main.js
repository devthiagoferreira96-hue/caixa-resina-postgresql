// Ponto de partida: sessão aberta (entra direto), tela de senha ou primeiro acesso
import './style.css';
import { store } from './lib/store.js';
import { carregarCadastros, manterRecorrencias } from './lib/api.js';
import { local } from './lib/local-db.js';
import { aplicarPreferencias } from './lib/preferencias.js';
import { telaPrimeiroAcesso, telaSenha } from './pages/acesso.js';
import { iniciarApp, redesenharSeSeguro } from './router.js';
import { toast } from './lib/ui.js';

aplicarPreferencias();

// App instalável e que abre sem internet (só na versão publicada, não no "npm run dev")
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}

async function iniciar() {
  let usuario;
  try {
    usuario = await local.usuarioCadastrado();
  } catch {
    return semServidor();
  }
  if (local.sessaoAtiva) {
    await local.abrirSessao();
    return abrirSistema();
  }
  if (usuario) telaSenha(usuario, abrirSistema);
  else telaPrimeiroAcesso(abrirSistema);
}

/** O servidor não respondeu (sem internet ou fora do ar): avisa e deixa tentar de novo */
function semServidor() {
  document.getElementById('app').innerHTML = `
  <main class="grid min-h-dvh place-items-center p-4">
    <div class="card w-full max-w-sm text-center" role="alert">
      <h1 class="text-xl font-bold">Sem conexão com o servidor</h1>
      <p class="mt-2 text-stone-600 dark:text-stone-400">Os dados ficam no servidor. Confira a internet e tente de novo.</p>
      <button type="button" class="btn-primario mt-5 w-full" data-tentar>Tentar de novo</button>
    </div>
  </main>`;
  document.querySelector('[data-tentar]').onclick = iniciar;
}

async function abrirSistema() {
  store.usuario = local.usuario;
  await carregarCadastros();
  // contas "sempre" e assinaturas no cartão: completa os próximos meses
  try { await manterRecorrencias(); } catch (e) { console.error(e); }
  iniciarApp();
}

/** Bloqueia o sistema: encerra a sessão no servidor, esquece os dados da memória e volta para a tela de senha */
export async function bloquear() {
  try { await local.bloquear(); } catch { /* segue bloqueando */ }
  location.hash = '';
  location.reload();
}

// Pede a senha de novo só depois de 30 minutos sem uso (sem tocar, digitar ou rolar a tela).
// O tempo com o app em segundo plano também conta (no celular, "fechar" o app muitas vezes só o deixa em segundo plano).
const BLOQUEAR_APOS_MS = 30 * 60_000;
let ultimoUso = Date.now();
const usou = () => { ultimoUso = Date.now(); };
for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll']) window.addEventListener(ev, usou, { passive: true, capture: true });
const conferirInatividade = () => {
  if (store.usuario && Date.now() - ultimoUso > BLOQUEAR_APOS_MS) bloquear();
};
setInterval(conferirInatividade, 30_000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') conferirInatividade();
});
window.addEventListener('caixa:bloquear', bloquear);

// Outra aba/janela mudou os dados: atualiza esta também
window.addEventListener('caixa:dados-externos', async () => {
  if (!store.usuario) return;
  await carregarCadastros();
  redesenharSeSeguro();
});
// Ao voltar para esta aba, confere se algo mudou (para navegadores sem aviso entre abas)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && store.usuario) local.recarregar();
});
// A sessão venceu (ou a senha foi trocada em outro aparelho): volta para a tela de senha
window.addEventListener('caixa:sessao-terminou', () => {
  toast('Sua sessão terminou. Entre de novo.', { tipo: 'erro' });
  setTimeout(bloquear, 1500);
});

iniciar();
