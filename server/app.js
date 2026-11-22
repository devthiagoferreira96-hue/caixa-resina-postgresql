// =====================================================================
// API REST do Caixa + Resina (Express).
//
//   POST   /api/conta            cria o usuário (e os dados iniciais)
//   POST   /api/entrar           entra com usuário e senha
//   POST   /api/recuperar        esqueci a senha: entra com o código de recuperação
//   GET    /api/sessao           quem está logado (usuario: null se ninguém entrou)
//   GET    /api/saude            servidor e banco no ar (usado pelo Render)
//   POST   /api/sair             encerra a sessão
//   POST   /api/conta/conferir   confere a senha atual (sem mudar nada)
//   PATCH  /api/conta            troca o nome e/ou a senha
//   POST   /api/conta/codigo     gera um código de recuperação novo
//   POST   /api/conta/backup     marca a data do último backup
//   DELETE /api/conta            apaga o usuário e todos os dados dele
//   GET    /api/dados            todas as tabelas do usuário
//   PUT    /api/dados            troca todos os dados (restaurar backup)
//   POST   /api/consulta         uma consulta from().select().eq()... (veja consultas.js)
// =====================================================================
import express from 'express';
import cookieParser from 'cookie-parser';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transacao, lerColunas } from './db.js';
import { criarConsultas, erroDoBanco, ErroDeUso } from './consultas.js';
import { gerarHash, conferirHash, gastarTempo, criarSessao, criarLimite } from './seguranca.js';
import { gerarCodigoRecuperacao, normalizarCodigo, codigoValido } from '../src/lib/codigo-recuperacao.js';

const SENHA_MIN = 4;

export async function criarApp({ pool, segredoJwt = process.env.JWT_SECRET, pastaSite } = {}) {
  const consultas = criarConsultas(await lerColunas(pool));
  const sessao = criarSessao(segredoJwt);
  // 5 erros seguidos no mesmo usuário, ou 20 no mesmo IP (vários usuários atrás da mesma internet)
  const limiteUsuario = criarLimite({ maximo: 5 });
  const limiteIp = criarLimite({ maximo: 20 });
  const limite = {
    espera: ([ip, u]) => Math.max(limiteIp.espera([ip]), limiteUsuario.espera([u])),
    errou: ([ip, u]) => { limiteIp.errou([ip]); limiteUsuario.errou([u]); },
    acertou: ([ip, u]) => { limiteIp.acertou([ip]); limiteUsuario.acertou([u]); },
  };
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1); // atrás de proxy (Render, Railway...): IP real do visitante
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
    });
    next();
  });
  app.use(cookieParser());
  app.use('/api', express.json({ limit: '25mb' })); // backups grandes passam por aqui

  // Pedidos que mudam dados precisam ser JSON: um formulário de outro site não consegue mandar
  app.use('/api', (req, res, next) => {
    if (!['GET', 'HEAD'].includes(req.method) && req.headers['content-type'] && !req.is('application/json')) {
      return res.status(415).json({ erro: { message: 'Envie os dados em JSON.' } });
    }
    res.set('Cache-Control', 'no-store');
    next();
  });

  /** Envolve a rota: erros viram { erro: { code, message } } com o status certo */
  const rota = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      const conhecido = erroDoBanco(e);
      if (process.env.LOG_SQL && conhecido) console.warn('[recusado]', e.message, JSON.stringify(req.body)?.slice(0, 500));
      if (conhecido) return res.status(e.status || 400).json({ erro: conhecido });
      console.error(e);
      res.status(500).json({ erro: { message: 'Erro no servidor. Tente de novo.' } });
    }
  };

  /** Exige sessão válida: coloca o usuário em req.usuario */
  const logado = (fn) => rota(async (req, res) => {
    const s = sessao.ler(req);
    const u = s && (await pool.query('select * from usuarios where id = $1', [s.id])).rows[0];
    if (!u || u.versao_sessao !== s.versao) {
      sessao.fechar(res);
      return res.status(401).json({ erro: { code: 'sessao', message: 'Sua sessão terminou. Entre de novo.' } });
    }
    req.usuario = u;
    await fn(req, res);
  });

  const publico = (u) => ({ usuario: u.nome, ultimoBackup: u.ultimo_backup });
  const nomeValido = (n) => typeof n === 'string' && n.trim().length >= 1 && n.trim().length <= 40;
  const senhaValida = (s) => typeof s === 'string' && s.length >= SENHA_MIN && s.length <= 64;
  const chavesDoLimite = (req, nome) => [`ip:${req.ip}`, `u:${String(nome || '').trim().toLowerCase()}`];
  const buscarPorNome = async (nome) => (await pool.query('select * from usuarios where lower(nome) = lower($1)', [String(nome || '').trim()])).rows[0];

  // ---------- Saúde (o Render confere se o servidor e o banco respondem)
  app.get('/api/saude', rota(async (req, res) => {
    await pool.query('select 1');
    res.json({ ok: true });
  }));

  // ---------- Acesso
  app.post('/api/conta', rota(async (req, res) => {
    const { usuario, senha, tabelas } = req.body || {};
    if (!nomeValido(usuario)) throw new ErroDeUso('Escreva seu nome (até 40 letras).');
    if (!senhaValida(senha)) throw new ErroDeUso(`A senha precisa ter pelo menos ${SENHA_MIN} caracteres.`);
    if (await buscarPorNome(usuario)) return res.status(409).json({ erro: { code: 'nome', message: 'Já existe um acesso com esse nome. Escolha outro ou entre com a sua senha.' } });
    const codigo = gerarCodigoRecuperacao();
    const u = await transacao(pool, async (db) => {
      const novo = (await db.query(
        'insert into usuarios (nome, senha_hash, codigo_hash) values ($1, $2, $3) returning *',
        [usuario.trim(), await gerarHash(senha), await gerarHash(normalizarCodigo(codigo))],
      )).rows[0];
      if (tabelas) await consultas.substituir(db, novo.id, tabelas);
      return novo;
    });
    sessao.abrir(res, u);
    res.status(201).json({ ...publico(u), codigo });
  }));

  app.post('/api/entrar', rota(async (req, res) => {
    const { usuario, senha } = req.body || {};
    const chaves = chavesDoLimite(req, usuario);
    const espera = limite.espera(chaves);
    if (espera) return res.status(429).json({ erro: { code: 'espera', espera, message: `Muitas tentativas. Aguarde ${espera} segundos.` } });
    const u = await buscarPorNome(usuario);
    const certo = u ? await conferirHash(senha, u.senha_hash) : (await gastarTempo(senha), false);
    if (!certo) {
      limite.errou(chaves);
      return res.status(401).json({ erro: { code: 'senha', message: 'Usuário ou senha incorretos.' } });
    }
    limite.acertou(chaves);
    sessao.abrir(res, u);
    res.json(publico(u));
  }));

  app.post('/api/recuperar', rota(async (req, res) => {
    const { usuario, codigo, senhaNova } = req.body || {};
    if (!senhaValida(senhaNova)) throw new ErroDeUso(`A senha precisa ter pelo menos ${SENHA_MIN} caracteres.`);
    const chaves = chavesDoLimite(req, usuario);
    const espera = limite.espera(chaves);
    if (espera) return res.status(429).json({ erro: { code: 'espera', espera, message: `Muitas tentativas. Aguarde ${espera} segundos.` } });
    const u = await buscarPorNome(usuario);
    const certo = u && codigoValido(codigo) ? await conferirHash(normalizarCodigo(codigo), u.codigo_hash) : (await gastarTempo(String(codigo)), false);
    if (!certo) {
      limite.errou(chaves);
      return res.status(401).json({ erro: { code: 'codigo', message: 'Código incorreto.' } });
    }
    limite.acertou(chaves);
    const novo = gerarCodigoRecuperacao(); // o antigo pode ter sido visto: troca também
    const atualizado = (await pool.query(
      'update usuarios set senha_hash = $2, codigo_hash = $3, versao_sessao = versao_sessao + 1 where id = $1 returning *',
      [u.id, await gerarHash(senhaNova), await gerarHash(normalizarCodigo(novo))],
    )).rows[0];
    sessao.abrir(res, atualizado);
    res.json({ ...publico(atualizado), codigo: novo });
  }));

  // sem sessão responde 200 com usuario: null (não é um erro: só ainda não entrou)
  app.get('/api/sessao', rota(async (req, res) => {
    const s = sessao.ler(req);
    const u = s && (await pool.query('select * from usuarios where id = $1', [s.id])).rows[0];
    if (!u || u.versao_sessao !== s.versao) {
      if (s) sessao.fechar(res);
      return res.json({ usuario: null });
    }
    res.json(publico(u));
  }));

  app.post('/api/sair', rota(async (req, res) => {
    sessao.fechar(res);
    res.status(204).end();
  }));

  // ---------- Conta
  app.post('/api/conta/conferir', logado(async (req, res) => {
    res.json({ ok: await conferirHash(req.body?.senha, req.usuario.senha_hash) });
  }));

  app.patch('/api/conta', logado(async (req, res) => {
    const { usuario, senhaAtual, senhaNova } = req.body || {};
    let u = req.usuario;
    if (senhaNova !== undefined) {
      if (!(await conferirHash(senhaAtual, u.senha_hash))) throw new ErroDeUso('A senha atual está incorreta.');
      if (!senhaValida(senhaNova)) throw new ErroDeUso(`A senha precisa ter pelo menos ${SENHA_MIN} caracteres.`);
      u = (await pool.query('update usuarios set senha_hash = $2, versao_sessao = versao_sessao + 1 where id = $1 returning *', [u.id, await gerarHash(senhaNova)])).rows[0];
      sessao.abrir(res, u); // esta sessão continua; as outras (outros aparelhos) terminam
    }
    if (usuario !== undefined) {
      if (!nomeValido(usuario)) throw new ErroDeUso('Escreva seu nome (até 40 letras).');
      const outro = await buscarPorNome(usuario);
      if (outro && outro.id !== u.id) throw new ErroDeUso('Já existe um acesso com esse nome.');
      u = (await pool.query('update usuarios set nome = $2 where id = $1 returning *', [u.id, usuario.trim()])).rows[0];
    }
    res.json(publico(u));
  }));

  app.post('/api/conta/codigo', logado(async (req, res) => {
    if (!(await conferirHash(req.body?.senhaAtual, req.usuario.senha_hash))) throw new ErroDeUso('A senha está incorreta.');
    const codigo = gerarCodigoRecuperacao();
    await pool.query('update usuarios set codigo_hash = $2 where id = $1', [req.usuario.id, await gerarHash(normalizarCodigo(codigo))]);
    res.json({ codigo });
  }));

  app.post('/api/conta/backup', logado(async (req, res) => {
    const u = (await pool.query('update usuarios set ultimo_backup = now() where id = $1 returning *', [req.usuario.id])).rows[0];
    res.json(publico(u));
  }));

  app.delete('/api/conta', logado(async (req, res) => {
    await pool.query('delete from usuarios where id = $1', [req.usuario.id]); // os dados saem junto (on delete cascade)
    sessao.fechar(res);
    res.status(204).end();
  }));

  // ---------- Dados
  app.get('/api/dados', logado(async (req, res) => {
    res.json({ tabelas: await consultas.carregarTudo(pool, req.usuario.id) });
  }));

  app.put('/api/dados', logado(async (req, res) => {
    await transacao(pool, (db) => consultas.substituir(db, req.usuario.id, req.body?.tabelas));
    res.json({ tabelas: await consultas.carregarTudo(pool, req.usuario.id) });
  }));

  // O banco recusou por uma regra (item em uso, id repetido, valor fora do permitido)?
  // A consulta foi processada: responde 200 com { data: null, erro }, como o cliente do Supabase.
  // Pedido mal montado continua sendo 400.
  app.post('/api/consulta', logado(async (req, res) => {
    const q = req.body;
    try {
      const data = q?.op && q.op !== 'select'
        ? await transacao(pool, (db) => consultas.executar(db, req.usuario.id, q))
        : await consultas.executar(pool, req.usuario.id, q);
      res.json({ data });
    } catch (e) {
      if (!/^23/.test(e.code || '')) throw e;
      if (process.env.LOG_SQL) console.warn('[recusado]', e.message);
      res.json({ data: null, erro: erroDoBanco(e) });
    }
  }));

  app.use('/api', (req, res) => res.status(404).json({ erro: { message: 'Endereço não encontrado.' } }));
  // JSON quebrado ou grande demais (o express.json avisa por aqui)
  app.use('/api', (err, req, res, next) => {
    if (err.type === 'entity.too.large') return res.status(413).json({ erro: { message: 'Os dados enviados são grandes demais.' } });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ erro: { message: 'JSON inválido.' } });
    next(err);
  });

  // ---------- Site (versão gerada pelo "npm run build")
  const site = pastaSite ?? fileURLToPath(new URL('../dist/', import.meta.url));
  if (existsSync(site)) {
    app.use(express.static(site, { index: 'index.html', maxAge: '1h', setHeaders: (res, caminho) => {
      if (/index\.html$|sw\.js$/.test(caminho)) res.set('Cache-Control', 'no-cache');
    } }));
  }
  return app;
}
