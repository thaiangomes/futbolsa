import { type AuthClient, AuthError } from "./auth-client";
import { SupabaseAuthClient } from "./supabase-auth-client";

export * from "./auth-client";

/** Sem o Supabase configurado: ninguém entra, e o site funciona como visitante. */
class UnconfiguredAuthClient implements AuthClient {
  private fail(): never {
    throw new AuthError("unavailable");
  }
  signInWithGoogle = async () => this.fail();
  signInWithPassword = async () => this.fail();
  signUp = async () => this.fail();
  requestPasswordReset = async () => this.fail();
  updatePassword = async () => this.fail();
  signOut = async () => undefined;
  signOutOthers = async () => undefined;
  getAccessToken = async () => null;
  authenticatedAt = async () => null;
  hasPassword = async () => false;
  onChange = () => () => undefined;
}

let client: AuthClient | undefined;

/**
 * O login do site, criado uma vez. A URL e a chave pública do Supabase são as únicas variáveis
 * de login que o site recebe (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`);
 * a chave de serviço fica só na API.
 */
export function getAuthClient(): AuthClient {
  if (!client) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    client = url && key ? new SupabaseAuthClient(url, key) : new UnconfiguredAuthClient();
  }
  return client;
}

/** Nos testes: troca o cliente de login. */
export function setAuthClient(next: AuthClient | undefined): void {
  client = next;
}
