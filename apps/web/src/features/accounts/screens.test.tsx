// @vitest-environment jsdom
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type ApiClient } from "../../lib/api";
import { type AuthClient, AuthError } from "../../lib/auth";
import { AccountSettings } from "./account-settings";
import { CreateLoginForm } from "./create-login-form";
import { LoginForm } from "./login-form";
import { NewPasswordForm, RequestResetForm } from "./password-reset";
import type { RegisteredMe } from "./session";
import { SignupForm } from "./signup-form";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2027-05-20T15:00:00Z");

function fakeAuth(overrides: Partial<Record<keyof AuthClient, unknown>> = {}): AuthClient & Record<string, ReturnType<typeof vi.fn>> {
  const base = {
    signInWithGoogle: vi.fn(async () => undefined),
    signInWithPassword: vi.fn(async () => undefined),
    signUp: vi.fn(async () => undefined),
    requestPasswordReset: vi.fn(async () => undefined),
    updatePassword: vi.fn(async () => undefined),
    signOut: vi.fn(async () => undefined),
    signOutOthers: vi.fn(async () => undefined),
    getAccessToken: vi.fn(async () => "token"),
    authenticatedAt: vi.fn(async () => new Date(NOW.getTime() - 60_000)),
    hasPassword: vi.fn(async () => true),
    onChange: vi.fn(() => () => undefined),
  };
  return { ...base, ...overrides } as never;
}

function fakeApi(handler: (path: string, req: { method?: string; body?: unknown }) => unknown) {
  const request = vi.fn(async (_schema: unknown, path: string, req: { method?: string; body?: unknown } = {}) => {
    const result = handler(path, req);
    if (result instanceof Error) throw result;
    return result;
  });
  return { api: { request } as unknown as ApiClient, request };
}

const me: RegisteredMe = {
  registered: true,
  id: "u1",
  nickname: "anagol",
  email: "ana@exemplo.com",
  role: "player",
  status: "active",
  termsAcceptedAt: "2027-03-20T12:00:00.000Z",
  season: null,
};

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(element: ReactElement) {
  await act(async () => root.render(element));
}
const $ = <T extends Element = HTMLElement>(selector: string) => container.querySelector(selector) as T;
const text = () => container.textContent ?? "";
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === label) as HTMLButtonElement;

/** Digita num campo controlado do React. */
async function type(selector: string, value: string) {
  const input = $<HTMLInputElement>(selector);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function click(el: Element) {
  await act(async () => {
    (el as HTMLElement).click();
  });
}
async function submit(selector = "form") {
  await act(async () => {
    $<HTMLFormElement>(selector).requestSubmit();
  });
}

describe("tela entrar (6a)", () => {
  it("conta 6: senha errada e e-mail sem conta mostram a mesma mensagem", async () => {
    const messages: string[] = [];
    for (const kind of ["wrong-password", "unknown-email"]) {
      const auth = fakeAuth({ signInWithPassword: vi.fn(async () => { throw new AuthError("invalid_credentials"); }) });
      await render(createElement(LoginForm, { auth, returnUrl: "http://site/auth/retorno", onSignedIn: () => undefined, key: kind }));
      await type("#em", kind === "wrong-password" ? "ana@exemplo.com" : "ninguem@exemplo.com");
      await type("#se", "qualquer-senha");
      await submit();
      messages.push($('[role="alert"]').textContent ?? "");
    }
    expect(messages[0]).toBe("E-mail ou senha incorretos. Confira e tente de novo.");
    expect(messages[1]).toBe(messages[0]);
  });

  it("entrar com e-mail e senha chama o login com o que foi digitado", async () => {
    const auth = fakeAuth();
    const onSignedIn = vi.fn();
    await render(createElement(LoginForm, { auth, returnUrl: "http://site/auth/retorno", onSignedIn }));
    await type("#em", " ana@exemplo.com ");
    await type("#se", "segredo123");
    await submit();
    expect(auth.signInWithPassword).toHaveBeenCalledWith("ana@exemplo.com", "segredo123");
    expect(onSignedIn).toHaveBeenCalled();
  });

  it("sem NEXT_PUBLIC_GOOGLE_LOGIN o botão do Google não aparece, nem na entrada nem na confirmação da conta", async () => {
    const auth = fakeAuth();
    await render(createElement(LoginForm, { auth, returnUrl: "http://site/auth/retorno", onSignedIn: () => undefined }));
    expect(container.textContent).not.toContain("Google");
    expect(container.querySelector("#em")).not.toBeNull();
  });

  it("com NEXT_PUBLIC_GOOGLE_LOGIN=true o botão volta e o Google volta para /auth/retorno", async () => {
    vi.stubEnv("NEXT_PUBLIC_GOOGLE_LOGIN", "true");
    try {
      const auth = fakeAuth();
      await render(createElement(LoginForm, { auth, returnUrl: "http://site/auth/retorno", onSignedIn: () => undefined }));
      await click(button("Entrar com o Google"));
      expect(auth.signInWithGoogle).toHaveBeenCalledWith("http://site/auth/retorno");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("primeiro acesso com e-mail e senha", () => {
  it("conta 4: 7 caracteres não deixa criar; 8 e repetida igual deixa; a resposta não diz se o e-mail tinha conta", async () => {
    const auth = fakeAuth();
    await render(createElement(CreateLoginForm, { auth, returnUrl: "http://site/auth/retorno" }));
    await type("#em", "bruno@exemplo.com");
    await type("#s1", "1234567");
    await type("#s2", "1234567");
    expect(button("Criar login").disabled).toBe(true);
    expect(text()).toContain("Use pelo menos 8 caracteres.");
    await type("#s1", "12345678");
    await type("#s2", "12345678");
    expect(button("Criar login").disabled).toBe(false);
    await submit();
    expect(auth.signUp).toHaveBeenCalledWith("bruno@exemplo.com", "12345678", "http://site/auth/retorno");
    expect(text()).toContain("Confirme o seu e-mail");
  });
});

describe("cadastro (6b)", () => {
  it("conta 9 e 2: joão mostra o erro sem chamar a API; sem o aceite o botão fica desligado", async () => {
    const { api, request } = fakeApi(() => ({}));
    await render(createElement(SignupForm, { api, onContinue: () => undefined }));
    await type("#ap", "joão");
    expect(text()).toContain("Só letras sem acento");
    expect(button("Criar conta").disabled).toBe(true);
    await type("#ap", "joao_10");
    expect(button("Criar conta").disabled).toBe(true);
    await click($('input[type="checkbox"]'));
    expect(button("Criar conta").disabled).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  it("conta 8: apelido em uso vem da API e aparece na tela", async () => {
    const { api } = fakeApi(() => new ApiError(409, "nickname_taken", "Este apelido já está em uso."));
    await render(createElement(SignupForm, { api, onContinue: () => undefined }));
    await type("#ap", "AnaGol");
    await click($('input[type="checkbox"]'));
    await submit();
    expect($('[role="alert"]').textContent).toBe("Este apelido já está em uso.");
  });

  it("conta criada antes do IPO: mostra caixa zero e a data de abertura", async () => {
    const created = { ...me, season: { year: 2027, status: "preparing", ipoOpensAt: "2027-03-28T19:00:00.000Z", hasWallet: false, needsEntry: false } };
    const { api, request } = fakeApi(() => created);
    const onCreated = vi.fn();
    await render(createElement(SignupForm, { api, onCreated, onContinue: () => undefined }));
    await type("#ap", "anagol");
    await click($('input[type="checkbox"]'));
    await submit();
    expect(request.mock.calls[0]![2]).toEqual({ method: "POST", body: { nickname: "anagol", acceptTerms: true } });
    expect(onCreated).toHaveBeenCalled();
    expect(text()).toContain("Tudo pronto, anagol.");
    expect(text()).toContain("dom. 28/03, 16h00");
    expect(text()).toContain("R$ 0,00");
  });
});

describe("esqueci a senha e nova senha (6d)", () => {
  it("conta 6: a resposta é a mesma para qualquer e-mail", async () => {
    const auth = fakeAuth();
    await render(createElement(RequestResetForm, { auth, returnUrl: "http://site/nova-senha" }));
    await type("#em", "qualquer@exemplo.com");
    await submit();
    expect(auth.requestPasswordReset).toHaveBeenCalledWith("qualquer@exemplo.com", "http://site/nova-senha");
    expect(text()).toContain("Se qualquer@exemplo.com tiver conta no FutBolsa");
  });

  it("conta 7: grava a senha nova e tira os outros aparelhos; link vencido mostra o aviso", async () => {
    const auth = fakeAuth();
    await render(createElement(NewPasswordForm, { auth, linkValid: true }));
    await type("#s1", "novasenha1");
    await type("#s2", "novasenha2");
    expect(button("Gravar senha").disabled).toBe(true);
    await type("#s2", "novasenha1");
    await submit();
    expect(auth.updatePassword).toHaveBeenCalledWith("novasenha1");
    expect(auth.signOutOthers).toHaveBeenCalled();
    expect(text()).toContain("Senha trocada");

    await render(createElement(NewPasswordForm, { auth, linkValid: false, key: "vencido" }));
    expect(text()).toContain("Este link já foi usado ou venceu.");
  });
});

describe("conta (6c)", () => {
  const props = (auth: AuthClient, api: ApiClient, extra: object = {}) => ({
    me, auth, api, returnUrl: "http://site/conta", onChanged: vi.fn(), onSignedOut: vi.fn(), now: () => NOW, ...extra,
  });

  it("conta 26: com o login há 2 horas, pede para entrar de novo antes de trocar a senha", async () => {
    const auth = fakeAuth({ authenticatedAt: vi.fn(async () => new Date(NOW.getTime() - 2 * 3600_000)) });
    const { api } = fakeApi(() => undefined);
    await render(createElement(AccountSettings, props(auth, api)));
    await click(button("Trocar senha"));
    expect(text()).toContain("Por segurança, entre de novo antes de trocar a senha.");
    await type("#atual", "senha-atual");
    await submit('form:has(#atual)');
    expect(auth.signInWithPassword).toHaveBeenCalledWith("ana@exemplo.com", "senha-atual");
    await type("#nova", "1234567");
    expect(button("Gravar").disabled).toBe(true);
    await type("#nova", "12345678");
    await submit('form:has(#nova)');
    expect(auth.updatePassword).toHaveBeenCalledWith("12345678");
    expect(auth.signOutOthers).toHaveBeenCalled();
    expect(text()).toContain("Senha trocada. A antiga deixou de funcionar e os outros aparelhos saíram da conta.");
  });

  it("conta 27: quem só entra pelo Google vê criar senha; com login recente, vai direto ao campo", async () => {
    const auth = fakeAuth({ hasPassword: vi.fn(async () => false) });
    const { api } = fakeApi(() => undefined);
    await render(createElement(AccountSettings, props(auth, api)));
    await click(button("Criar senha"));
    expect($("#nova")).not.toBeNull();
    expect(text()).toContain("Depois você entra também com e-mail e senha, na mesma conta.");
  });

  it("conta 10: troca de apelido manda o novo e relê a conta; apelido em uso aparece", async () => {
    const auth = fakeAuth();
    const { api, request } = fakeApi(() => undefined);
    const p = props(auth, api);
    await render(createElement(AccountSettings, p));
    await type("#ap", "ana_fla");
    await submit('form:has(#ap)');
    expect(request.mock.calls[0]![1]).toBe("/me/nickname");
    expect(request.mock.calls[0]![2]).toEqual({ method: "PATCH", body: { nickname: "ana_fla" } });
    expect(p.onChanged).toHaveBeenCalled();
  });

  it("conta 22: excluir só com o apelido digitado; reauth_required pede o login e repete", async () => {
    const auth = fakeAuth();
    let calls = 0;
    const { api, request } = fakeApi((path) => {
      if (path !== "/me") return undefined;
      calls++;
      return calls === 1 ? new ApiError(401, "reauth_required", "Por segurança, entre de novo antes de continuar.") : { walletCloseout: "done" };
    });
    const p = props(auth, api);
    await render(createElement(AccountSettings, p));
    expect(button("Excluir minha conta").disabled).toBe(true);
    await type("#conf", "anagol");
    await click(button("Excluir minha conta"));
    expect(text()).toContain("Por segurança, entre de novo antes de excluir a conta.");
    expect(text()).not.toContain("Google");
    await type("#atual", "senha-atual");
    await submit('form:has(#atual)');
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]![2]).toEqual({ method: "DELETE", body: { confirmNickname: "anagol" } });
    expect(auth.signOut).toHaveBeenCalled();
    expect(p.onSignedOut).toHaveBeenCalledWith("deleted");
  });

  it("sair de todos os aparelhos derruba as sessões", async () => {
    const auth = fakeAuth();
    const { api } = fakeApi(() => undefined);
    const p = props(auth, api);
    await render(createElement(AccountSettings, p));
    await click(button("Sair de todos os aparelhos"));
    expect(auth.signOut).toHaveBeenCalledWith({ everywhere: true });
    expect(p.onSignedOut).toHaveBeenCalledWith("signed_out");
  });

  it("conta 11: o e-mail aparece só na própria conta, marcado como privado", async () => {
    const { api } = fakeApi(() => undefined);
    await render(createElement(AccountSettings, props(fakeAuth(), api)));
    expect(text()).toContain("E-mail (privado)");
  });
});
