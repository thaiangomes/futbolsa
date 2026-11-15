import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";

/** A marca que só o login falso contém (`fake-auth-client.ts`). */
const MARCA = "FUTBOLSA_E2E_LOGIN_FALSO";
const SITE = resolve(import.meta.dirname, "..");

function arquivos(pasta: string): string[] {
  return readdirSync(pasta).flatMap((nome) => {
    const caminho = join(pasta, nome);
    return statSync(caminho).isDirectory() ? arquivos(caminho) : [caminho];
  });
}

function contem(pasta: string): string[] {
  return arquivos(pasta).filter((a) => /\.(js|html|txt|json|map)$/.test(a) && readFileSync(a, "utf8").includes(MARCA));
}

test.describe("guarda do build (T19)", () => {
  test("e2e guarda: o site de teste tem o login falso e o build normal (out/) não tem", async () => {
    test.setTimeout(300_000);
    const teste = join(SITE, "out-e2e");
    expect(existsSync(teste), "rode npm run e2e:build antes").toBe(true);
    expect(contem(teste).length).toBeGreaterThan(0);
    const normal = join(SITE, "out");
    // o build normal é o que vai ao ar: sem ele pronto (CI já o constrói antes), a guarda o constrói aqui
    if (!existsSync(normal)) {
      execFileSync(process.execPath, ["../../node_modules/next/dist/bin/next", "build"], { cwd: SITE, stdio: "ignore", env: { ...process.env, NEXT_PUBLIC_AUTH_CLIENT: "" } });
    }
    expect(contem(normal), "o login falso apareceu no build normal").toEqual([]);
  });
});
