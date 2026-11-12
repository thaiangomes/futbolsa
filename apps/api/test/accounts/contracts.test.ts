import { describe, expect, it } from "vitest";
import {
  ACCOUNT_ERROR_MESSAGES,
  createMeBodySchema,
  invitesBodySchema,
  isReservedNickname,
  meResponseSchema,
  nicknameSchema,
  patchRoleBodySchema,
  publicPlayerSchema,
} from "@futbolsa/contracts";

const ok = (nickname: string) => nicknameSchema.safeParse(nickname).success;

describe("contratos de accounts", () => {
  it("conta 9: ab, um_apelido_com_mais_de_20 e joão recusados; joao_10 aceito", () => {
    expect(ok("ab")).toBe(false);
    expect(ok("um_apelido_com_mais_de_20")).toBe(false);
    expect(ok("joão")).toBe(false);
    expect(ok("joao_10")).toBe(true);
  });

  it("conta 9: limites de 3 e 20 caracteres", () => {
    expect(ok("abc")).toBe(true);
    expect(ok("a".repeat(20))).toBe(true);
    expect(ok("a".repeat(21))).toBe(false);
  });

  it("conta 9: espaço, hífen, ponto e emoji recusados", () => {
    for (const n of ["ana gol", "ana-gol", "ana.gol", "ana⚽gol", " anagol", "anagol\n"]) expect(ok(n)).toBe(false);
  });

  it("conta 25: Casa, ADMIN e conta_excluida são reservados; casa_10 não", () => {
    expect(isReservedNickname("Casa")).toBe(true);
    expect(isReservedNickname("ADMIN")).toBe(true);
    expect(isReservedNickname("conta_excluida")).toBe(true);
    expect(isReservedNickname("Tesouraria")).toBe(true);
    expect(isReservedNickname("casa_10")).toBe(false);
  });

  it("conta 2: cadastro sem o aceite, ou com false, é recusado", () => {
    expect(createMeBodySchema.safeParse({ nickname: "anagol" }).success).toBe(false);
    expect(createMeBodySchema.safeParse({ nickname: "anagol", acceptTerms: false }).success).toBe(false);
    expect(createMeBodySchema.safeParse({ nickname: "anagol", acceptTerms: "true" }).success).toBe(false);
    expect(createMeBodySchema.safeParse({ nickname: "anagol", acceptTerms: true }).success).toBe(true);
  });

  it("conta 21 e 20: o cadastro não aceita idade, nascimento nem nome", () => {
    for (const extra of [{ birthDate: "2010-01-01" }, { age: 12 }, { name: "Ana Souza" }, { role: "admin" }]) {
      expect(createMeBodySchema.safeParse({ nickname: "anagol", acceptTerms: true, ...extra }).success).toBe(false);
    }
  });

  it("conta 11: o perfil público não deixa passar e-mail nem id", () => {
    expect(publicPlayerSchema.safeParse({ nickname: "anagol", snapshot: null }).success).toBe(true);
    expect(publicPlayerSchema.safeParse({ nickname: "anagol", snapshot: null, email: "ana@exemplo.com" }).success).toBe(false);
    expect(publicPlayerSchema.safeParse({ nickname: "anagol", snapshot: null, id: "x" }).success).toBe(false);
  });

  it("GET /me sem conta não traz e-mail nem dados de outra pessoa", () => {
    expect(meResponseSchema.safeParse({ registered: false, invited: true }).success).toBe(true);
    expect(meResponseSchema.safeParse({ registered: false, invited: true, email: "a@b.com" }).success).toBe(false);
  });

  it("convites: de 1 a 200 e-mails válidos", () => {
    expect(invitesBodySchema.safeParse({ emails: [] }).success).toBe(false);
    expect(invitesBodySchema.safeParse({ emails: ["ana@exemplo.com"] }).success).toBe(true);
    expect(invitesBodySchema.safeParse({ emails: ["nao-e-email"] }).success).toBe(false);
    const many = Array.from({ length: 201 }, (_, i) => `p${i}@exemplo.com`);
    expect(invitesBodySchema.safeParse({ emails: many }).success).toBe(false);
    expect(invitesBodySchema.safeParse({ emails: many.slice(0, 200) }).success).toBe(true);
  });

  it("admin 33: mudar papel exige motivo", () => {
    expect(patchRoleBodySchema.safeParse({ role: "admin" }).success).toBe(false);
    expect(patchRoleBodySchema.safeParse({ role: "admin", reason: "  " }).success).toBe(false);
    expect(patchRoleBodySchema.safeParse({ role: "admin", reason: "ajuda no admin" }).success).toBe(true);
    expect(patchRoleBodySchema.safeParse({ role: "dono", reason: "ajuda no admin" }).success).toBe(false);
  });

  it("toda mensagem de erro é em português e não diz se um e-mail tem conta", () => {
    for (const message of Object.values(ACCOUNT_ERROR_MESSAGES)) {
      expect(message).not.toMatch(/não existe|not found|unknown/i);
    }
  });
});
