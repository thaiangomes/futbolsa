"use client";

import { useRouter } from "next/navigation";
import { Footer, SimpleHeader } from "../../features/accounts/ui/brand";
import { AccountSettings } from "../../features/accounts/account-settings";
import { RequireAccount, useSession } from "../../features/accounts/session-provider";
import { useSiteUrl } from "../../features/accounts/navigation";

function Conta() {
  const { state, auth, api, reload } = useSession();
  const router = useRouter();
  const returnUrl = useSiteUrl("/conta");
  if (state.status !== "ready") return null;
  return (
    <AccountSettings me={state.me} auth={auth} api={api} returnUrl={returnUrl} onChanged={reload}
      onSignedOut={() => router.replace("/entrar")} />
  );
}

/** Perfil e conta (prancha 6c). */
export default function ContaPage() {
  const { state } = useSession();
  const nickname = state.status === "ready" ? state.me.nickname : "";
  return (
    <div className="fb" style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <SimpleHeader
        right={
          <div className="row" style={{ gap: 12 }}>
            <span className="chip chip-live hide-sm">Jogo · dinheiro fictício</span>
            {nickname && (
              <span className="row-s">
                <span className="av" aria-hidden="true">{nickname[0]?.toUpperCase()}</span>
                <span className="b small hide-sm">{nickname}</span>
              </span>
            )}
          </div>
        }
      />
      <main className="wrap stack" style={{ flex: 1, width: "100%" }}>
        <RequireAccount>
          <Conta />
        </RequireAccount>
      </main>
      <Footer />
    </div>
  );
}
