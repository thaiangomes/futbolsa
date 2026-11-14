import { type AuthClient, AuthError, authenticatedAtFromToken } from "./auth-client";

/**
 * O login falso do build de teste do navegador (P8 do Plano do ensaio, carga e testes no navegador).
 * Só entra no site quando `NEXT_PUBLIC_AUTH_CLIENT=fake` na hora do build (`npm run e2e:build`); o
 * build normal não o contém (a guarda `guarda-build.spec.ts` confere pela marca abaixo).
 *
 * O Playwright põe no `localStorage` o token de teste que o servidor de teste emitiu e, para as telas
 * de e-mail e senha, uma lista de contas (`futbolsa:e2e:contas`).
 */
export const MARCA_DO_LOGIN_FALSO = "FUTBOLSA_E2E_LOGIN_FALSO";

const CHAVE_TOKEN = "futbolsa:e2e:token";
const CHAVE_CONTAS = "futbolsa:e2e:contas";
const CHAVE_ULTIMA = "futbolsa:e2e:ultimo-login";

type Contas = Record<string, { password: string; token: string }>;

function ler<T>(chave: string, padrao: T): T {
  try {
    const texto = window.localStorage.getItem(chave);
    return texto ? (JSON.parse(texto) as T) : padrao;
  } catch {
    return padrao;
  }
}

export class FakeAuthClient implements AuthClient {
  readonly marca = MARCA_DO_LOGIN_FALSO;
  private readonly ouvintes = new Set<() => void>();

  constructor() {
    if (typeof window !== "undefined") window.addEventListener("storage", () => this.avisar());
  }

  private avisar() {
    for (const ouvinte of this.ouvintes) ouvinte();
  }

  private contas(): Contas {
    return ler<Contas>(CHAVE_CONTAS, {});
  }

  async signInWithGoogle(): Promise<void> {
    throw new AuthError("unavailable");
  }

  async signInWithPassword(email: string, password: string): Promise<void> {
    const conta = this.contas()[email.trim().toLowerCase()];
    if (!conta || conta.password !== password) throw new AuthError("invalid_credentials");
    window.localStorage.setItem(CHAVE_TOKEN, conta.token);
    window.localStorage.setItem(CHAVE_ULTIMA, String(Date.now()));
    this.avisar();
  }

  async signUp(): Promise<void> {
    // mesma resposta para qualquer e-mail (critério 8): nada a fazer
  }

  async requestPasswordReset(): Promise<void> {
    // mesma resposta para qualquer e-mail (critério 6)
  }

  async updatePassword(password: string): Promise<void> {
    if (password.length < 8) throw new AuthError("weak_password");
  }

  async signOut(): Promise<void> {
    window.localStorage.removeItem(CHAVE_TOKEN);
    this.avisar();
  }

  async signOutOthers(): Promise<void> {}

  async getAccessToken(): Promise<string | null> {
    return window.localStorage.getItem(CHAVE_TOKEN);
  }

  async authenticatedAt(): Promise<Date | null> {
    const token = await this.getAccessToken();
    return token ? authenticatedAtFromToken(token) : null;
  }

  async hasPassword(): Promise<boolean> {
    return true;
  }

  onChange(listener: () => void): () => void {
    this.ouvintes.add(listener);
    return () => this.ouvintes.delete(listener);
  }
}
