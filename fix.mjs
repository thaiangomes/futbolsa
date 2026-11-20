import fs from "node:fs";
let s = fs.readFileSync("scratch.mjs", "utf8");
const a = "N e B1 dão quase o mesmo porque a tabela é a mesma; a diferença do preço final ÷ IPO (1,15 contra 1,08) vem de a faixa de N ser calculada pela tabela com o bônus em \`qualification\` e o clube que fica nas duas vagas contar só uma vez.";
if (!s.includes(a)) throw new Error("x");
s = s.replace(a, "N e B1 dão quase o mesmo em tudo, pois a tabela é a mesma; só o preço final ÷ IPO difere (1,15 contra 1,08) e **não isolei a causa** (B1 traz o bônus dentro da colocação, N em \`qualification\`; as faixas do IPO saem iguais, então fica como pendência de investigar, provavelmente a ordem em que os bots agem).");
fs.writeFileSync("scratch.mjs", s);
