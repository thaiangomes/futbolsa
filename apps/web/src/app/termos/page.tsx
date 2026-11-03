import { LegalPage, SummaryItems } from "../../features/accounts/ui/legal-page";

export const metadata = { title: "Termos de uso · FutBolsa" };

export default function TermosPage() {
  return (
    <LegalPage title="Termos de uso">
      <p className="m0">O FutBolsa é um jogo da bolsa dos clubes brasileiros, jogado só com convite. Ao criar a conta, você aceita:</p>
      <SummaryItems />
    </LegalPage>
  );
}
