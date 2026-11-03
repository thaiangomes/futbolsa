"use client";

import { type FormEvent, useState } from "react";
import { type AuthClient, AuthError, AUTH_ERROR_MESSAGES } from "../../lib/auth";
import { passwordFeedback } from "./forms";

export interface CreateLoginFormProps {
  auth: AuthClient;
  /** Para onde o link de confirmação do e-mail volta (`/auth/retorno`). */
  returnUrl: string;
}

/**
 * Primeiro acesso com e-mail e senha (Conta e login, critérios 4 e 5): a senha tem no mínimo 8
 * caracteres e o e-mail é confirmado por um link. A resposta é a mesma para um e-mail novo ou
 * já usado, para ninguém descobrir quem tem conta. O convite é conferido depois, no cadastro.
 */
export function CreateLoginForm({ auth, returnUrl }: CreateLoginFormProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const check = passwordFeedback(password, repeat);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!check.ok || !email) return;
    setBusy(true);
    setError(null);
    try {
      await auth.signUp(email.trim(), password, returnUrl);
      setSent(true);
    } catch (err) {
      setError(err instanceof AuthError ? err.message : AUTH_ERROR_MESSAGES.unavailable);
    } finally {
      setBusy(false);
    }
  };

  if (sent) {
    return (
      <div className="stack">
        <h1 className="h2" id="t-criar">Confirme o seu e-mail</h1>
        <div className="note note-ok" role="status">
          <div>
            Enviamos um link para <strong>{email.trim()}</strong>. Abra o link para confirmar o e-mail e continuar o
            cadastro. Confira também a caixa de spam.
          </div>
        </div>
        <p className="xs muted m0">Se este e-mail já tinha login no FutBolsa, entre com ele em vez de criar outro.</p>
        <a className="btn btn-lg btn-full" href="/entrar">Voltar para entrar</a>
      </div>
    );
  }

  return (
    <form className="stack" onSubmit={(e) => void submit(e)} noValidate>
      <div className="stack-s" style={{ gap: 4 }}>
        <h1 className="h2" id="t-criar">Primeiro acesso</h1>
        <span className="small muted">Crie o seu login com o e-mail que o admin liberou. Depois você escolhe o apelido.</span>
      </div>
      <div className="field">
        <label htmlFor="em">E-mail</label>
        <input id="em" className="input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="s1">Senha</label>
        <input id="s1" className={`input${check.password.ok || !password ? "" : " err"}`} type="password" autoComplete="new-password"
          value={password} onChange={(e) => setPassword(e.target.value)} aria-describedby="s1-h" />
        <span id="s1-h" className={`hint${!password || check.password.ok ? "" : " err"}`}>{check.password.message}</span>
      </div>
      <div className="field">
        <label htmlFor="s2">Repita a senha</label>
        <input id="s2" className={`input${check.repeat.ok ? "" : " err"}`} type="password" autoComplete="new-password"
          value={repeat} onChange={(e) => setRepeat(e.target.value)} aria-describedby="s2-h" />
        <span id="s2-h" className={`hint${check.repeat.ok ? "" : " err"}`}>{check.repeat.message || " "}</span>
      </div>
      {error && <div className="note note-err" role="alert"><div>{error}</div></div>}
      <button type="submit" className="btn btn-p btn-lg btn-full" disabled={busy || !check.ok || !email}>Criar login</button>
      <a className="small" href="/entrar">Já tenho login</a>
    </form>
  );
}
