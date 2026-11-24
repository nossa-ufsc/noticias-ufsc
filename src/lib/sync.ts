// Orquestração com isolamento por fonte: coleta, validação e upsert de cada fonte
// acontecem separados — a Agecom fora do ar não impede o Araranguá de sincronizar.
//
// Regras da poda (ufsc-prune) — ela rejeita eventos futuros que "sumiram do feed",
// então só pode ver fontes cujo conjunto de eventos é confiável e COMPLETO:
//   - a fonte foi coletada pelo export iCal (o widget HTML só mostra ~10 dias);
//   - passou na validação e o upsert real (não dry) deu certo;
//   - a execução permite poda (sem --source/--fixture/--dry-run/--skip-db).
// Fonte que falhou fica de fora: a function só poda dentro das fontes enviadas.

import type { Coleta, ModoColeta } from './coleta.js';
import type { PipelineStats, SourceId, UfscEventRow } from './types.js';
import { validarLote } from './validate.js';

export type ResultadoFonte = {
  fonte: SourceId;
  ok: boolean;
  modo: ModoColeta | null;
  completa: boolean;
  erro: string | null;
  stats: PipelineStats | null;
  rows: UfscEventRow[];
  /** Upsert real (não dry, não --skip-db) concluído. */
  gravado: boolean;
  podado: boolean;
};

export type OpcoesSync = {
  fontes: SourceId[];
  nomes: Record<SourceId, string>;
  coletar: (fonte: SourceId) => Promise<Coleta>;
  /** null = --skip-db (não chama a Edge Function). */
  upsert: ((rows: UfscEventRow[], dry: boolean) => Promise<string[]>) | null;
  /** null = poda desligada nesta execução (--source/--fixture/--dry-run). */
  podar: ((sources: SourceId[], keepSourceIds: string[]) => Promise<string>) | null;
  dry: boolean;
  log?: (s: string) => void;
};

export type ResultadoSync = { fontes: ResultadoFonte[]; erroPoda: string | null };

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function sincronizar(o: OpcoesSync): Promise<ResultadoSync> {
  const log = o.log ?? console.log;
  const resultados: ResultadoFonte[] = [];

  for (const fonte of o.fontes) {
    log(`→ ${o.nomes[fonte]}`);
    const r: ResultadoFonte = {
      fonte, ok: false, modo: null, completa: false, erro: null, stats: null, rows: [], gravado: false, podado: false,
    };
    resultados.push(r);
    try {
      const c = await o.coletar(fonte);
      r.modo = c.modo;
      r.completa = c.completa;
      r.stats = c.stats;
      log(
        `   ${c.stats.totalNoFeed} no feed${c.modo === 'ical' ? '' : ` (via ${c.modo === 'arquivo' ? 'arquivo /event/' : 'widget'}, parcial)`} | ` +
          `${c.stats.selecionados} selecionados | ignorados ${JSON.stringify(c.stats.ignorados)}`
      );
      for (const e of c.stats.erros) log(`   ⚠ ${e}`);
      validarLote(c.rows, [c.stats]);
      r.rows = [...c.rows].sort((a, b) => a.start_date.localeCompare(b.start_date));
      r.ok = true;
    } catch (e) {
      r.erro = msg(e);
      log(`   ✖ ${fonte}: ${r.erro}`);
    }
  }

  if (o.upsert) {
    for (const r of resultados.filter((x) => x.ok)) {
      try {
        const saidas = await o.upsert(r.rows, o.dry);
        for (const s of saidas) log(`\n${s}`);
        r.gravado = !o.dry;
      } catch (e) {
        r.ok = false;
        r.erro = `upsert: ${msg(e)}`;
        log(`\n✖ ${r.fonte}: ${r.erro}`);
      }
    }
  }

  let erroPoda: string | null = null;
  if (o.podar && o.upsert && !o.dry) {
    const podaveis = resultados.filter((r) => r.ok && r.completa && r.gravado);
    for (const r of resultados.filter((x) => !podaveis.includes(x))) {
      log(`\n(poda pulada para ${r.fonte}: ${r.ok ? 'coleta parcial via página' : 'fonte falhou'})`);
    }
    if (podaveis.length) {
      try {
        const keep = podaveis.flatMap((r) => r.rows.map((row) => row.source_id));
        log(`\n${await o.podar(podaveis.map((r) => r.fonte), keep)}`);
        for (const r of podaveis) r.podado = true;
      } catch (e) {
        erroPoda = msg(e);
        log(`\n✖ poda: ${erroPoda}`);
      }
    }
  }

  return { fontes: resultados, erroPoda };
}
