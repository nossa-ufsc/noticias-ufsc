// X-ALT-DESC (HTML) → texto corrido para a tela de detalhes do app.
// Tira o avatar que o plugin injeta no começo, preserva quebras de parágrafo/lista,
// colapsa espaços e limita o tamanho.

import * as cheerio from 'cheerio';

const MAX_CHARS = 4000;

export function htmlParaTexto(html: string): string {
  if (!html) return '';
  // O Time.ly serializa o HTML com "\\n" literais entre as tags; viram quebras reais.
  const $ = cheerio.load(html.replace(/\\n/g, '\n').replace(/\\(?=\s*\n)/g, ''));
  $('script, style, .ai1ec-event-avatar, img').remove();
  // Quebras estruturais viram \n antes de extrair o texto.
  $('br').replaceWith('\n');
  $('p, div, li, h1, h2, h3, h4, h5, h6, blockquote, tr').each((_, el) => {
    $(el).prepend('\n').append('\n');
  });
  $('li').each((_, el) => {
    $(el).prepend('• ');
  });
  const texto = $.root()
    .text()
    .replace(/ /g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return truncar(texto, MAX_CHARS);
}

/** DESCRIPTION (texto puro do feed) — só normaliza espaços/quebras. */
export function textoPuro(s: string): string {
  return truncar(
    s
      .replace(/\r/g, '')
      .replace(/[ \t]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
    MAX_CHARS
  );
}

function truncar(s: string, max: number): string {
  if (s.length <= max) return s;
  const corte = s.lastIndexOf(' ', max - 1);
  return `${s.slice(0, corte > max * 0.8 ? corte : max - 1).trimEnd()}…`;
}
