import "reflect-metadata";
import { createApp } from "./app.js";

const app = await createApp();
const port = Number(process.env.PORT ?? 3000);
await app.listen(port, "0.0.0.0");
console.log(`API do FutBolsa ouvindo na porta ${port}`);
