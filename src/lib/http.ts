// Rede: segue redirects, UA de browser (sites da UFSC variam por UA), timeout
// generoso e retry com backoff — os runners do GitHub ficam nos EUA.

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const TIMEOUT_MS = 90_000;
const TENTATIVAS = 3;

export async function baixarTexto(url: string): Promise<string> {
  let ultimoErro: unknown;
  for (let tentativa = 1; tentativa <= TENTATIVAS; tentativa++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'pt-BR,pt;q=0.9', Accept: 'text/calendar,*/*' },
        redirect: 'follow',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok) return await res.text();
      if (res.status < 500 && res.status !== 429) throw new Error(`GET ${url} -> HTTP ${res.status}`);
      ultimoErro = new Error(`GET ${url} -> HTTP ${res.status}`);
    } catch (e) {
      if (e instanceof Error && /-> HTTP 4/.test(e.message)) throw e;
      ultimoErro = e;
    }
    if (tentativa < TENTATIVAS) {
      console.error(`⚠ Tentativa ${tentativa}/${TENTATIVAS} falhou para ${url}; aguardando…`);
      await new Promise((r) => setTimeout(r, 5_000 * tentativa));
    }
  }
  throw ultimoErro instanceof Error ? ultimoErro : new Error(String(ultimoErro));
}
