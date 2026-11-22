// =====================================================================
// Senhas, sessão e limite de tentativas.
//  * Senha e código de recuperação: só o hash fica no banco (scrypt + sal).
//  * Sessão: JWT assinado num cookie httpOnly (o JavaScript da página não lê),
//    SameSite=Strict (outro site não consegue usar a sessão).
//  * "versao_sessao": ao trocar a senha, as sessões antigas deixam de valer.
// =====================================================================
import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import jwt from 'jsonwebtoken';

const scryptAsync = promisify(scrypt);
const CUSTO = { N: 16384, r: 8, p: 1 };
export const COOKIE = 'caixa_sessao';
const DURACAO_H = 12;

export async function gerarHash(segredo) {
  const sal = randomBytes(16);
  const hash = await scryptAsync(String(segredo), sal, 32, CUSTO);
  return `scrypt$${sal.toString('base64')}$${hash.toString('base64')}`;
}

export async function conferirHash(segredo, guardado) {
  const [alg, sal64, hash64] = String(guardado || '').split('$');
  if (alg !== 'scrypt' || !sal64 || !hash64) return false;
  const esperado = Buffer.from(hash64, 'base64');
  const obtido = await scryptAsync(String(segredo), Buffer.from(sal64, 'base64'), esperado.length, CUSTO);
  return timingSafeEqual(obtido, esperado);
}

// hash de uma senha qualquer: quem não existe leva o mesmo tempo para responder
// (assim não dá para descobrir quais usuários existem pelo tempo da resposta)
const HASH_FALSO = gerarHash(randomBytes(12).toString('hex'));
export const gastarTempo = async (segredo) => conferirHash(segredo, await HASH_FALSO);

export function criarSessao(segredoJwt) {
  if (!segredoJwt || segredoJwt.length < 32) throw new Error('Defina JWT_SECRET com pelo menos 32 caracteres (veja .env.example).');
  const producao = process.env.NODE_ENV === 'production';
  const opcoesCookie = { httpOnly: true, sameSite: 'strict', secure: producao, path: '/', maxAge: DURACAO_H * 3600_000 };
  return {
    abrir(res, usuario) {
      const token = jwt.sign({ sub: usuario.id, v: usuario.versao_sessao }, segredoJwt, { expiresIn: `${DURACAO_H}h`, algorithm: 'HS256' });
      res.cookie(COOKIE, token, opcoesCookie);
    },
    fechar(res) {
      res.clearCookie(COOKIE, { ...opcoesCookie, maxAge: undefined });
    },
    /** { id, versao } da sessão, ou null se não tiver / tiver vencido / for falsa */
    ler(req) {
      const token = req.cookies?.[COOKIE];
      if (!token) return null;
      try {
        const p = jwt.verify(token, segredoJwt, { algorithms: ['HS256'] });
        return { id: p.sub, versao: p.v };
      } catch {
        return null;
      }
    },
  };
}

/**
 * Limite de tentativas (senha ou código errado): depois de `maximo` erros seguidos
 * para a mesma chave (usuário ou IP), espera 30 segundos a cada nova tentativa.
 */
export function criarLimite({ maximo = 5, esperaMs = 30_000 } = {}) {
  const erros = new Map(); // chave -> { n, ate }
  const limpar = setInterval(() => {
    const agora = Date.now();
    for (const [k, v] of erros) if (v.ate < agora - 15 * 60_000) erros.delete(k);
  }, 60_000);
  limpar.unref?.();
  return {
    /** segundos que ainda faltam esperar (0 = pode tentar) */
    espera(chaves) {
      const agora = Date.now();
      return Math.max(0, ...chaves.map((k) => Math.ceil(((erros.get(k)?.ate || 0) - agora) / 1000)));
    },
    errou(chaves) {
      for (const k of chaves) {
        const e = erros.get(k) || { n: 0, ate: 0 };
        e.n++;
        e.ate = e.n >= maximo ? Date.now() + esperaMs : Date.now();
        erros.set(k, e);
      }
    },
    acertou(chaves) { for (const k of chaves) erros.delete(k); },
  };
}
