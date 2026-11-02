"use client";

import { type FormEvent, useState } from "react";
import { type AuthClient, AuthError, AUTH_ERROR_MESSAGES } from "../../lib/auth";

export interface LoginFormProps {
  auth: AuthClient;
  /** Para onde o Google e o link do e-mail voltam (`/auth/retorno`). */
  returnUrl: string;
  /** Depois de entrar com e-mail e senha. */
  onSignedIn(): void;
}

/** O ícone do Google, com as cores dele (só no botão de entrar). */
function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.4h6.5a5.6 5.6 0 0 1-2.4 3.6v3h3.9c2.2-2.1 3.5-5.1 3.5-8.7z" />
      <path fill="#34A853" d="M12 24c3.2 0 6-1.1 8-2.9l-3.9-3c-1.1.7-2.5 1.2-4.1 1.2-3.1 0-5.8-2.1-6.7-5H1.3v3.1A12 12 0 0 0 12 24z" />
      <path fill="#FBBC05" d="M5.3 14.3a7.2 7.2 0 0 1 0-4.6V6.6h-4a12 12 0 0 0 0 10.8z" />
      <path fill="#EA4335" d="M12 4.8c1.8 0 3.3.6 4.6 1.8l3.4-3.4A12 12 0 0 0 1.3 6.6l4 3.1c.9-2.9 3.6-4.9 6.7-4.9z" />
    </svg>
  );
}

/**
 * Entrar (prancha 6a): Google, ou e-mail e senha. Senha errada e e-mail sem conta mostram a
 * mesma mensagem (Conta e login, critério 6).
 */
export function LoginForm({ auth, returnUrl, onSignedIn }: LoginFormProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<void>, after?: () => void) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      after?.();
    } catch (e) {
      setError(e instanceof AuthError ? e.message : AUTH_ERROR_MESSAGES.unavailable);
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(() => auth.signInWithPassword(email.trim(), password), onSignedIn);
  };

  return (
    <form className="stack" onSubmit={submit} noValidate>
      <div className="stack-s" style={{ gap: 4 }}>
        <h2 className="h2" id="t-entrar">Entrar no jogo</h2>
        <span className="small muted">Use o e-mail que o admin liberou para você.</span>
      </div>
      <button type="button" className="btn btn-lg btn-full" style={{ background: "var(--panel2)" }} disabled={busy}
        onClick={() => void run(() => auth.signInWithGoogle(returnUrl))}>
        <GoogleIcon />
        Entrar com o Google
      </button>
      <div className="row-s xs muted" style={{ gap: 12 }}>
        <span className="grow" style={{ height: 1, background: "var(--line)" }} />
        ou com e-mail e senha
        <span className="grow" style={{ height: 1, background: "var(--line)" }} />
      </div>
      <div className="field">
        <label htmlFor="em">E-mail</label>
        <input id="em" className="input" type="email" autoComplete="email" value={email}
          onChange={(e) => { setEmail(e.target.value); setError(null); }} />
      </div>
      <div className="field">
        <label htmlFor="se">Senha</label>
        <input id="se" className="input" type="password" autoComplete="current-password" value={password}
          onChange={(e) => { setPassword(e.target.value); setError(null); }} />
      </div>
      {error && (
        <div className="note note-err" role="alert">
          <div>{error}</div>
        </div>
      )}
      <button type="submit" className="btn btn-p btn-lg btn-full" disabled={busy || !email || !password}>Entrar</button>
      <div className="row between small">
        <a href="/esqueci-senha">Esqueci a senha</a>
        <a href="/criar-conta">Primeiro acesso com e-mail e senha</a>
      </div>
      <hr className="hr" />
      <p className="xs muted m0">
        Só entra quem tem o e-mail liberado pelo admin. Ainda não tem convite? Peça a quem te chamou para o jogo. Entrar
        com o Google ou com e-mail e senha no mesmo endereço leva à mesma conta.
      </p>
    </form>
  );
}
