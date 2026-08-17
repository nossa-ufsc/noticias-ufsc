// VEVENT do Time.ly → linha do contrato do app (UfscEventRow). Puro: sem rede, sem
// relógio (o `agora` é injetado para os testes serem determinísticos).

import { detectarCampus, limparLocal } from './campus.js';
import { classificar, limparTags } from './categorias.js';
import { toInterval } from './dates.js';
import { htmlParaTexto, textoPuro } from './html.js';
import { dateProp, text, textList, type IcalEvent } from './ical.js';
import type { FeedSource, UfscEventRow } from './types.js';

export type Selecao =
  | { ok: true; row: UfscEventRow }
  | { ok: false; motivo: 'sem-uid' | 'sem-titulo' | 'sem-data' | 'ja-passou' | 'muito-longe' | 'erro'; detalhe?: string };

const JANELA_PASSADO_MS = 1 * 86_400_000; // mantém eventos que terminaram há < 1 dia
const JANELA_FUTURO_MS = 120 * 86_400_000; // e que começam em < 120 dias

/** UID "ai1ec-263721@noticias.paginas.ufsc.br" → "263721". */
export function idDoUid(uid: string): string | null {
  const m = /^ai1ec-(\d+)@/.exec(uid.trim());
  return m ? m[1] : null;
}

/**
 * X-WP-IMAGES-URL (já sem escapes): "thumbnail;url;w;h;crop,medium;url;w;h;crop,large;url;w;h;crop"
 * → melhor URL (large > medium > thumbnail) restrita aos hosts confiáveis.
 */
export function melhorImagem(raw: string, hosts: string[]): string | null {
  if (!raw) return null;
  const porTamanho = new Map<string, string>();
  for (const parte of raw.split(',')) {
    const campos = parte.split(';').map((c) => c.trim());
    const [nome, url] = campos;
    if (nome && url && hostConfiavel(url, hosts)) porTamanho.set(nome, url);
  }
  return porTamanho.get('large') ?? porTamanho.get('medium') ?? porTamanho.get('thumbnail') ?? null;
}

export function hostConfiavel(url: string, hosts: string[]): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    const h = u.hostname.toLowerCase();
    return hosts.some((ok) => h === ok || h.endsWith(`.${ok}`));
  } catch {
    return false;
  }
}

function httpsOuNull(url: string): string | null {
  try {
    const u = new URL(url.trim());
    return u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Força https em links http do próprio site (o feed mistura). */
function paraHttps(url: string): string {
  return url.replace(/^http:\/\//i, 'https://');
}

export function normalizarEvento(
  ev: IcalEvent,
  fonte: FeedSource,
  agora: number,
  fallbackImagem: string
): Selecao {
  try {
    const id = idDoUid(text(ev, 'UID'));
    if (!id) return { ok: false, motivo: 'sem-uid' };

    const nome = text(ev, 'SUMMARY').slice(0, 300);
    if (!nome) return { ok: false, motivo: 'sem-titulo', detalhe: id };

    const inicio = dateProp(ev, 'DTSTART');
    if (!inicio) return { ok: false, motivo: 'sem-data', detalhe: id };
    const { start, end, allDay } = toInterval(inicio, dateProp(ev, 'DTEND'));

    if (new Date(end).getTime() < agora - JANELA_PASSADO_MS) return { ok: false, motivo: 'ja-passou' };
    if (new Date(start).getTime() > agora + JANELA_FUTURO_MS) return { ok: false, motivo: 'muito-longe' };

    const categorias = textList(ev, 'CATEGORIES');
    const tags = textList(ev, 'X-TAGS');
    const descHtml = text(ev, 'X-ALT-DESC');
    const descricao = descHtml ? htmlParaTexto(descHtml) : textoPuro(text(ev, 'DESCRIPTION'));

    const locationRaw = text(ev, 'LOCATION');
    const location = limparLocal(locationRaw, `${nome} ${tags.join(' ')} ${descricao.slice(0, 400)}`);
    const campus = detectarCampus(locationRaw, nome, fonte.campusPadrao);

    const imagem = melhorImagem(text(ev, 'X-WP-IMAGES-URL'), fonte.hosts);
    const permalink = text(ev, 'URL');
    const info_url = permalink && hostConfiavel(permalink, fonte.hosts) ? paraHttps(permalink) : null;

    const custoTipo = text(ev, 'X-COST-TYPE').toLowerCase();
    const custo = text(ev, 'X-COST');
    const is_free = custoTipo === 'free' ? true : /\d/.test(custo) ? false : null;

    const row: UfscEventRow = {
      source_id: `${fonte.id}:${id}`,
      name: nome,
      start_date: start,
      end_date: end,
      location,
      campus,
      image_url: imagem ? paraHttps(imagem) : fallbackImagem,
      ticket_url: httpsOuNull(text(ev, 'X-TICKETS-URL')),
      info_url,
      description: descricao || null,
      tags: limparTags(categorias, tags),
      category: classificar(categorias, tags, nome),
      is_free,
      is_all_day: allDay,
    };
    return { ok: true, row };
  } catch (e) {
    return { ok: false, motivo: 'erro', detalhe: e instanceof Error ? e.message : String(e) };
  }
}
