/** @type {import('next').NextConfig} */
// O login falso só entra no build de teste (`npm run e2e:build`, pasta out-e2e): o valor "fake" fora dela é ignorado, para uma
// variável esquecida na hospedagem nunca pôr o adaptador falso no site que vai ao ar.
const nextConfig = {
  // Site estático: o Next gera arquivos prontos em out/ e recusa recurso de servidor.
  output: "export",
  // O build de teste do navegador (`npm run e2e:build`) sai em outra pasta, para não pisar no build normal.
  // Valor fixo no build: sem ele o Next deixa a variável para a hora de rodar e o login falso não sai do pacote.
  env: { NEXT_PUBLIC_AUTH_CLIENT: process.env.NEXT_PUBLIC_AUTH_CLIENT === "fake" && process.env.NEXT_DIST_DIR === "out-e2e" ? "fake" : "real" },
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
};

export default nextConfig;
