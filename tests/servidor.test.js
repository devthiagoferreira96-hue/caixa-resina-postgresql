// Testes da API + PostgreSQL. Sobe um PostgreSQL de verdade em memória (PGlite),
// cria as tabelas e conversa com o servidor por HTTP, como o navegador faz.
// Rode com: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { criarPool, migrar } from '../server/db.js';
import { criarApp } from '../server/app.js';
import { dadosIniciais } from '../src/lib/exemplo.js';

let banco, socket, pool, servidor, URL_API;

before(async () => {
  banco = await PGlite.create();
  socket = new PGLiteSocketServer({ db: banco, port: 0, host: '127.0.0.1' });
  await socket.start();
  const porta = socket.server?.address?.().port ?? socket.port;
  process.env.PG_MAX = '1';
  pool = criarPool(`postgres://postgres@127.0.0.1:${porta}/postgres`);
  await migrar(pool);
  await migrar(pool); // rodar de novo não pode quebrar (if not exists)
  const app = await criarApp({ pool, segredoJwt: 'segredo-de-teste-com-mais-de-32-caracteres!!', pastaSite: '/nao/existe' });
  await new Promise((ok) => { servidor = app.listen(0, '127.0.0.1', ok); });
  URL_API = `http://127.0.0.1:${servidor.address().port}/api/`;
});

after(async () => {
  await new Promise((ok) => servidor.close(ok));
  await pool.end();
  await socket.stop();
  await banco.close();
});

/** Um "navegador": guarda o cookie da sessão entre os pedidos */
function cliente() {
  let cookie = '';
  const pedir = async (metodo, caminho, corpo) => {
    const r = await fetch(URL_API + caminho, {
      method: metodo,
      headers: { ...(corpo !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: corpo !== undefined ? JSON.stringify(corpo) : undefined,
    });
    const novo = r.headers.get('set-cookie');
    if (novo) cookie = novo.split(';')[0];
    const j = r.status === 204 ? null : await r.json();
    return { status: r.status, j };
  };
  const consulta = async (q) => (await pedir('POST', 'consulta', q)).j;
  return { pedir, consulta, get cookie() { return cookie; }, set cookie(c) { cookie = c; } };
}

const id = () => crypto.randomUUID();

test('rota de saúde responde com o banco no ar', async () => {
  const r = await cliente().pedir('GET', 'saude');
  assert.equal(r.status, 200);
  assert.equal(r.j.ok, true);
});

test('cria o acesso com os dados iniciais e abre a sessão', async () => {
  const a = cliente();
  const r = await a.pedir('POST', 'conta', { usuario: 'Ana', senha: 'senha123', tabelas: dadosIniciais({ comExemplo: true }) });
  assert.equal(r.status, 201);
  assert.match(r.j.codigo, /^[A-Z0-9]{4}(-[A-Z0-9]{4}){3}$/);
  assert.match(a.cookie, /^caixa_sessao=/);
  assert.equal((await a.pedir('GET', 'sessao')).j.usuario, 'Ana');
  const { tabelas } = (await a.pedir('GET', 'dados')).j;
  assert.ok(tabelas.contas.length >= 4);
  assert.ok(tabelas.lancamentos.length > 5);
  assert.equal(typeof tabelas.lancamentos[0].valor, 'number'); // numeric volta como número
  assert.match(tabelas.lancamentos[0].vencimento, /^\d{4}-\d{2}-\d{2}$/); // date volta como AAAA-MM-DD
  // senha nunca volta do servidor
  assert.ok(!JSON.stringify(r.j).includes('senha123'));
});

test('não deixa criar dois acessos com o mesmo nome (sem diferenciar maiúsculas)', async () => {
  const r = await cliente().pedir('POST', 'conta', { usuario: 'ana', senha: 'outra123' });
  assert.equal(r.status, 409);
});

test('sem sessão, nenhum dado sai', async () => {
  const c = cliente();
  assert.equal((await c.pedir('GET', 'dados')).status, 401);
  assert.equal((await c.pedir('POST', 'consulta', { tabela: 'contas', op: 'select' })).status, 401);
  c.cookie = 'caixa_sessao=token.falso.qualquer';
  assert.equal((await c.pedir('GET', 'sessao')).j.usuario, null);
});

test('select com eq, in, gte, lt e order (SQL de verdade)', async () => {
  const c = cliente();
  await c.pedir('POST', 'conta', { usuario: 'Bruno', senha: 'senha123' });
  const conta = id();
  await c.consulta({ tabela: 'contas', op: 'insert', linhas: [{ id: conta, nome: 'Carteira' }] });
  const linhas = [['2026-01-05', 10, true], ['2026-01-20', 20, false], ['2026-02-01', 30, false], ['2026-02-15', 40, true]]
    .map(([vencimento, valor, pago]) => ({ id: id(), tipo: 'saida', valor, vencimento, pago, descricao: `Conta ${valor}`, conta_id: conta }));
  const ins = await c.consulta({ tabela: 'lancamentos', op: 'insert', linhas });
  assert.equal(ins.data.length, 4);
  assert.ok(ins.data[0].criado_em); // criado_em preenchido como no sistema original

  const jan = await c.consulta({ tabela: 'lancamentos', op: 'select', filtros: [['gte', 'vencimento', '2026-01-01'], ['lt', 'vencimento', '2026-02-01']], ordem: { c: 'vencimento', asc: false } });
  assert.deepEqual(jan.data.map((l) => l.valor), [20, 10]);
  const abertos = await c.consulta({ tabela: 'lancamentos', op: 'select', filtros: [['eq', 'pago', false]], ordem: { c: 'valor' } });
  assert.deepEqual(abertos.data.map((l) => l.valor), [20, 30]);
  const alguns = await c.consulta({ tabela: 'lancamentos', op: 'select', filtros: [['in', 'id', [linhas[0].id, linhas[3].id]]], ordem: { c: 'valor' } });
  assert.deepEqual(alguns.data.map((l) => l.valor), [10, 40]);
  const nenhum = await c.consulta({ tabela: 'lancamentos', op: 'select', filtros: [['in', 'id', []]] });
  assert.deepEqual(nenhum.data, []);
  const um = await c.consulta({ tabela: 'lancamentos', op: 'select', filtros: [['eq', 'id', linhas[2].id]], unico: true });
  assert.equal(um.data.valor, 30);
});

test('update e delete só mexem nas linhas filtradas', async () => {
  const c = cliente();
  await c.pedir('POST', 'conta', { usuario: 'Carla', senha: 'senha123' });
  const [a, b] = [id(), id()];
  await c.consulta({ tabela: 'pessoas', op: 'insert', linhas: [{ id: a, nome: 'A' }, { id: b, nome: 'B' }] });
  const up = await c.consulta({ tabela: 'pessoas', op: 'update', valores: { nome: 'A2' }, filtros: [['eq', 'id', a]] });
  assert.equal(up.data.length, 1);
  assert.equal(up.data[0].nome, 'A2');
  assert.equal(up.data[0].tipo, 'Outro'); // padrão do sistema
  const del = await c.consulta({ tabela: 'pessoas', op: 'delete', filtros: [['eq', 'id', b]] });
  assert.equal(del.data.length, 1);
  const resto = await c.consulta({ tabela: 'pessoas', op: 'select' });
  assert.deepEqual(resto.data.map((p) => p.nome), ['A2']);
});

test('chaves estrangeiras: em uso não exclui; cascata e set null funcionam', async () => {
  const c = cliente();
  await c.pedir('POST', 'conta', { usuario: 'Diego', senha: 'senha123' });
  const [cat, cartao, compra, pessoa, lanc] = [id(), id(), id(), id(), id()];
  await c.consulta({ tabela: 'categorias', op: 'insert', linhas: [{ id: cat, nome: 'Mercado' }] });
  await c.consulta({ tabela: 'pessoas', op: 'insert', linhas: [{ id: pessoa, nome: 'Fulano' }] });
  await c.consulta({ tabela: 'cartoes', op: 'insert', linhas: [{ id: cartao, nome: 'Cartão', dia_fechamento: 3, dia_vencimento: 10 }] });
  await c.consulta({ tabela: 'compras_cartao', op: 'insert', linhas: [{ id: compra, cartao_id: cartao, data_compra: '2026-03-01', valor_total: 300, qtd_parcelas: 3, descricao: 'TV', categoria_id: cat, pessoa_id: pessoa }] });
  await c.consulta({ tabela: 'parcelas', op: 'insert', linhas: [1, 2, 3].map((n) => ({ id: id(), compra_id: compra, numero: n, valor: 100, fatura_mes: `2026-0${n + 3}-01` })) });
  await c.consulta({ tabela: 'lancamentos', op: 'insert', linhas: [{ id: lanc, tipo: 'saida', valor: 50, vencimento: '2026-03-10', descricao: 'Feira', categoria_id: cat, pessoa_id: pessoa, fatura_cartao_id: cartao }] });

  // categoria em uso: erro 23503 (o sistema mostra "Esse item já foi usado em lançamentos")
  const emUso = await c.consulta({ tabela: 'categorias', op: 'delete', filtros: [['eq', 'id', cat]] });
  assert.equal(emUso.erro.code, '23503');

  // excluir a pessoa: lançamento e compra ficam sem pessoa (set null)
  await c.consulta({ tabela: 'pessoas', op: 'delete', filtros: [['eq', 'id', pessoa]] });
  const l = await c.consulta({ tabela: 'lancamentos', op: 'select', filtros: [['eq', 'id', lanc]], unico: true });
  assert.equal(l.data.pessoa_id, null);

  // excluir o cartão: compras e parcelas saem junto (cascade); o lançamento perde a fatura (set null)
  await c.consulta({ tabela: 'cartoes', op: 'delete', filtros: [['eq', 'id', cartao]] });
  const { tabelas } = (await c.pedir('GET', 'dados')).j;
  assert.equal(tabelas.compras_cartao.length, 0);
  assert.equal(tabelas.parcelas.length, 0);
  assert.equal(tabelas.lancamentos[0].fatura_cartao_id, null);
});

test('resina: a mensagem de erro diz se o item foi usado em cargas ou em insumos', async () => {
  const c = cliente();
  await c.pedir('POST', 'conta', { usuario: 'Eva', senha: 'senha123' });
  const [prod, produto, carga] = [id(), id(), id()];
  await c.consulta({ tabela: 'resina_produtores', op: 'insert', linhas: [{ id: prod, nome: 'Produtor 1', cor: '#2E9E6B' }] });
  await c.consulta({ tabela: 'resina_produtos', op: 'insert', linhas: [{ id: produto, nome: 'Estimulante' }] });
  await c.consulta({ tabela: 'resina_cargas', op: 'insert', linhas: [{ id: carga, numero: 1, data: '2026-04-01', preco_kg: 6.5 }] });
  await c.consulta({ tabela: 'resina_carga_itens', op: 'insert', linhas: [{ id: id(), carga_id: carga, produtor_id: prod, tbs: 2.5 }] });
  await c.consulta({ tabela: 'resina_insumos', op: 'insert', linhas: [{ id: id(), data: '2026-04-02', produtor_id: prod, produto_id: produto, quantidade: 3, valor_unitario: 12.3333, valor_total: 37 }] });

  const p = await c.consulta({ tabela: 'resina_produtores', op: 'delete', filtros: [['eq', 'id', prod]] });
  assert.match(p.erro.message, /cargas/);
  assert.doesNotMatch(p.erro.message, /insumos/);
  const i = await c.consulta({ tabela: 'resina_produtos', op: 'delete', filtros: [['eq', 'id', produto]] });
  assert.match(i.erro.message, /insumos/);
  // valores com mais de 2 casas não são arredondados pelo banco
  const ins = await c.consulta({ tabela: 'resina_insumos', op: 'select' });
  assert.equal(ins.data[0].valor_unitario, 12.3333);
  // excluir a carga leva os itens junto
  await c.consulta({ tabela: 'resina_cargas', op: 'delete', filtros: [['eq', 'id', carga]] });
  assert.equal((await c.consulta({ tabela: 'resina_carga_itens', op: 'select' })).data.length, 0);
});

test('campos que ainda não são coluna ficam em "extras" e também dão para filtrar', async () => {
  const c = cliente();
  await c.pedir('POST', 'conta', { usuario: 'Fabio', senha: 'senha123' });
  const x = id();
  await c.consulta({ tabela: 'contas', op: 'insert', linhas: [{ id: x, nome: 'Poupança', apelido: 'reserva', meta: { valor: 1000 } }] });
  const r = await c.consulta({ tabela: 'contas', op: 'select', filtros: [['eq', 'apelido', 'reserva']] });
  assert.equal(r.data.length, 1);
  assert.deepEqual(r.data[0].meta, { valor: 1000 });
  await c.consulta({ tabela: 'contas', op: 'update', valores: { apelido: 'colchão' }, filtros: [['eq', 'id', x]] });
  assert.equal((await c.consulta({ tabela: 'contas', op: 'select', unico: true })).data.apelido, 'colchão');
});

test('cada usuário só vê e só liga os próprios dados', async () => {
  const a = cliente(), b = cliente();
  await a.pedir('POST', 'conta', { usuario: 'Gabi', senha: 'senha123' });
  await b.pedir('POST', 'conta', { usuario: 'Hugo', senha: 'senha123' });
  const contaDaGabi = id();
  await a.consulta({ tabela: 'contas', op: 'insert', linhas: [{ id: contaDaGabi, nome: 'Da Gabi' }] });
  assert.equal((await b.consulta({ tabela: 'contas', op: 'select' })).data.length, 0);
  // Hugo tenta alterar e apagar pelo id: nada acontece
  assert.equal((await b.consulta({ tabela: 'contas', op: 'update', valores: { nome: 'Peguei' }, filtros: [['eq', 'id', contaDaGabi]] })).data.length, 0);
  assert.equal((await b.consulta({ tabela: 'contas', op: 'delete', filtros: [['eq', 'id', contaDaGabi]] })).data.length, 0);
  // e não consegue ligar um lançamento dele à conta da Gabi (chave estrangeira composta)
  const r = await b.consulta({ tabela: 'lancamentos', op: 'insert', linhas: [{ id: id(), tipo: 'saida', valor: 1, vencimento: '2026-01-01', conta_id: contaDaGabi }] });
  assert.equal(r.erro.code, '23503');
  assert.equal((await a.consulta({ tabela: 'contas', op: 'select', unico: true })).data.nome, 'Da Gabi');
});

test('consultas mal montadas não viram SQL', async () => {
  const c = cliente();
  await c.pedir('POST', 'conta', { usuario: 'Iris', senha: 'senha123' });
  const ruins = [
    { tabela: 'usuarios', op: 'select' },
    { tabela: 'contas; drop table contas', op: 'select' },
    { tabela: 'contas', op: 'select', filtros: [['eq', 'nome" or 1=1 --', 'x']] },
    { tabela: 'contas', op: 'select', filtros: [['eq', 'usuario_id', 'qualquer']] },
    { tabela: 'contas', op: 'select', ordem: { c: 'nome; drop table contas' } },
    { tabela: 'contas', op: 'insert', linhas: [{ id: id(), nome: 'X', 'a"b': 1 }] },
    { tabela: 'contas', op: 'truncate' },
  ];
  for (const q of ruins) {
    const r = await c.pedir('POST', 'consulta', q);
    assert.equal(r.status, 400, JSON.stringify(q));
  }
  // o valor vai como parâmetro: texto com aspas é só texto
  await c.consulta({ tabela: 'contas', op: 'insert', linhas: [{ id: id(), nome: "O'Brien'); drop table contas; --" }] });
  assert.equal((await c.consulta({ tabela: 'contas', op: 'select', filtros: [['eq', 'nome', "O'Brien'); drop table contas; --"]] })).data.length, 1);
});

test('restaurar backup troca tudo numa transação (e um backup quebrado não apaga nada)', async () => {
  const c = cliente();
  await c.pedir('POST', 'conta', { usuario: 'João', senha: 'senha123', tabelas: dadosIniciais({ comExemplo: true }) });
  const antes = (await c.pedir('GET', 'dados')).j.tabelas;
  const r = await c.pedir('PUT', 'dados', { tabelas: antes });
  assert.equal(r.status, 200);
  const semSeq = (t) => Object.fromEntries(Object.entries(t).map(([k, v]) => [k, [...v].sort((x, y) => (x.id > y.id ? 1 : -1))]));
  assert.deepEqual(semSeq(r.j.tabelas), semSeq(antes));

  // backup com lançamento ligado a uma conta que não existe: nada muda
  const quebrado = { ...antes, lancamentos: [...antes.lancamentos, { id: id(), tipo: 'saida', valor: 9, vencimento: '2026-01-01', conta_id: 'nao-existe' }] };
  const falhou = await c.pedir('PUT', 'dados', { tabelas: quebrado });
  assert.equal(falhou.status, 400);
  assert.equal((await c.pedir('GET', 'dados')).j.tabelas.lancamentos.length, antes.lancamentos.length);
});

test('entrar, senha errada, limite de tentativas e sair', async () => {
  const c = cliente();
  await c.pedir('POST', 'conta', { usuario: 'Kaio', senha: 'certa123' });
  await c.pedir('POST', 'sair');
  assert.equal((await c.pedir('GET', 'sessao')).j.usuario, null);
  assert.equal((await c.pedir('POST', 'entrar', { usuario: 'kaio', senha: 'certa123' })).status, 200);
  for (let i = 0; i < 5; i++) assert.equal((await c.pedir('POST', 'entrar', { usuario: 'Kaio', senha: 'errada' })).status, 401);
  const bloqueado = await c.pedir('POST', 'entrar', { usuario: 'Kaio', senha: 'certa123' });
  assert.equal(bloqueado.status, 429);
  assert.ok(bloqueado.j.erro.espera > 0);
});

test('código de recuperação: cria senha nova, troca o código e derruba as outras sessões', async () => {
  const celular = cliente(), pc = cliente();
  const { codigo } = (await celular.pedir('POST', 'conta', { usuario: 'Lia', senha: 'antiga123' })).j;
  await pc.pedir('POST', 'entrar', { usuario: 'Lia', senha: 'antiga123' });
  assert.equal((await pc.pedir('GET', 'sessao')).j.usuario, 'Lia');

  assert.equal((await celular.pedir('POST', 'recuperar', { usuario: 'Lia', codigo: 'AAAA-BBBB-CCCC-DDDD', senhaNova: 'nova1234' })).status, 401);
  const r = await celular.pedir('POST', 'recuperar', { usuario: 'Lia', codigo: codigo.toLowerCase().replace(/-/g, ' '), senhaNova: 'nova1234' });
  assert.equal(r.status, 200);
  assert.notEqual(r.j.codigo, codigo);
  assert.equal((await pc.pedir('GET', 'sessao')).j.usuario, null); // a sessão antiga do PC terminou
  assert.equal((await pc.pedir('GET', 'dados')).status, 401);
  assert.equal((await celular.pedir('GET', 'sessao')).j.usuario, 'Lia');
  // o código usado não vale mais
  assert.equal((await cliente().pedir('POST', 'recuperar', { usuario: 'Lia', codigo, senhaNova: 'outra123' })).status, 401);
  assert.equal((await cliente().pedir('POST', 'entrar', { usuario: 'Lia', senha: 'nova1234' })).status, 200);
});

test('trocar nome e senha, novo código, backup e apagar o acesso', async () => {
  const c = cliente();
  await c.pedir('POST', 'conta', { usuario: 'Mara', senha: 'senha123', tabelas: dadosIniciais() });
  assert.equal((await c.pedir('POST', 'conta/conferir', { senha: 'senha123' })).j.ok, true);
  assert.equal((await c.pedir('POST', 'conta/conferir', { senha: 'errada' })).j.ok, false);
  assert.equal((await c.pedir('PATCH', 'conta', { senhaAtual: 'errada', senhaNova: 'nova1234' })).status, 400);
  assert.equal((await c.pedir('PATCH', 'conta', { usuario: 'Mara S.', senhaAtual: 'senha123', senhaNova: 'nova1234' })).j.usuario, 'Mara S.');
  assert.equal((await c.pedir('GET', 'sessao')).j.usuario, 'Mara S.'); // esta sessão continua depois de trocar a senha
  assert.match((await c.pedir('POST', 'conta/codigo', { senhaAtual: 'nova1234' })).j.codigo, /-/);
  assert.ok((await c.pedir('POST', 'conta/backup')).j.ultimoBackup);
  assert.equal((await c.pedir('DELETE', 'conta')).status, 204);
  assert.equal((await cliente().pedir('POST', 'entrar', { usuario: 'Mara S.', senha: 'nova1234' })).status, 401);
  const sobrou = await pool.query("select count(*)::int as n from categorias c where not exists (select 1 from usuarios u where u.id = c.usuario_id)");
  assert.equal(sobrou.rows[0].n, 0); // os dados saíram junto com o usuário
});
