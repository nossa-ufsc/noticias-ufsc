// Classificador de categoria do app a partir das CATEGORIES/X-TAGS/título da Agecom.
// Taxonomia enxuta (a mesma do app): festa | palestra | curso | cultura | academico |
// esporte | saude | outro. Primeira regra que casar vence — a ordem importa: um
// "seminário de cinema" é palestra (o formato manda), um "curso de teatro" é curso.

import type { EventCategory } from './types.js';

const RULES: Array<[EventCategory, RegExp]> = [
  ['festa', /\b(festa|calourada|baile|balada|open bar)\b/],
  ['curso', /\b(curso|workshop|oficina|minicurso|formacao|capacitacao|treinamento|bootcamp|escola de (verao|inverno))\b/],
  [
    'palestra',
    /\b(palestra|seminario|conferencia|debate|roda de conversa|mesa[- ]redonda|aula (magna|inaugural|publica|aberta)|webinar|live|coloquio|audiencia publica|forum|painel|dialogo|bate[- ]papo)\b/,
  ],
  [
    'cultura',
    /\b(cinema|cine|filme|exibicao|mostra|teatro|espetaculo|exposicao|apresentacao musical|show|concerto|musica|recital|coral|lancamento de livro|festival|atracoes culturais|planetario|observacao do ceu|sarau|danca|arte|cultural|literatura|feira do livro)\b/,
  ],
  [
    'academico',
    /\b(congresso|encontro|jornada|simposio|semana academica|semana de atividades|semana da|assembleia|evento internacional|defesa|banca|colacao|formatura|reuniao|sessao solene|premiacao|hackathon|maratona|olimpiada|feira de ciencias|sepex|feira de cursos|portas abertas|semana (de|do|da)\b)/,
  ],
  ['esporte', /\b(esporte|esportiv[oa]|campeonato|corrida|torneio|jogos|copa|atletica|remo|nautidesign|regata)\b/],
  ['saude', /\b(saude|meditacao|mindfulness|bem[- ]estar|vacinacao|doacao de sangue|psicolog|acolhimento|autocuidado|yoga)\b/],
  // "aula" genérica só depois de tudo (aula magna/pública já caiu em palestra).
  ['curso', /\baulas?\b/],
];

/** Remove acentos, baixa caixa e normaliza espaços/hífens para casar as regras. */
export function normalizar(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[_/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Categoriza a partir dos rótulos estruturais (categorias/tags) primeiro e do
 * título como fallback: rótulo da fonte vence sobre palpite pelo nome.
 */
export function classificar(categorias: string[], tags: string[], titulo: string): EventCategory {
  const rotulos = normalizar([...categorias, ...tags].join(' | '));
  for (const [cat, re] of RULES) if (re.test(rotulos)) return cat;
  const t = normalizar(titulo);
  for (const [cat, re] of RULES) if (re.test(t)) return cat;
  return 'outro';
}

const TAG_RUIDO = new Set([
  'ufsc',
  'universidade federal de santa catarina',
  'evento',
  'eventos',
  'evento publico',
  'agecom',
  'campus trindade',
  'florianopolis',
]);

/** Une categorias + tags, baixa caixa, tira ruído/duplicatas, limita a 20. */
export function limparTags(categorias: string[], tags: string[]): string[] {
  const out: string[] = [];
  const vistos = new Set<string>();
  for (const raw of [...categorias, ...tags]) {
    const v = raw.replace(/\s+/g, ' ').trim().toLowerCase();
    if (!v || v.length > 60) continue;
    const chave = normalizar(v);
    if (TAG_RUIDO.has(chave) || vistos.has(chave)) continue;
    vistos.add(chave);
    out.push(v);
    if (out.length >= 20) break;
  }
  return out;
}
