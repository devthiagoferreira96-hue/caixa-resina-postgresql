// =====================================================================
// Montador de SQL: recebe a consulta que o navegador montou com
// from('tabela').select().eq().order()... e executa no PostgreSQL.
//
// Segurança:
//  * Os valores sempre vão como parâmetros ($1, $2...), nunca colados no SQL.
//  * Nomes de tabela só da lista TABELAS; nomes de coluna só [a-z0-9_].
//  * Todo SQL tem "usuario_id = $1": ninguém lê nem altera dados de outra pessoa.
// =====================================================================
import { randomUUID } from 'node:crypto';
import { TABELAS, COM_DATA, PADROES } from '../src/lib/consulta-local.js';

const INTERNAS = new Set(['usuario_id', 'extras', 'seq']); // colunas que o navegador não vê
const NOME = /^[a-z_][a-z0-9_]{0,62}$/;
const OPERADORES = { eq: '=', gte: '>=', gt: '>', lte: '<=', lt: '<' };
const LOTE = 500; // linhas por INSERT (o PostgreSQL aceita até 65535 parâmetros por comando)

// Ordem para restaurar um backup: quem é referenciado vem antes de quem referencia
const ORDEM_GRAVACAO = ['contas', 'cartoes', 'categorias', 'pessoas', 'lancamentos', 'compras_cartao', 'parcelas',
  'resina_fazendas', 'resina_produtores', 'resina_motoristas', 'resina_caminhoes', 'resina_titulares', 'resina_produtos',
  'resina_precos', 'resina_cargas', 'resina_carga_itens', 'resina_insumos', 'resina_movimentos'];

/** Erro de uso da API (pedido mal montado): vira HTTP 400 */
export class ErroDeUso extends Error {
  constructor(msg) { super(msg); this.status = 400; this.code = 'uso'; }
}

/** Erros do PostgreSQL no formato que o sistema já entende ({ code, message }) */
export function erroDoBanco(e) {
  if (e instanceof ErroDeUso) return { code: e.code, message: e.message };
  // o nome da restrição diz o que estava em uso (cargas, insumos...): veja traduzirErro em api.js
  if (e.code === '23503') return { code: e.code, message: `foreign key violation: ${e.constraint || ''}` };
  if (e.code === '23505') return { code: e.code, message: 'duplicate key' };
  if (e.code === '23514' || e.code === '23502') return { code: e.code, message: `Valor não permitido (${e.constraint || e.column || 'campo'}).` };
  if (e.code === '22P02' || e.code === '22007' || e.code === '22008') return { code: e.code, message: 'Algum valor está em um formato inválido.' };
  return null; // erro inesperado: o servidor registra e responde 500
}

const aspas = (c) => `"${c}"`;

export function criarConsultas(colunasDoBanco) {
  for (const t of TABELAS) if (!colunasDoBanco[t]) throw new Error(`A tabela ${t} não existe. Rode npm run db:migrar.`);
  const cols = (t) => colunasDoBanco[t];

  function conferirTabela(t) {
    if (!TABELAS.includes(t)) throw new ErroDeUso('Tabela desconhecida.');
  }
  function conferirColuna(c) {
    if (typeof c !== 'string' || !NOME.test(c) || INTERNAS.has(c)) throw new ErroDeUso('Coluna inválida.');
  }

  /** Valor pronto para a coluna (vazio em data vira null; objeto em coluna comum vira JSON) */
  function paraColuna(meta, v) {
    const data = meta.tipo === 'date' || meta.tipo.startsWith('timestamp');
    if (v === '' && (data || meta.tipo === 'numeric' || meta.tipo === 'integer')) return null;
    // o sistema usa "0000-01-01" como "desde sempre"; o PostgreSQL começa no ano 1
    if (data && typeof v === 'string' && v.startsWith('0000-')) return `0001-01-01${v.slice(10)}`;
    if (v !== null && typeof v === 'object') return JSON.stringify(v);
    return v;
  }

  /** Separa a linha em colunas de verdade e "extras" (campos que ainda não viraram coluna) */
  function separar(t, linha) {
    if (!linha || typeof linha !== 'object' || Array.isArray(linha)) throw new ErroDeUso('Linha inválida.');
    const c = {}, x = {};
    for (const [k, v] of Object.entries(linha)) {
      if (v === undefined || INTERNAS.has(k)) continue;
      if (!NOME.test(k)) throw new ErroDeUso('Campo inválido.');
      if (cols(t)[k]) c[k] = paraColuna(cols(t)[k], v);
      else x[k] = v;
    }
    return { c, x };
  }

  /** Linha do banco -> objeto igual ao que o sistema usa */
  function paraObjeto(row) {
    const { usuario_id, extras, seq, ...resto } = row;
    return { ...(extras || {}), ...resto };
  }

  /** WHERE com o usuário e os filtros eq/in/gte/gt/lte/lt */
  function onde(t, filtros, params) {
    const partes = ['usuario_id = $1'];
    if (!Array.isArray(filtros)) throw new ErroDeUso('Filtros inválidos.');
    for (const f of filtros) {
      const [op, col, val] = Array.isArray(f) ? f : [];
      conferirColuna(col);
      const tipada = Boolean(cols(t)[col]);
      // campo fora das colunas: procura dentro de "extras" (comparando como texto)
      const ref = tipada ? aspas(col) : `(extras->>'${col}')`;
      const param = (v) => {
        params.push(tipada ? (Array.isArray(v) ? v.map((i) => paraColuna(cols(t)[col], i)) : paraColuna(cols(t)[col], v)) : (Array.isArray(v) ? v.map((i) => (i == null ? null : String(i))) : v == null ? null : String(v)));
        return `$${params.length}`;
      };
      if (op === 'in') {
        if (!Array.isArray(val)) throw new ErroDeUso('O filtro "in" precisa de uma lista.');
        if (!val.length) { partes.push('false'); continue; }
        const semNulos = val.filter((v) => v !== null);
        const algum = semNulos.length ? `${ref} = any(${param(semNulos)})` : 'false';
        partes.push(val.length > semNulos.length ? `(${algum} or ${ref} is null)` : algum);
      } else if (op === 'eq') {
        partes.push(val === null ? `${ref} is null` : `${ref} = ${param(val)}`);
      } else if (OPERADORES[op]) {
        partes.push(val === null ? 'false' : `${ref} ${OPERADORES[op]} ${param(val)}`);
      } else {
        throw new ErroDeUso('Filtro desconhecido.');
      }
    }
    return partes.join(' and ');
  }

  function ordenar(t, ordem) {
    if (!ordem) return 'order by seq';
    conferirColuna(ordem.c);
    const ref = cols(t)[ordem.c] ? aspas(ordem.c) : `(extras->>'${ordem.c}')`;
    return `order by ${ref} ${ordem.asc === false ? 'desc nulls last' : 'asc nulls first'}, seq`;
  }

  /**
   * Insere linhas. `comPadroes`: completa como o sistema original fazia (ativo = true...).
   * `ignorarRepetidos`: id que já existe fica como está (upsert com ignoreDuplicates).
   */
  async function inserir(db, t, usuario, linhas, { comPadroes = true, ignorarRepetidos = false } = {}) {
    if (!Array.isArray(linhas)) throw new ErroDeUso('Linhas inválidas.');
    if (!linhas.length) return [];
    const agora = new Date().toISOString();
    const separadas = linhas.map((l) => {
      const base = comPadroes ? { ...PADROES[t], ...(COM_DATA.includes(t) ? { criado_em: agora } : {}), ...l } : l;
      const s = separar(t, base);
      s.c.id = s.c.id == null || s.c.id === '' ? randomUUID() : String(s.c.id);
      return s;
    });
    const nomes = [...new Set(separadas.flatMap((s) => Object.keys(s.c)))];
    const saida = [];
    for (let i = 0; i < separadas.length; i += LOTE) {
      const params = [usuario];
      const valores = separadas.slice(i, i + LOTE).map(({ c, x }) => {
        const celulas = nomes.map((n) => {
          const v = c[n], meta = cols(t)[n];
          // campo que não veio (ou null em coluna obrigatória com padrão): usa o padrão do banco
          if (v === undefined || (v === null && !meta.nulo && meta.temPadrao)) return 'default';
          params.push(v);
          return `$${params.length}`;
        });
        params.push(JSON.stringify(x));
        return `($1, ${celulas.join(', ')}, $${params.length}::jsonb)`;
      });
      const { rows } = await db.query(
        `insert into ${t} (usuario_id, ${nomes.map(aspas).join(', ')}, extras) values ${valores.join(', ')}
         ${ignorarRepetidos ? 'on conflict (id) do nothing' : ''} returning *`,
        params,
      );
      saida.push(...rows.map(paraObjeto));
    }
    return saida;
  }

  /**
   * Executa uma consulta do navegador:
   * { tabela, op: select|insert|upsert|update|delete, filtros: [[op, coluna, valor]], ordem: { c, asc }, unico, linhas, valores }
   */
  async function executar(db, usuario, q) {
    if (!q || typeof q !== 'object') throw new ErroDeUso('Consulta inválida.');
    const t = q.tabela;
    conferirTabela(t);
    let dados;
    if (q.op === 'insert' || q.op === 'upsert') {
      dados = await inserir(db, t, usuario, q.linhas, { ignorarRepetidos: q.op === 'upsert' });
    } else {
      const params = [usuario];
      const where = onde(t, q.filtros || [], params);
      if (q.op === 'update') {
        const { c, x } = separar(t, q.valores);
        delete c.id; // o id não muda
        const sets = Object.entries(c).map(([k, v]) => {
          if (v === null && !cols(t)[k].nulo && cols(t)[k].temPadrao) return `${aspas(k)} = default`;
          params.push(v);
          return `${aspas(k)} = $${params.length}`;
        });
        if (Object.keys(x).length) { params.push(JSON.stringify(x)); sets.push(`extras = extras || $${params.length}::jsonb`); }
        const sql = sets.length
          ? `update ${t} set ${sets.join(', ')} where ${where} returning *`
          : `select * from ${t} where ${where}`;
        dados = (await db.query(sql, params)).rows.map(paraObjeto);
      } else if (q.op === 'delete') {
        dados = (await db.query(`delete from ${t} where ${where} returning *`, params)).rows.map(paraObjeto);
      } else if (q.op === 'select' || q.op === undefined) {
        const sql = `select * from ${t} where ${where} ${ordenar(t, q.ordem)}${q.unico ? ' limit 1' : ''}`;
        dados = (await db.query(sql, params)).rows.map(paraObjeto);
      } else {
        throw new ErroDeUso('Operação desconhecida.');
      }
      if (q.ordem && q.op !== 'select') {
        // update/delete com order(): ordena a resposta como o sistema original
        const { c, asc } = q.ordem;
        dados.sort((a, b) => (a[c] > b[c] ? 1 : a[c] < b[c] ? -1 : 0) * (asc === false ? -1 : 1));
      }
    }
    return q.unico ? (dados[0] ?? null) : dados;
  }

  /** Todas as tabelas do usuário (para abrir o sistema) */
  async function carregarTudo(db, usuario) {
    const tabelas = {};
    for (const t of TABELAS) {
      tabelas[t] = (await db.query(`select * from ${t} where usuario_id = $1 order by seq`, [usuario])).rows.map(paraObjeto);
    }
    return tabelas;
  }

  /** Troca todos os dados do usuário (restaurar backup). Precisa estar dentro de uma transação. */
  async function substituir(db, usuario, tabelas) {
    if (!tabelas || typeof tabelas !== 'object' || Array.isArray(tabelas)) throw new ErroDeUso('Dados inválidos.');
    await db.query('set constraints all deferred'); // confere as ligações só no fim
    for (const t of [...ORDEM_GRAVACAO].reverse()) await db.query(`delete from ${t} where usuario_id = $1`, [usuario]);
    for (const t of ORDEM_GRAVACAO) {
      const linhas = tabelas[t] ?? [];
      if (!Array.isArray(linhas)) throw new ErroDeUso(`A tabela ${t} está danificada.`);
      await inserir(db, t, usuario, linhas, { comPadroes: false });
    }
  }

  return { executar, carregarTudo, substituir };
}
