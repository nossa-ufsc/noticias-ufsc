// Retry/backoff do baixarTexto contra servidores locais (sem rede externa).

import { afterAll, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:net';
import { baixarTexto, ErroHttpDefinitivo } from '../src/lib/http.js';

const RAPIDO = { esperaBaseMs: 1, timeoutMs: 2_000, prazoTotalMs: 10_000 };

let hits = 0;
let roteiro: number[] = [];
const http = Bun.serve({
  port: 0,
  fetch() {
    hits++;
    const status = roteiro.shift() ?? 200;
    return new Response(status === 200 ? 'BEGIN:VCALENDAR' : 'erro', { status });
  },
});
const URL_HTTP = `http://127.0.0.1:${http.port}/feed`;

// Servidor TCP que derruba a conexão assim que ela abre — o que a UFSC faz com o export.
let conexoes = 0;
const reset: Server = createServer((s) => {
  conexoes++;
  s.resetAndDestroy?.() ?? s.destroy();
});
await new Promise<void>((r) => reset.listen(0, '127.0.0.1', r));
const portaReset = (reset.address() as { port: number }).port;

afterAll(() => {
  http.stop(true);
  reset.close();
});

describe('baixarTexto', () => {
  test('5xx/429 são repetidos até dar certo', async () => {
    hits = 0;
    roteiro = [503, 429, 200];
    expect(await baixarTexto(URL_HTTP, RAPIDO)).toBe('BEGIN:VCALENDAR');
    expect(hits).toBe(3);
  });

  test('403 não é repetido e diz que foi bloqueio', async () => {
    hits = 0;
    roteiro = [403];
    const erro = await baixarTexto(URL_HTTP, RAPIDO).catch((e) => e);
    expect(erro).toBeInstanceOf(ErroHttpDefinitivo);
    expect(erro.message).toContain('HTTP 403 (bloqueado');
    expect(hits).toBe(1);
  });

  test('conexão derrubada: repete todas as tentativas e o erro final traz a URL', async () => {
    conexoes = 0;
    const url = `http://127.0.0.1:${portaReset}/x`;
    const erro = await baixarTexto(url, { ...RAPIDO, tentativas: 3 }).catch((e) => e);
    expect(erro).toBeInstanceOf(Error);
    expect(erro.message).toStartWith(`GET ${url} falhou:`);
    expect(conexoes).toBe(3);
  });

  test('prazo total corta as tentativas restantes', async () => {
    hits = 0;
    roteiro = [500, 500, 500, 500];
    const erro = await baixarTexto(URL_HTTP, { tentativas: 4, esperaBaseMs: 400, timeoutMs: 2_000, prazoTotalMs: 300 }).catch(
      (e) => e
    );
    expect(erro.message).toContain('HTTP 500');
    expect(hits).toBe(1);
  });
});
