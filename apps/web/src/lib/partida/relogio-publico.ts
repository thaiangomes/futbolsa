/**
 * Partida de teste aberta a convidados (F17, T9): o site fica na Vercel e não passa pelo servidor da partida, que na etapa 1 põe
 * o relógio do jogo nas páginas. O site decide pelo `Date.now()` se o IPO aceita ofertas e se o mercado está aberto, e o jogo está
 * em outro dia que o do navegador. Este script (só quando o build tem `NEXT_PUBLIC_PARTIDA=1`) pergunta à API a hora do jogo
 * (`GET /partida/hora`, sem login) e troca `Date` por ela: parada quando o relógio está pausado, andando junto em tempo real,
 * atualizada a cada 20 segundos (o plano grátis do túnel limita as requisições por mês: README da partida). Se a API não responder, o `Date` fica como está.
 */
export function scriptDoRelogioPublico(apiUrl: string): string {
  const url = JSON.stringify(`${apiUrl.replace(/\/+$/, "")}/partida/hora`);
  return (
    "(function(){var R=Date,N=R.now.bind(R),U=" +
    url +
    ",e;" +
    "try{var x=new XMLHttpRequest();x.open('GET',U,false);x.send();if(x.status!==200)return;var j=JSON.parse(x.responseText);e={sim:j.sim,run:j.run,real:N()}}catch(_){return}" +
    "function a(){return e.run?e.sim+(N()-e.real):e.sim}" +
    "function F(){if(!(this instanceof F))return new R(a()).toString();if(arguments.length===0)return new R(a());return new (Function.prototype.bind.apply(R,[null].concat([].slice.call(arguments))))()}" +
    "F.prototype=R.prototype;F.now=a;F.parse=R.parse;F.UTC=R.UTC;window.Date=F;" +
    "function u(){fetch(U,{cache:'no-store'}).then(function(r){return r.json()}).then(function(j){e={sim:j.sim,run:j.run,real:N()}}).catch(function(){})}" +
    "setInterval(u,20000);document.addEventListener('visibilitychange',function(){if(!document.hidden)u()})})()"
  );
}
