/**
 * O adaptador de login do site (Arquitetura da Fase 1, Segurança): as telas só falam com esta
 * interface. A implementação do Supabase é o único lugar do site que conhece o Supabase; trocar
 * pelo login da empresa é escrever outra. O site nunca lê tabela: só entra, sai e pega o token.
 */
export interface AuthClient {
  signInWithGoogle(redirectTo: string): Promise<void>;
  /** Erro de e-mail ou de senha vem sempre como `invalid_credentials` (Conta e login, critério 6). */
  signInWithPassword(email: string, password: string): Promise<void>;
  /** Mesma resposta para e-mail novo ou já usado, para não revelar quem tem conta. */
  signUp(email: string, password: string, redirectTo: string): Promise<void>;
  /** Mesma resposta para qualquer e-mail (critérios 6 e 7). */
  requestPasswordReset(email: string, redirectTo: string): Promise<void>;
  /** Grava a senha nova (esqueci a senha, ou trocar e criar logado: critérios 7, 26 e 27). */
  updatePassword(password: string): Promise<void>;
  /** Sai deste aparelho, ou de todos (`everywhere`). */
  signOut(options?: { everywhere?: boolean }): Promise<void>;
  /** Sai dos outros aparelhos, depois de trocar a senha (critério 26). */
  signOutOthers(): Promise<void>;
  /** O token de acesso, ou `null` sem sessão. `forceRefresh` pede um novo (mesmo formato do WebSocket). */
  getAccessToken(options?: { forceRefresh?: boolean }): Promise<string | null>;
  /** Hora do último login (para pedir o login de novo antes de excluir ou trocar a senha). */
  authenticatedAt(): Promise<Date | null>;
  /** Se a conta já tem senha (falso para quem só entra pelo Google: a tela mostra "criar senha"). */
  hasPassword(): Promise<boolean>;
  /** Avisa quando a pessoa entra, sai ou o token é renovado. Devolve como parar de ouvir. */
  onChange(listener: () => void): () => void;
}

export type AuthErrorCode =
  | "invalid_credentials"
  | "email_not_confirmed"
  | "weak_password"
  | "same_password"
  | "rate_limited"
  | "unavailable";

/** Mensagens das falhas do login, em português. Nenhuma diz se um e-mail tem conta. */
export const AUTH_ERROR_MESSAGES: Record<AuthErrorCode, string> = {
  invalid_credentials: "E-mail ou senha incorretos. Confira e tente de novo.",
  email_not_confirmed: "Confirme o seu e-mail pelo link que enviamos antes de entrar.",
  weak_password: "A senha precisa ter pelo menos 8 caracteres.",
  same_password: "A senha nova precisa ser diferente da atual.",
  rate_limited: "Muitas tentativas seguidas. Espere um pouco e tente de novo.",
  unavailable: "O login está fora do ar agora. Tente de novo em instantes.",
};

export class AuthError extends Error {
  constructor(readonly code: AuthErrorCode) {
    super(AUTH_ERROR_MESSAGES[code]);
    this.name = "AuthError";
  }
}

/** Senha de no mínimo 8 caracteres (critério 4); a mesma regra fica configurada no Supabase. */
export const MIN_PASSWORD_LENGTH = 8;

export function isPasswordLongEnough(password: string): boolean {
  return password.length >= MIN_PASSWORD_LENGTH;
}

/** Login feito há no máximo 15 minutos para excluir a conta ou trocar a senha (o mesmo da API). */
export const REAUTH_WINDOW_MS = 15 * 60_000;

export function needsReauth(authenticatedAt: Date | null, now: Date): boolean {
  return !authenticatedAt || now.getTime() - authenticatedAt.getTime() > REAUTH_WINDOW_MS;
}

/** O último login pelo `amr` do token (métodos com horário), sem conferir a assinatura: só para a tela. */
export function authenticatedAtFromToken(token: string): Date | null {
  try {
    const payload = JSON.parse(base64UrlDecode(token.split(".")[1] ?? "")) as { amr?: Array<{ timestamp?: unknown }>; iat?: number };
    const times = (payload.amr ?? []).map((m) => m?.timestamp).filter((t): t is number => typeof t === "number");
    const seconds = times.length ? Math.max(...times) : payload.iat;
    return typeof seconds === "number" ? new Date(seconds * 1000) : null;
  } catch {
    return null;
  }
}

function base64UrlDecode(s: string): string {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  return decodeURIComponent(
    Array.from(atob(b64), (c) => `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`).join(""),
  );
}
