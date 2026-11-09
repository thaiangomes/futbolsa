import { ContactLink, LegalList, LegalSection } from "./legal-page";

/**
 * Texto completo da política de privacidade, aprovado pelo Thaian em 2026-11-08 (vault,
 * Produto/Termos e privacidade). O parágrafo do Google só aparece com o login pelo Google
 * ligado, como o botão (`googleLoginEnabled`).
 */
export function PrivacyText({ google }: { google: boolean }) {
  return (
    <>
      <p className="m0">
        O FutBolsa guarda o mínimo de dados para o jogo funcionar. Quanto menos dado, menos risco. Esta política explica
        o que guardamos, para quê, quem vê e como você exerce os seus direitos pela Lei Geral de Proteção de Dados
        (LGPD, Lei 13.709/2018).
      </p>

      <LegalSection n={1} title="Quem cuida dos seus dados">
        <p className="m0">
          O responsável pelos dados (controlador) é Thaian Gomes, pessoa física, que organiza o FutBolsa. Contato para
          qualquer assunto de privacidade: <ContactLink />.
        </p>
      </LegalSection>

      <LegalSection n={2} title="O que guardamos">
        <LegalList>
          <li>
            <strong>E-mail:</strong> para você entrar, para conferir o convite e para mandar os e-mails do login
            (confirmação do e-mail e nova senha) e avisos importantes do jogo.
          </li>
          <li>
            <strong>Senha:</strong> fica com o serviço de login (Supabase), guardada de forma cifrada. Nós não vemos a
            sua senha.
          </li>
          <li><strong>Apelido:</strong> o seu nome no jogo.</li>
          <li><strong>Data e hora em que você aceitou</strong> estes termos e esta política.</li>
          <li>
            <strong>O que você faz no jogo:</strong> ofertas no IPO, ordens, negócios, o extrato da carteira (caixa,
            ações, dividendos, ajustes), as posições nos rankings, o histórico de cada temporada e, se houver, avisos e
            advertências.
          </li>
          <li>
            <strong>Dados técnicos do acesso:</strong> o serviço de login registra dados como o endereço IP, o navegador
            e o horário de cada entrada, para a segurança da conta. O servidor do jogo usa o endereço IP só por alguns
            instantes, para limitar abusos, sem gravá-lo.
          </li>
          <li>
            <strong>No seu navegador:</strong> a sessão de login fica guardada no armazenamento do navegador para você
            continuar logado. Não usamos cookies de publicidade nem ferramentas de análise ou rastreamento.
          </li>
        </LegalList>
        <p className="m0">
          <strong>Não guardamos</strong> nome, foto, idade ou data de nascimento, CPF, telefone, endereço nem dados de
          pagamento. O jogo nunca pede nada disso.
        </p>
        {google && (
          <p className="m0" data-testid="google-paragraph">
            Ao entrar com o Google, o jogo usa só o seu e-mail. O Google pode mandar também o seu nome e a sua foto; o
            serviço de login os guarda junto da identidade, mas o jogo não os copia, não os usa e não os mostra.
          </p>
        )}
      </LegalSection>

      <LegalSection n={3} title="Para que usamos">
        <LegalList>
          <li>
            Para rodar o jogo que você aceitou jogar: criar e manter a sua conta, executar as suas ordens, pagar
            dividendos, montar os rankings e o histórico (LGPD, art. 7º, V).
          </li>
          <li>
            Para a segurança e a justiça do jogo: impedir acessos indevidos, abusos e trapaças entre contas (legítimo
            interesse, art. 7º, IX).
          </li>
          <li>Para cumprir a lei, quando ela exigir (art. 7º, II).</li>
        </LegalList>
        <p className="m0">Não vendemos os seus dados, não fazemos publicidade e não montamos perfis para marketing.</p>
      </LegalSection>

      <LegalSection n={4} title="Quem vê o quê">
        <LegalList>
          <li>
            <strong>Outros jogadores:</strong> veem só o seu apelido; nos rankings, a sua posição e o seu retorno; no
            seu perfil, uma vez por mês, a divisão da sua carteira em porcentagens (sem quantidades nem valores). Nunca
            veem o seu e-mail, as suas ordens nem os seus negócios. O livro de ofertas não mostra apelidos.
          </li>
          <li>
            <strong>Admin:</strong> o organizador e quem ele indicar. Vê o seu e-mail, a carteira, o caixa, as ordens,
            as ofertas, o extrato e os negócios (com as duas pontas), e pode buscar uma conta pelo e-mail exato, para
            cuidar do jogo e atender pedidos como o de exclusão.
          </li>
          <li>
            <strong>Operadores</strong>, que tratam dados só para nós e só para isso:
            <LegalList>
              <li>
                <strong>Supabase:</strong> serviço de login e banco de dados do jogo. Guarda o e-mail, a senha cifrada e
                os dados do jogo.
              </li>
              <li><strong>Google (Gmail):</strong> envia os e-mails de confirmação e de nova senha.</li>
              <li>
                <strong>Vercel:</strong> publica o site. Recebe os dados técnicos da visita, como o endereço IP e o
                navegador.
              </li>
              <li>
                <strong>Computador do organizador</strong>, onde roda hoje o servidor do jogo. Quando ele for para
                outro lugar (o plano é o Azure, da Microsoft), esta política ganha uma versão nova.
              </li>
            </LegalList>
          </li>
          <li>Fora disso, só compartilhamos dados se a lei ou uma ordem judicial exigir.</li>
        </LegalList>
      </LegalSection>

      <LegalSection n={5} title="Onde ficam os dados">
        <p className="m0">Os dados do jogo e do login ficam no Supabase, em São Paulo, no Brasil.</p>
      </LegalSection>

      <LegalSection n={6} title="Por quanto tempo">
        <LegalList>
          <li>
            Enquanto a conta existir, guardamos os dados do item 2. O histórico das temporadas fica na conta enquanto
            ela existir.
          </li>
          <li>
            <strong>Se você excluir a conta</strong> (ou o admin excluir), na hora: o e-mail e o apelido são apagados, a
            sua identidade de login é apagada do Supabase e o seu e-mail sai da lista de convites. Os negócios, o
            extrato, os rankings já fechados e o histórico continuam no banco, mas sem e-mail nem apelido, ligados só a
            um código interno, e aparecem como &quot;conta excluída&quot;. Eles ficam porque cada negócio tem outro
            jogador do outro lado e porque apagar mudaria a posição dos outros nos rankings.
          </li>
          <li>
            <strong>Registro do admin:</strong> as ações do admin com convites guardam o e-mail embaralhado (um código
            que não deixa recuperar o e-mail, só conferir se um e-mail conhecido bate).
          </li>
          <li>
            <strong>Convite não usado:</strong> se o seu e-mail foi liberado e você nunca criou conta, ele fica na lista
            de convites até o admin retirar. Você pode pedir a retirada pelo contato.
          </li>
        </LegalList>
      </LegalSection>

      <LegalSection n={7} title="Os seus direitos">
        <p className="m0">
          Pela LGPD (art. 18) você pode pedir: confirmar se tratamos os seus dados e ter acesso a eles; corrigir dados
          errados; apagar ou anonimizar dados desnecessários; levar os seus dados para outro serviço (portabilidade);
          saber com quem compartilhamos; e reclamar na Autoridade Nacional de Proteção de Dados (ANPD).
        </p>
        <p className="m0">Como pedir:</p>
        <LegalList>
          <li>
            <strong>Na tela da conta:</strong> você vê o seu e-mail, o apelido e a data do aceite, troca o apelido e a
            senha e exclui a conta quando quiser.
          </li>
          <li>
            <strong>Pelo contato</strong> <ContactLink />: para os outros pedidos (uma cópia dos seus dados, trocar o
            e-mail da conta) ou para excluir a conta se não conseguir entrar. Para proteger você, respondemos só ao
            e-mail da própria conta. Respondemos em até 15 dias.
          </li>
          <li>Se você tem menos de 18 anos, o seu pai, mãe ou responsável também pode fazer esses pedidos pelo contato.</li>
        </LegalList>
      </LegalSection>

      <LegalSection n={8} title="Segurança">
        <p className="m0">
          A senha fica cifrada no serviço de login, as tabelas do jogo ficam fora do acesso público do Supabase (só o
          servidor do jogo e o organizador chegam a elas), o e-mail de um jogador nunca aparece para outro e toda ação
          do admin fica registrada. Nenhum sistema é totalmente seguro: se acontecer um incidente que possa trazer risco
          a você, avisamos você e a ANPD, como manda a lei.
        </p>
      </LegalSection>

      <LegalSection n={9} title="Mudanças nesta política">
        <p className="m0">
          Podemos mudar esta política. A data da versão fica no topo da página. Se a mudança for importante, avisamos
          antes no jogo ou pelo e-mail da conta e pedimos que você aceite de novo.
        </p>
      </LegalSection>

      <LegalSection n={10} title="Contato">
        <p className="m0"><ContactLink /></p>
      </LegalSection>
    </>
  );
}
