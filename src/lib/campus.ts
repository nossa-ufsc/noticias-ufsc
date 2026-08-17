// Descobre o campus a partir do LOCATION/título. O feed da Agecom é institucional
// (padrão Florianópolis) mas anuncia coisas dos outros campi de vez em quando; os
// feeds dos campi (ara.ufsc.br…) já vêm com o campus certo por padrão.

import { normalizar } from './categorias.js';
import type { Campus } from './types.js';

const PISTAS: Array<[Campus, RegExp]> = [
  ['joinville', /\bjoinville\b/],
  ['blumenau', /\bblumenau\b/],
  ['ararangua', /\bararangua\b/],
  ['curitibanos', /\bcuritibanos\b/],
  ['florianopolis', /\b(florianopolis|trindade|itacorubi|floripa)\b/],
];

/** Só LOCATION e título — a descrição cita outros campi com frequência (parcerias). */
export function detectarCampus(location: string, titulo: string, padrao: Campus): Campus {
  const texto = normalizar(`${location} ${titulo}`);
  for (const [campus, re] of PISTAS) if (re.test(texto)) return campus;
  return padrao;
}

/**
 * LOCATION vem como "Auditório X @ Campus Y, Cidade": fica só o lugar (esquerda do @).
 * Se estiver vazio: 'Online' quando as tags/descrição indicam transmissão, senão 'UFSC'.
 */
export function limparLocal(location: string, pistasOnline: string): string {
  let local = location.split('@')[0].replace(/\s+/g, ' ').trim();
  local = local.replace(/[,\s–-]+$/g, '').trim();
  if (local) return local.slice(0, 300);
  if (/\b(online|on-line|youtube|transmiss|remot|virtual|zoom|google meet|webinar|live)\b/i.test(pistasOnline)) {
    return 'Online';
  }
  return 'UFSC';
}
