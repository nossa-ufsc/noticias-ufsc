// Rede: segue redirects, UA de browser (sites da UFSC variam por UA), timeout
// generoso e retry com backoff exponencial + jitter — os runners do GitHub ficam nos EUA.
//
// Desde 2026-09-28 o export iCal da Agecom ora não conecta (timeout de ~2 min do SO),
// ora leva RST na hora (filtro na frente do nginx da UFSC). Por isso há um prazo TOTAL
// por URL: sem ele, 4 tentativas de connect-timeout seguravam o job por ~10 min.

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export type OpcoesHttp = {
  tentativas?: number;
  /** Timeout de cada tentativa (conexão + corpo). */
  timeoutMs?: number;
  /** Espera antes da 2ª tentativa; depois multiplica por 3 (±50% de jitter). */
  esperaBaseMs?: number;
  /** Teto de tempo somando todas as tentativas e esperas. */
  prazoTotalMs?: number;
  accept?: string;
};

// O export da Agecom (~8 MB, gerado na hora) já passou de 90 s a partir dos runners.
const PADRAO: Required<OpcoesHttp> = {
  tentativas: 4,
  timeoutMs: 240_000,
  esperaBaseMs: 5_000,
  prazoTotalMs: 6 * 60_000,
  accept: 'text/calendar,*/*',
};

/** 4xx (exceto 429): o servidor respondeu e recusou — repetir não adianta (ex.: 403 a IPs de datacenter). */
export class ErroHttpDefinitivo extends Error {
  constructor(
    readonly url: string,
    readonly status: number
  ) {
    super(`GET ${url} -> HTTP ${status}${status === 403 ? ' (bloqueado pelo servidor)' : ''}`);
  }
}

/** "ECONNRESET: The socket connection…" — o Bun às vezes põe o código na mensagem, às vezes não. */
export function descreverErro(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  if (e.name === 'TimeoutError') return 'timeout';
  const code = (e as Error & { code?: string }).code;
  const texto = e.message.replace(/\. For more information, pass `verbose: true`.*$/, '');
  return code && !texto.startsWith(code) ? `${code}: ${texto}` : texto;
}

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function baixarTexto(url: string, opcoes: OpcoesHttp = {}): Promise<string> {
  const o = { ...PADRAO, ...opcoes };
  const inicio = Date.now();
  let ultimoErro: Error = new Error(`GET ${url}: nenhuma tentativa`);
  for (let tentativa = 1; tentativa <= o.tentativas; tentativa++) {
    const restante = o.prazoTotalMs - (Date.now() - inicio);
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'pt-BR,pt;q=0.9', Accept: o.accept },
        redirect: 'follow',
        signal: AbortSignal.timeout(Math.max(1, Math.min(o.timeoutMs, restante))),
      });
      if (res.ok) return await res.text();
      if (res.status < 500 && res.status !== 429) throw new ErroHttpDefinitivo(url, res.status);
      ultimoErro = new Error(`GET ${url} -> HTTP ${res.status}`);
    } catch (e) {
      if (e instanceof ErroHttpDefinitivo) throw e;
      ultimoErro = new Error(`GET ${url} falhou: ${descreverErro(e)}`);
    }
    if (tentativa === o.tentativas) break;
    const espera = Math.round(o.esperaBaseMs * 3 ** (tentativa - 1) * (0.5 + Math.random()));
    if (Date.now() - inicio + espera >= o.prazoTotalMs) {
      console.error(`⚠ Prazo de ${Math.round(o.prazoTotalMs / 1000)} s esgotado para ${url}`);
      break;
    }
    console.error(
      `⚠ Tentativa ${tentativa}/${o.tentativas}: ${ultimoErro.message}; nova tentativa em ${Math.round(espera / 1000)} s…`
    );
    await dormir(espera);
  }
  throw ultimoErro;
}
