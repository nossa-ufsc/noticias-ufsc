// Testes offline sobre os feeds gravados em fixtures/ (snapshot de 2026-08-17).
// `agora` fixo garante determinismo — a janela de seleção não muda com o tempo.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { classificar, limparTags } from '../src/lib/categorias.js';
import { toInterval } from '../src/lib/dates.js';
import { htmlParaTexto } from '../src/lib/html.js';
import { dateProp, parseEvents, text, textList, unescapeText } from '../src/lib/ical.js';
import { idDoUid, melhorImagem, normalizarEvento } from '../src/lib/normalize.js';
import { validarLote } from '../src/lib/validate.js';
import { FONTES } from '../src/sources/index.js';

const AGORA = Date.parse('2026-08-17T15:00:00-03:00');
const FALLBACK = 'https://example.supabase.co/storage/v1/object/public/events/events-images/fallback-ufsc.jpg';
const agecom = parseEvents(readFileSync(new URL('../fixtures/agecom.ics', import.meta.url), 'utf8'));
const ara = parseEvents(readFileSync(new URL('../fixtures/ara.ics', import.meta.url), 'utf8'));

describe('ical', () => {
  test('parseia todos os VEVENTs dos fixtures', () => {
    expect(agecom.length).toBe(62);
    expect(ara.length).toBe(15);
  });

  test('desdobra linhas e desfaz escapes', () => {
    expect(unescapeText('a\\, b\\; c\\nd')).toBe('a, b; c\nd');
    const ev = agecom.find((e) => text(e, 'SUMMARY').startsWith('Concerto Trio'))!;
    expect(text(ev, 'LOCATION')).toBe('Igrejinha da UFSC @ Rua Desembargador Vítor Lima, 117 – Trindade, Florianópolis – SC');
  });

  test('CATEGORIES/X-TAGS separados por vírgula escapada', () => {
    const ev = agecom.find((e) => text(e, 'SUMMARY').startsWith('Concerto Trio'))!;
    expect(textList(ev, 'CATEGORIES')).toEqual(['evento', 'musical']);
  });

  test('DTSTART VALUE=DATE vs com hora', () => {
    const allDay = agecom.find((e) => text(e, 'SUMMARY').startsWith('Exposição: Perder Tudo'))!;
    expect(dateProp(allDay, 'DTSTART')).toEqual({ date: '20260817', time: null, tzid: null });
    const timed = agecom.find((e) => text(e, 'SUMMARY').startsWith('Concerto Trio'))!;
    expect(dateProp(timed, 'DTSTART')?.time).toBe('2000');
  });
});

describe('dates', () => {
  test('dia inteiro: fim inclusivo 23:59:59 BRT', () => {
    const it = toInterval({ date: '20260824', time: null, tzid: null }, { date: '20260829', time: null, tzid: null });
    expect(it).toEqual({ start: '2026-08-24T03:00:00.000Z', end: '2026-08-29T02:59:59.000Z', allDay: true });
  });
  test('com hora e sem DTEND: 2h', () => {
    const it = toInterval({ date: '20260820', time: '2000', tzid: 'America/Sao_Paulo' }, null);
    expect(it).toEqual({ start: '2026-08-20T23:00:00.000Z', end: '2026-08-21T01:00:00.000Z', allDay: false });
  });
  test('fim igual ao início vira 2h', () => {
    const d = { date: '20261005', time: '0800', tzid: null };
    expect(toInterval(d, d).end).toBe('2026-10-05T13:00:00.000Z');
  });
});

describe('categorias', () => {
  test('rótulo da fonte vence o título', () => {
    expect(classificar(['seminário'], [], 'Mostra de cinema')).toBe('palestra');
    expect(classificar(['cinema', 'filme'], [], 'Cineclube')).toBe('cultura');
    expect(classificar([], ['workshop'], 'Reprodução de peixes')).toBe('curso');
    expect(classificar([], [], 'Aula Magna do IELA')).toBe('palestra');
    expect(classificar([], [], 'SEAME')).toBe('outro');
  });
  test('limparTags tira ruído e duplicatas', () => {
    expect(limparTags(['Evento', 'UFSC', 'Palestra'], ['palestra', 'CCE'])).toEqual(['palestra', 'cce']);
  });
});

describe('html', () => {
  test('X-ALT-DESC vira texto com parágrafos', () => {
    const ev = agecom.find((e) => text(e, 'SUMMARY').startsWith('Concerto Trio'))!;
    const t = htmlParaTexto(text(ev, 'X-ALT-DESC'));
    expect(t.startsWith('O projeto Igrejinha Musical apresenta')).toBe(true);
    expect(t).toContain('\n\nO Igrejinha Musical é uma ação');
    expect(t).not.toContain('\\');
    expect(t).not.toContain('<');
  });
});

describe('normalize', () => {
  test('idDoUid e melhorImagem', () => {
    expect(idDoUid('ai1ec-263721@noticias.paginas.ufsc.br')).toBe('263721');
    expect(idDoUid('x')).toBeNull();
    expect(
      melhorImagem('thumbnail;https://noticias.ufsc.br/a-150x150.png;150;150;1,large;https://noticias.ufsc.br/a.png;845;842;', ['ufsc.br'])
    ).toBe('https://noticias.ufsc.br/a.png');
    expect(melhorImagem('large;https://evil.com/a.png;1;1;', ['ufsc.br'])).toBeNull();
  });

  test('seleciona a janela e mapeia campos (Agecom)', () => {
    const rows = agecom.map((e) => normalizarEvento(e, FONTES.agecom, AGORA, FALLBACK)).filter((s) => s.ok).map((s) => s.row);
    expect(rows.length).toBe(26);
    const concerto = rows.find((r) => r.name === 'Concerto Trio Internacional')!;
    expect(concerto).toMatchObject({
      source_id: 'agecom:295280',
      campus: 'florianopolis',
      location: 'Igrejinha da UFSC',
      category: 'cultura',
      is_free: true,
      is_all_day: false,
      ticket_url: null,
      info_url: 'https://noticias.ufsc.br/event/concerto-trio-internacional/',
      start_date: '2026-08-20T23:00:00.000Z',
    });
    expect(concerto.image_url).toMatch(/^https:\/\/noticias\.ufsc\.br\/files\//);
    expect(concerto.tags).toContain('musical');

    const nautidesign = rows.find((r) => r.name.startsWith('Desafio Universitário de Nautidesign'))!;
    expect(nautidesign.campus).toBe('joinville');
    expect(nautidesign.category).toBe('esporte');

    const seguranca = rows.find((r) => r.name === 'Palestra sobre segurança para mulheres')!;
    expect(seguranca.ticket_url).toBe('https://inscricoes.ufsc.br/calemacao4ed');

    const congresso = rows.find((r) => r.name.startsWith('V Congresso Brasileiro'))!;
    expect(congresso.is_free).toBe(false);
  });

  test('ARA usa campus padrão ararangua e fallback de imagem/local', () => {
    const rows = ara.map((e) => normalizarEvento(e, FONTES.ara, AGORA, FALLBACK)).filter((s) => s.ok).map((s) => s.row);
    expect(rows.length).toBe(8);
    for (const r of rows) expect(r.campus).toBe('ararangua');
    const saene = rows.find((r) => r.name === 'SAENE')!;
    expect(saene.location).toBe('UFSC');
    expect(saene.image_url).toBe(FALLBACK);
    expect(saene.is_all_day).toBe(true);
    expect(saene.start_date).toBe('2026-08-31T03:00:00.000Z');
    expect(saene.end_date).toBe('2026-09-05T02:59:59.000Z');
  });

  test('validarLote aceita o lote real e rejeita duplicata', () => {
    const rows = agecom.map((e) => normalizarEvento(e, FONTES.agecom, AGORA, FALLBACK)).filter((s) => s.ok).map((s) => s.row);
    const stats = [{ fonte: 'agecom' as const, totalNoFeed: agecom.length, selecionados: rows.length, ignorados: {}, erros: [] }];
    expect(() => validarLote(rows, stats)).not.toThrow();
    expect(() => validarLote([...rows, rows[0]], stats)).toThrow(/duplicado/);
    expect(() => validarLote([], [{ ...stats[0], selecionados: 0 }])).toThrow(/nenhum evento futuro/);
  });
});
