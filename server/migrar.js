// Cria (ou completa) as tabelas no banco do DATABASE_URL. Uso: npm run db:migrar
import { criarPool, migrar } from './db.js';

const pool = criarPool();
await migrar(pool);
console.log('Tabelas prontas.');
await pool.end();
