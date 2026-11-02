"use client";

import { type FormEvent, useState } from "react";
import { type AuthClient, AuthError, AUTH_ERROR_MESSAGES } from "../../lib/auth";
import { passwordFeedback } from "./forms";

function Steps({ step }: { step: 1 | 2 | 3 }) {
  return (
    <div className="steps" aria-hidden="true">
      <span className={step >= 1 ? "on" : ""} />
      <span className={step >= 2 ? "on" : ""} />
      <span className={step >= 3 ? "on" : ""} />
    </div>
  );
}

const messageOf = (e: unknown) => (e instanceof AuthError ? e.message : AUTH_ERROR_MESSAGES.unavailable);

/**
 * Esqueci a senha (prancha 6d, passos 1 e 2): manda o link e responde igual para qualquer
 * e-mail, para ninguém descobrir quem tem conta (Conta e login, critérios 6 e 7).
 */
export function RequestResetForm({ auth, returnUrl }: { auth: AuthClient; returnUrl: string }) {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await auth.requestPasswordReset(email.trim(), returnUrl);
      setSent(true);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  if (sent) {
    return (
      <div className="stack">
        <Steps step={2} />
        <h1 className="h2" id="t-senha">Confira o seu e-mail</h1>
        <div className="note note-ok" role="status">
          <div>
            Se <strong>{email.trim() || "o e-mail informado"}</strong> tiver conta no FutBolsa, enviamos um link para criar
            outra senha. Confira também a caixa de spam.
          </div>
        </div>
        <p className="xs muted m0">
          A resposta é a mesma para qualquer e-mail, para ninguém descobrir quem tem conta. Quem entra só com o Google
          também pode usar o link para criar uma senha.
        </p>
        <button type="button" className="btn" onClick={() => setSent(false)}>Usar outro e-mail</button>
      </div>
    );
  }

  return (
    <form className="stack" onSubmit={(e) => void submit(e)} noValidate>
      <Steps step={1} />
      <div className="stack-s" style={{ gap: 4 }}>
        <h1 className="h2" id="t-senha">Esqueci a senha</h1>
        <span className="small muted">Diga o e-mail da sua conta e mandamos um link para criar outra senha.</span>
      </div>
      <div className="field">
        <label htmlFor="em">E-mail</label>
        <input id="em" className="input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      {error && <div className="note note-err" role="alert"><div>{error}</div></div>}
      <button type="submit" className="btn btn-p btn-lg btn-full" disabled={busy || !email.trim()}>Enviar link</button>
      <a className="small" href="/entrar">Voltar para entrar</a>
    </form>
  );
}

/**
 * Nova senha (prancha 6d, passo 3), aberta pelo link do e-mail, que já deixa a pessoa logada.
 * Depois de gravar, a senha antiga deixa de valer e os outros aparelhos saem (critério 7).
 */
export function NewPasswordForm({ auth, linkValid }: { auth: AuthClient; linkValid: boolean }) {
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const check = passwordFeedback(password, repeat);

  if (!linkValid) {
    return (
      <div className="stack">
        <Steps step={3} />
        <h1 className="h2" id="t-senha">Crie a senha nova</h1>
        <div className="note note-err" role="alert">
          <div>Este link já foi usado ou venceu. <a href="/esqueci-senha">Pedir outro link</a></div>
        </div>
      </div>
    );
  }

  if (done) {
    return (
      <div className="stack">
        <Steps step={3} />
        <h1 className="h2" id="t-senha">Senha trocada</h1>
        <div className="note note-ok" role="status">
          <div>A senha nova já vale e a antiga deixou de funcionar. Os outros aparelhos saíram da conta.</div>
        </div>
        <a className="btn btn-p btn-lg btn-full" href="/auth/retorno">Entrar no jogo</a>
      </div>
    );
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!check.ok) return;
    setBusy(true);
    setError(null);
    try {
      await auth.updatePassword(password);
      await auth.signOutOthers();
      setDone(true);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="stack" onSubmit={(e) => void submit(e)} noValidate>
      <Steps step={3} />
      <div className="stack-s" style={{ gap: 4 }}>
        <h1 className="h2" id="t-senha">Crie a senha nova</h1>
        <span className="small muted">Depois de gravar, a senha antiga deixa de funcionar.</span>
      </div>
      <div className="field">
        <label htmlFor="s1">Senha nova</label>
        <input id="s1" className={`input${!password || check.password.ok ? "" : " err"}`} type="password" autoComplete="new-password"
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
      <button type="submit" className="btn btn-p btn-lg btn-full" disabled={busy || !check.ok}>Gravar senha</button>
    </form>
  );
}
