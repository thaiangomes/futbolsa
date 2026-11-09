import { ContactLink, LegalList, LegalSection } from "./legal-page";

/** Texto completo dos termos de uso, aprovado pelo Thaian em 2026-11-08 (vault, Produto/Termos e privacidade). */
export function TermsText() {
  return (
    <>
      <LegalSection n={1} title="O que é o FutBolsa">
        <p className="m0">
          O FutBolsa é um jogo on-line e gratuito em que cada clube brasileiro de futebol é uma ação, com um código
          (ticker) como FLA3 ou PAL3. A cada temporada você recebe R$ 100.000,00 fictícios, participa das ofertas
          iniciais (IPO), compra e vende ações, recebe dividendos fictícios pelos resultados reais dos clubes e disputa
          rankings mensais e anuais. O objetivo é divertir e ensinar como funciona uma bolsa de valores. O jogo é
          organizado por Thaian Gomes (&quot;nós&quot;). Ao criar a conta, você aceita estes termos e a{" "}
          <a href="/privacidade">Política de privacidade</a>.
        </p>
      </LegalSection>

      <LegalSection n={2} title="O dinheiro é fictício">
        <LegalList>
          <li>Todo o dinheiro, as ações, os dividendos e a recompra do jogo são fictícios e não valem nada fora dele.</li>
          <li>
            Não dá para comprar moeda do jogo, depositar, sacar nem trocar nada do jogo por dinheiro, bens ou prêmios.
            Os rankings não dão prêmio em dinheiro.
          </li>
          <li>
            O FutBolsa não é aposta nem investimento, e nada nele é recomendação de investimento. A bolsa de verdade
            funciona com outras regras.
          </li>
          <li>É proibido vender ou comprar contas, apelidos ou moeda do jogo por dinheiro de verdade, fora do jogo.</li>
        </LegalList>
      </LegalSection>

      <LegalSection n={3} title="Sem relação com clubes, CBF ou B3">
        <p className="m0">
          O FutBolsa não tem relação com nenhum clube, com a CBF, com federações nem com a B3, e não é patrocinado nem
          aprovado por eles. Os clubes aparecem só pelo nome em texto, pelo ticker e por um selo próprio, nunca pelo
          escudo. Nomes e marcas pertencem aos seus donos. Os resultados das partidas vêm de fontes públicas e podem
          ter atraso ou erro; o admin corrige quando preciso.
        </p>
      </LegalSection>

      <LegalSection n={4} title="Quem pode jogar">
        <LegalList>
          <li>O jogo é só com convite: só cria conta quem tem o e-mail liberado pelo admin.</li>
          <li>Uma conta por e-mail. Antes de jogar, você confirma o e-mail pelo link que mandamos.</li>
          <li>Não pedimos idade. Se você tem menos de 18 anos, jogue com o conhecimento do seu pai, mãe ou responsável.</li>
        </LegalList>
      </LegalSection>

      <LegalSection n={5} title="Sua conta">
        <LegalList>
          <li>
            <strong>Apelido:</strong> é o único nome que os outros jogadores veem. Tem de 3 a 20 caracteres, só letras
            sem acento, números e <code>_</code>, e é único no jogo. Alguns apelidos são reservados (como{" "}
            <code>casa</code>, <code>admin</code> e <code>bot</code>). Você pode trocar quando quiser, se o novo estiver
            livre, e os rankings, inclusive os antigos, passam a mostrar o novo. Não use apelido ofensivo nem que se
            passe por outra pessoa.
          </li>
          <li>
            <strong>Senha:</strong> tem no mínimo 8 caracteres. Não a compartilhe. Se esquecer, peça um link para criar
            outra. Você pode trocar a senha e sair da conta em todos os aparelhos na tela da conta.
          </li>
          <li>Você responde pelo que for feito com a sua conta.</li>
        </LegalList>
      </LegalSection>

      <LegalSection n={6} title="Regras de conduta">
        <p className="m0">É proibido:</p>
        <LegalList>
          <li>combinar negócios entre contas para passar dinheiro de uma para outra ou mexer no preço de um clube;</li>
          <li>usar programas para mandar ordens ou ofertas automaticamente (os robôs do jogo são só da casa);</li>
          <li>tentar invadir, sobrecarregar ou explorar falhas do jogo. Se achar uma falha, avise pelo contato.</li>
        </LegalList>
        <p className="m0">
          Quando o admin confirma uma trapaça entre contas, os negócios envolvidos são anulados e as duas contas recebem
          um aviso e uma advertência, que vale até o fim da temporada. Se acontecer de novo, a conta pode ser banida
          (bloqueada).
        </p>
      </LegalSection>

      <LegalSection n={7} title="Como o jogo é conduzido">
        <LegalList>
          <li>
            O <strong>admin</strong> cuida do jogo: libera e-mails, registra e corrige os resultados das partidas,
            aprova os pagamentos de dividendos, pode suspender a negociação, corrigir erros (com estorno ou ajuste de
            saldo) e recalcular rankings. Toda ação do admin fica registrada, com o motivo.
          </li>
          <li>
            O jogo tem contas automáticas da casa (<strong>bots</strong>), marcadas como bot, e um{" "}
            <strong>formador de mercado</strong> da casa, que compra e vende para o mercado ter sempre com quem negociar.
          </li>
          <li>
            <strong>Temporada:</strong> cada ano é uma temporada. No fim, a casa recompra todas as ações, a temporada é
            encerrada, seu resultado vai para o histórico e o caixa vai a zero. Os R$ 100.000,00 voltam na abertura do
            IPO da temporada seguinte. Apelido e histórico passam de uma temporada para outra; caixa, ações e ordens não
            passam.
          </li>
        </LegalList>
      </LegalSection>

      <LegalSection n={8} title="Bloqueio pelo admin">
        <p className="m0">
          O admin pode bloquear uma conta que descumpra estes termos, com o motivo registrado. A conta bloqueada tem as
          ordens e ofertas abertas canceladas, não negocia nem faz ofertas e sai dos rankings enquanto estiver
          bloqueada. Ela continua dona das ações, recebe os dividendos e pode ver a carteira. O admin pode desbloquear.
          O admin também pode excluir uma conta, com os mesmos efeitos da exclusão feita pelo próprio jogador (item 9).
        </p>
      </LegalSection>

      <LegalSection n={9} title="Excluir a conta">
        <p className="m0">
          Você pode excluir a sua conta quando quiser, na tela da conta. Para confirmar que é você, o jogo pede que
          tenha entrado nos últimos 15 minutos e que digite o seu apelido. A exclusão não tem volta: as ordens e ofertas
          abertas são canceladas, as suas ações vão para a tesouraria da casa, o caixa some e o seu e-mail e o seu
          apelido são apagados. O apelido fica livre para outro jogador. Você sai dos rankings da temporada atual; nos
          rankings já fechados, a sua linha continua com o nome &quot;conta excluída&quot;, para não mudar a posição dos
          outros. Para voltar a jogar, o admin precisa liberar o e-mail de novo. Se não conseguir entrar, peça a
          exclusão pelo contato (<ContactLink />).
        </p>
      </LegalSection>

      <LegalSection n={10} title="Disponibilidade">
        <p className="m0">
          O FutBolsa é gratuito e feito para um grupo de amigos. Ele pode ficar fora do ar, ter erros, mudar regras ou
          deixar de existir. Como tudo no jogo é fictício, nada do que acontece dentro dele dá direito a dinheiro ou a
          compensação.
        </p>
      </LegalSection>

      <LegalSection n={11} title="Mudanças nestes termos">
        <p className="m0">
          Podemos mudar estes termos. A data da versão fica no topo da página. Se a mudança for importante, avisamos
          antes no jogo ou pelo e-mail da conta e pedimos que você aceite de novo para continuar jogando.
        </p>
      </LegalSection>

      <LegalSection n={12} title="Lei e contato">
        <p className="m0">
          Estes termos seguem as leis do Brasil. Dúvidas, pedidos e avisos: <ContactLink />.
        </p>
      </LegalSection>
    </>
  );
}
