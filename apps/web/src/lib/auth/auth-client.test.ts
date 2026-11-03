import { describe, expect, it } from "vitest";
import { AUTH_ERROR_MESSAGES, authenticatedAtFromToken, isPasswordLongEnough, needsReauth } from "./auth-client";
import { toAuthError } from "./supabase-auth-client";

const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const token = (payload: unknown) => `${b64url({ alg: "ES256" })}.${b64url(payload)}.assinatura`;

describe("adaptador de login do site", () => {
  it("conta 6: senha errada e e-mail sem conta viram a mesma mensagem", () => {
    const wrongPassword = toAuthError({ code: "invalid_credentials", status: 400 });
    const unknownEmail = toAuthError({ code: "user_not_found", status: 400 });
    const noCode = toAuthError({ code: undefined, status: 400 });
    expect(wrongPassword!.message).toBe(AUTH_ERROR_MESSAGES.invalid_credentials);
    expect(unknownEmail!.message).toBe(wrongPassword!.message);
    expect(noCode!.message).toBe(wrongPassword!.message);
    expect(wrongPassword!.message).not.toMatch(/existe|cadastr|conta/i);
  });

  it("limite de tentativas e login fora do ar têm mensagens próprias", () => {
    expect(toAuthError({ code: "over_request_rate_limit", status: 429 })!.code).toBe("rate_limited");
    expect(toAuthError({ code: undefined, status: 500 })!.code).toBe("unavailable");
    expect(toAuthError(null)).toBeNull();
  });

  it("conta 4: senha de 7 caracteres é curta; 8 passa", () => {
    expect(isPasswordLongEnough("1234567")).toBe(false);
    expect(isPasswordLongEnough("12345678")).toBe(true);
  });

  it("o último login sai do amr do token (o maior horário); sem amr, a emissão", () => {
    expect(authenticatedAtFromToken(token({ amr: [{ method: "password", timestamp: 100 }, { method: "otp", timestamp: 200 }] }))).toEqual(new Date(200_000));
    expect(authenticatedAtFromToken(token({ iat: 50 }))).toEqual(new Date(50_000));
    expect(authenticatedAtFromToken("lixo")).toBeNull();
  });

  it("conta 26: login há mais de 15 minutos pede para entrar de novo", () => {
    const now = new Date("2027-05-20T15:00:00Z");
    expect(needsReauth(new Date(now.getTime() - 16 * 60_000), now)).toBe(true);
    expect(needsReauth(new Date(now.getTime() - 14 * 60_000), now)).toBe(false);
    expect(needsReauth(null, now)).toBe(true);
  });
});
