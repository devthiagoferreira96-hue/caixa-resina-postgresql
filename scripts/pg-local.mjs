// =====================================================================
// PostgreSQL de verdade rodando dentro do Node (PGlite), para desenvolver
// sem instalar nada. Fica escutando como um servidor PostgreSQL comum.
// Uso: npm run db:local   ->  postgres://postgres@127.0.0.1:5433/postgres
// Os dados ficam na pasta .pgdata (apague a pasta para começar do zero).
// Em produção, use um PostgreSQL normal (Docker, Neon, Supabase, RDS...).
// =====================================================================
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

const porta = Number(process.env.PG_LOCAL_PORTA || 5433);
const pasta = process.env.PG_LOCAL_PASTA || './.pgdata';
const db = await PGlite.create({ dataDir: pasta });
const srv = new PGLiteSocketServer({ db, port: porta, host: '127.0.0.1' });
await srv.start();
console.log(`PostgreSQL local no ar: postgres://postgres@127.0.0.1:${porta}/postgres (dados em ${pasta})`);
const parar = async () => { await srv.stop(); await db.close(); process.exit(0); };
process.on('SIGINT', parar);
process.on('SIGTERM', parar);
