import { googleLoginEnabled } from "../../features/accounts/flags";
import { LegalPage } from "../../features/accounts/ui/legal-page";
import { PrivacyText } from "../../features/accounts/ui/privacy-text";

export const metadata = { title: "Política de privacidade · FutBolsa" };

export default function PrivacidadePage() {
  return (
    <LegalPage title="Política de privacidade">
      <PrivacyText google={googleLoginEnabled()} />
    </LegalPage>
  );
}
