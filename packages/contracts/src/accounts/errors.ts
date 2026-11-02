/**
 * Códigos de erro do login e das contas (F5), com a mensagem que o jogador vê. O código diz
 * o que a tela faz; a mensagem nunca revela se um e-mail tem conta, a não ser ao próprio dono
 * (Conta e login, critério 6).
 */
export const ACCOUNT_ERROR_MESSAGES = {
  invalid_token: "Sua sessão não é válida. Entre de novo.",
  email_not_confirmed: "Confirme o seu e-mail pelo link que enviamos antes de jogar.",
  registration_required: "Falta terminar o cadastro: escolha o apelido e aceite os termos.",
  account_deleted: "Esta conta foi excluída.",
  invite_required: "O FutBolsa é só com convite. Peça ao admin para liberar o seu e-mail.",
  already_registered: "Esta conta já foi criada.",
  nickname_taken: "Este apelido já está em uso.",
  nickname_reserved: "Este apelido é reservado. Escolha outro.",
  terms_required: "Para criar a conta, aceite os termos de uso e a política de privacidade.",
  admin_required: "Só o admin pode fazer isso.",
  last_admin: "O jogo não pode ficar sem nenhum admin.",
  reauth_required: "Por segurança, entre de novo antes de continuar.",
  invite_used: "Este e-mail já criou a conta; o convite não pode mais ser retirado.",
} as const;

export type AccountErrorCode = keyof typeof ACCOUNT_ERROR_MESSAGES;

