// Sobe o servidor: confere o banco, cria as tabelas que faltarem e abre a porta.
// Uso: npm start   (variáveis em .env, veja .env.example)
import { criarPool, migrar } from './db.js';
import { criarApp } from './app.js';

const pool = criarPool();
await migrar(pool);
const app = await criarApp({ pool });
const porta = Number(process.env.PORT || 3000);
const servidor = app.listen(porta, () => console.log(`Caixa + Resina no ar: http://localhost:${porta}`));

const desligar = () => servidor.close(() => pool.end().then(() => process.exit(0)));
process.on('SIGINT', desligar);
process.on('SIGTERM', desligar);
