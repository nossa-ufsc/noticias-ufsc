// Planos B/C (arquivo /event/, widget + páginas de evento) sobre HTML gravado em
// fixtures/html/ (2026-11-24).

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { coletarFonte, eventosDoArquivo, type Baixar } from '../src/lib/coleta.js';
import { eventoDaPagina, linksDoArquivo, linksDoWidget } from '../src/lib/pagina.js';
import { normalizarEvento } from '../src/lib/normalize.js';
import { FONTES } from '../src/sources/index.js';

const html = (f: string) => readFileSync(new URL(`../fixtures/html/${f}`, import.meta.url), 'utf8');
const AGORA = Date.parse('2026-11-24T16:00:00-03:00');

describe('widget de agenda', () => {
  test('um link por post, só do próprio host, em https', () => {
    const links = linksDoWidget(html('agecom-home.html'), 'noticias.ufsc.br');
    expect(links.length).toBe(27);
    expect(new Set(links.map((l) => l.postId)).size).toBe(27);
    // recorrente (4 ocorrências no widget) entra uma vez, com a primeira ocorrência
    expect(links[0]).toEqual({
      postId: '298456',
      url: 'https://noticias.ufsc.br/event/26o-congresso-brasileiro-de-engenharia-e-ciencia-dos-materiais/?instance_id=7053',
    });
    expect(linksDoWidget(html('agecom-home.html'), 'ara.ufsc.br')).toEqual([]);
    expect(linksDoWidget(html('ara-home.html'), 'ara.ufsc.br')).toEqual([
      { postId: '24354', url: 'https://ara.ufsc.br/event/colacao-de-grau-202602/?instance_id=6009' },
    ]);
  });
});

describe('arquivo /event/', () => {
  const ARQUIVO = 'https://noticias.ufsc.br/event/';

  test('links de evento do próprio host, sem query, sem repetir, sem paginação', () => {
    const links = linksDoArquivo(html('agecom-arquivo.html'), 'noticias.ufsc.br');
    expect(links.length).toBe(39);
    expect(new Set(links.map((l) => l.url)).size).toBe(39);
    for (const l of links) expect(l.url).toMatch(/^https:\/\/noticias\.ufsc\.br\/event\/[^/?#]+\/$/);
    expect(linksDoArquivo(html('agecom-arquivo.html'), 'ara.ufsc.br')).toEqual([]);
  });

  test('pagina até não ter links novos', async () => {
    const pedidas: string[] = [];
    const baixar: Baixar = async (url) => {
      pedidas.push(url);
      if (url === ARQUIVO || url.endsWith('/event/page/2/')) return html('agecom-arquivo.html');
      return html('agecom-evento.html');
    };
    const r = await eventosDoArquivo(FONTES.agecom, AGORA, baixar, 0);
    expect(r.paginas).toBe(2); // a página 2 só repete links já vistos → para
    expect(r.eventos.length).toBe(39);
    expect(pedidas.filter((u) => u.includes('/event/page/')).length).toBe(1);
  });

  test('404 numa página além da primeira = fim do arquivo, não erro', async () => {
    const baixar: Baixar = async (url) => {
      if (url === ARQUIVO) return html('agecom-arquivo.html');
      if (url.includes('/event/page/')) throw new Error(`GET ${url} -> HTTP 404`);
      return html('agecom-evento.html');
    };
    const r = await eventosDoArquivo(FONTES.agecom, AGORA, baixar, 0);
    expect(r.paginas).toBe(1); // só a 1ª foi lida; a 2ª deu 404 e encerrou
    expect(r.eventos.length).toBe(39);
  });

  test('para na primeira página em que todos os eventos já passaram', async () => {
    const baixar: Baixar = async (url) =>
      url === ARQUIVO ? html('agecom-arquivo.html') : html('agecom-evento.html');
    const r = await eventosDoArquivo(FONTES.agecom, Date.parse('2027-06-01T12:00:00-03:00'), baixar, 0);
    expect(r.paginas).toBe(1);
  });

  test('export derrubado → plano B pelo arquivo, parcial', async () => {
    const baixar: Baixar = async (url) => {
      if (url.includes('ai1ec_exporter_controller')) throw new Error('ECONNRESET');
      if (url === ARQUIVO) return html('agecom-arquivo.html');
      if (url.includes('/event/page/')) return '<html></html>';
      if (url.includes('processos-criativos')) return html('agecom-evento.html');
      throw new Error('HTTP 404');
    };
    const c = await coletarFonte(FONTES.agecom, AGORA, { baixar, pausaMs: 0, log: () => {} });
    expect(c).toMatchObject({ modo: 'arquivo', completa: false });
    expect(c.rows.map((r) => r.source_id)).toEqual(['agecom:296383']);
  });
});

describe('página de evento → mesma linha que o iCal geraria', () => {
  test('evento com hora', () => {
    const sel = normalizarEvento(eventoDaPagina(html('agecom-evento.html'), 'noticias.ufsc.br'), FONTES.agecom, AGORA);
    if (!sel.ok) throw new Error(sel.motivo);
    expect(sel.row).toMatchObject({
      source_id: 'agecom:296383',
      name: 'Cine Meridianum – O Nome da Rosa',
      start_date: '2026-11-26T17:00:00.000Z',
      end_date: '2026-11-26T17:15:00.000Z',
      location: 'Auditório do Bloco E, do Centro de Filosofia e Ciências Humanas (CFH)',
      campus: 'florianopolis',
      image_url: 'https://noticias.ufsc.br/files/2026/09/o-nome-da-rosa-768x1085.jpg',
      info_url: 'https://noticias.ufsc.br/event/cine-meridianum-o-nome-da-rosa/',
      category: 'palestra', // "debate" pesa mais que "cinema" no classificador (igual ao iCal)
      is_free: true,
      is_all_day: false,
    });
    expect(sel.row.tags).toEqual(expect.arrayContaining(['cinema', 'debate', 'cine meridianum']));
    expect(sel.row.description).toStartWith('O Cine Meridianum, promovido pelo');
    expect(sel.row.description).toContain('\n\nSinopse\n\n');
    expect(sel.row.description).not.toContain('Quando:'); // bloco de detalhes do plugin fica de fora
  });

  test('dia inteiro: fim inclusivo e sem imagem genérica', () => {
    const ev = eventoDaPagina(html('agecom-evento-dia-inteiro.html'), 'noticias.ufsc.br');
    const sel = normalizarEvento(ev, FONTES.agecom, AGORA);
    if (!sel.ok) throw new Error(sel.motivo);
    expect(sel.row).toMatchObject({
      source_id: 'agecom:298456',
      start_date: '2026-11-24T03:00:00.000Z',
      end_date: '2026-11-25T02:59:59.000Z',
      is_all_day: true,
      location: 'UFSC',
      image_url: '', // og:image é o brasão padrão do site, não do evento
    });
    expect(sel.row.tags).toContain('congresso');
  });

  test('página que não é de evento lança', () => {
    expect(() => eventoDaPagina(html('ara-home.html'), 'ara.ufsc.br')).toThrow(/ai1ec-single-event/);
  });
});

describe('coletarFonte', () => {
  const ICS = readFileSync(new URL('../fixtures/ara.ics', import.meta.url), 'utf8');

  test('export ok → modo ical, completa', async () => {
    const baixar: Baixar = async () => ICS;
    const c = await coletarFonte(FONTES.ara, Date.parse('2026-08-17T15:00:00-03:00'), { baixar, log: () => {} });
    expect(c).toMatchObject({ modo: 'ical', completa: true });
    expect(c.rows.length).toBe(8);
  });

  test('export e arquivo derrubados → plano C pelo widget, parcial; página quebrada é pulada', async () => {
    const pedidas: string[] = [];
    const baixar: Baixar = async (url) => {
      pedidas.push(url);
      if (url.includes('ai1ec_exporter_controller')) throw new Error('ECONNRESET');
      if (url === 'https://noticias.ufsc.br/') return html('agecom-home.html');
      if (url.includes('cine-meridianum-o-nome-da-rosa')) return html('agecom-evento.html');
      if (url.includes('26o-congresso')) return html('agecom-evento-dia-inteiro.html');
      throw new Error('HTTP 404');
    };
    const logs: string[] = [];
    const c = await coletarFonte(FONTES.agecom, AGORA, { baixar, pausaMs: 0, log: (s) => logs.push(s) });
    expect(c).toMatchObject({ modo: 'html', completa: false });
    expect(c.rows.map((r) => r.source_id).sort()).toEqual(['agecom:296383', 'agecom:298456']);
    expect(c.stats.totalNoFeed).toBe(2);
    expect(c.stats.erros.length).toBe(25);
    expect(pedidas.length).toBe(1 + 1 + 1 + 27); // export, arquivo, home, 27 páginas
    expect(logs[0]).toContain('plano B');
  });

  test('export, arquivo e home fora → erro com os três motivos', async () => {
    const baixar: Baixar = async (url) => {
      throw new Error(url.includes('exporter') ? 'ECONNRESET' : 'HTTP 403');
    };
    expect(coletarFonte(FONTES.agecom, AGORA, { baixar, log: () => {} })).rejects.toThrow(
      'iCal: ECONNRESET | arquivo: HTTP 403 | widget: HTTP 403'
    );
  });
});
