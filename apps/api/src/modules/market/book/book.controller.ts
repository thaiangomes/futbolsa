import { Controller, Get, Param } from "@nestjs/common";
import { type BookView, type ClubList, clubTickerParamSchema } from "@futbolsa/contracts";
import { CurrentAuth, Public, type RequestAuth } from "../../../infra/auth-adapter/index.js";
import { ZodValidationPipe } from "../../../infra/http/index.js";
import { BookReadService } from "./book-read.service.js";

const tickerPipe = new ZodValidationPipe(clubTickerParamSchema);

/**
 * `GET /clubs` e `GET /clubs/:ticker/book` (T8 e L8): o livro, os negócios, o preço e o estado dos clubes. Públicas;
 * com um token válido, o livro traz também a faixa de 20% e o saldo livre de quem pediu.
 */
@Controller("clubs")
export class BookController {
  constructor(private readonly reads: BookReadService) {}

  @Public()
  @Get()
  list(): Promise<ClubList> {
    return this.reads.list();
  }

  @Public()
  @Get(":ticker/book")
  book(@Param("ticker", tickerPipe) ticker: string, @CurrentAuth() auth: RequestAuth | undefined): Promise<BookView> {
    return this.reads.book(ticker, auth?.user?.id ?? null);
  }
}
