// Datas do feed (horário de Brasília) → ISO UTC. Sem lib de timezone: o Brasil não
// tem mais horário de verão desde 2019, então America/Sao_Paulo é UTC-3 fixo.
// (O feed carrega um VTIMEZONE que confirma: só STANDARD -0300 desde 2019.)

import type { IcalDate } from './ical.js';

const BRT_OFFSET = '-03:00';

/** 'YYYYMMDD' + 'HHMM' (BRT) → ISO UTC. */
export function brtToIso(date: string, time: string, seconds = '00'): string {
  const y = date.slice(0, 4);
  const mo = date.slice(4, 6);
  const d = date.slice(6, 8);
  const hh = time.slice(0, 2);
  const mm = time.slice(2, 4);
  const iso = new Date(`${y}-${mo}-${d}T${hh}:${mm}:${seconds}${BRT_OFFSET}`);
  if (Number.isNaN(iso.getTime())) throw new Error(`data inválida: ${date}T${time}`);
  return iso.toISOString();
}

/** Soma dias a 'YYYYMMDD' (aritmética em UTC, só troca o dia do calendário). */
export function addDays(date: string, days: number): string {
  const d = new Date(Date.UTC(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8)));
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

export type Interval = { start: string; end: string; allDay: boolean };

/**
 * DTSTART/DTEND → intervalo ISO UTC.
 * - VALUE=DATE (dia inteiro): DTEND é EXCLUSIVO no RFC; gravamos end INCLUSIVO
 *   (23:59:59 do último dia) porque o app filtra `end_date >= now` e mostra faixas.
 * - Com hora e sem DTEND: assume 2h de duração.
 * - Datas com sufixo Z (UTC) são convertidas direto.
 */
const TZIDS_OK = new Set([null, 'UTC', 'America/Sao_Paulo']);

export function toInterval(start: IcalDate, end: IcalDate | null): Interval {
  // Qualquer outro fuso viraria BRT em silêncio (horas erradas sem aviso).
  for (const d of [start, end]) {
    if (d && !TZIDS_OK.has(d.tzid)) throw new Error(`TZID não suportado: ${d.tzid}`);
  }
  if (!start.time) {
    const last = end && !end.time ? addDays(end.date, -1) : start.date;
    const lastSafe = last < start.date ? start.date : last;
    return {
      start: brtToIso(start.date, '0000'),
      end: brtToIso(lastSafe, '2359', '59'),
      allDay: true,
    };
  }
  const startIso = start.tzid === 'UTC' ? utcToIso(start.date, start.time) : brtToIso(start.date, start.time);
  let endIso: string;
  if (end?.time) {
    endIso = end.tzid === 'UTC' ? utcToIso(end.date, end.time) : brtToIso(end.date, end.time);
  } else if (end && !end.time) {
    // início com hora + fim só data (raro): fim = 23:59:59 do último dia
    endIso = brtToIso(addDays(end.date, -1), '2359', '59');
  } else {
    endIso = new Date(new Date(startIso).getTime() + 2 * 3_600_000).toISOString();
  }
  if (endIso <= startIso) endIso = new Date(new Date(startIso).getTime() + 2 * 3_600_000).toISOString();
  return { start: startIso, end: endIso, allDay: false };
}

function utcToIso(date: string, time: string): string {
  return new Date(
    `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${time.slice(0, 2)}:${time.slice(2, 4)}:00Z`
  ).toISOString();
}
