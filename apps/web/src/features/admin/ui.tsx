"use client";

import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { errorMessage, reasonFeedback } from "./forms";

export interface Loader<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload(): Promise<void>;
  set(value: T): void;
}

/** Carrega uma vez ao abrir a tela e deixa recarregar depois de cada ação. */
export function useLoader<T>(load: () => Promise<T>): Loader<T> {
  const loadRef = useRef(load);
  loadRef.current = load;
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    try {
      setData(await loadRef.current());
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, loading, reload, set: setData };
}

export function ErrorNote({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="note note-err" role="alert">
      <div>{message}</div>
    </div>
  );
}

export function LoadState({ loader }: { loader: Loader<unknown> }) {
  if (loader.loading) return <p className="muted">Carregando…</p>;
  return <ErrorNote message={loader.error} />;
}

/** O campo de motivo, obrigatório onde a API o exige: o botão de quem usa fica desligado até o motivo valer. */
export function ReasonField({ value, onChange, id = "motivo", label = "Motivo" }: { value: string; onChange(v: string): void; id?: string; label?: string }) {
  const feedback = reasonFeedback(value);
  const touched = value.length > 0;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        className={`input${touched && !feedback.ok ? " err" : ""}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        maxLength={500}
        aria-describedby={`${id}-dica`}
      />
      <span id={`${id}-dica`} className={`hint${touched && !feedback.ok ? " err" : ""}`}>{feedback.message}</span>
    </div>
  );
}

/** Executa uma ação da API mostrando o erro; devolve `true` se deu certo. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run, clearError: () => setError(null) };
}

export function Card({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <div className="card">
      <div className="card-h">
        <h2 className="card-t">{title}</h2>
        {right}
      </div>
      <div className="card-b">{children}</div>
    </div>
  );
}
