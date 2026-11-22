// =====================================================================
// Código de recuperação: 16 caracteres sem os que confundem (0/O, 1/I/L).
// Usado no navegador (conferir o que foi digitado) e no servidor (gerar o código).
// O servidor guarda só o hash do código, igual à senha.
// =====================================================================
const ALFABETO = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 31 símbolos -> ~79 bits, impossível de adivinhar

export function gerarCodigoRecuperacao() {
  const limite = 256 - (256 % ALFABETO.length); // evita viés
  let codigo = '';
  while (codigo.length < 16) {
    for (const b of crypto.getRandomValues(new Uint8Array(32))) {
      if (b < limite && codigo.length < 16) codigo += ALFABETO[b % ALFABETO.length];
    }
  }
  return codigo.match(/.{4}/g).join('-'); // K7QM-2XPA-9TRW-HF4D
}

/** Aceita o código digitado de qualquer jeito: minúsculas, espaços, com ou sem traços */
export const normalizarCodigo = (digitado) => String(digitado || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
export const codigoValido = (digitado) => {
  const c = normalizarCodigo(digitado);
  return c.length === 16 && [...c].every((ch) => ALFABETO.includes(ch));
};
