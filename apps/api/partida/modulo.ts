import { Body, Controller, Get, HttpCode, Inject, Module, Post } from "@nestjs/common";
import { z } from "zod";
import { AdminOnly, Public } from "../src/infra/auth-adapter/index.js";
import { DomainError } from "../src/infra/http/errors.js";
import { ZodValidationPipe } from "../src/infra/http/index.js";
import type { Pedido, RelogioDaPartida, RespostaDoRelogio, EstadoDoRelogio } from "./relogio.js";

/**
 * O módulo da partida (F17, T6): a rota do relógio do admin. Só existe na montagem da partida (`apps/api/partida/`, passado a
 * `createTestApp` como `imports`); a API do jogo público não o tem, `src/` nunca importa esta pasta e nenhuma variável de
 * ambiente o liga (critério 13).
 */

/** Onde o relógio fica depois que o app sobe (o relógio precisa do app, e o app, da rota). */
export class PorRelogio {
  atual: RelogioDaPartida | undefined;
}

export const pedidoDoRelogioSchema = z.discriminatedUnion("acao", [
  z.object({ acao: z.literal("dia") }).strict(),
  z.object({ acao: z.literal("rodada") }).strict(),
  z.object({ acao: z.literal("ate"), data: z.string() }).strict(),
  z.object({ acao: z.literal("atualizar") }).strict(),
  z.object({ acao: z.literal("pausar") }).strict(),
  z.object({ acao: z.literal("tempo-real") }).strict(),
]);

@AdminOnly()
@Controller("admin/partida")
export class PartidaController {
  constructor(@Inject(PorRelogio) private readonly por: PorRelogio) {}

  private relogio(): RelogioDaPartida {
    if (!this.por.atual) throw new DomainError("partida_nao_pronta", 503, "a partida ainda está subindo");
    return this.por.atual;
  }

  /** A tela do admin pergunta aqui se a API está em modo partida (em qualquer outra API a rota não existe: 404). */
  @Get()
  estado(): { partida: true; relogio: EstadoDoRelogio } {
    return { partida: true, relogio: this.relogio().estado() };
  }

  @HttpCode(200)
  @Post("relogio")
  relogioPedir(@Body(new ZodValidationPipe(pedidoDoRelogioSchema)) pedido: Pedido): Promise<RespostaDoRelogio> {
    return this.relogio().pedir(pedido);
  }
}

/**
 * O site da Vercel não passa pelo servidor da partida, que na etapa 1 põe o relógio do jogo nas páginas: ele pergunta aqui a hora
 * do jogo. Sem login (o site precisa dela antes de qualquer entrada); só o instante e se o relógio anda.
 */
@Controller("partida")
export class HoraDaPartidaController {
  constructor(@Inject(PorRelogio) private readonly por: PorRelogio) {}

  @Public()
  @Get("hora")
  hora(): { sim: number; run: boolean } {
    if (!this.por.atual) throw new DomainError("partida_nao_pronta", 503, "a partida ainda está subindo");
    const e = this.por.atual.estado();
    return { sim: Date.parse(e.instante), run: e.modo === "tempo-real" };
  }
}

@Module({
  controllers: [PartidaController, HoraDaPartidaController],
  providers: [PorRelogio],
  exports: [PorRelogio],
})
export class ModuloDaPartida {}
