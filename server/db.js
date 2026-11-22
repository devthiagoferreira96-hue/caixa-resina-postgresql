// =====================================================================
// Conexão com o PostgreSQL (node-postgres) e conversão dos tipos.
// =====================================================================
import pg from 'pg';
import { readFile } from 'node:fs/promises';

const { Pool, types } = pg;

// O PostgreSQL devolve numeric como texto (para não perder precisão). O sistema
// trabalha com Number e arredonda os centavos sozinho, então converte aqui.
types.setTypeParser(types.builtins.NUMERIC, (v) => (v === null ? null : Number(v)));
types.setTypeParser(types.builtins.INT8, (v) => (v === null ? null : Number(v)));
// date continua "AAAA-MM-DD" (sem virar Date com fuso horário, que mudaria o dia)
types.setTypeParser(types.builtins.DATE, (v) => v);
// timestamptz no mesmo formato que o navegador gera: 2026-05-01T12:00:00.000Z
types.setTypeParser(types.builtins.TIMESTAMPTZ, (v) => (v === null ? null : new Date(v).toISOString()));

export function criarPool(url = process.env.DATABASE_URL) {
  if (!url) throw new Error('Defina DATABASE_URL (veja o arquivo .env.example).');
  return new Pool({
    connectionString: url,
    max: Number(process.env.PG_MAX || 10),
    ssl: process.env.PG_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  });
}

/** Cria as tabelas que faltarem (o esquema usa "if not exists": pode rodar sempre) */
export async function migrar(pool) {
  const sql = await readFile(new URL('./esquema.sql', import.meta.url), 'utf8');
  await pool.query(sql);
}

/** Roda `fn` dentro de uma transação: ou grava tudo, ou nada */
export async function transacao(pool, fn) {
  const cliente = await pool.connect();
  try {
    await cliente.query('begin');
    const r = await fn(cliente);
    await cliente.query('commit');
    return r;
  } catch (e) {
    await cliente.query('rollback').catch(() => {});
    throw e;
  } finally {
    cliente.release();
  }
}

/**
 * Lê do próprio banco quais colunas cada tabela tem, o tipo e se tem valor padrão.
 * Assim o montador de SQL não precisa repetir a lista de colunas.
 */
export async function lerColunas(pool) {
  const { rows } = await pool.query(`
    select table_name, column_name, data_type, is_nullable = 'YES' as nulo, column_default is not null or is_identity = 'YES' as tem_padrao
    from information_schema.columns
    where table_schema = current_schema()
    order by table_name, ordinal_position`);
  const colunas = {};
  for (const r of rows) {
    (colunas[r.table_name] ||= {})[r.column_name] = { tipo: r.data_type, nulo: r.nulo, temPadrao: r.tem_padrao };
  }
  return colunas;
}
