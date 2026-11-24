// Isolamento por fonte, regras da poda e status no snapshot — com coleta/admin falsos.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { Coleta } from '../src/lib/coleta.js';
import { selecionar } from '../src/lib/coleta.js';
import { parseEvents } from '../src/lib/ical.js';
import { alertas, montarSnapshot } from '../src/lib/snapshot.js';
import { sincronizar, type OpcoesSync } from '../src/lib/sync.js';
import type { SourceId, UfscEventRow } from '../src/lib/types.js';
import { FONTES } from '../src/sources/index.js';

const AGORA = Date.parse('2026-08-17T15:00:00-03:00');
const coletaReal = (f: SourceId, modo: Coleta['modo'] = 'ical'): Coleta => ({
  ...selecionar(parseEvents(readFileSync(new URL(`../fixtures/${f}.ics`, import.meta.url), 'utf8')), FONTES[f], AGORA),
  modo,
  completa: modo === 'ical',
});

function cenario(coletas: Partial<Record<SourceId, Coleta | Error>>, extra: Partial<OpcoesSync> = {}) {
  const upserts: Array<{ fonte: string; n: number }> = [];
  const podas: Array<{ sources: SourceId[]; keep: string[] }> = [];
  const opcoes: OpcoesSync = {
    fontes: ['agecom', 'ara'],
    nomes: { agecom: 'Agecom', ara: 'ARA' },
    coletar: async (f) => {
      const c = coletas[f];
      if (!c || c instanceof Error) throw c ?? new Error('sem coleta');
      return c;
    },
    upsert: async (rows: UfscEventRow[]) => {
      upserts.push({ fonte: rows[0]?.source_id.split(':')[0] ?? '?', n: rows.length });
      return ['ok'];
    },
    podar: async (sources, keep) => {
      podas.push({ sources, keep });
      return 'podado';
    },
    dry: false,
    log: () => {},
    ...extra,
  };
  return { opcoes, upserts, podas };
}

describe('sincronizar', () => {
  test('tudo ok: grava as duas e poda as duas', async () => {
    const { opcoes, upserts, podas } = cenario({ agecom: coletaReal('agecom'), ara: coletaReal('ara') });
    const res = await sincronizar(opcoes);
    expect(res.fontes.map((r) => [r.fonte, r.ok, r.gravado, r.podado])).toEqual([
      ['agecom', true, true, true],
      ['ara', true, true, true],
    ]);
    expect(upserts).toEqual([{ fonte: 'agecom', n: 26 }, { fonte: 'ara', n: 8 }]);
    expect(podas[0].sources).toEqual(['agecom', 'ara']);
    expect(podas[0].keep.length).toBe(34);
  });

  test('Agecom fora do ar não impede o ARA, e a poda só vê o ARA', async () => {
    const { opcoes, upserts, podas } = cenario({ agecom: new Error('ECONNRESET'), ara: coletaReal('ara') });
    const res = await sincronizar(opcoes);
    expect(res.fontes[0]).toMatchObject({ fonte: 'agecom', ok: false, erro: 'ECONNRESET', gravado: false });
    expect(res.fontes[1]).toMatchObject({ fonte: 'ara', ok: true, gravado: true, podado: true });
    expect(upserts).toEqual([{ fonte: 'ara', n: 8 }]);
    expect(podas).toEqual([{ sources: ['ara'], keep: res.fontes[1].rows.map((r) => r.source_id) }]);
  });

  test('coleta parcial (página) grava mas não poda', async () => {
    const { opcoes, upserts, podas } = cenario({ agecom: coletaReal('agecom', 'html'), ara: coletaReal('ara') });
    const res = await sincronizar(opcoes);
    expect(upserts.map((u) => u.fonte)).toEqual(['agecom', 'ara']);
    expect(res.fontes[0]).toMatchObject({ ok: true, gravado: true, podado: false });
    expect(podas.map((p) => p.sources)).toEqual([['ara']]);
  });

  test('validação reprova só a fonte quebrada', async () => {
    const vazia: Coleta = { ...coletaReal('ara'), rows: [], stats: { ...coletaReal('ara').stats, totalNoFeed: 0 } };
    const { opcoes, upserts, podas } = cenario({ agecom: coletaReal('agecom'), ara: vazia });
    const res = await sincronizar(opcoes);
    expect(res.fontes[1].ok).toBe(false);
    expect(res.fontes[1].erro).toMatch(/feed ara sem nenhum VEVENT/);
    expect(upserts.map((u) => u.fonte)).toEqual(['agecom']);
    expect(podas.map((p) => p.sources)).toEqual([['agecom']]);
  });

  test('upsert que falha tira a fonte da poda', async () => {
    const { opcoes, podas } = cenario({ agecom: coletaReal('agecom'), ara: coletaReal('ara') });
    const upsertOriginal = opcoes.upsert!;
    opcoes.upsert = async (rows, dry) => {
      if (rows[0].source_id.startsWith('ara:')) throw new Error('events-admin ufsc-upsert HTTP 500');
      return upsertOriginal(rows, dry);
    };
    const res = await sincronizar(opcoes);
    expect(res.fontes[1]).toMatchObject({ ok: false, erro: 'upsert: events-admin ufsc-upsert HTTP 500' });
    expect(podas.map((p) => p.sources)).toEqual([['agecom']]);
  });

  test('dry-run e --skip-db nunca podam', async () => {
    const a = cenario({ agecom: coletaReal('agecom'), ara: coletaReal('ara') }, { dry: true });
    const ra = await sincronizar(a.opcoes);
    expect(a.upserts.length).toBe(2);
    expect(a.podas).toEqual([]);
    expect(ra.fontes.every((r) => r.ok && !r.gravado)).toBe(true);

    const b = cenario({ agecom: coletaReal('agecom'), ara: coletaReal('ara') }, { upsert: null });
    await sincronizar(b.opcoes);
    expect(b.podas).toEqual([]);
  });
});

describe('snapshot e alertas', () => {
  test('ultimoSucesso: atual para quem gravou, herdado para quem falhou (inclusive do formato antigo)', async () => {
    const { opcoes } = cenario({ agecom: new Error('ECONNRESET'), ara: coletaReal('ara') });
    const res = await sincronizar(opcoes);
    const agora = Date.parse('2026-11-24T18:00:00Z');
    const antigo = { geradoEm: '2026-09-27T14:39:12.803Z', fontes: [{ fonte: 'agecom' }, { fonte: 'ara' }] };
    const snap = montarSnapshot(res, agora, antigo);
    expect(snap.fontes.map((f) => [f.fonte, f.status, f.ultimoSucesso])).toEqual([
      ['agecom', 'falhou', '2026-09-27T14:39:12.803Z'],
      ['ara', 'ok', '2026-11-24T18:00:00.000Z'],
    ]);
    expect(snap.eventos.every((e) => e.source_id.startsWith('ara:'))).toBe(true);

    // Próxima execução herda do formato novo.
    const snap2 = montarSnapshot(res, agora + 3_600_000, snap);
    expect(snap2.fontes[0].ultimoSucesso).toBe('2026-09-27T14:39:12.803Z');

    const al = alertas(snap, agora, null);
    expect(al).toEqual([
      { nivel: 'error', texto: 'fonte agecom falhou — sem sincronizar desde 2026-09-27 (58 dias): ECONNRESET' },
    ]);
  });

  test('queda recente é warning; coleta parcial e poda com erro também aparecem', () => {
    const agora = Date.parse('2026-11-24T18:00:00Z');
    const snap = montarSnapshot(
      {
        fontes: [
          { fonte: 'agecom', ok: false, modo: null, completa: false, erro: 'timeout', stats: null, rows: [], gravado: false, podado: false },
          { fonte: 'ara', ok: true, modo: 'html', completa: false, erro: null, stats: null, rows: [], gravado: true, podado: false },
        ],
        erroPoda: null,
      },
      agora,
      { fontes: [{ fonte: 'agecom', status: 'ok', ultimoSucesso: '2026-11-23T18:00:00.000Z' }] }
    );
    expect(alertas(snap, agora, 'HTTP 500').map((a) => a.nivel)).toEqual(['warning', 'warning', 'error']);
  });
});
