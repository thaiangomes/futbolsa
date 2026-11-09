"use client";

import { type ReactNode, useCallback, useEffect, useState } from "react";
import { ipoErrorMessage } from "./forms";

export function Card({ title, right, children, id }: { title: string; right?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <div className="card" id={id}>
      <div className="card-h">
        <h2 className="card-t">{title}</h2>
        {right}
      </div>
      <div className="card-b">{children}</div>
    </div>
  );
}

/** Aviso de recusa ou de erro: a mensagem do código, sem texto a mais. */
export function ErrorNote({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="note note-err" role="alert">
      <div>{message}</div>
    </div>
  );
}

/** Uma célula rotulada de uma linha de clube (o rótulo fica visível no computador e no celular). */
export function Cell({ label, children, testId, className = "" }: { label: string; children: ReactNode; testId?: string; className?: string }) {
  return (
    <div className={`ipo-cell ${className}`.trim()} data-testid={testId}>
      <span className="ipo-k">{label}</span>
      <span className="ipo-v num">{children}</span>
    </div>
  );
}

/** Executa uma chamada da API mostrando a mensagem do código de erro; devolve `true` se deu certo. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (fn: () => Promise<unknown>, onError?: (e: unknown) => void): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      setError(ipoErrorMessage(e));
      onError?.(e);
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run, clearError: () => setError(null) };
}

/** O relógio da tela: relê `now` a cada `everyMs` (a contagem regressiva anda sozinha). */
export function useNow(now: () => number, everyMs = 1000): number {
  const [value, setValue] = useState(now);
  useEffect(() => {
    setValue(now());
    const id = setInterval(() => setValue(now()), everyMs);
    return () => clearInterval(id);
  }, [now, everyMs]);
  return value;
}
