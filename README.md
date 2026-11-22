# Caixa + Resina · versão com servidor e PostgreSQL

Sistema de gestão financeira e de produção: caixa da família e da empresa (entradas, saídas, contas a pagar, cartões com parcelas, projeção de saldo) e um módulo **Resina** (cargas, produtores, insumos e conta corrente do arrendamento).

Este repositório é a **versão com back-end**. A versão original funciona 100% offline, com os dados cifrados no próprio aparelho (IndexedDB + Web Crypto). Aqui, as mesmas telas passam a guardar tudo num **PostgreSQL**, através de uma **API REST em Node.js (Express)**, com login no servidor e vários usuários.

> Projeto de portfólio, com dados fictícios. O sistema original está em uso numa empresa e não foi alterado: esta é uma cópia separada.

**Tecnologias:** Node.js, Express 5, PostgreSQL 17 (`pg`), JWT em cookie httpOnly, scrypt, JavaScript (ES Modules, sem framework), Tailwind CSS 4, Vite, PWA. Testes com `node:test` + PGlite e Playwright.

---

## Arquitetura

```
 Navegador (telas em JavaScript)                    Servidor Node.js                 PostgreSQL
 ┌───────────────────────────────┐   HTTPS + JSON   ┌───────────────────────────┐    ┌──────────────────┐
 │ telas  →  api.js              │                  │ Express (server/app.js)   │    │ 18 tabelas +     │
 │   local.from('lancamentos')   │  POST /api/...   │  • sessão (JWT no cookie) │ SQL│ usuarios         │
 │     .select().eq().order()    │ ───────────────► │  • montador de SQL        │───►│ FKs compostas    │
 │ local-db.js (cliente da API)  │ ◄─────────────── │    (server/consultas.js)  │    │ (usuario_id, id) │
 │   + cópia das tabelas na      │   { data } ou    │  • transações             │    │ índices, checks  │
 │     memória para somatórios   │   { erro }       │  • limite de tentativas   │    │                  │
 └───────────────────────────────┘                  └───────────────────────────┘    └──────────────────┘
```

**A troca foi feita numa camada só.** No original, todas as telas leem e gravam por `src/lib/api.js`, que usa `local.from('tabela').select().eq()...` (o mesmo formato do Supabase). Nesta versão, `src/lib/local-db.js` deixou de consultar o IndexedDB e passou a mandar a consulta para `POST /api/consulta`. O servidor valida a consulta, monta o SQL com parâmetros e executa no PostgreSQL. **As telas do caixa e da resina não foram reescritas**: só mudaram as de acesso (usuário e senha conferidos no servidor) e os textos que diziam "os dados ficam só neste aparelho".

### Decisões do banco (`server/esquema.sql`)

- **Multiusuário com isolamento no banco:** toda tabela tem `usuario_id`, e as chaves estrangeiras são **compostas** (`(usuario_id, conta_id) → contas(usuario_id, id)`). Mesmo com um erro no servidor, um lançamento não consegue apontar para a conta de outro usuário.
- **Regras de exclusão no banco:**
  - `RESTRICT`: não exclui categoria, conta ou produtor em uso.
  - `CASCADE`: excluir cartão leva compras e parcelas; excluir carga leva os itens.
  - `SET NULL (coluna)` (PostgreSQL 15+): excluir pessoa deixa o lançamento sem pessoa.
- **Nomes de restrição pensados para o usuário:** `fk_cargas_*` e `fk_insumos_*`. O erro 23503 chega na tela como "Esse item já foi usado em cargas…", e não como uma mensagem técnica.
- **Restaurar backup numa transação:** com `SET CONSTRAINTS ALL DEFERRED` as ligações são conferidas no fim, então a ordem das linhas no arquivo não importa. Se algo estiver errado, **nada muda**.
- **IDs gerados no navegador (UUID):** o **Desfazer** recoloca uma linha excluída com o mesmo id, e as ligações continuam certas.
- **Coluna `extras jsonb`:** guarda campos que ainda não viraram coluna, sem perder nada. O servidor também filtra por eles (`extras->>'campo'`).
- **`numeric` sem escala** nos valores: o sistema calcula preço unitário com mais de 2 casas, e o banco não arredonda em silêncio.
- Índices nas consultas mais usadas (vencimento, fatura do mês, data das cargas e dos insumos).

### Segurança

- **Senha e código de recuperação** viram hash (**scrypt** com sal), comparados em tempo constante. O banco nunca guarda a senha.
- **Sessão:** JWT (HS256) num cookie `httpOnly` + `SameSite=Strict` (+ `Secure` em produção). O JavaScript da página não lê o cookie, e outro site não consegue usá-lo.
- **Trocar a senha encerra as outras sessões** (`versao_sessao` no token), e o código de recuperação é trocado sempre que é usado.
- **Limite de tentativas:** 5 erros no mesmo usuário (ou 20 no mesmo IP) fazem esperar 30 s. Usuário inexistente leva o mesmo tempo para responder, então não dá para descobrir quem tem conta.
- **Nada de SQL montado com texto do usuário:**
  - os valores vão sempre como parâmetros (`$1, $2…`);
  - tabelas só da lista permitida, e colunas só com `[a-z0-9_]`;
  - todo comando leva `usuario_id = $1`.
- Pedidos que mudam dados precisam ser JSON, e as respostas da API não ficam em cache (nem no service worker).

---

## Rodar no seu computador

Precisa do [Node.js](https://nodejs.org) 22 ou mais novo.

```bash
npm install
cp .env.example .env        # no Windows: copy .env.example .env
```

**1. Banco de dados**: escolha um:

```bash
npm run db:local            # PostgreSQL de verdade rodando dentro do Node (PGlite), sem instalar nada
# ou
docker compose up -d        # PostgreSQL 17 no Docker (troque DATABASE_URL e PG_MAX no .env)
```

**2. Servidor e telas:**

```bash
npm run servidor            # API em http://localhost:3000 (cria as tabelas sozinho)
npm run dev                 # telas em http://localhost:5173 (as chamadas /api vão para o servidor)
```

Para usar como em produção (um endereço só): `npm run build && npm start` e abra http://localhost:3000.

No primeiro acesso, crie um usuário e marque *Começar com dados de exemplo* para conhecer o sistema.

### Publicar de graça (Render + Neon)

O repositório já vem com o `render.yaml`. O servidor roda no **Render** e o PostgreSQL fica no **Neon**, os dois no plano gratuito.

1. **Neon** ([neon.tech](https://neon.tech)):
   - crie um projeto (PostgreSQL 17, região *US East*);
   - em *Connect*, copie a **connection string pooled**: `postgresql://...-pooler...neon.tech/neondb?sslmode=require`.
2. **Render** ([render.com](https://render.com)):
   - vá em *New > Blueprint* e escolha este repositório;
   - quando pedir o `DATABASE_URL`, cole o endereço do Neon;
   - o `JWT_SECRET` é gerado sozinho.
3. Pronto. Ao subir, o servidor cria as tabelas sozinho, e o Render confere `/api/saude` antes de liberar o endereço.

No plano gratuito, o Render **adormece o servidor depois de ~15 min sem acesso**: a primeira visita depois disso leva uns 30–60 s, e as seguintes são normais. O Neon também "dorme" sem uso e acorda na primeira consulta.

Qualquer outra hospedagem de Node.js com PostgreSQL também serve (Railway, Fly.io, um VPS com o `docker-compose.yml`). Basta configurar:

- `DATABASE_URL` (e `PG_SSL=true` se o banco exigir SSL e o endereço não tiver `sslmode`);
- `JWT_SECRET` (32+ caracteres aleatórios);
- `NODE_ENV=production`.

Depois, rode `npm run build && npm start`.

### API

| Método | Rota | O que faz |
|---|---|---|
| POST | `/api/conta` | cria o usuário (com os dados iniciais) e abre a sessão |
| POST | `/api/entrar` · `/api/sair` | entra com usuário e senha / encerra a sessão |
| POST | `/api/recuperar` | esqueci a senha: entra com o código e cria senha nova |
| GET | `/api/sessao` | quem está logado (`usuario: null` se ninguém entrou) |
| GET | `/api/saude` | servidor e banco no ar (usado pelo Render) |
| PATCH | `/api/conta` | troca nome e/ou senha |
| POST | `/api/conta/conferir` · `/api/conta/codigo` · `/api/conta/backup` | confere a senha / novo código / marca o backup |
| DELETE | `/api/conta` | apaga o usuário e todos os dados (cascade) |
| GET · PUT | `/api/dados` | todas as tabelas / restaurar backup (transação) |
| POST | `/api/consulta` | `{ tabela, op, filtros, ordem, unico, linhas, valores }` → SQL |

Exemplo de consulta: `{ "tabela": "lancamentos", "op": "select", "filtros": [["gte", "vencimento", "2026-11-01"], ["eq", "pago", false]], "ordem": { "c": "vencimento" } }` vira

```sql
select * from lancamentos where usuario_id = $1 and "vencimento" >= $2 and "pago" = $3 order by "vencimento" asc nulls first, seq
```

---

## O que o sistema faz

- **Caixa:** entradas e saídas, contas a pagar, repetições (todo mês, sempre, todo ano), desconto e juros, transferência entre contas, extrato por conta e projeção de saldo.
- **Cartões:** cada parcela cai na fatura certa pelo dia de fechamento; estorno, assinatura e pagamento de fatura com adiantamento.
- **Relatórios:** por categoria, por área (Casa, Fazenda, Empresa) e por pessoa; exportação em **Excel** e **PDF** feita no próprio navegador.
- **Importar planilhas** do Excel (.xlsx) com conferência linha a linha.
- **Senha e código de recuperação**, temas de cores, modo escuro, letras maiores e *Desfazer* em quase tudo.

## Casa, Fazenda e tipos de categoria

- Cada categoria tem um **tipo** (saída, entrada ou os dois). O formulário de lançamento só mostra as categorias do tipo escolhido. Dados de versões anteriores recebem o tipo automaticamente (pelo nome e pelo uso).
- As categorias dos grupos **Fazenda** e **Empresa** (`GRUPOS_SEPARADOS` em `src/lib/store.js`) ficam fora do *Resumo da casa* e ganham um quadro próprio no Início com vendas, despesas e lucro.

## Importar a planilha do Excel

*Ajustes > Backup, importar e exportar > Importar planilha do Excel*. Lê o `.xlsx` no modelo do `NOVO_CAIXA.xlsx` (uma aba por mês; caixa nas colunas A–J e um bloco por cartão), no próprio aparelho (`src/lib/ler-xlsx.js` + `DecompressionStream`). As colunas são achadas pelo título. Mostra uma prévia (mês/ano de cada aba, cadastros novos, avisos), pula o que já existe e pode ser desfeita. Regras em `src/lib/importar-planilha.js`.

A importação reconhece sozinha cada aba e manda para o lugar certo (`importarQualquerPlanilha` em `src/components/importar.js`). O mesmo botão aparece em Ajustes, na Produção e na Conta corrente.
- **Caixa** (modelo NOVO_CAIXA): a REFERENCIA vira a observação, e a PARCELA vai para o campo da parcela. "FATURA <cartão>" vira pagamento de fatura, mesmo quando o cartão só aparece no bloco da própria planilha. Valor com sinal contrário no bloco do cartão vira reembolso.
- **Produção da resina** (CONTROLE ANUAL FAZENDA, abas SAFRAS): os blocos `DATA | TBS | PESO - KG` de cada produtor e safra (agosto a julho) viram cargas, uma por dia, com o kg de cada produtor. Regras em `src/modulos/resina/importar-safras.js`. Linhas repetidas entre as abas entram uma vez só. Nos blocos de duas pessoas ("PEDRO E PAULO"), a linha com o nome ao lado vai para quem está escrito, e a linha sem nome é dividida meio a meio. A aba de resumo (Tbs por mês × ano) não é importada. Aceita meio tambor (28,5).
- **Conta corrente**: quando a carga já veio das SAFRAS (mesmo dia, produtor e Tbs), a conta corrente completa essa carga (conta, preço, nota e %) em vez de criar outra.
- Quando o arquivo tem mais de um tipo de aba (o backup em Excel), a importação pergunta o que trazer e abre as conferências na ordem Caixa → Produção → Conta corrente.

## Temas de cores

*Ajustes > Aparência*: temas prontos (Verde Cofre, Azul Navy Contábil, Neutros com toque de cobre) ou 5 cores próprias (principal, gráficos, fundo, quadros, texto). `src/lib/temas.js` gera os tons da cor principal e os cinzas a partir dessas cores (OKLCH) e ajusta o que for preciso para manter contraste WCAG AA. As cores entram como variáveis CSS (`--color-brand-*`, `--color-stone-*`, `--color-fundo`, `--color-cartao`, `--color-texto`, `--color-destaque`).

## Proteções contra erro

- **Clique duplo** em Salvar não grava duas vezes (`semRepetir` em `lib/ui.js`).
- **Mais de uma aba/janela aberta** (ou o app instalado + o navegador): quem grava avisa as outras (`BroadcastChannel`), que recarregam os dados antes de continuar; nada se perde.
- **Backup editado ou danificado**: cada linha é conferida ao restaurar (`conferirTabelas` em `lib/api.js`); o que dá é corrigido, o resto fica de fora, e a pessoa é avisada antes de confirmar.
- **Nomes repetidos** em contas, cartões, categorias e pessoas são recusados (sem diferenciar maiúscula ou acento).
- **Aparelho sem espaço**: se não der para gravar, aparece um aviso pedindo backup.
- **Arquivos de fora**: PDF, CSV, Word, planilha com senha, .xls antigo, arquivo cortado ou vazio são recusados com uma mensagem que diz o que fazer.

## Módulo Resina (produção e cargas)

Módulo opcional, ligado em Ajustes > Módulos. Fica em `src/modulos/resina/` e não mexe no Caixa: usa tabelas próprias (`resina_*`) no mesmo arquivo cifrado e no mesmo backup.

- **Cadastros**: produtores (cor e % de arrendamento), motoristas, caminhões (placa e quantos Tbs cabem), preço do kg por data e fazenda.
- **Carga**: número automático (C-2026-0001), pesagem na fazenda e/ou na chegada (com a diferença em kg, % e R$), Tbs e % de arrendamento por produtor, kg calculado pelos Tbs ou digitado, e a carreta animada.
- **Produção**: totais do mês e quanto cada produtor produziu.
- **Insumos**: em *Cadastros > Produtos (insumos)* ficam os produtos usados na coleta, com unidade e valor unitário. Na tela **Insumos**, cada entrega a um produtor tem data, conta (CNPJ/CPF), nota e vários produtos (quantidade, valor unitário e valor total; quem só sabe o total digita o total e o unitário é calculado).
- **Insumos × produção** (na tela Produção, por mês ou pelo ano inteiro): compara o gasto com insumos e a resina entregue por cada produtor. O número principal é o **insumo por kg de resina**, comparado com a média de todos. Gera alerta quem fica 25% ou mais acima da média (pode ser desperdício ou resina que não chegou nas cargas) e quem recebeu insumo sem entregar resina. Os insumos são descontados do produtor, então a tabela mostra a parte do produtor menos os insumos, e o consumo de cada produto por tonelada.
- **Conta corrente do arrendamento**: segue a planilha *Conta corrente arrendo* da empresa. Há uma conta para cada cadastro em *Cadastros > Contas* (o CNPJ da empresa e o CPF da proprietária), e cada carga escolhe a sua, junto com a **nota** e o **destino**.
  - Cada produtor de cada carga vira uma linha. O **débito** é o arrendamento, ou seja, o que a proprietária tem para receber. **UNI.** é o valor de um tambor (média de kg por tambor × preço do kg), então débito = tambores × UNI. × % arrendo.
  - Os **insumos** também entram como débito, porque são descontados do produtor.
  - **Crédito** é o que já foi recebido, lançado na própria tela (*Lançar recebimento*). Dá para filtrar por produtor.
  - O **saldo** vem desde a primeira carga. Negativo quer dizer que ainda falta receber.
  - **Exportar Excel** gera o mês com as mesmas 13 colunas da planilha da empresa: débito negativo e saldo em fórmula (`saldo anterior + crédito + débito`).
  - **Ligado ao Caixa:** o recebimento (crédito) pode entrar também como **entrada** numa conta do Caixa, e a compra de insumos como **saída** de uma conta ou **compra no cartão**. O que vai para o Caixa guarda de onde veio (`resina_movimento_id` / `resina_entrega_id`): mudar ou excluir na Resina refaz ou exclui no Caixa (`src/modulos/resina/ligacao-caixa.js`). O Início do Caixa mostra o **arrendamento a receber** de cada conta (CNPJ/CPF).
  - **Importar planilha** lê a planilha da empresa (as colunas são achadas pelo título). Quando as colunas de número estão vazias, lê o texto da descrição: `CARGA 57 TBS = 11.480 KG X R$ 4,60 X 55%` vira carga, `125 KG PASTA` vira insumo e o resto (PIX etc.) vira lançamento. Antes de gravar, mostra cada linha como foi entendida: dá para escolher o produtor, crédito ou débito, digitar o valor que falta, juntar produtos ao cadastro ou desmarcar a linha. Linhas seguidas da mesma carga viram uma carga com vários produtores. O que já está no sistema não é importado de novo, e dá para desfazer a importação inteira.
- Quem já usava o sistema recebe as tabelas novas vazias; nenhum cadastro do Caixa é criado de novo ou apagado. Backups antigos (sem a resina) continuam restaurando normalmente.

## Backup

Os dados ficam no PostgreSQL. O backup em arquivo é uma cópia extra, sua, para guardar fora do sistema e restaurar quando precisar (a restauração é uma transação só no servidor).

- **Fazer backup:** *Ajustes > Backup e exportar > Backup, Excel ou PDF > Backup completo*. No celular, abre o *Compartilhar* (Drive, e-mail ou WhatsApp); no computador, baixa um arquivo `.json`.
- **Exportar:** na mesma janela dá para gerar o **backup em Excel (.xlsx)** ou um **relatório em PDF**, do mês aberto, do ano ou de tudo. O backup em Excel é **um arquivo só**, com as abas no formato das planilhas da família e da empresa, e pode ser importado de volta:
  - o Caixa, com uma aba por mês como no NOVO_CAIXA (`src/lib/planilha-caixa.js`), com saldo anterior, resumo por conta e categoria em fórmulas e um bloco por cartão;
  - CONTROLE ANUAL e SAFRAS, como no CONTROLE ANUAL FAZENDA;
  - uma CONTA CORRENTE por conta, como na Conta corrente arrendo (`src/modulos/resina/planilhas-resina.js`).

  Dá para escolher só algumas partes. O que esses formatos não têm (recorrência, desconto/juros, competência, pessoa da compra no cartão, cadastros como motoristas e caminhões) só volta pelo `.json`, que continua sendo o backup completo.
- **Restaurar:** em *Ajustes > Restaurar um backup* ou, ao criar um acesso novo, em *Tenho um arquivo de backup* na primeira tela. A restauração tem *Desfazer*.
- O Início mostra um lembrete quando você ainda não fez backup ou quando o último tem mais de 30 dias.
- O arquivo de backup **não tem senha**: guarde-o num lugar só seu.

## Testes

```bash
npm test
```

- **Regras de negócio** (`tests/regras.test.js`, 245 checagens): fatura de cada compra, parcelas, datas, somas, repetições, cargas e conta corrente.
- **API + PostgreSQL** (`tests/servidor.test.js`, 14 testes): sobe um PostgreSQL de verdade em memória (PGlite) e testa por HTTP:
  - cadastro, login, limite de tentativas, recuperação com código e fim das sessões antigas;
  - filtros `eq/in/gte/lt/order`;
  - `RESTRICT`, `CASCADE` e `SET NULL`;
  - isolamento entre usuários;
  - tentativas de SQL injection;
  - restaurar backup (e backup quebrado que não apaga nada).
- **Navegador** (`testes-navegador/`, Python + Playwright): roteiros que usam o sistema inteiro como uma pessoa usaria (veja o `LEIA-ME.md` de lá).

---

## Como o código está organizado

```
server/
  index.js                 sobe o servidor (cria as tabelas que faltarem)
  app.js                   rotas da API, sessão, limite de tentativas, erros
  consultas.js             montador de SQL: from().select().eq()... → SQL com parâmetros
  db.js                    conexão (pg), conversão de tipos, transações
  seguranca.js             scrypt, JWT, cookie, limite de tentativas
  esquema.sql              tabelas, chaves estrangeiras, índices e checks
scripts/pg-local.mjs       PostgreSQL local sem instalar nada (PGlite)
docker-compose.yml         PostgreSQL 17 no Docker
src/
  main.js                  início: sessão aberta, tela de senha ou primeiro acesso
  lib/
    local-db.js            cliente da API: mesma interface de antes, agora no servidor
    api.js                 TODAS as leituras e gravações das telas passam por aqui
    consulta-local.js      lista de tabelas e padrões (usados também pelo servidor)
    codigo-recuperacao.js  gerar e conferir o código (navegador e servidor)
    faturas.js, calculos.js, recorrencia.js   regras de negócio
  pages/ components/       telas e peças das telas
  modulos/resina/          módulo Resina
tests/                     testes (npm test)
```

### Tabelas

| Tabela | O que guarda |
|---|---|
| `usuarios` | nome, hash da senha e do código de recuperação, versão da sessão, último backup |
| `contas`, `cartoes`, `categorias`, `pessoas` | cadastros do caixa |
| `lancamentos` | entradas, saídas, contas a pagar, pagamentos de fatura, transferências |
| `compras_cartao` + `parcelas` | compras no crédito e cada parcela na fatura certa (estorno = parcela negativa) |
| `resina_fazendas`, `resina_produtores`, `resina_motoristas`, `resina_caminhoes`, `resina_titulares`, `resina_produtos`, `resina_precos` | cadastros da Resina |
| `resina_cargas` + `resina_carga_itens` | cargas e quanto cada produtor entregou |
| `resina_insumos`, `resina_movimentos` | insumos entregues aos produtores e lançamentos da conta corrente |

## Acessibilidade

- Todos os campos têm rótulo, dica e mensagem de erro lidas por leitores de tela.
- Dá para usar tudo pelo teclado. As janelas fecham com `Esc` e há o link "Pular para o conteúdo".
- Os botões têm pelo menos 44px de altura, bons para tocar no celular.
- O status nunca é indicado só pela cor: sempre vem com texto ("Pago", "Atrasado").
- Opções de **letras maiores** e **modo escuro** em Ajustes, e o sistema respeita a configuração de "reduzir movimento" do aparelho.
- O botão **?** explica cada tela, há uma apresentação no primeiro acesso e o botão **Desfazer** nas ações.
