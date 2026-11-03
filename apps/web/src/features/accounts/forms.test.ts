import { describe, expect, it } from "vitest";
import { formatBrasilia, formatDate, nicknameFeedback, passwordFeedback } from "./forms";

describe("regras dos formulários de conta", () => {
  it("conta 9: ab, um_apelido_com_mais_de_20 e joão mostram o erro; joao_10 passa", () => {
    expect(nicknameFeedback("ab")).toEqual({ ok: false, message: "Use pelo menos 3 caracteres." });
    expect(nicknameFeedback("um_apelido_com_mais_de_20").ok).toBe(false);
    expect(nicknameFeedback("joão").message).toMatch(/sem acento/);
    expect(nicknameFeedback("joao_10").ok).toBe(true);
  });

  it("conta 25: reservados mostram o erro na hora", () => {
    for (const n of ["Casa", "ADMIN", "conta_excluida"]) expect(nicknameFeedback(n)).toEqual({ ok: false, message: "Este apelido é reservado. Escolha outro." });
    expect(nicknameFeedback("casa_10").ok).toBe(true);
  });

  it("conta 4: 7 caracteres recusa, 8 passa; as duas senhas precisam ser iguais", () => {
    expect(passwordFeedback("1234567").ok).toBe(false);
    expect(passwordFeedback("1234567").password.message).toBe("Use pelo menos 8 caracteres.");
    expect(passwordFeedback("12345678").ok).toBe(true);
    expect(passwordFeedback("12345678", "12345679")).toMatchObject({ ok: false, repeat: { ok: false } });
    expect(passwordFeedback("12345678", "12345678").ok).toBe(true);
    expect(passwordFeedback("", "").password.ok).toBe(false);
  });

  it("datas no fuso de Brasília", () => {
    expect(formatBrasilia("2027-03-28T19:00:00.000Z")).toBe("dom. 28/03, 16h00");
    expect(formatDate("2027-03-20T12:00:00.000Z")).toBe("20/03/2027");
  });
});
