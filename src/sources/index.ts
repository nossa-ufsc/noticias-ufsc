// Fontes: calendários All-in-One Event Calendar (Time.ly) dos sites da UFSC.
// Mesmo plugin em todos, então é só trocar host/campus. Blumenau, Planetário e
// Estrutura têm o plugin mas o feed está vazio (2026-08); Joinville/Curitibanos não têm.

import type { FeedSource, SourceId } from '../lib/types.js';

const AI1EC_EXPORT =
  '/?plugin=all-in-one-event-calendar&controller=ai1ec_exporter_controller&action=export_events&no_html=true';

export const FONTES: Record<SourceId, FeedSource> = {
  agecom: {
    id: 'agecom',
    nome: 'Agecom (noticias.ufsc.br/calendario)',
    url: `https://noticias.ufsc.br${AI1EC_EXPORT}`,
    campusPadrao: 'florianopolis',
    hosts: ['ufsc.br'],
  },
  ara: {
    id: 'ara',
    nome: 'Campus Araranguá (ara.ufsc.br)',
    // O site redireciona para &lang=pt; o fetch segue.
    url: `https://ara.ufsc.br${AI1EC_EXPORT}&lang=pt`,
    campusPadrao: 'ararangua',
    hosts: ['ufsc.br'],
  },
};

export const FONTES_PADRAO: SourceId[] = ['agecom', 'ara'];
