import { isReservedNickname, nicknameSchema } from "@futbolsa/contracts";
import { isPasswordLongEnough, MIN_PASSWORD_LENGTH } from "../../lib/auth";

export interface Feedback {
  ok: boolean;
  /** O texto debaixo do campo: o erro, ou a dica quando está tudo certo. */
  message: string;
}

/**
 * O apelido validado na hora, antes de chamar a API (Conta e login, critérios 9 e 25). Se ele
 * está em uso só a API sabe: a resposta `nickname_taken` vem depois de enviar.
 */
export function nicknameFeedback(value: string): Feedback {
  if (value.length < 3) return { ok: false, message: "Use pelo menos 3 caracteres." };
  if (value.length > 20) return { ok: false, message: "Use no máximo 20 caracteres." };
  if (!nicknameSchema.safeParse(value).success) {
    return { ok: false, message: "Só letras sem acento, números e _. Nada de espaço, acento ou ç." };
  }
  if (isReservedNickname(value)) return { ok: false, message: "Este apelido é reservado. Escolha outro." };
  return { ok: true, message: "Pode usar. Se outra pessoa já tiver, avisamos ao criar a conta." };
}

/** Senha nova: no mínimo 8 caracteres (critério 4) e, quando há o campo de repetir, igual. */
export function passwordFeedback(password: string, repeat?: string): { password: Feedback; repeat: Feedback; ok: boolean } {
  const short = password.length > 0 && !isPasswordLongEnough(password);
  const differs = repeat !== undefined && repeat.length > 0 && repeat !== password;
  return {
    password: short
      ? { ok: false, message: `Use pelo menos ${MIN_PASSWORD_LENGTH} caracteres.` }
      : { ok: isPasswordLongEnough(password), message: `No mínimo ${MIN_PASSWORD_LENGTH} caracteres.` },
    repeat: differs ? { ok: false, message: "As duas senhas estão diferentes." } : { ok: true, message: "" },
    ok: isPasswordLongEnough(password) && (repeat === undefined || repeat === password),
  };
}

/** Data e hora de Brasília, como nas telas ("dom. 28/03, 16h00"). */
export function formatBrasilia(iso: string): string {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("weekday").replace(".", "")}. ${get("day")}/${get("month")}, ${get("hour")}h${get("minute")}`;
}

/** Data de Brasília, só o dia ("20/03/2027"). */
export function formatDate(iso: string): string {
  return new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(iso));
}
