// CLI: bun src/index.ts eventos [--dry-run] [--skip-db] [--source agecom,ara] [--fixture <dir>]
//
//   eventos      baixa os feeds iCal, normaliza, valida e manda pra Edge Function
//   --dry-run    chama a function com dry=true (valida lá, não grava) e não poda
//   --skip-db    não chama a function (só gera data/eventos.json)
//   --source     restringe as fontes (padrão: todas)
//   --fixture    lê <dir>/<fonte>.ics em vez de baixar (testes/debug offline)
//
// Saída: data/eventos.json (snapshot do que foi enviado — commitado pelo workflow como
// keep-alive) e log em stdout.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { podarEventos, upsertEventos } from './lib/admin.js';
import { baixarTexto } from './lib/http.js';
import { parseEvents } from './lib/ical.js';
import { normalizarEvento } from './lib/normalize.js';
import type { PipelineStats, SourceId, UfscEventRow } from './lib/types.js';
import { validarLote } from './lib/validate.js';
import { FONTES, FONTES_PADRAO } from './sources/index.js';

// Imagem padrão (bucket público do app) para o raro evento sem imagem no feed.
const FALLBACK_IMAGEM =
  'https://tpqzvgsilwrrogylzhui.supabase.co/storage/v1/object/public/events/events-images/fallback-ufsc.jpg';

type Args = { cmd: string; dry: boolean; skipDb: boolean; fontes: SourceId[]; fixture: string | null };

function parseArgs(argv: string[]): Args {
  const args: Args = { cmd: argv[0] ?? '', dry: false, skipDb: false, fontes: FONTES_PADRAO, fixture: null };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dry = true;
    else if (a === '--skip-db') args.skipDb = true;
    else if (a === '--source') {
      const lista = (argv[++i] ?? '').split(',').filter(Boolean) as SourceId[];
      for (const f of lista) if (!(f in FONTES)) throw new Error(`fonte desconhecida: ${f}`);
      args.fontes = lista;
    } else if (a === '--fixture') args.fixture = argv[++i] ?? null;
    else throw new Error(`argumento desconhecido: ${a}`);
  }
  return args;
}

async function coletar(fonteId: SourceId, agora: number, fixture: string | null) {
  const fonte = FONTES[fonteId];
  const ics = fixture ? await readFile(`${fixture}/${fonteId}.ics`, 'utf8') : await baixarTexto(fonte.url);
  const eventos = parseEvents(ics);
  const stats: PipelineStats = { fonte: fonteId, totalNoFeed: eventos.length, selecionados: 0, ignorados: {}, erros: [] };
  const rows: UfscEventRow[] = [];
  for (const ev of eventos) {
    const sel = normalizarEvento(ev, fonte, agora, FALLBACK_IMAGEM);
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

async function cmdEventos(args: Args) {
  const agora = Date.now();
  const todas: UfscEventRow[] = [];
  const stats: PipelineStats[] = [];
  for (const f of args.fontes) {
    console.log(`→ ${FONTES[f].nome}`);
    const r = await coletar(f, agora, args.fixture);
    console.log(
      `   ${r.stats.totalNoFeed} no feed | ${r.stats.selecionados} selecionados | ignorados ${JSON.stringify(r.stats.ignorados)}`
    );
    for (const e of r.stats.erros) console.log(`   ⚠ ${e}`);
    todas.push(...r.rows);
    stats.push(r.stats);
  }
  todas.sort((a, b) => a.start_date.localeCompare(b.start_date));

  validarLote(todas, stats);

  await mkdir('data', { recursive: true });
  await writeFile(
    'data/eventos.json',
    JSON.stringify({ geradoEm: new Date(agora).toISOString(), fontes: stats, eventos: todas }, null, 2) + '\n'
  );
  console.log(`\n${todas.length} eventos → data/eventos.json`);

  const porCategoria: Record<string, number> = {};
  for (const r of todas) porCategoria[r.category] = (porCategoria[r.category] ?? 0) + 1;
  console.log(`por categoria: ${JSON.stringify(porCategoria)}`);

  if (args.skipDb) {
    console.log('(--skip-db: não chamou a Edge Function)');
    return;
  }
  const saidas = await upsertEventos(todas, args.dry);
  for (const s of saidas) console.log(`\n${s}`);
  if (!args.dry) {
    console.log(`\n${await podarEventos(todas.map((r) => r.source_id))}`);
  }
}

const args = parseArgs(process.argv.slice(2));
if (args.cmd !== 'eventos') {
  console.error('uso: bun src/index.ts eventos [--dry-run] [--skip-db] [--source agecom,ara] [--fixture <dir>]');
  process.exit(2);
}
try {
  await cmdEventos(args);
} catch (e) {
  console.error(`✖ ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}
