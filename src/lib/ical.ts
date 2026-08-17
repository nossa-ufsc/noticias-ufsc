// Parser mínimo de iCalendar (RFC 5545) — só o que o export do All-in-One Event
// Calendar (Time.ly) da UFSC precisa: desdobrar linhas, separar VEVENTs e ler
// propriedades com parâmetros (VALUE=DATE, TZID, LANGUAGE) e escapes (\, \; \n).
// Não expandimos RRULE: importamos só a ocorrência-mestre (DTSTART) — o feed da
// Agecom tem meia dúzia de recorrentes e o site deles também mostra assim.

export type IcalProp = { params: Record<string, string>; value: string };
export type IcalEvent = Record<string, IcalProp[]>; // nome (MAIÚSCULO) → ocorrências

/** Junta as continuações de linha (linha seguinte começando com espaço/tab). */
export function unfold(text: string): string[] {
  return text
    .replace(/\r\n[ \t]/g, '')
    .replace(/\n[ \t]/g, '')
    .split(/\r?\n/);
}

/** Desfaz os escapes de TEXT do RFC 5545. */
export function unescapeText(v: string): string {
  return v
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

/** "NAME;P1=a;P2=b:valor" → { name, params, value } (valor cru, sem unescape). */
function parseLine(line: string): { name: string; params: Record<string, string>; value: string } | null {
  // O ':' que separa nome+params do valor é o primeiro ':' fora de aspas.
  let i = 0;
  let inQuotes = false;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuotes = !inQuotes;
    else if (c === ':' && !inQuotes) break;
  }
  if (i >= line.length) return null;
  const head = line.slice(0, i);
  const value = line.slice(i + 1);
  const [rawName, ...rawParams] = head.split(';');
  const name = rawName.trim().toUpperCase();
  if (!name) return null;
  const params: Record<string, string> = {};
  for (const p of rawParams) {
    const eq = p.indexOf('=');
    if (eq === -1) continue;
    params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name, params, value };
}

/** Extrai todos os VEVENTs de um .ics. */
export function parseEvents(text: string): IcalEvent[] {
  const events: IcalEvent[] = [];
  let current: IcalEvent | null = null;
  let depth = 0; // ignora componentes aninhados (VALARM) dentro do VEVENT
  for (const line of unfold(text)) {
    if (line === 'BEGIN:VEVENT') {
      current = {};
      depth = 0;
      continue;
    }
    if (!current) continue;
    if (line.startsWith('BEGIN:')) {
      depth++;
      continue;
    }
    if (line.startsWith('END:')) {
      if (depth > 0) {
        depth--;
        continue;
      }
      if (line === 'END:VEVENT') events.push(current);
      current = null;
      continue;
    }
    if (depth > 0) continue;
    const parsed = parseLine(line);
    if (!parsed) continue;
    (current[parsed.name] ??= []).push({ params: parsed.params, value: parsed.value });
  }
  return events;
}

/** Primeira ocorrência de uma propriedade (crua). */
export function prop(ev: IcalEvent, name: string): IcalProp | undefined {
  return ev[name.toUpperCase()]?.[0];
}

/** Valor TEXT já com unescape e espaços colapsados; '' se ausente. */
export function text(ev: IcalEvent, name: string): string {
  const p = prop(ev, name);
  return p ? unescapeText(p.value).replace(/[ \t]+/g, ' ').trim() : '';
}

/**
 * Lista TEXT (CATEGORIES, X-TAGS), podendo aparecer em várias linhas. O Time.ly
 * escapa até a vírgula separadora ("evento\,musical"), então dividimos em QUALQUER
 * vírgula — categorias com vírgula literal não existem na prática.
 */
export function textList(ev: IcalEvent, name: string): string[] {
  const out: string[] = [];
  for (const p of ev[name.toUpperCase()] ?? []) {
    for (const part of p.value.split(/\\?,/)) {
      const v = unescapeText(part).trim();
      if (v) out.push(v);
    }
  }
  return out;
}

export type IcalDate = { date: string; time: string | null; tzid: string | null };

/**
 * DTSTART/DTEND → { date: 'YYYYMMDD', time: 'HHMM' | null (VALUE=DATE), tzid }.
 * Um sufixo 'Z' significa UTC (tzid = 'UTC').
 */
export function dateProp(ev: IcalEvent, name: string): IcalDate | null {
  const p = prop(ev, name);
  if (!p) return null;
  const m = /^(\d{8})(?:T(\d{4})\d{0,2}(Z?))?$/.exec(p.value.trim());
  if (!m) return null;
  const isDate = p.params.VALUE === 'DATE' || !m[2];
  return {
    date: m[1],
    time: isDate ? null : m[2],
    tzid: m[3] ? 'UTC' : (p.params.TZID ?? null),
  };
}
