/**
 * Versão dos termos de uso e da política de privacidade (W7), aprovada pelo Thaian em
 * 2026-11-08 (vault, Produto/Termos e privacidade). A API guarda só `termsAcceptedAt`: quem
 * aceitou depois desta data aceitou esta versão. Mudou o texto, muda a data aqui; uma mudança
 * importante pede o novo aceite, que é proposto antes (coluna `terms_version`).
 */
export const LEGAL_VERSION = { date: "2026-11-08", label: "8 de novembro de 2026" } as const;

/** Canal para os pedidos da LGPD e para quem não consegue entrar (resposta do Thaian em 2026-11-08). */
export const LEGAL_CONTACT = "noreply.futbolsa@gmail.com";
