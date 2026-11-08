import { LegalPage } from "../../features/accounts/ui/legal-page";
import { TermsText } from "../../features/accounts/ui/terms-text";

export const metadata = { title: "Termos de uso · FutBolsa" };

export default function TermosPage() {
  return (
    <LegalPage title="Termos de uso">
      <TermsText />
    </LegalPage>
  );
}
