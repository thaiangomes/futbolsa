"use client";

import { type FormEvent, useState } from "react";
import { meResponseSchema, type MeResponse } from "@futbolsa/contracts";
import { ApiError, type ApiClient } from "../../lib/api";
import { formatBrasilia, nicknameFeedback } from "./forms";

export interface SignupFormProps {
  api: ApiClient;
  /** A conta acabou de ser criada (a tela de "tudo pronto" aparece). */
  onCreated?(): void;
  /** Depois de criar a conta, ao sair da tela de "tudo pronto". */
  onContinue(): void;
}

type Registered = Extract<MeResponse, { registered: true }>;

/**
 * Cadastro (prancha 6b): o apelido validado na hora e o aceite dos termos e da política, em
 * resumo. Sem os dois, a conta não é criada (Conta e login, critérios 2, 8, 9, 21 e 25).
 */
export function SignupForm({ api, onCreated, onContinue }: SignupFormProps) {
  const [nickname, setNickname] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<Registered | null>(null);
  const feedback = nicknameFeedback(nickname);
  const touched = nickname.length > 0;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!feedback.ok || !accepted) return;
    setBusy(true);
    setError(null);
    try {
      const me = await api.request(meResponseSchema, "/me", { method: "POST", body: { nickname, acceptTerms: true } });
      if (me.registered) {
        onCreated?.();
        setCreated(me);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Não deu para criar a conta agora. Tente de novo.");
    } finally {
      setBusy(false);
    }
  };

  if (created) return <SignupDone me={created} onContinue={onContinue} />;

  const hintBad = touched && !feedback.ok;
  return (
    <form className="stack" style={{ gap: 24 }} onSubmit={(e) => void submit(e)} noValidate>
      <div className="stack-s" style={{ gap: 6 }}>
        <h1 className="h1">Escolha como os outros vão te ver</h1>
        <p className="muted m0">
          Seu apelido é o único nome que aparece no jogo: nos rankings e no seu perfil. Seu e-mail fica privado. Dá para
          trocar o apelido depois.
        </p>
      </div>
      <section className="card card-b stack">
        <div className="field">
          <label htmlFor="ap">Apelido</label>
          <div className="row" style={{ flexWrap: "nowrap", gap: 8 }}>
            <span className="av" style={{ width: 42, height: 42, fontSize: 16 }} aria-hidden="true">{(nickname[0] ?? "?").toUpperCase()}</span>
            <input id="ap" className={`input${hintBad ? " err" : ""}`} autoComplete="off" value={nickname}
              onChange={(e) => { setNickname(e.target.value); setError(null); }} aria-describedby="ap-h" aria-invalid={hintBad} />
          </div>
          <span id="ap-h" className={`hint${hintBad ? " err" : ""}`}>{touched ? feedback.message : " "}</span>
        </div>
        <div className="row" style={{ gap: 6 }}>
          <span className="xs muted">Regras:</span>
          <span className="chip">3 a 20 caracteres</span>
          <span className="chip">letras sem acento, números e _</span>
          <span className="chip">único no jogo</span>
        </div>
      </section>

      <section className="card card-b stack" aria-labelledby="t-termos">
        <h2 className="h3" id="t-termos">Termos de uso e política de privacidade, em resumo</h2>
        <ul className="small muted stack-s m0" style={{ paddingLeft: 18, gap: 6 }}>
          <li>O dinheiro do jogo é <strong style={{ color: "var(--text)" }}>fictício</strong>: não dá para comprar, sacar nem trocar por prêmio.</li>
          <li>O FutBolsa <strong style={{ color: "var(--text)" }}>não tem relação</strong> com nenhum clube, com a CBF nem com a B3.</li>
          <li>Guardamos só o seu e-mail, o apelido, a data deste aceite e o seu histórico no jogo. Nada de nome, foto ou idade.</li>
          <li>Você pode excluir sua conta quando quiser, no seu perfil.</li>
        </ul>
        <label className="ck">
          <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
          <span className="small">
            Li e aceito os <a href="/termos" target="_blank" rel="noreferrer">Termos de uso</a> e a{" "}
            <a href="/privacidade" target="_blank" rel="noreferrer">Política de privacidade</a>.
          </span>
        </label>
      </section>
      {error && <div className="note note-err" role="alert"><div>{error}</div></div>}
      <div className="row between">
        <span className="xs muted">Sem apelido e aceite, a conta não é criada.</span>
        <button type="submit" className="btn btn-p btn-lg" disabled={busy || !feedback.ok || !accepted}>Criar conta</button>
      </div>
    </form>
  );
}

/** "Tudo pronto": o que acontece com a conta nesta temporada. */
function SignupDone({ me, onContinue }: { me: Registered; onContinue(): void }) {
  const season = me.season;
  return (
    <div className="stack" style={{ gap: 24 }}>
      <div className="stack-s" style={{ gap: 6 }}>
        <h1 className="h1">Tudo pronto, {me.nickname}.</h1>
        <p className="muted m0">Sua conta foi criada. Veja o que acontece agora.</p>
      </div>
      <section className="card card-b stack-s" style={{ gap: 0 }}>
        {season?.hasWallet && <div className="kv"><span>Caixa agora</span><span>R$ 100.000,00 fictícios</span></div>}
        {season && !season.hasWallet && !season.needsEntry && season.ipoOpensAt && (
          <>
            <div className="kv"><span>Caixa agora</span><span>R$ 0,00</span></div>
            <div className="kv"><span>Ofertas do IPO {season.year} abrem</span><span>{formatBrasilia(season.ipoOpensAt)}</span></div>
            <div className="kv"><span>Nesse momento você recebe</span><span>R$ 100.000,00 fictícios</span></div>
          </>
        )}
        {season?.needsEntry && (
          <div className="kv"><span>Temporada {season.year} em andamento</span><span>escolha como entrar no jogo</span></div>
        )}
        {!season && <div className="kv"><span>Caixa agora</span><span>R$ 0,00 até abrir o IPO da próxima temporada</span></div>}
      </section>
      <div className="row">
        {season?.needsEntry ? (
          <a className="btn btn-p btn-lg" href="/entrada">Escolher como entrar</a>
        ) : (
          <button type="button" className="btn btn-p btn-lg" onClick={onContinue}>Continuar</button>
        )}
      </div>
    </div>
  );
}
