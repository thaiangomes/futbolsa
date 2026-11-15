"use client";

import { useRouter } from "next/navigation";
import { Footer } from "../../features/accounts/ui/brand";
import { PlayerHeader } from "../../features/accounts/ui/player-nav";
import { AccountSettings } from "../../features/accounts/account-settings";
import { RequireAccount, useSession } from "../../features/accounts/session-provider";
import { useSiteUrl } from "../../features/accounts/navigation";
import { ProfileHistory, ProfileSnapshot } from "../../features/portfolio";

function Conta() {
  const { state, auth, api, reload } = useSession();
  const router = useRouter();
  const returnUrl = useSiteUrl("/conta");
  if (state.status !== "ready") return null;
  return (
    <AccountSettings me={state.me} auth={auth} api={api} returnUrl={returnUrl} onChanged={reload}
      onSignedOut={() => router.replace("/entrar")}
      profileExtra={<><ProfileSnapshot nickname={state.me.nickname} api={api} /><ProfileHistory api={api} /></>} />
  );
}

/** Perfil e conta (prancha 6c). */
export default function ContaPage() {
  return (
    <div className="fb" style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <PlayerHeader active="perfil" />
      <main className="wrap stack" style={{ flex: 1, width: "100%" }}>
        <RequireAccount>
          <Conta />
        </RequireAccount>
      </main>
      <Footer />
    </div>
  );
}
