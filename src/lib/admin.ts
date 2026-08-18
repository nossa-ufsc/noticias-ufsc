// Cliente da Edge Function `events-admin` (Supabase do app). Só precisa do
// PIPELINE_TOKEN (escopo: ufsc-upsert | ufsc-prune) — nunca da service role.

import type { SourceId, UfscEventRow } from './types.js';

const LOTE = 100;

type Resposta = { ok: boolean; output?: string; error?: string };

function config() {
  const url = process.env.EVENTS_ADMIN_URL;
  const token = process.env.EVENTS_ADMIN_TOKEN;
  if (!url || !token) throw new Error('EVENTS_ADMIN_URL e EVENTS_ADMIN_TOKEN são obrigatórios para gravar.');
  return { url, token };
}

async function chamar(body: Record<string, unknown>): Promise<string> {
  const { url, token } = config();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'x-admin-token': token, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const json = (await res.json().catch(() => ({}))) as Resposta;
  if (!res.ok || !json.ok) {
    throw new Error(`events-admin ${String(body.action)} HTTP ${res.status}: ${json.error ?? 'sem detalhe'}`);
  }
  return json.output ?? '';
}

export async function upsertEventos(rows: UfscEventRow[], dry: boolean): Promise<string[]> {
  const saidas: string[] = [];
  for (let i = 0; i < rows.length; i += LOTE) {
    saidas.push(await chamar({ action: 'ufsc-upsert', rows: rows.slice(i, i + LOTE), dry }));
  }
  return saidas;
}

/** Poda restrita às fontes desta execução (a function só mexe em `source_id` com esses prefixos). */
export async function podarEventos(sources: SourceId[], keepSourceIds: string[]): Promise<string> {
  return chamar({ action: 'ufsc-prune', sources, keep_source_ids: keepSourceIds });
}
