/**
 * Códigos de erro do IPO (F8), com a mensagem que o jogador ou o admin vê. O código diz o que a
 * tela faz; as mensagens não revelam nada sobre as ofertas dos outros jogadores (IPO por
 * bookbuilding, critério 15).
 */
export const IPO_ERROR_MESSAGES = {
  ipo_not_open: "As ofertas do IPO ainda não abriram.",
  ipo_closed: "O período de ofertas do IPO já fechou.",
  club_not_listed: "Este clube não está listado na temporada.",
  bid_exists: "Você já tem uma oferta neste clube: edite a que existe.",
  bid_not_found: "Você não tem oferta neste clube.",
  invalid_quantity: "A quantidade tem de ser um número inteiro de ações, de 1 em diante.",
  invalid_price: "O preço máximo tem de ser um valor em reais com no máximo dois decimais, maior que zero.",
  below_band_floor: "O preço máximo está abaixo do piso da faixa deste clube.",
  insufficient_cash: "Seu caixa livre não cobre a reserva desta oferta.",
  account_blocked: "Sua conta está bloqueada e não pode fazer ofertas.",
  negative_cash: "Seu caixa está negativo: regularize antes de fazer ofertas.",
  no_wallet: "Você não tem carteira nesta temporada: o IPO já fechou para a sua conta.",
  ipo_close_earlier: "O fechamento do IPO só pode ser adiado, nunca antecipado.",
  ipo_not_ready: "O IPO ainda não pode abrir.",
} as const;

export type IpoErrorCode = keyof typeof IPO_ERROR_MESSAGES;
