"use client";

import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { deleteMeResponseSchema } from "@futbolsa/contracts";
import { z } from "zod";
import { ApiError, type ApiClient } from "../../lib/api";
import { type AuthClient, AuthError, AUTH_ERROR_MESSAGES, needsReauth } from "../../lib/auth";
import { googleLoginEnabled } from "./flags";
import { formatDate, nicknameFeedback, passwordFeedback } from "./forms";
import type { RegisteredMe } from "./session";

const messageOf = (e: unknown) =>
  e instanceof AuthError || e instanceof ApiError ? e.message : AUTH_ERROR_MESSAGES.unavailable;

export interface AccountSettingsProps {
  me: RegisteredMe;
  auth: AuthClient;
  api: ApiClient;
  /** Para onde o Google volta depois de entrar de novo (`/conta`). */
  returnUrl: string;
  /** Depois de trocar o apelido: relê a conta. */
  onChanged(): void | Promise<void>;
  /** Depois de sair de todos os aparelhos ou de excluir a conta. */
  onSignedOut(reason: "signed_out" | "deleted"): void;
  /** O relógio, para os testes. */
  now?: () => Date;
  /** Um bloco a mais embaixo do perfil público (a foto mensal da carteira, da F10). */
  profileExtra?: ReactNode;
}

/**
 * Entrar de novo antes de trocar a senha ou excluir a conta: confere que é o dono, não limita
 * quando (decisão do Thaian em 2026-10-31). Com senha, pede a senha atual; pelo Google, volta à tela.
 */
function ReauthPanel({ auth, email, hasPassword, verb, returnUrl, onDone, onCancel }: {
  auth: AuthClient; email: string; hasPassword: boolean; verb: string; returnUrl: string; onDone(): void; onCancel(): void;
}) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const confirm = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await auth.signInWithPassword(email, password);
      onDone();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack-s" style={{ gap: 10 }}>
      <div className="note" style={{ padding: "10px 12px" }}><div>Por segurança, entre de novo antes de {verb}.</div></div>
      {hasPassword && (
        <form className="stack-s" style={{ gap: 10 }} onSubmit={(e) => void confirm(e)}>
          <div className="field">
            <label htmlFor="atual">Senha atual</label>
            <input id="atual" className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          {error && <div className="note note-err" role="alert"><div>{error}</div></div>}
          <button type="submit" className="btn btn-p btn-full" disabled={busy || !password}>Confirmar e continuar</button>
          {googleLoginEnabled() && <span className="xs muted" style={{ textAlign: "center" }}>ou</span>}
        </form>
      )}
      {googleLoginEnabled() && (
        <button type="button" className="btn btn-full" onClick={() => void auth.signInWithGoogle(returnUrl).catch((e: unknown) => setError(messageOf(e)))}>
          Entrar de novo com o Google
        </button>
      )}
      {!hasPassword && error && <div className="note note-err" role="alert"><div>{error}</div></div>}
      <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>Cancelar</button>
    </div>
  );
}

/** Trocar a senha, ou criar uma para quem só entra pelo Google (Conta e login, critérios 26 e 27). */
function PasswordSection({ auth, email, returnUrl, now }: { auth: AuthClient; email: string; returnUrl: string; now: () => Date }) {
  const [hasPassword, setHasPassword] = useState<boolean | null>(null);
  const [step, setStep] = useState<"idle" | "reauth" | "field" | "ok">("idle");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void auth.hasPassword().then(setHasPassword, () => setHasPassword(false));
  }, [auth]);
  const create = hasPassword === false;
  const check = passwordFeedback(password);

  const open = async () => {
    setPassword("");
    setError(null);
    setStep(needsReauth(await auth.authenticatedAt(), now()) ? "reauth" : "field");
  };
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!check.ok) return;
    setBusy(true);
    setError(null);
    try {
      await auth.updatePassword(password);
      await auth.signOutOthers();
      setStep("ok");
      setHasPassword(true);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack-s" style={{ gap: 10, borderTop: "1px solid var(--line)", paddingTop: 14 }}>
      <div className="row between">
        <span className="b">Senha</span>
        <span className="xs muted">{hasPassword === null ? "" : create ? "você ainda não tem senha" : "definida"}</span>
      </div>
      {step === "idle" && (
        <button type="button" className="btn btn-full" disabled={hasPassword === null} onClick={() => void open()}>
          {create ? "Criar senha" : "Trocar senha"}
        </button>
      )}
      {step === "reauth" && (
        <ReauthPanel auth={auth} email={email} hasPassword={!create} verb={create ? "criar a senha" : "trocar a senha"}
          returnUrl={returnUrl} onDone={() => setStep("field")} onCancel={() => setStep("idle")} />
      )}
      {step === "field" && (
        <form className="stack-s" style={{ gap: 10 }} onSubmit={(e) => void save(e)}>
          <div className="field">
            <label htmlFor="nova">{create ? "Senha (mínimo 8 caracteres)" : "Senha nova (mínimo 8 caracteres)"}</label>
            <input id="nova" className={`input${!password || check.password.ok ? "" : " err"}`} type="password" autoComplete="new-password"
              value={password} onChange={(e) => setPassword(e.target.value)} aria-describedby="nova-h" />
            <span id="nova-h" className={`hint${!password || check.password.ok ? "" : " err"}`}>
              {password && !check.password.ok ? check.password.message
                : create ? "Depois você entra também com e-mail e senha, na mesma conta." : "Ao gravar, os outros aparelhos saem da conta."}
            </span>
          </div>
          {error && <div className="note note-err" role="alert"><div>{error}</div></div>}
          <div className="row" style={{ flexWrap: "nowrap" }}>
            <button type="button" className="btn grow" onClick={() => setStep("idle")}>Cancelar</button>
            <button type="submit" className="btn btn-p grow" disabled={busy || !check.ok}>Gravar</button>
          </div>
        </form>
      )}
      {step === "ok" && (
        <div className="note note-ok" role="status">
          <div>
            {create
              ? "Senha criada. Agora você entra com o Google ou com e-mail e senha, e cai sempre na mesma conta."
              : "Senha trocada. A antiga deixou de funcionar e os outros aparelhos saíram da conta."}
          </div>
        </div>
      )}
    </div>
  );
}

/** Perfil e conta (prancha 6c, a parte da conta; a foto mensal e o histórico vêm na F10 e na F15). */
export function AccountSettings({ me, auth, api, returnUrl, onChanged, onSignedOut, now = () => new Date(), profileExtra }: AccountSettingsProps) {
  const [nickname, setNickname] = useState(me.nickname);
  const [nickError, setNickError] = useState<string | null>(null);
  const [nickOk, setNickOk] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [deleteStep, setDeleteStep] = useState<"form" | "reauth">("form");
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [hasPassword, setHasPassword] = useState(true);
  useEffect(() => {
    void auth.hasPassword().then(setHasPassword, () => undefined);
  }, [auth]);
  const nickFeedback = nicknameFeedback(nickname);
  const nickChanged = nickname !== me.nickname;

  const changeNickname = async (e: FormEvent) => {
    e.preventDefault();
    if (!nickFeedback.ok || !nickChanged) return;
    setBusy(true);
    setNickError(null);
    setNickOk(false);
    try {
      await api.request(z.undefined(), "/me/nickname", { method: "PATCH", body: { nickname } });
      setNickOk(true);
      await onChanged();
    } catch (err) {
      setNickError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  const deleteAccount = async () => {
    setBusy(true);
    setDeleteError(null);
    try {
      await api.request(deleteMeResponseSchema, "/me", { method: "DELETE", body: { confirmNickname: confirm } });
      await auth.signOut();
      onSignedOut("deleted");
    } catch (err) {
      if (err instanceof ApiError && err.code === "reauth_required") setDeleteStep("reauth");
      else setDeleteError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="g-main-aside">
      <div className="stack">
        <section className="card card-b row" style={{ gap: 20 }} aria-label="Perfil público">
          <span className="av" style={{ width: 72, height: 72, fontSize: 30 }} aria-hidden="true">{me.nickname[0]?.toUpperCase()}</span>
          <div className="stack-s grow" style={{ gap: 4 }}>
            <h1 className="h1">{me.nickname}</h1>
            <span className="small muted">Conta criada em {formatDate(me.termsAcceptedAt)}</span>
          </div>
          <span className="chip">Assim os outros veem seu perfil</span>
        </section>
        {profileExtra}
      </div>

      <aside className="stack">
        <section className="card" aria-labelledby="t-conta">
          <div className="card-h"><h2 className="card-t" id="t-conta">Sua conta</h2><span className="xs muted">Só você vê</span></div>
          <div className="card-b stack">
            <form className="field" onSubmit={(e) => void changeNickname(e)}>
              <label htmlFor="ap">Apelido</label>
              <div className="row" style={{ flexWrap: "nowrap", gap: 8 }}>
                <input id="ap" className={`input${nickFeedback.ok ? "" : " err"}`} value={nickname} aria-describedby="ap-h"
                  onChange={(e) => { setNickname(e.target.value); setNickError(null); setNickOk(false); }} />
                <button type="submit" className="btn" disabled={busy || !nickChanged || !nickFeedback.ok}>Trocar</button>
              </div>
              <span id="ap-h" className={`hint${nickError || !nickFeedback.ok ? " err" : ""}`}>
                {nickError ?? (!nickFeedback.ok ? nickFeedback.message
                  : nickOk ? "Apelido trocado." : "Os rankings, inclusive os antigos, passam a mostrar o novo apelido.")}
              </span>
            </form>
            <div className="kv"><span>E-mail (privado)</span><span>{me.email}</span></div>
            <div className="kv"><span>Termos aceitos em</span><span>{formatDate(me.termsAcceptedAt)}</span></div>
            <PasswordSection auth={auth} email={me.email} returnUrl={returnUrl} now={now} />
            <button type="button" className="btn btn-full"
              onClick={() => void auth.signOut({ everywhere: true }).then(() => onSignedOut("signed_out"))}>
              Sair de todos os aparelhos
            </button>
          </div>
        </section>

        <section className="card" aria-labelledby="t-excluir" style={{ borderColor: "var(--down-soft)" }}>
          <div className="card-h"><h2 className="card-t" id="t-excluir" style={{ color: "var(--down)" }}>Excluir conta</h2></div>
          <div className="card-b stack small muted">
            <p className="m0">
              Não tem volta. Suas ordens são canceladas, suas ações vão para a tesouraria da casa, o caixa some e seu e-mail
              e apelido são apagados. Nos rankings já fechados, sua linha fica como &quot;conta excluída&quot;.
            </p>
            {deleteStep === "reauth" ? (
              <ReauthPanel auth={auth} email={me.email} hasPassword={hasPassword} verb="excluir a conta" returnUrl={returnUrl}
                onDone={() => { setDeleteStep("form"); void deleteAccount(); }} onCancel={() => setDeleteStep("form")} />
            ) : (
              <>
                <div className="field">
                  <label htmlFor="conf">Para confirmar, digite seu apelido</label>
                  <input id="conf" className="input" placeholder={me.nickname} value={confirm} autoComplete="off"
                    onChange={(e) => { setConfirm(e.target.value); setDeleteError(null); }} />
                </div>
                {deleteError && <div className="note note-err" role="alert"><div>{deleteError}</div></div>}
                <button type="button" className="btn btn-danger btn-full" disabled={busy || confirm.toLowerCase() !== me.nickname.toLowerCase()}
                  onClick={() => void deleteAccount()}>
                  Excluir minha conta
                </button>
              </>
            )}
          </div>
        </section>
      </aside>
    </div>
  );
}
