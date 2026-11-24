// data/eventos.json: o que esta execução coletou + o estado de cada fonte. O campo
// `ultimoSucesso` (último upsert real da fonte) atravessa execuções pelo próprio
// snapshot commitado — é ele que transforma "fonte caiu hoje" em aviso e "fonte fora
// há dias" em erro visível no Actions, sem derrubar o job das outras fontes.

import type { ModoColeta } from './coleta.js';
import type { ResultadoSync } from './sync.js';
import type { SourceId, UfscEventRow } from './types.js';

export const DIAS_ALERTA = 3;

export type FonteSnapshot = {
  fonte: SourceId;
  status: 'ok' | 'falhou';
  modo: ModoColeta | null;
  completa: boolean;
  erro: string | null;
  /** ISO do último upsert real bem-sucedido desta fonte (null = nunca). */
  ultimoSucesso: string | null;
  totalNoFeed: number | null;
  selecionados: number | null;
  ignorados: Record<string, number>;
  erros: string[];
};

export type Snapshot = { geradoEm: string; fontes: FonteSnapshot[]; eventos: UfscEventRow[] };

/** Snapshot anterior (formato atual ou o antigo, em que `fontes` era só PipelineStats). */
type SnapshotAnterior = { geradoEm?: string; fontes?: Array<{ fonte?: string; status?: string; ultimoSucesso?: string | null }> };

function ultimoSucessoAnterior(anterior: SnapshotAnterior | null, fonte: SourceId): string | null {
  const f = anterior?.fontes?.find((x) => x.fonte === fonte);
  if (!f) return null;
  if (f.ultimoSucesso !== undefined) return f.ultimoSucesso;
  // Formato antigo: o snapshot só era escrito quando tudo dava certo.
  return f.status === undefined ? (anterior?.geradoEm ?? null) : null;
}

export function montarSnapshot(res: ResultadoSync, agora: number, anterior: SnapshotAnterior | null): Snapshot {
  const geradoEm = new Date(agora).toISOString();
  const fontes = res.fontes.map((r): FonteSnapshot => ({
    fonte: r.fonte,
    status: r.ok ? 'ok' : 'falhou',
    modo: r.modo,
    completa: r.completa,
    erro: r.erro,
    ultimoSucesso: r.ok && r.gravado ? geradoEm : ultimoSucessoAnterior(anterior, r.fonte),
    totalNoFeed: r.stats?.totalNoFeed ?? null,
    selecionados: r.stats?.selecionados ?? null,
    ignorados: r.stats?.ignorados ?? {},
    erros: r.stats?.erros ?? [],
  }));
  const eventos = res.fontes
    .filter((r) => r.ok)
    .flatMap((r) => r.rows)
    .sort((a, b) => a.start_date.localeCompare(b.start_date));
  return { geradoEm, fontes, eventos };
}

export type Alerta = { nivel: 'warning' | 'error'; texto: string };

export function alertas(snap: Snapshot, agora: number, erroPoda: string | null): Alerta[] {
  const out: Alerta[] = [];
  for (const f of snap.fontes) {
    if (f.status === 'falhou') {
      const dias = f.ultimoSucesso ? (agora - Date.parse(f.ultimoSucesso)) / 86_400_000 : Infinity;
      const desde = f.ultimoSucesso ? `sem sincronizar desde ${f.ultimoSucesso.slice(0, 10)} (${Math.floor(dias)} dias)` : 'nunca sincronizou';
      out.push({ nivel: dias >= DIAS_ALERTA ? 'error' : 'warning', texto: `fonte ${f.fonte} falhou — ${desde}: ${f.erro}` });
    } else if (f.modo === 'html' || f.modo === 'arquivo') {
      const via = f.modo === 'arquivo' ? 'arquivo /event/' : 'widget da home';
      out.push({ nivel: 'warning', texto: `fonte ${f.fonte}: export iCal fora do ar; coleta parcial via ${via} (sem poda)` });
    }
  }
  if (erroPoda) out.push({ nivel: 'error', texto: `poda falhou: ${erroPoda}` });
  return out;
}
