// @vitest-environment jsdom
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import PrivacidadePage from "../../app/privacidade/page";
import TermosPage from "../../app/termos/page";
import { LEGAL_CONTACT, LEGAL_VERSION } from "./legal";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const googleBefore = process.env.NEXT_PUBLIC_GOOGLE_LOGIN;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  if (googleBefore === undefined) delete process.env.NEXT_PUBLIC_GOOGLE_LOGIN;
  else process.env.NEXT_PUBLIC_GOOGLE_LOGIN = googleBefore;
});

function render(el: ReactElement) {
  act(() => root.render(el));
  return container.textContent ?? "";
}

function contactLinks() {
  return [...container.querySelectorAll<HTMLAnchorElement>("a")].filter((a) => a.href === `mailto:${LEGAL_CONTACT}`);
}

describe("W7: termos de uso e política de privacidade completos", () => {
  it("conta 2: os termos mostram a versão, o texto completo e o contato, sem o aviso de versão resumida", () => {
    const text = render(createElement(TermosPage));
    expect(text).toContain(`Versão de ${LEGAL_VERSION.label}`);
    expect(container.querySelector("time")?.getAttribute("dateTime")).toBe(LEGAL_VERSION.date);
    expect(text).not.toMatch(/versão resumida/i);
    expect(text).toContain("fictícios e não valem nada fora dele");
    expect(text).toContain("não tem relação com nenhum clube, com a CBF");
    expect(text).toContain("Bloqueio pelo admin");
    expect(text).toContain("Excluir a conta");
    expect(text).toContain("conta excluída");
    expect(container.querySelectorAll("h2")).toHaveLength(12);
    expect(contactLinks().length).toBeGreaterThan(0);
    expect(container.querySelector('a[href="/privacidade"]')).not.toBeNull();
  });

  it("conta 20: a política diz o que guarda, quem vê, os operadores e onde ficam os dados", () => {
    const text = render(createElement(PrivacidadePage));
    expect(text).toContain(`Versão de ${LEGAL_VERSION.label}`);
    expect(text).not.toMatch(/versão resumida/i);
    expect(text).toContain("Não guardamos nome, foto, idade");
    expect(text).toContain("Thaian Gomes, pessoa física");
    for (const operator of ["Supabase:", "Google (Gmail):", "Vercel:"]) expect(text).toContain(operator);
    expect(text).toContain("em São Paulo, no Brasil");
    expect(text).toContain("LGPD (art. 18)");
    expect(text).toContain("Respondemos em até 15 dias");
    expect(container.querySelectorAll("h2")).toHaveLength(10);
    expect(contactLinks().length).toBeGreaterThan(0);
  });

  it("o parágrafo do Google só aparece com o login pelo Google ligado", () => {
    delete process.env.NEXT_PUBLIC_GOOGLE_LOGIN;
    expect(render(createElement(PrivacidadePage))).not.toContain("Ao entrar com o Google");
    process.env.NEXT_PUBLIC_GOOGLE_LOGIN = "true";
    expect(render(createElement(PrivacidadePage))).toContain("Ao entrar com o Google, o jogo usa só o seu e-mail");
  });
});
