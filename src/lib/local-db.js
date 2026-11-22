// =====================================================================
// DADOS NO SERVIDOR (PostgreSQL)
// As telas continuam usando local.from('tabela').select().eq()... como antes.
// A diferença é que cada consulta vai para a API (server/app.js), que monta o
// SQL e executa no PostgreSQL. Ver server/consultas.js.
//
// Uma cópia das tabelas fica na memória (local.tabelas()) para as telas que
// somam tudo de uma vez (Início, relatórios, exportações). Ela é atualizada
// com o que o servidor devolve a cada gravação.
//
// Acesso: usuário e senha conferidos no servidor; a sessão fica num cookie
// httpOnly (o JavaScript da página não tem acesso a ela).
// =====================================================================
import { tabelasVazias, TABELAS } from './consulta-local.js';

const BASE = new URL('api/', document.baseURI);
const LEMBRAR = 'caixa.ultimoUsuario'; // só o nome, para já mostrar "Olá, fulano"
// excluir nestas tabelas mexe em outras (on delete cascade / set null): recarrega tudo
const EXCLUSAO_EM_CASCATA = ['contas', 'cartoes', 'pessoas', 'compras_cartao', 'resina_cargas'];

let tabelas = tabelasVazias();

// Várias abas abertas: quem grava avisa as outras, que buscam os dados de novo no servidor
const ESTA_ABA = crypto.randomUUID();
const canal = typeof BroadcastChannel === 'function' ? new BroadcastChannel('caixa-resina') : null;
if (canal) {
  canal.onmessage = (e) => {
    if (e.data?.de === ESTA_ABA) return;
    if (e.data?.tipo === 'mudou') recarregar();
    if (e.data?.tipo === 'apagado' || e.data?.tipo === 'saiu') location.reload();
  };
}
let aviso = null;
const avisarOutrasAbas = () => { clearTimeout(aviso); aviso = setTimeout(() => canal?.postMessage({ tipo: 'mudou', de: ESTA_ABA }), 150); };

const lembrar = {
  ler: () => { try { return localStorage.getItem(LEMBRAR); } catch { return null; } },
  gravar: (nome) => { try { localStorage.setItem(LEMBRAR, nome); } catch { /* sem armazenamento: só não lembra */ } },
  esquecer: () => { try { localStorage.removeItem(LEMBRAR); } catch { /* idem */ } },
};

/** Chama a API. Erros viram Error com .code, .status e .espera (segundos, se houver) */
async function api(metodo, caminho, corpo) {
  let r;
  try {
    r = await fetch(new URL(caminho, BASE), {
      method: metodo,
      credentials: 'same-origin',
      headers: corpo === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
    });
  } catch {
    throw Object.assign(new Error('Sem conexão com o servidor. Confira a internet e tente de novo.'), { code: 'rede' });
  }
  const j = r.status === 204 ? null : await r.json().catch(() => null);
  if (!r.ok) {
    const e = Object.assign(new Error(j?.erro?.message || `O servidor respondeu com erro (${r.status}).`), {
      code: j?.erro?.code, status: r.status, espera: j?.erro?.espera,
    });
    if (r.status === 401 && e.code === 'sessao' && local.usuario) window.dispatchEvent(new Event('caixa:sessao-terminou'));
    throw e;
  }
  return j;
}

/** Atualiza a cópia na memória com o que o servidor devolveu */
async function aplicarNaCopia(q, data) {
  const linhas = data == null ? [] : [].concat(data);
  const t = tabelas[q.tabela];
  if (q.op === 'insert' || q.op === 'upsert') {
    t.push(...linhas);
  } else if (q.op === 'update') {
    const porId = new Map(linhas.map((l) => [l.id, l]));
    tabelas[q.tabela] = t.map((l) => porId.get(l.id) || l);
  } else if (q.op === 'delete') {
    if (EXCLUSAO_EM_CASCATA.includes(q.tabela)) await carregarDados();
    else {
      const ids = new Set(linhas.map((l) => l.id));
      tabelas[q.tabela] = t.filter((l) => !ids.has(l.id));
    }
  }
  if (q.op !== 'select') avisarOutrasAbas();
}

/** Consulta no estilo from().select().eq().order(): monta o pedido e manda para o servidor */
class Consulta {
  constructor(tabela) { this.q = { tabela, op: 'select', filtros: [] }; }
  select() { return this; }
  insert(linhas) { this.q.op = 'insert'; this.q.linhas = [].concat(linhas); return this; }
  upsert(linhas) { this.q.op = 'upsert'; this.q.linhas = [].concat(linhas); return this; }
  update(valores) { this.q.op = 'update'; this.q.valores = valores; return this; }
  delete() { this.q.op = 'delete'; return this; }
  eq(c, v) { this.q.filtros.push(['eq', c, v]); return this; }
  in(c, lista) { this.q.filtros.push(['in', c, lista]); return this; }
  gte(c, v) { this.q.filtros.push(['gte', c, v]); return this; }
  gt(c, v) { this.q.filtros.push(['gt', c, v]); return this; }
  lte(c, v) { this.q.filtros.push(['lte', c, v]); return this; }
  lt(c, v) { this.q.filtros.push(['lt', c, v]); return this; }
  order(c, { ascending = true } = {}) { this.q.ordem = { c, asc: ascending }; return this; }
  range() { return this; }
  single() { this.q.unico = true; return this; }
  maybeSingle() { this.q.unico = true; return this; }
  then(ok, falha) { return this.executar().then(ok, falha); }

  /** Igual ao Supabase: nunca rejeita, devolve { data, error } */
  async executar() {
    try {
      const { data, erro } = await api('POST', 'consulta', this.q);
      if (erro) return { data: null, error: erro }; // o banco recusou (ex.: item em uso)
      await aplicarNaCopia(this.q, data);
      return { data, error: null };
    } catch (e) {
      return { data: null, error: { code: e.code, message: e.message } };
    }
  }
}

async function carregarDados() {
  const r = await api('GET', 'dados');
  tabelas = { ...tabelasVazias(), ...r.tabelas };
}

function entrou(r) {
  local.usuario = r.usuario;
  local.ultimoBackup = r.ultimoBackup || null;
  lembrar.gravar(r.usuario);
}

/** Busca os dados de novo (outra aba ou outro aparelho mudou alguma coisa) */
async function recarregar() {
  if (!local.usuario) return;
  try {
    const antes = JSON.stringify(tabelas);
    await carregarDados();
    if (JSON.stringify(tabelas) !== antes) window.dispatchEvent(new Event('caixa:dados-externos'));
  } catch (e) {
    console.error('Não foi possível recarregar os dados', e);
  }
}

export const local = {
  usuario: null,
  ultimoBackup: null,
  sessaoAtiva: false,
  from: (tabela) => new Consulta(tabela),
  tabelas: () => tabelas,

  /**
   * Já tem sessão aberta? Então entra direto (sessaoAtiva = true).
   * Senão, devolve o nome do último usuário deste aparelho (ou null).
   */
  async usuarioCadastrado() {
    const r = await api('GET', 'sessao'); // sem conexão: o erro sobe e quem chamou mostra o aviso
    this.sessaoAtiva = Boolean(r.usuario);
    if (!this.sessaoAtiva) return lembrar.ler();
    entrou(r);
    return this.usuario;
  },

  /** Abre os dados de uma sessão que já estava aberta */
  async abrirSessao() {
    await carregarDados();
  },

  /** Primeiro acesso: cria o usuário com os dados iniciais. Retorna o código de recuperação. */
  async criarConta(usuario, senha, tabelasIniciais) {
    const r = await api('POST', 'conta', { usuario, senha, tabelas: tabelasIniciais });
    entrou(r);
    await carregarDados();
    return r.codigo;
  },

  /** Entra com usuário e senha. Retorna { ok } ou { ok: false, espera } (segundos). */
  async desbloquear(senha, usuario = lembrar.ler()) {
    try {
      entrou(await api('POST', 'entrar', { usuario, senha }));
    } catch (e) {
      if (e.status === 401) return { ok: false };
      if (e.status === 429) return { ok: false, espera: e.espera };
      throw e;
    }
    await carregarDados();
    return { ok: true };
  },

  /** Esqueci a senha: entra com o código e cria uma senha nova. Retorna o código novo ou null. */
  async recuperarComCodigo(codigo, senhaNova, usuario = lembrar.ler()) {
    let r;
    try {
      r = await api('POST', 'recuperar', { usuario, codigo, senhaNova });
    } catch (e) {
      if (e.status === 401 || e.status === 429) return null;
      throw e;
    }
    entrou(r);
    await carregarDados();
    return r.codigo;
  },

  /** Confere a senha atual (sem mudar nada) */
  async senhaConfere(senha) {
    return (await api('POST', 'conta/conferir', { senha })).ok;
  },

  /** Troca o nome e/ou a senha */
  async alterarConta({ usuario, senhaAtual, senhaNova }) {
    entrou(await api('PATCH', 'conta', { usuario, senhaAtual, senhaNova }));
  },

  /** Gera um código de recuperação novo (o antigo deixa de funcionar). Exige a senha atual. */
  async novoCodigo(senhaAtual) {
    return (await api('POST', 'conta/codigo', { senhaAtual })).codigo;
  },

  /** Troca todos os dados (restaurar backup), numa transação só no servidor */
  async substituir(novas) {
    const r = await api('PUT', 'dados', { tabelas: novas });
    tabelas = { ...tabelasVazias(), ...r.tabelas };
    avisarOutrasAbas();
  },

  async marcarBackup() {
    entrou(await api('POST', 'conta/backup'));
  },

  /** Encerra a sessão e esquece os dados da memória */
  async bloquear() {
    const tinha = this.usuario;
    this.usuario = null;
    tabelas = tabelasVazias();
    if (tinha) {
      await api('POST', 'sair').catch(() => {});
      canal?.postMessage({ tipo: 'saiu', de: ESTA_ABA });
    }
  },

  /** Apaga o usuário e todos os dados dele no servidor */
  async apagarTudo() {
    if (this.usuario) await api('DELETE', 'conta');
    this.usuario = null;
    tabelas = tabelasVazias();
    lembrar.esquecer();
    canal?.postMessage({ tipo: 'apagado', de: ESTA_ABA });
  },

  /** "Entrar com outro usuário": esquece o nome lembrado neste aparelho */
  esquecerUsuario() {
    lembrar.esquecer();
  },

  recarregar,
  /** Nada fica pendente: cada mudança já foi gravada no servidor */
  gravarAgora: () => Promise.resolve(),
  TABELAS,
};
