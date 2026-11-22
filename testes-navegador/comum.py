import random

SENHA = '1234abcd'

async def preparar(pg, U, exemplo=True, nome='Thiago', senha=SENHA):
    """Primeiro acesso (cria usuário), tela de senha (entra) ou sessão já aberta (entra direto).
    Versão PostgreSQL: os usuários ficam no servidor, então cada teste cria um nome único
    (ex.: "Thiago 4821") para não esbarrar no usuário criado por outro teste."""
    await pg.goto(U)
    await pg.wait_for_selector('#confirmar, #senha, #titulo-pagina', timeout=15000)
    if await pg.locator('#titulo-pagina').count():
        await pg.wait_for_timeout(500)
        return  # a sessão continuava aberta
    if await pg.locator('#confirmar').count():
        await pg.fill('#usuario', f'{nome} {random.randint(1000, 9999)}'); await pg.fill('#senha', senha); await pg.fill('#confirmar', senha)
        if exemplo: await pg.check('[name=exemplo]')
    else:
        await pg.fill('#senha', senha)
    await pg.click('button[type=submit]')
    await guardar_codigo(pg)
    await pg.wait_for_selector('#titulo-pagina', timeout=15000)
    await pg.wait_for_timeout(700)

async def guardar_codigo(pg, timeout=6000):
    """Se aparecer a janela do código de recuperação, marca 'já guardei' e continua. Retorna o código."""
    try:
        await pg.wait_for_selector('dialog[open] [data-guardei]', timeout=timeout)
    except Exception:
        return None
    codigo = (await pg.inner_text('dialog[open] output')).strip()
    await pg.check('dialog[open] [data-guardei]'); await pg.click('dialog[open] [data-continuar]')
    await pg.wait_for_timeout(300)
    return codigo

async def pular_tour(pg):
    if await pg.locator('dialog[open] >> text=Pular').count():
        await pg.click('dialog[open] >> text=Pular'); await pg.wait_for_timeout(300)

async def recarregar(pg, senha=SENHA):
    """Recarrega a página. Com a sessão aberta entra direto; se pedir a senha, digita."""
    await pg.reload()
    await pg.wait_for_selector('#senha, #titulo-pagina', timeout=15000)
    if await pg.locator('#senha').count():
        await pg.fill('#senha', senha); await pg.click('button[type=submit]')
    await pg.wait_for_selector('#titulo-pagina', timeout=10000)
    await pg.wait_for_timeout(600)
