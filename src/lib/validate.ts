// Sanidade ANTES de gravar (mesma filosofia do cardapios-ufsc: parse ruim falha o job,
// nunca envenena o banco). A Edge Function revalida linha a linha; aqui pegamos o
// que indica feed quebrado como um todo.

import type { PipelineStats, UfscEventRow } from './types.js';

export function validarLote(rows: UfscEventRow[], stats: PipelineStats[]): void {
  const problemas: string[] = [];

  const totalFeed = stats.reduce((n, s) => n + s.totalNoFeed, 0);
  if (totalFeed === 0) problemas.push('nenhum VEVENT em nenhum feed (feed vazio ou parser quebrado)');

  // A Agecom sempre tem eventos futuros; zero selecionados = algo mudou no feed.
  const agecom = stats.find((s) => s.fonte === 'agecom');
  if (agecom && agecom.totalNoFeed > 0 && agecom.selecionados === 0) {
    problemas.push('feed da Agecom parseado mas nenhum evento futuro selecionado');
  }

  const ids = new Set<string>();
  for (const r of rows) {
    if (ids.has(r.source_id)) problemas.push(`source_id duplicado: ${r.source_id}`);
    ids.add(r.source_id);
    if (!r.name) problemas.push(`${r.source_id}: sem nome`);
    if (Number.isNaN(Date.parse(r.start_date)) || Number.isNaN(Date.parse(r.end_date))) {
      problemas.push(`${r.source_id}: data inválida`);
    }
    if (r.end_date < r.start_date) problemas.push(`${r.source_id}: fim antes do início`);
    if (!/^https?:\/\//.test(r.image_url)) problemas.push(`${r.source_id}: image_url inválida`);
  }

  // Se mais de 30% das linhas vieram sem imagem própria ou sem descrição, o feed mudou de forma.
  const semDescricao = rows.filter((r) => !r.description).length;
  if (rows.length >= 10 && semDescricao / rows.length > 0.3) {
    problemas.push(`${semDescricao}/${rows.length} eventos sem descrição — X-ALT-DESC mudou?`);
  }

  if (problemas.length) {
    throw new Error(`Validação falhou:\n- ${problemas.slice(0, 20).join('\n- ')}`);
  }
}
