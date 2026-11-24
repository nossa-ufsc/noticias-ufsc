// Coleta de UMA fonte: export iCal (completo) e, se ele cair, o widget de agenda da
// home + páginas dos eventos (parcial — src/lib/pagina.ts). A rede é injetada para os
// testes rodarem offline.

import { readFile } from 'node:fs/promises';
import { baixarTexto, type OpcoesHttp } from './http.js';
import { parseEvents, type IcalEvent } from './ical.js';
import { normalizarEvento } from './normalize.js';
import { eventoDaPagina, linksDoWidget } from './pagina.js';
import type { FeedSource, PipelineStats, UfscEventRow } from './types.js';

export type Baixar = (url: string, opcoes?: OpcoesHttp) => Promise<string>;

export type ModoColeta = 'ical' | 'html';

export type Coleta = {
  rows: UfscEventRow[];
  stats: PipelineStats;
  modo: ModoColeta;
  /** true só para o export iCal inteiro — o único que pode alimentar a poda. */
  completa: boolean;
};

// Páginas HTML são leves (~200 KB): timeout curto, poucas tentativas e pausa entre
// páginas para não martelar o servidor da UFSC.
const OPCOES_HTML: OpcoesHttp = {
  tentativas: 2,
  timeoutMs: 30_000,
  esperaBaseMs: 3_000,
  prazoTotalMs: 60_000,
  accept: 'text/html,*/*',
};
const PAUSA_ENTRE_PAGINAS_MS = 500;

export function selecionar(eventos: IcalEvent[], fonte: FeedSource, agora: number) {
  const stats: PipelineStats = { fonte: fonte.id, totalNoFeed: eventos.length, selecionados: 0, ignorados: {}, erros: [] };
  const rows: UfscEventRow[] = [];
  for (const ev of eventos) {
    const sel = normalizarEvento(ev, fonte, agora);
    if (sel.ok) {
      rows.push(sel.row);
    } else {
      stats.ignorados[sel.motivo] = (stats.ignorados[sel.motivo] ?? 0) + 1;
      if (sel.motivo === 'erro' || sel.motivo === 'sem-titulo') stats.erros.push(`${sel.motivo}: ${sel.detalhe}`);
    }
  }
  stats.selecionados = rows.length;
  return { rows, stats };
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Widget da home → páginas de evento. Página individual com erro é pulada (e registrada). */
export async function eventosDoWidget(
  fonte: FeedSource,
  baixar: Baixar,
  pausaMs = PAUSA_ENTRE_PAGINAS_MS
): Promise<{ eventos: IcalEvent[]; erros: string[] }> {
  const host = new URL(fonte.paginaEventos).hostname;
  const links = linksDoWidget(await baixar(fonte.paginaEventos, OPCOES_HTML), host);
  const eventos: IcalEvent[] = [];
  const erros: string[] = [];
  for (const link of links) {
    if (pausaMs > 0) await new Promise((r) => setTimeout(r, pausaMs));
    try {
      eventos.push(eventoDaPagina(await baixar(link.url, OPCOES_HTML), host));
    } catch (e) {
      erros.push(`página ${link.url}: ${msg(e)}`);
    }
  }
  if (links.length > 0 && eventos.length === 0) {
    throw new Error(`nenhuma das ${links.length} páginas de evento pôde ser lida (${erros[0]})`);
  }
  return { eventos, erros };
}

export async function coletarFonte(
  fonte: FeedSource,
  agora: number,
  opcoes: { baixar?: Baixar; fixture?: string | null; pausaMs?: number; log?: (s: string) => void } = {}
): Promise<Coleta> {
  const { baixar = baixarTexto, fixture = null, pausaMs, log = console.log } = opcoes;
  if (fixture) {
    const ics = await readFile(`${fixture}/${fonte.id}.ics`, 'utf8');
    return { ...selecionar(parseEvents(ics), fonte, agora), modo: 'ical', completa: true };
  }
  let erroIcal: string;
  try {
    return { ...selecionar(parseEvents(await baixar(fonte.url)), fonte, agora), modo: 'ical', completa: true };
  } catch (e) {
    erroIcal = msg(e);
  }
  log(`   ⚠ export iCal indisponível (${erroIcal}); plano B: widget de ${fonte.paginaEventos}`);
  try {
    const { eventos, erros } = await eventosDoWidget(fonte, baixar, pausaMs);
    const r = selecionar(eventos, fonte, agora);
    r.stats.erros.push(...erros);
    return { ...r, modo: 'html', completa: false };
  } catch (e) {
    throw new Error(`iCal: ${erroIcal} | página: ${msg(e)}`);
  }
}
