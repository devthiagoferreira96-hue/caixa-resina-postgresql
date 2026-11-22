// Telas de acesso: criar o usuário (primeiro acesso) e entrar com usuário e senha.
// Quem confere a senha é o servidor (server/app.js); aqui só ficam os formulários.
import { local } from '../lib/local-db.js';
import { dadosIniciais } from '../lib/exemplo.js';
import { escolherBackup } from '../components/backup.js';
import { mostrarCodigoRecuperacao } from '../components/recuperacao.js';
import { codigoValido } from '../lib/codigo-recuperacao.js';
import { icone, erroNoCampo, limparErros, dialogo, toast, semRepetir } from '../lib/ui.js';
import { esc } from '../lib/format.js';

const app = () => document.getElementById('app');
const marca = (subtitulo) => `
  <div class="mb-6 flex flex-col items-center gap-3 text-center">
    <span class="flex size-14 items-center justify-center rounded-2xl bg-brand-600 text-lg font-bold text-white" aria-hidden="true">R$</span>
    <div><h1 class="text-2xl font-bold">Caixa da Família</h1>
    <p class="text-stone-600 dark:text-stone-400">${subtitulo}</p></div>
  </div>`;

const campoSenha = (id, rotulo, autocomplete, dica = '') => `
  <div data-campo>
    <label class="rotulo" for="${id}">${rotulo}</label>
    <div class="relative">
      <input id="${id}" name="${id}" type="password" class="campo pr-12" autocomplete="${autocomplete}" maxlength="64" ${dica ? `aria-describedby="dica-${id}"` : ''}>
      <button type="button" data-ver="${id}" class="btn-icone absolute inset-y-0 right-0" aria-label="Mostrar senha" aria-pressed="false">${icone('olho')}</button>
    </div>
    ${dica ? `<p id="dica-${id}" class="dica">${dica}</p>` : ''}
  </div>`;

function ligarMostrarSenha(raiz) {
  raiz.querySelectorAll('[data-ver]').forEach((b) => (b.onclick = () => {
    const campo = raiz.querySelector(`#${b.dataset.ver}`);
    const ver = campo.type === 'password';
    campo.type = ver ? 'text' : 'password';
    b.setAttribute('aria-pressed', String(ver));
    b.setAttribute('aria-label', ver ? 'Esconder senha' : 'Mostrar senha');
  }));
}

// ---------- Primeiro acesso: criar usuário e senha
export function telaPrimeiroAcesso(aoEntrar, restaurando = null) {
  document.title = 'Começar · Caixa da Família';
  app().innerHTML = `
  <main class="grid min-h-dvh place-items-center p-4">
    <div class="w-full max-w-sm animate-entrar">
      ${marca(restaurando ? 'Crie um usuário para abrir o backup.' : 'Vamos criar o seu acesso.')}
      <form class="card grid gap-4" novalidate>
        ${restaurando ? `<p class="rounded-xl bg-brand-50 p-3 text-sm text-brand-900 dark:bg-brand-950 dark:text-brand-100">Backup de ${esc(restaurando.usuario || 'usuário')} com ${restaurando.tabelas.lancamentos?.length || 0} lançamentos pronto para restaurar.</p>` : ''}
        <div data-campo>
          <label class="rotulo" for="usuario">Seu nome de usuário</label>
          <input id="usuario" name="usuario" class="campo" maxlength="40" autocomplete="username" value="${esc(restaurando?.usuario || '')}" placeholder="Ex.: Thiago" aria-describedby="dica-usuario">
          <p id="dica-usuario" class="dica">É com ele e com a senha que você entra, de qualquer aparelho.</p>
        </div>
        ${campoSenha('senha', 'Crie uma senha', 'new-password', 'Pelo menos 4 caracteres.')}
        ${campoSenha('confirmar', 'Repita a senha', 'new-password')}
        ${restaurando ? '' : `
        <label class="flex cursor-pointer items-start gap-3 rounded-xl border border-stone-200 p-3 dark:border-stone-700">
          <input type="checkbox" name="exemplo" class="mt-0.5 size-5 accent-brand-600">
          <span><span class="block font-semibold">Começar com dados de exemplo</span>
          <span class="block text-sm text-stone-600 dark:text-stone-400">Para conhecer o sistema. Depois dá para apagar tudo em Ajustes.</span></span>
        </label>`}
        <div class="rounded-xl bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-900/40 dark:text-amber-100" role="note">
          <strong>Guarde bem a senha.</strong> Os dados ficam no servidor, protegidos por ela. Na próxima tela você recebe um <strong>código de recuperação</strong>: com ele dá para criar uma senha nova se esquecer.
        </div>
        <button type="submit" class="btn-primario">${restaurando ? 'Criar e restaurar' : 'Criar e entrar'}</button>
      </form>
      ${restaurando ? '' : `<p class="mt-4 flex flex-wrap justify-center gap-x-4 text-center">
        <button type="button" data-ja-tenho class="cursor-pointer p-2 text-sm font-semibold text-brand-700 underline underline-offset-2 dark:text-brand-400">Já tenho um acesso</button>
        <button type="button" data-restaurar class="cursor-pointer p-2 text-sm text-stone-600 underline underline-offset-2 dark:text-stone-400">Tenho um arquivo de backup</button></p>`}
    </div>
  </main>`;

  const form = app().querySelector('form');
  ligarMostrarSenha(form);
  form.usuario.focus();
  app().querySelector('[data-ja-tenho]')?.addEventListener('click', () => telaSenha(null, aoEntrar));
  app().querySelector('[data-restaurar]')?.addEventListener('click', async () => {
    const dados = await escolherBackup();
    if (dados) telaPrimeiroAcesso(aoEntrar, dados);
  });

  form.onsubmit = semRepetir(async (e) => {
    e.preventDefault();
    limparErros(form);
    const usuario = form.usuario.value.trim();
    const senha = form.senha.value;
    let ok = true;
    if (!usuario) { erroNoCampo(form, 'usuario', 'Escreva seu nome.'); ok = false; }
    if (senha.length < 4) { erroNoCampo(form, 'senha', 'A senha precisa ter pelo menos 4 caracteres.'); ok = false; }
    else if (form.confirmar.value !== senha) { erroNoCampo(form, 'confirmar', 'As duas senhas estão diferentes.'); ok = false; }
    if (!ok) return form.querySelector('[aria-invalid]').focus();

    const botao = form.querySelector('[type=submit]');
    botao.disabled = true;
    botao.textContent = 'Preparando…';
    const tabelas = restaurando ? restaurando.tabelas : dadosIniciais({ comExemplo: form.exemplo?.checked });
    let codigo;
    try {
      codigo = await local.criarConta(usuario, senha, tabelas);
    } catch (erro) {
      botao.disabled = false;
      botao.textContent = restaurando ? 'Criar e restaurar' : 'Criar e entrar';
      if (erro.code === 'nome') { erroNoCampo(form, 'usuario', erro.message); return form.usuario.focus(); }
      return toast(erro.message, { tipo: 'erro' });
    }
    await mostrarCodigoRecuperacao(codigo, { motivo: 'criado' });
    if (restaurando) toast('Backup restaurado');
    await aoEntrar();
  });
}

// ---------- Entrar: usuário e senha (o usuário já vem preenchido se entrou antes neste aparelho)
export function telaSenha(usuario, aoEntrar) {
  document.title = 'Entrar · Caixa da Família';
  let erros = 0;
  app().innerHTML = `
  <main class="grid min-h-dvh place-items-center p-4">
    <div class="w-full max-w-sm animate-entrar">
      ${marca(usuario ? `Olá, ${esc(usuario)}! Digite sua senha para entrar.` : 'Entre com seu usuário e senha.')}
      <form class="card grid gap-4" novalidate>
        ${usuario
    ? `<input type="text" name="usuario" value="${esc(usuario)}" autocomplete="username" class="hidden" aria-label="Usuário" aria-hidden="true" tabindex="-1">`
    : `<div data-campo><label class="rotulo" for="usuario">Usuário</label>
        <input id="usuario" name="usuario" class="campo" maxlength="40" autocomplete="username"></div>`}
        ${campoSenha('senha', 'Senha', 'current-password')}
        <p id="erro-senha-geral" class="erro-campo -mt-2 hidden" role="alert"></p>
        <button type="submit" class="btn-primario">Entrar</button>
      </form>
      <p class="mt-4 flex flex-wrap justify-center gap-x-4 text-center">
        <button type="button" data-esqueci class="cursor-pointer p-2 text-sm text-stone-600 underline underline-offset-2 dark:text-stone-400">Esqueci minha senha</button>
        ${usuario
    ? '<button type="button" data-outro class="cursor-pointer p-2 text-sm text-stone-600 underline underline-offset-2 dark:text-stone-400">Entrar com outro usuário</button>'
    : '<button type="button" data-criar class="cursor-pointer p-2 text-sm font-semibold text-brand-700 underline underline-offset-2 dark:text-brand-400">Criar um acesso</button>'}</p>
    </div>
  </main>`;

  const form = app().querySelector('form');
  const erro = app().querySelector('#erro-senha-geral');
  ligarMostrarSenha(form);
  (usuario ? form.senha : form.usuario).focus();
  const nome = () => usuario || form.usuario.value.trim();
  app().querySelector('[data-esqueci]').onclick = () => esqueciSenha(aoEntrar, nome());
  app().querySelector('[data-outro]')?.addEventListener('click', () => { local.esquecerUsuario(); telaSenha(null, aoEntrar); });
  app().querySelector('[data-criar]')?.addEventListener('click', () => telaPrimeiroAcesso(aoEntrar));

  form.onsubmit = semRepetir(async (e) => {
    e.preventDefault();
    const botao = form.querySelector('[type=submit]');
    if (!nome()) { erro.textContent = 'Digite seu usuário.'; erro.classList.remove('hidden'); return form.usuario.focus(); }
    if (!form.senha.value) { erro.textContent = 'Digite sua senha.'; erro.classList.remove('hidden'); return form.senha.focus(); }
    botao.disabled = true;
    botao.textContent = 'Abrindo…';
    let r;
    try {
      r = await local.desbloquear(form.senha.value, nome());
    } catch (falha) {
      erro.textContent = falha.message;
      erro.classList.remove('hidden');
      botao.disabled = false;
      botao.textContent = 'Entrar';
      return;
    }
    if (r.ok) {
      if (r.codigoNovo) await mostrarCodigoRecuperacao(r.codigoNovo, { motivo: 'atualizacao' });
      return aoEntrar();
    }
    erros++;
    // depois de 5 erros o servidor faz esperar 30 segundos a cada tentativa (dificulta quem tenta adivinhar)
    const espera = r.espera || (erros >= 5 ? 30 : 0);
    const errado = usuario ? 'Senha incorreta' : 'Usuário ou senha incorretos';
    erro.textContent = espera ? `${errado}. Aguarde ${espera} segundos para tentar de novo.` : `${errado}. Tente de novo.`;
    erro.classList.remove('hidden');
    form.senha.value = '';
    form.senha.setAttribute('aria-invalid', 'true');
    setTimeout(() => { botao.disabled = false; botao.textContent = 'Entrar'; form.senha.focus(); }, espera * 1000);
  });
}

function esqueciSenha(aoEntrar, usuario = '') {
  let erros = 0;
  const d = dialogo({
    titulo: 'Esqueci minha senha',
    largura: 'max-w-md',
    corpo: `
      <form class="grid gap-4" novalidate>
        <p class="text-stone-700 dark:text-stone-300">Digite o <strong>código de recuperação</strong> que você guardou (no WhatsApp ou no papel) e crie uma senha nova. Seus dados continuam todos no servidor.</p>
        <div data-campo><label class="rotulo" for="rec-usuario">Usuário</label>
          <input id="rec-usuario" name="usuario" class="campo" maxlength="40" autocomplete="username" value="${esc(usuario)}"></div>
        <div data-campo><label class="rotulo" for="codigo">Código de recuperação</label>
          <input id="codigo" name="codigo" class="campo text-center font-mono text-lg tracking-wider uppercase" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="24" placeholder="XXXX-XXXX-XXXX-XXXX" aria-describedby="dica-codigo">
          <p id="dica-codigo" class="dica">16 letras e números. Pode digitar com ou sem os tracinhos.</p></div>
        ${campoSenha('nova', 'Senha nova', 'new-password', 'Pelo menos 4 caracteres.')}
        ${campoSenha('repetir', 'Repita a senha nova', 'new-password')}
        <button type="submit" class="btn-primario">Criar senha nova</button>
        <button type="button" class="cursor-pointer p-2 text-sm text-stone-600 underline underline-offset-2 dark:text-stone-400" data-sem-codigo>Não tenho o código</button>
      </form>`,
  });
  const f = d.querySelector('form');
  ligarMostrarSenha(f);
  (usuario ? f.codigo : f.usuario).focus();
  f.onsubmit = semRepetir(async (e) => {
    e.preventDefault();
    limparErros(f);
    let ok = true;
    if (!f.usuario.value.trim()) { erroNoCampo(f, 'usuario', 'Digite seu usuário.'); ok = false; }
    if (!codigoValido(f.codigo.value)) { erroNoCampo(f, 'codigo', 'Confira o código: são 16 letras e números.'); ok = false; }
    if (f.nova.value.length < 4) { erroNoCampo(f, 'nova', 'A senha precisa ter pelo menos 4 caracteres.'); ok = false; }
    else if (f.nova.value !== f.repetir.value) { erroNoCampo(f, 'repetir', 'As duas senhas estão diferentes.'); ok = false; }
    if (!ok) return f.querySelector('[aria-invalid]').focus();
    const botao = f.querySelector('[type=submit]');
    botao.disabled = true;
    botao.textContent = 'Conferindo…';
    let codigoNovo;
    try {
      codigoNovo = await local.recuperarComCodigo(f.codigo.value, f.nova.value, f.usuario.value.trim());
    } catch (falha) {
      botao.disabled = false;
      botao.textContent = 'Criar senha nova';
      return toast(falha.message, { tipo: 'erro' });
    }
    if (codigoNovo) {
      d.close();
      await mostrarCodigoRecuperacao(codigoNovo, { motivo: 'recuperado' });
      toast('Senha nova criada. Use-a da próxima vez que abrir o sistema.');
      return aoEntrar();
    }
    erros++;
    const espera = erros >= 5 ? 30 : 0;
    erroNoCampo(f, 'codigo', espera ? `Usuário ou código incorreto. Aguarde ${espera} segundos para tentar de novo.` : 'Usuário ou código incorreto. Confira as letras e números.');
    setTimeout(() => { botao.disabled = false; botao.textContent = 'Criar senha nova'; }, espera * 1000);
  });
  f.querySelector('[data-sem-codigo]').onclick = () => { d.close(); semCodigo(aoEntrar); };
}

/** Sem senha e sem código: não dá para entrar nesse acesso. Dá para criar outro e restaurar um backup. */
function semCodigo(aoEntrar) {
  const d = dialogo({
    titulo: 'Sem a senha e sem o código',
    largura: 'max-w-md',
    corpo: `
      <div class="grid gap-3 text-stone-700 dark:text-stone-300">
        <p>Para proteger seus dados, sem a senha e sem o código de recuperação <strong>não é possível entrar</strong> nesse acesso.</p>
        <p>Se você tiver um <strong>arquivo de backup</strong>, pode criar um acesso novo (com outro nome) e restaurar os dados dele.</p>
      </div>
      <div class="mt-5 grid gap-2">
        <button type="button" class="btn-primario" data-voltar>Voltar e tentar o código de novo</button>
        <button type="button" class="btn-neutro" data-novo>Criar um acesso novo</button>
      </div>`,
  });
  d.querySelector('[data-voltar]').onclick = () => { d.close(); esqueciSenha(aoEntrar); };
  d.querySelector('[data-novo]').onclick = () => {
    d.close();
    local.esquecerUsuario();
    telaPrimeiroAcesso(aoEntrar);
  };
}
