// Coleta de UMA fonte: export iCal (completo); se ele cair, o arquivo público /event/
// e, por último, o widget de agenda da home — os dois via páginas dos eventos (parcial,
// src/lib/pagina.ts). A rede é injetada para os
// testes rodarem offline.

import { readFile } from 'node:fs/promises';
import { baixarTexto, type OpcoesHttp } from './http.js';
import { parseEvents, type IcalEvent } from './ical.js';
import { normalizarEvento } from './normalize.js';
import { eventoDaPagina, linksDoArquivo, linksDoWidget, type LinkEvento } from './pagina.js';
import type { FeedSource, PipelineStats, UfscEventRow } from './types.js';

export type Baixar = (url: string, opcoes?: OpcoesHttp) => Promise<string>;

export type ModoColeta = 'ical' | 'arquivo' | 'html';

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

/** Teto de páginas do arquivo /event/ por execução (~10 eventos por página). */
const MAX_PAGINAS_ARQUIVO = 12;

/** Baixa e lê as páginas de evento; página individual com erro é pulada (e registrada). */
async function lerPaginas(links: LinkEvento[], host: string, baixar: Baixar, pausaMs: number) {
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
  return { eventos, erros };
}

/**
 * Arquivo público /event/ → páginas de evento. Como o arquivo vem do mais recente ao
 * mais antigo (por publicação), para na primeira página em que TODOS os eventos já
 * passaram, ou no teto de páginas. Cobre bem mais que o widget, mas um evento futuro
 * publicado há muito tempo pode ficar de fora — por isso também nunca alimenta a poda.
 */
export async function eventosDoArquivo(
  fonte: FeedSource,
  agora: number,
  baixar: Baixar,
  pausaMs = PAUSA_ENTRE_PAGINAS_MS
): Promise<{ eventos: IcalEvent[]; erros: string[]; paginas: number }> {
  const base = new URL(fonte.paginaEventos);
  const host = base.hostname;
  const vistos = new Set<string>();
  const eventos: IcalEvent[] = [];
  const erros: string[] = [];
  let paginas = 0;
  for (let n = 1; n <= MAX_PAGINAS_ARQUIVO; n++) {
    const url = new URL(n === 1 ? '/event/' : `/event/page/${n}/`, base).toString();
    if (n > 1 && pausaMs > 0) await new Promise((r) => setTimeout(r, pausaMs));
    let pagina: string;
    try {
      pagina = await baixar(url, OPCOES_HTML);
    } catch (e) {
      // Página além da última: o WordPress responde 404 (ex.: ara.ufsc.br só tem 1 página).
      if (n > 1 && /HTTP 404/.test(msg(e))) break;
      throw e;
    }
    const links = linksDoArquivo(pagina, host).filter((l) => !vistos.has(l.url));
    paginas = n;
    if (!links.length) break;
    links.forEach((l) => vistos.add(l.url));
    const lidos = await lerPaginas(links, host, baixar, pausaMs);
    eventos.push(...lidos.eventos);
    erros.push(...lidos.erros);
    const todosPassados =
      lidos.eventos.length > 0 &&
      lidos.eventos.every((ev) => {
        const sel = normalizarEvento(ev, fonte, agora);
        return !sel.ok && sel.motivo === 'ja-passou';
      });
    if (todosPassados) break;
  }
  if (vistos.size > 0 && eventos.length === 0) {
    throw new Error(`nenhuma das ${vistos.size} páginas de evento pôde ser lida (${erros[0]})`);
  }
  return { eventos, erros, paginas };
}

/** Widget da home → páginas de evento. Página individual com erro é pulada (e registrada). */
export async function eventosDoWidget(
  fonte: FeedSource,
  baixar: Baixar,
  pausaMs = PAUSA_ENTRE_PAGINAS_MS,
  jaLidos: Set<string> = new Set()
): Promise<{ eventos: IcalEvent[]; erros: string[] }> {
  const host = new URL(fonte.paginaEventos).hostname;
  // O widget traz o id do post: pula o que o arquivo já leu (UID ai1ec-<id>@<host>).
  const links = linksDoWidget(await baixar(fonte.paginaEventos, OPCOES_HTML), host).filter(
    (l) => !jaLidos.has(`ai1ec-${l.postId}@${host}`)
  );
  const { eventos, erros } = await lerPaginas(links, host, baixar, pausaMs);
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
  log(`   ⚠ export iCal indisponível (${erroIcal}); plano B: arquivo /event/ + widget de ${fonte.paginaEventos}`);
  // Arquivo (por publicação) e widget (próximos ~10 dias, inclui recorrentes publicados há
  // tempo) se completam: junta os dois, sem repetir evento (mesmo UID).
  const eventos: IcalEvent[] = [];
  const erros: string[] = [];
  const uids = new Set<string>();
  const juntar = (lista: IcalEvent[]) => {
    for (const ev of lista) {
      const uid = ev.UID?.[0]?.value ?? '';
      if (uid && uids.has(uid)) continue;
      if (uid) uids.add(uid);
      eventos.push(ev);
    }
  };
  let erroArquivo: string | null = null;
  try {
    const r = await eventosDoArquivo(fonte, agora, baixar, pausaMs);
    juntar(r.eventos);
    erros.push(...r.erros);
    log(`   arquivo: ${r.paginas} página(s), ${r.eventos.length} evento(s) lidos`);
  } catch (e) {
    erroArquivo = msg(e);
    log(`   ⚠ arquivo /event/ indisponível (${erroArquivo})`);
  }
  let erroWidget: string | null = null;
  try {
    const antes = eventos.length;
    const r = await eventosDoWidget(fonte, baixar, pausaMs, uids);
    juntar(r.eventos);
    erros.push(...r.erros);
    log(`   widget: +${eventos.length - antes} evento(s) fora do arquivo`);
  } catch (e) {
    erroWidget = msg(e);
    log(`   ⚠ widget indisponível (${erroWidget})`);
  }
  if (erroArquivo && erroWidget) {
    throw new Error(`iCal: ${erroIcal} | arquivo: ${erroArquivo} | widget: ${erroWidget}`);
  }
  const r = selecionar(eventos, fonte, agora);
  r.stats.erros.push(...erros);
  return { ...r, modo: erroArquivo ? 'html' : 'arquivo', completa: false };
}
