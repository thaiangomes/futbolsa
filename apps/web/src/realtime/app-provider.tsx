"use client";

import { createElement, type ReactNode } from "react";
import { getAuthClient } from "../lib/auth";
import { RealtimeProvider } from "./react";

/**
 * O tempo real do site com o login da F5: o token vem do `AuthClient`, e entrar ou sair reabre a
 * conexão. É um componente de cliente à parte porque o `layout.tsx` (servidor) não pode passar
 * o objeto de login como propriedade.
 */
export function AppRealtimeProvider({ children }: { children: ReactNode }) {
  return createElement(RealtimeProvider, { auth: getAuthClient(), children });
}
