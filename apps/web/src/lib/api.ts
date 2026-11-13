import { COMMON_ERROR_MESSAGES, errorResponseSchema } from "@futbolsa/contracts";
import type { ZodType } from "zod";
import type { AuthClient } from "./auth";

/** Erro devolvido pela API: o código diz o que a tela faz; a mensagem já vem em português. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields?: string[],
    /** O resto do corpo do erro (por exemplo a `preview` do `correction_stale`), sem validar. */
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiClientOptions {
  baseUrl: string;
  auth: AuthClient;
  fetch?: typeof fetch;
}

export interface ApiRequest {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  /** Cabeçalhos a mais (por exemplo `Idempotency-Key` no envio de ordem). Não substituem o `Authorization`. */
  headers?: Record<string, string>;
}

/**
 * Chama a API com o token no cabeçalho `Authorization: Bearer` (nunca na URL) e confere a resposta
 * pelo esquema do contrato. Um 401 `invalid_token` renova a sessão uma vez e tenta de novo; se
 * falhar de novo, o erro sobe e a porta das páginas manda para `/entrar`.
 */
export class ApiClient {
  private readonly fetchFn: typeof fetch;

  constructor(private readonly options: ApiClientOptions) {
    this.fetchFn = options.fetch ?? ((...args) => fetch(...args));
  }

  async request<T>(schema: ZodType<T>, path: string, req: ApiRequest = {}): Promise<T> {
    let res = await this.send(path, req, await this.options.auth.getAccessToken());
    if (res.status === 401 && (await peekCode(res)) === "invalid_token") {
      const fresh = await this.options.auth.getAccessToken({ forceRefresh: true });
      if (fresh) res = await this.send(path, req, fresh);
    }
    if (!res.ok) throw await toApiError(res);
    if (res.status === 204) return schema.parse(undefined);
    return schema.parse(await res.json());
  }

  /** Um arquivo de texto da API (o relatório de trapaça em HTML), com o login. */
  async requestText(path: string): Promise<string> {
    let res = await this.send(path, {}, await this.options.auth.getAccessToken());
    if (res.status === 401 && (await peekCode(res)) === "invalid_token") {
      const fresh = await this.options.auth.getAccessToken({ forceRefresh: true });
      if (fresh) res = await this.send(path, {}, fresh);
    }
    if (!res.ok) throw await toApiError(res);
    return res.text();
  }

  private send(path: string, req: ApiRequest, token: string | null): Promise<Response> {
    const headers: Record<string, string> = { accept: "application/json", ...req.headers };
    if (token) headers.authorization = `Bearer ${token}`;
    if (req.body !== undefined) headers["content-type"] = "application/json";
    return this.fetchFn(`${this.options.baseUrl.replace(/\/+$/, "")}${path}`, {
      method: req.method ?? "GET",
      headers,
      body: req.body === undefined ? undefined : JSON.stringify(req.body),
    });
  }
}

async function peekCode(res: Response): Promise<string | undefined> {
  try {
    return errorResponseSchema.parse(await res.clone().json()).code;
  } catch {
    return undefined;
  }
}

async function toApiError(res: Response): Promise<ApiError> {
  try {
    const raw = (await res.json()) as Record<string, unknown>;
    const body = errorResponseSchema.parse(raw);
    const { code: _c, message: _m, fields: _f, ...extra } = raw;
    return new ApiError(res.status, body.code, body.message, body.fields, Object.keys(extra).length > 0 ? extra : undefined);
  } catch {
    return new ApiError(res.status, "internal_error", COMMON_ERROR_MESSAGES.internal_error);
  }
}
