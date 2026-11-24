// Plano B quando o export iCal está fora do ar: lê o widget "Eventos" da home do site
// (agenda do All-in-One Event Calendar) e a página pública de cada evento, e monta um
// IcalEvent equivalente ao do export — assim normalizarEvento/validarLote valem igual.
//
// Desde 2026-09-28 a UFSC derruba (RST) qualquer requisição ao
// `controller=ai1ec_exporter_controller` e /calendario/ dá 404 no nginx, mas a home e
// as páginas /event/… seguem no ar. Limitação: o widget só mostra os próximos ~10 dias
// (~25 eventos), então uma coleta por aqui é PARCIAL e nunca pode alimentar a poda.

import * as cheerio from 'cheerio';
import type { IcalEvent, IcalProp } from './ical.js';

export type LinkEvento = { postId: string; url: string };

/**
 * Links das páginas de evento listados no(s) widget(s) de agenda, um por post (eventos
 * recorrentes aparecem uma vez por ocorrência; fica a primeira, que é a mais próxima).
 * Só aceita links do mesmo host da página.
 */
export function linksDoWidget(html: string, host: string): LinkEvento[] {
  const $ = cheerio.load(html);
  const porPost = new Map<string, string>();
  $('.ai1ec-agenda-widget-view .ai1ec-event').each((_, el) => {
    const id = /\bai1ec-event-id-(\d+)\b/.exec($(el).attr('class') ?? '')?.[1];
    const href = $(el).find('a.ai1ec-load-event').first().attr('href');
    if (!id || !href || porPost.has(id)) return;
    try {
      const u = new URL(href);
      if (u.hostname !== host) return;
      u.protocol = 'https:';
      porPost.set(id, u.toString());
    } catch {
      // href quebrado: ignora
    }
  });
  return [...porPost].map(([postId, url]) => ({ postId, url }));
}

/**
 * Links das páginas de evento listados no arquivo público /event/ (e /event/page/N/),
 * na ordem da página. O arquivo é ordenado por publicação, do mais novo ao mais
 * antigo — cobre a agenda além dos ~10 dias do widget. Só aceita o mesmo host.
 */
export function linksDoArquivo(html: string, host: string): LinkEvento[] {
  const $ = cheerio.load(html);
  const vistos = new Set<string>();
  const links: LinkEvento[] = [];
  $('a[href]').each((_, el) => {
    try {
      const u = new URL($(el).attr('href') ?? '');
      const slug = /^\/event\/([^/]+)\/?$/.exec(u.pathname)?.[1];
      if (u.hostname !== host || !slug || slug === 'page') return;
      u.protocol = 'https:';
      u.search = '';
      u.hash = '';
      const url = u.toString();
      if (vistos.has(url)) return;
      vistos.add(url);
      links.push({ postId: slug, url });
    } catch {
      // href quebrado: ignora
    }
  });
  return links;
}

/** Escapa TEXT do RFC 5545 (o inverso de unescapeText) para reaproveitar text()/textList(). */
function esc(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

const linha = (value: string, params: Record<string, string> = {}): IcalProp[] => [{ params, value }];

/** "2026-11-26T14:00:00-03:00" → DTSTART/DTEND: dia inteiro vira VALUE=DATE (fim exclusivo, como no iCal). */
function dataIcal(iso: string, diaInteiro: boolean): IcalProp[] | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T/.exec(iso);
  if (!m) return null;
  if (diaInteiro) return linha(`${m[1]}${m[2]}${m[3]}`, { VALUE: 'DATE' });
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return null;
  return linha(`${t.toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`);
}

/** Maior variante do srcset com até 1024 px de largura (o iCal usa a "large"); senão o src. */
function imagemDoConteudo(conteudo: cheerio.Cheerio<any>): string | null {
  const img = conteudo.find('img').first();
  if (!img.length) return null;
  let melhor: { url: string; w: number } | null = null;
  for (const cand of (img.attr('srcset') ?? '').split(',')) {
    const [url, larg] = cand.trim().split(/\s+/);
    const w = Number.parseInt(larg ?? '', 10);
    if (url && w && w <= 1024 && (!melhor || w > melhor.w)) melhor = { url, w };
  }
  return melhor?.url ?? img.attr('src') ?? null;
}

/**
 * Página pública /event/<slug>/ → IcalEvent com as mesmas propriedades que o export
 * preenche (UID, SUMMARY, DTSTART/DTEND, LOCATION, CATEGORIES, X-TAGS, X-ALT-DESC,
 * X-WP-IMAGES-URL, URL, X-COST-TYPE/X-COST). Lança se a página não for de evento.
 */
export function eventoDaPagina(html: string, host: string): IcalEvent {
  const $ = cheerio.load(html);
  const single = $('.ai1ec-single-event').first();
  const postId = /\bai1ec-event-id-(\d+)\b/.exec(single.attr('class') ?? '')?.[1];
  if (!single.length || !postId) throw new Error('página sem .ai1ec-single-event (layout mudou?)');

  const ev: IcalEvent = {};
  ev.UID = linha(`ai1ec-${postId}@${host}`);

  const tituloLink = single.closest('article').find('h2 a').first();
  const titulo =
    tituloLink.text().trim() ||
    ($('meta[property="og:title"]').attr('content') ?? '').replace(/\s*\(\d{4}-\d{2}-\d{2}\)\s*$/, '').trim();
  if (titulo) ev.SUMMARY = linha(esc(titulo));
  const permalink = tituloLink.attr('href');
  if (permalink) ev.URL = linha(permalink);

  const diaInteiro = single.find('.ai1ec-time .ai1ec-allday-badge').length > 0;
  const inicio = dataIcal(single.find('.dt-start').first().text().trim(), diaInteiro);
  const fim = dataIcal(single.find('.dt-end').first().text().trim(), diaInteiro);
  if (inicio) ev.DTSTART = inicio;
  if (fim) ev.DTEND = fim;

  // "Auditório X<br>UFSC - Campus Trindade<br>Florianópolis" → "Auditório X @ UFSC - Campus Trindade, Florianópolis"
  const localEl = single.find('.p-location').first().clone();
  localEl.find('br').replaceWith('\n');
  const [lugar = '', ...endereco] = localEl
    .text()
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (lugar) ev.LOCATION = linha(esc(endereco.length ? `${lugar} @ ${endereco.join(', ')}` : lugar));

  const termos = (sel: string) =>
    single
      .find(sel)
      .map((_, a) => $(a).text().replace(/\s+/g, ' ').trim())
      .get()
      .filter(Boolean)
      .map((t) => ({ params: {}, value: esc(t) }));
  const categorias = termos('.ai1ec-categories a.ai1ec-category');
  const tags = termos('.ai1ec-tags a.ai1ec-tag');
  if (categorias.length) ev.CATEGORIES = categorias;
  if (tags.length) ev['X-TAGS'] = tags;

  const custo = single.find('.ai1ec-cost .ai1ec-field-value').first().text().replace(/\s+/g, ' ').trim();
  if (/^(gr[aá]tis|free|gratuito)$/i.test(custo)) ev['X-COST-TYPE'] = linha('free');
  else if (custo) ev['X-COST'] = linha(esc(custo));

  const ingresso = single.find('a.ai1ec-tickets, .ai1ec-tickets a').first().attr('href');
  if (ingresso) ev['X-TICKETS-URL'] = linha(ingresso);

  // A descrição é o resto do .content, depois do bloco de detalhes do plugin.
  const conteudo = single.parent().clone();
  conteudo.find('.ai1ec-single-event, footer, .ai1ec-event-footer, script, style').remove();
  const imagem = imagemDoConteudo(conteudo);
  if (imagem) ev['X-WP-IMAGES-URL'] = linha(`large;${imagem};0;0;`);
  const descricao = (conteudo.html() ?? '').trim();
  if (descricao) ev['X-ALT-DESC'] = linha(esc(descricao), { FMTTYPE: 'text/html' });

  return ev;
}
