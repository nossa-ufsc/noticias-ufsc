// CLI: bun src/index.ts eventos [--dry-run] [--skip-db] [--source agecom,ara] [--fixture <dir>] [--now <iso>]
//
//   eventos      baixa os feeds iCal, normaliza, valida e manda pra Edge Function
//   --dry-run    chama a function com dry=true (valida lá, não grava) e não poda
//   --skip-db    não chama a function (só gera data/eventos.json)
//   --source     restringe as fontes (padrão: todas)
//   --fixture    lê <dir>/<fonte>.ics em vez de baixar (testes/debug offline)
//   --now        fixa o "agora" (ISO) — usado no CI com fixtures congelados
//
// Cada fonte é isolada (src/lib/sync.ts): uma fora do ar não impede as outras. Se o
// export iCal cair, a fonte tenta o widget de agenda da home (coleta parcial).
//
// Poda (ufsc-prune) só roda numa execução sem --source/--fixture/--dry-run/--skip-db, e
// só para as fontes coletadas pelo export iCal completo e gravadas com sucesso — senão
// eventos de fontes ausentes/parciais seriam rejeitados em massa. A function, por sua
// vez, só poda dentro das fontes enviadas.
//
// Saída: data/eventos.json (eventos desta execução + status/último sucesso de cada
// fonte — commitado pelo workflow como keep-alive) e log em stdout. Exit 1 só quando
// TODAS as fontes falharam; falha parcial vira anotação (warning; error após 3 dias).

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { podarEventos, upsertEventos } from './lib/admin.js';
import { coletarFonte } from './lib/coleta.js';
import { alertas, montarSnapshot, type Alerta, type Snapshot } from './lib/snapshot.js';
import { sincronizar } from './lib/sync.js';
import type { SourceId } from './lib/types.js';
import { FONTES, FONTES_PADRAO } from './sources/index.js';

const SNAPSHOT = 'data/eventos.json';

type Args = {
  cmd: string;
  dry: boolean;
  skipDb: boolean;
  fontes: SourceId[];
  fixture: string | null;
  now: number | null;
  fontesRestritas: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    cmd: argv[0] ?? '',
    dry: false,
    skipDb: false,
    fontes: FONTES_PADRAO,
    fixture: null,
    now: null,
    fontesRestritas: false,
  };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dry = true;
    else if (a === '--skip-db') args.skipDb = true;
    else if (a === '--source') {
      const lista = (argv[++i] ?? '').split(',').filter(Boolean) as SourceId[];
      for (const f of lista) if (!(f in FONTES)) throw new Error(`fonte desconhecida: ${f}`);
      args.fontes = lista;
      args.fontesRestritas = true;
    } else if (a === '--fixture') args.fixture = argv[++i] ?? null;
    else if (a === '--now') {
      const t = Date.parse(argv[++i] ?? '');
      if (Number.isNaN(t)) throw new Error('--now precisa de uma data ISO');
      args.now = t;
    }
    else throw new Error(`argumento desconhecido: ${a}`);
  }
  return args;
}

async function lerSnapshotAnterior() {
  try {
    return JSON.parse(await readFile(SNAPSHOT, 'utf8'));
  } catch {
    return null;
  }
}

/** Anotação do GitHub Actions (aparece no resumo do run); fora do Actions, linha comum. */
function anotar(a: Alerta) {
  const texto = a.texto.replace(/\r?\n/g, ' ');
  if (process.env.GITHUB_ACTIONS === 'true') console.log(`::${a.nivel}::${texto}`);
  else console.log(`${a.nivel === 'error' ? '✖' : '⚠'} ${texto}`);
}

async function resumoDoJob(snap: Snapshot, alertasDoRun: Alerta[]) {
  const arquivo = process.env.GITHUB_STEP_SUMMARY;
  if (!arquivo) return;
  const linhas = [
    '| fonte | status | modo | selecionados | último sucesso | erro |',
    '|---|---|---|---|---|---|',
    ...snap.fontes.map(
      (f) =>
        `| ${f.fonte} | ${f.status} | ${f.modo ?? '—'} | ${f.selecionados ?? '—'} | ${f.ultimoSucesso ?? 'nunca'} | ${(f.erro ?? '').replace(/\|/g, '\\|').slice(0, 200)} |`
    ),
    '',
    ...alertasDoRun.map((a) => `- **${a.nivel}**: ${a.texto}`),
  ];
  await appendFile(arquivo, `${linhas.join('\n')}\n`);
}

/** Código de saída: 1 só se TODAS as fontes falharam (falha parcial vira aviso/erro anotado). */
async function cmdEventos(args: Args): Promise<number> {
  const agora = args.now ?? Date.now();
  const anterior = await lerSnapshotAnterior();
  const podaPermitida = !args.dry && !args.skipDb && !args.fontesRestritas && !args.fixture;

  const res = await sincronizar({
    fontes: args.fontes,
    nomes: Object.fromEntries(Object.values(FONTES).map((f) => [f.id, f.nome])) as Record<SourceId, string>,
    coletar: (f) => coletarFonte(FONTES[f], agora, { fixture: args.fixture }),
    upsert: args.skipDb ? null : upsertEventos,
    podar: podaPermitida ? podarEventos : null,
    dry: args.dry,
  });

  const snap = montarSnapshot(res, agora, anterior);
  await mkdir('data', { recursive: true });
  await writeFile(SNAPSHOT, JSON.stringify(snap, null, 2) + '\n');
  console.log(`\n${snap.eventos.length} eventos → ${SNAPSHOT}`);

  const porCategoria: Record<string, number> = {};
  for (const r of snap.eventos) porCategoria[r.category] = (porCategoria[r.category] ?? 0) + 1;
  console.log(`por categoria: ${JSON.stringify(porCategoria)}`);
  if (args.skipDb) console.log('(--skip-db: não chamou a Edge Function)');
  else if (!podaPermitida && !args.dry) console.log('(poda pulada: execução parcial com --source/--fixture)');

  const alertasDoRun = alertas(snap, agora, res.erroPoda);
  if (alertasDoRun.length) console.log('');
  for (const a of alertasDoRun) anotar(a);
  await resumoDoJob(snap, alertasDoRun);

  const ok = res.fontes.filter((r) => r.ok).map((r) => r.fonte);
  console.log(`\nfontes ok: ${ok.join(', ') || 'nenhuma'} de ${res.fontes.length}`);
  return ok.length === 0 ? 1 : 0;
}

const args = parseArgs(process.argv.slice(2));
if (args.cmd !== 'eventos') {
  console.error(
    'uso: bun src/index.ts eventos [--dry-run] [--skip-db] [--source agecom,ara] [--fixture <dir>] [--now <iso>]'
  );
  process.exit(2);
}
try {
  process.exitCode = await cmdEventos(args);
} catch (e) {
  console.error(`✖ ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}
