import { LegalPage, SummaryItems } from "../../features/accounts/ui/legal-page";

export const metadata = { title: "Política de privacidade · FutBolsa" };

export default function PrivacidadePage() {
  return (
    <LegalPage title="Política de privacidade">
      <p className="m0">O FutBolsa guarda o mínimo para o jogo funcionar. Em resumo:</p>
      <SummaryItems />
    </LegalPage>
  );
}
