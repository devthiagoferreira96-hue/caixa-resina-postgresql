-- =====================================================================
-- Esquema do PostgreSQL do Caixa + Resina.
--
-- Regras gerais:
--  * Cada linha pertence a um usuário (usuario_id). O servidor sempre filtra por ele.
--  * As chaves estrangeiras são compostas (usuario_id, x_id): um usuário não
--    consegue ligar um lançamento a uma conta de outro usuário, nem por engano.
--  * O id é gerado no navegador (UUID): assim o "desfazer" consegue recolocar
--    uma linha excluída com o mesmo id.
--  * "extras" guarda campos novos que ainda não viraram coluna, sem perder nada.
--  * "seq" guarda a ordem de inserção (desempate quando a ordem pedida empata).
--  * Os nomes das restrições importam: o sistema traduz o erro pelo nome
--    ("cargas"/"insumos") em uma mensagem que qualquer pessoa entende.
--  * As chaves são DEFERRABLE: ao restaurar um backup, tudo é conferido no fim
--    da transação, então a ordem das linhas no arquivo não importa.
-- Rode com: npm run db:migrar
-- =====================================================================

create table if not exists usuarios (
  id uuid primary key default gen_random_uuid(),
  nome text not null check (char_length(nome) between 1 and 40),
  senha_hash text not null,
  codigo_hash text not null,          -- código de recuperação (também só o hash)
  versao_sessao int not null default 1, -- muda ao trocar a senha: derruba as sessões antigas
  ultimo_backup timestamptz,
  criado_em timestamptz not null default now()
);
create unique index if not exists usuarios_nome_unico on usuarios (lower(nome));

-- ---------- Caixa
create table if not exists contas (
  id text primary key,
  usuario_id uuid not null references usuarios(id) on delete cascade,
  nome text not null,
  saldo_inicial numeric not null default 0,
  ativa boolean not null default true,
  extras jsonb not null default '{}',
  seq bigint generated always as identity,
  unique (usuario_id, id)
);

create table if not exists cartoes (
  id text primary key,
  usuario_id uuid not null references usuarios(id) on delete cascade,
  nome text not null,
  dia_fechamento int check (dia_fechamento between 1 and 31),
  dia_vencimento int check (dia_vencimento between 1 and 31),
  ativo boolean not null default true,
  extras jsonb not null default '{}',
  seq bigint generated always as identity,
  unique (usuario_id, id)
);

create table if not exists categorias (
  id text primary key,
  usuario_id uuid not null references usuarios(id) on delete cascade,
  nome text not null,
  grupo text default 'Casa',
  no_grafico boolean default true,
  tipo text check (tipo in ('saida', 'entrada', 'ambos')),
  extras jsonb not null default '{}',
  seq bigint generated always as identity,
  unique (usuario_id, id)
);

create table if not exists pessoas (
  id text primary key,
  usuario_id uuid not null references usuarios(id) on delete cascade,
  nome text not null,
  tipo text default 'Outro',
  extras jsonb not null default '{}',
  seq bigint generated always as identity,
  unique (usuario_id, id)
);

create table if not exists lancamentos (
  id text primary key,
  usuario_id uuid not null references usuarios(id) on delete cascade,
  tipo text not null check (tipo in ('saida', 'entrada')),
  valor numeric not null check (valor > 0 and valor <= 99999999.99),
  descricao text,
  vencimento date not null,
  pago boolean not null default false,
  data_pagamento date,
  competencia date,
  conta_id text,
  categoria_id text,
  pessoa_id text,
  fatura_cartao_id text,
  fatura_mes date,
  parcela text,
  grupo text,
  recorrente boolean,
  observacao text,
  desconto numeric,
  juros numeric,
  valor_original numeric,
  divisao text,
  transferencia text,
  transferencia_conta_id text,
  resina_movimento_id text,
  resina_entrega_id text,
  resina_receber_id text,
  criado_em timestamptz default now(),
  alterado_em timestamptz,
  extras jsonb not null default '{}',
  seq bigint generated always as identity,
  constraint fk_lancamentos_conta foreign key (usuario_id, conta_id) references contas (usuario_id, id) deferrable,
  constraint fk_lancamentos_categoria foreign key (usuario_id, categoria_id) references categorias (usuario_id, id) deferrable,
  constraint fk_lancamentos_pessoa foreign key (usuario_id, pessoa_id) references pessoas (usuario_id, id) on delete set null (pessoa_id) deferrable,
  constraint fk_lancamentos_fatura foreign key (usuario_id, fatura_cartao_id) references cartoes (usuario_id, id) on delete set null (fatura_cartao_id) deferrable,
  constraint fk_lancamentos_transferencia foreign key (usuario_id, transferencia_conta_id) references contas (usuario_id, id) on delete set null (transferencia_conta_id) deferrable
);
create index if not exists lancamentos_vencimento on lancamentos (usuario_id, vencimento);
create index if not exists lancamentos_fatura on lancamentos (usuario_id, fatura_mes);
create index if not exists lancamentos_grupo on lancamentos (usuario_id, grupo);
create index if not exists lancamentos_pagos on lancamentos (usuario_id, pago);

create table if not exists compras_cartao (
  id text primary key,
  usuario_id uuid not null references usuarios(id) on delete cascade,
  cartao_id text not null,
  data_compra date not null,
  valor_total numeric not null check (valor_total <= 99999999.99),
  qtd_parcelas int not null default 1 check (qtd_parcelas >= 1),
  descricao text,
  categoria_id text,
  subcategoria text,
  pessoa_id text,
  tipo text default 'compra' check (tipo in ('compra', 'estorno')),
  recorrente boolean,
  criado_em timestamptz default now(),
  alterado_em timestamptz,
  extras jsonb not null default '{}',
  seq bigint generated always as identity,
  unique (usuario_id, id),
  constraint fk_compras_cartao foreign key (usuario_id, cartao_id) references cartoes (usuario_id, id) on delete cascade deferrable,
  constraint fk_compras_categoria foreign key (usuario_id, categoria_id) references categorias (usuario_id, id) deferrable,
  constraint fk_compras_pessoa foreign key (usuario_id, pessoa_id) references pessoas (usuario_id, id) on delete set null (pessoa_id) deferrable
);

create table if not exists parcelas (
  id text primary key,
  usuario_id uuid not null references usuarios(id) on delete cascade,
  compra_id text not null,
  numero int not null default 1,
  valor numeric not null,
  fatura_mes date not null,
  extras jsonb not null default '{}',
  seq bigint generated always as identity,
  constraint fk_parcelas_compra foreign key (usuario_id, compra_id) references compras_cartao (usuario_id, id) on delete cascade deferrable
);
create index if not exists parcelas_fatura on parcelas (usuario_id, fatura_mes);
create index if not exists parcelas_compra on parcelas (compra_id);

-- ---------- Módulo Resina: cadastros
create table if not exists resina_fazendas (
  id text primary key,
  usuario_id uuid not null references usuarios(id) on delete cascade,
  nome text not null,
  proprietario text,
  extras jsonb not null default '{}',
  seq bigint generated always as identity,
  unique (usuario_id, id)
);

create table if not exists resina_produtores (
  id text primary key,
  usuario_id uuid not null references usuarios(id) on delete cascade,
  nome text not null,
  cor text,
  arrendamento numeric default 0 check (arrendamento between 0 and 100),
  ativo boolean not null default true,
  extras jsonb not null default '{}',
  seq bigint generated always as identity,
  unique (usuario_id, id)
);

create table if not exists resina_motoristas (
  id text primary key,
  usuario_id uuid not null references usuarios(id) on delete cascade,
  nome text not null,
  telefone text,
  ativo boolean not null default true,
  extras jsonb not null default '{}',
  seq bigint generated always as identity,
  unique (usuario_id, id)
);

create table if not exists resina_caminhoes (
  id text primary key,
  usuario_id uuid not null references usuarios(id) on delete cascade,
  nome text not null,
  descricao text,
  capacidade int,
  ativo boolean not null default true,
  extras jsonb not null default '{}',
  seq bigint generated always as identity,
  unique (usuario_id, id)
);

create table if not exists resina_titulares (
  id text primary key,
  usuario_id uuid not null references usuarios(id) on delete cascade,
  nome text not null,
  documento text,
  ativo boolean not null default true,
  extras jsonb not null default '{}',
  seq bigint generated always as identity,
  unique (usuario_id, id)
);

create table if not exists resina_produtos (
  id text primary key,
  usuario_id uuid not null references usuarios(id) on delete cascade,
  nome text not null,
  unidade text default 'un',
  valor_unitario numeric default 0,
  ativo boolean not null default true,
  extras jsonb not null default '{}',
  seq bigint generated always as identity,
  unique (usuario_id, id)
);

create table if not exists resina_precos (
  id text primary key,
  usuario_id uuid not null references usuarios(id) on delete cascade,
  inicio date not null,
  valor_kg numeric not null,
  extras jsonb not null default '{}',
  seq bigint generated always as identity
);

-- ---------- Módulo Resina: movimento
create table if not exists resina_cargas (
  id text primary key,
  usuario_id uuid not null references usuarios(id) on delete cascade,
  numero int,
  data date not null,
  fazenda_id text,
  motorista_id text,
  caminhao_id text,
  titular_id text,
  preco_kg numeric,
  peso_fazenda numeric,
  peso_chegada numeric,
  peso_base text,
  obs text,
  nota text,
  destino text,
  criado_em timestamptz default now(),
  alterado_em timestamptz,
  extras jsonb not null default '{}',
  seq bigint generated always as identity,
  unique (usuario_id, id),
  constraint fk_cargas_fazenda foreign key (usuario_id, fazenda_id) references resina_fazendas (usuario_id, id) deferrable,
  constraint fk_cargas_motorista foreign key (usuario_id, motorista_id) references resina_motoristas (usuario_id, id) deferrable,
  constraint fk_cargas_caminhao foreign key (usuario_id, caminhao_id) references resina_caminhoes (usuario_id, id) deferrable,
  constraint fk_cargas_titular foreign key (usuario_id, titular_id) references resina_titulares (usuario_id, id) deferrable
);
create index if not exists resina_cargas_data on resina_cargas (usuario_id, data);

create table if not exists resina_carga_itens (
  id text primary key,
  usuario_id uuid not null references usuarios(id) on delete cascade,
  carga_id text not null,
  produtor_id text not null,
  tbs numeric,
  arrendamento numeric,
  kg_manual numeric,
  extras jsonb not null default '{}',
  seq bigint generated always as identity,
  constraint fk_carga_itens_carga foreign key (usuario_id, carga_id) references resina_cargas (usuario_id, id) on delete cascade deferrable,
  constraint fk_cargas_itens_produtor foreign key (usuario_id, produtor_id) references resina_produtores (usuario_id, id) deferrable
);
create index if not exists resina_carga_itens_carga on resina_carga_itens (carga_id);

create table if not exists resina_insumos (
  id text primary key,
  usuario_id uuid not null references usuarios(id) on delete cascade,
  data date not null,
  produtor_id text not null,
  produto_id text not null,
  titular_id text,
  quantidade numeric,
  valor_unitario numeric,
  valor_total numeric,
  pct_produtor numeric,
  entrega_id text,
  obs text,
  nota text,
  criado_em timestamptz default now(),
  alterado_em timestamptz,
  extras jsonb not null default '{}',
  seq bigint generated always as identity,
  -- produtor e conta usados: a mensagem fala de "cargas" (igual ao sistema original)
  constraint fk_cargas_insumo_produtor foreign key (usuario_id, produtor_id) references resina_produtores (usuario_id, id) deferrable,
  constraint fk_cargas_insumo_titular foreign key (usuario_id, titular_id) references resina_titulares (usuario_id, id) deferrable,
  constraint fk_insumos_produto foreign key (usuario_id, produto_id) references resina_produtos (usuario_id, id) deferrable
);
create index if not exists resina_insumos_data on resina_insumos (usuario_id, data);

create table if not exists resina_movimentos (
  id text primary key,
  usuario_id uuid not null references usuarios(id) on delete cascade,
  data date not null,
  titular_id text,
  produtor_id text,
  tipo text default 'credito' check (tipo in ('credito', 'debito')),
  valor numeric not null check (valor > 0),
  descricao text,
  nota text,
  criado_em timestamptz default now(),
  alterado_em timestamptz,
  extras jsonb not null default '{}',
  seq bigint generated always as identity,
  constraint fk_cargas_movimento_titular foreign key (usuario_id, titular_id) references resina_titulares (usuario_id, id) deferrable,
  constraint fk_cargas_movimento_produtor foreign key (usuario_id, produtor_id) references resina_produtores (usuario_id, id) deferrable
);
create index if not exists resina_movimentos_data on resina_movimentos (usuario_id, data);
