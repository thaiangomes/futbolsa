import { createClient, type AuthError as SupabaseAuthError, type SupabaseClient } from "@supabase/supabase-js";
import { type AuthClient, AuthError, type AuthErrorCode, authenticatedAtFromToken } from "./auth-client";

/** Traduz o erro do Supabase num código do jogo. Senha errada e e-mail sem conta dão o mesmo. */
export function toAuthError(error: Pick<SupabaseAuthError, "code" | "status"> | null): AuthError | null {
  if (!error) return null;
  const byCode: Record<string, AuthErrorCode> = {
    invalid_credentials: "invalid_credentials",
    user_not_found: "invalid_credentials",
    email_not_confirmed: "email_not_confirmed",
    weak_password: "weak_password",
    same_password: "same_password",
    over_request_rate_limit: "rate_limited",
    over_email_send_rate_limit: "rate_limited",
  };
  const code = (error.code && byCode[error.code]) || (error.status === 429 ? "rate_limited" : error.status === 400 ? "invalid_credentials" : "unavailable");
  return new AuthError(code);
}

function check(result: { error: Pick<SupabaseAuthError, "code" | "status"> | null }): void {
  const error = toAuthError(result.error);
  if (error) throw error;
}

/**
 * O login pelo Supabase (Google, e-mail e senha), no fluxo PKCE, que funciona no site estático:
 * o link do e-mail e a volta do Google caem numa página do site, que troca o código pela sessão.
 */
export class SupabaseAuthClient implements AuthClient {
  private readonly supabase: SupabaseClient;

  constructor(url: string, publishableKey: string) {
    this.supabase = createClient(url, publishableKey, {
      auth: { flowType: "pkce", persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
  }

  async signInWithGoogle(redirectTo: string): Promise<void> {
    check(await this.supabase.auth.signInWithOAuth({ provider: "google", options: { redirectTo } }));
  }

  async signInWithPassword(email: string, password: string): Promise<void> {
    check(await this.supabase.auth.signInWithPassword({ email, password }));
  }

  async signUp(email: string, password: string, redirectTo: string): Promise<void> {
    check(await this.supabase.auth.signUp({ email, password, options: { emailRedirectTo: redirectTo } }));
  }

  async requestPasswordReset(email: string, redirectTo: string): Promise<void> {
    const result = await this.supabase.auth.resetPasswordForEmail(email, { redirectTo });
    // só o limite de envio aparece; qualquer outra resposta é a mesma, exista a conta ou não
    if (result.error && toAuthError(result.error)?.code === "rate_limited") throw new AuthError("rate_limited");
  }

  async updatePassword(password: string): Promise<void> {
    check(await this.supabase.auth.updateUser({ password }));
  }

  async signOut(options: { everywhere?: boolean } = {}): Promise<void> {
    await this.supabase.auth.signOut({ scope: options.everywhere ? "global" : "local" });
  }

  async signOutOthers(): Promise<void> {
    await this.supabase.auth.signOut({ scope: "others" });
  }

  async getAccessToken(options: { forceRefresh?: boolean } = {}): Promise<string | null> {
    if (options.forceRefresh) {
      const { data } = await this.supabase.auth.refreshSession();
      return data.session?.access_token ?? null;
    }
    const { data } = await this.supabase.auth.getSession();
    return data.session?.access_token ?? null;
  }

  async authenticatedAt(): Promise<Date | null> {
    const token = await this.getAccessToken();
    return token ? authenticatedAtFromToken(token) : null;
  }

  async hasPassword(): Promise<boolean> {
    const { data } = await this.supabase.auth.getUser();
    return Boolean(data.user?.identities?.some((i) => i.provider === "email"));
  }

  onChange(listener: () => void): () => void {
    const { data } = this.supabase.auth.onAuthStateChange(() => listener());
    return () => data.subscription.unsubscribe();
  }
}
