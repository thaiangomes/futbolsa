/**
 * O botão "Entrar com o Google" só aparece com `NEXT_PUBLIC_GOOGLE_LOGIN=true`. Fica escondido
 * até o Google estar configurado no Supabase (decisão do Thaian em 2026-11-07); ligar é só
 * mudar a variável e publicar o site de novo. Lida a cada chamada, para os testes poderem trocar.
 */
export function googleLoginEnabled(): boolean {
  return process.env.NEXT_PUBLIC_GOOGLE_LOGIN === "true";
}
