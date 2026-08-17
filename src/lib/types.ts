// Contrato com a Edge Function `events-admin` (ação `ufsc-upsert`) do Supabase do app.
// A function revalida tudo e força source='ufsc', status='approved', created_by.

export type Campus = 'florianopolis' | 'joinville' | 'blumenau' | 'ararangua' | 'curitibanos';

export type EventCategory =
  | 'festa'
  | 'palestra'
  | 'curso'
  | 'cultura'
  | 'academico'
  | 'esporte'
  | 'saude'
  | 'outro';

export type UfscEventRow = {
  /** `<fonte>:<id do post>` — chave do upsert junto com source='ufsc'. */
  source_id: string;
  name: string;
  /** ISO 8601 em UTC. Para dia inteiro: 00:00 do primeiro dia (horário de Brasília). */
  start_date: string;
  /** ISO 8601 em UTC. Para dia inteiro: 23:59:59 do ÚLTIMO dia (inclusivo). */
  end_date: string;
  location: string;
  campus: Campus;
  image_url: string;
  /** Link de inscrição/ingresso (X-TICKETS-URL), quando houver. */
  ticket_url: string | null;
  /** Página do evento no site da UFSC. */
  info_url: string | null;
  description: string | null;
  tags: string[] | null;
  category: EventCategory;
  is_free: boolean | null;
  is_all_day: boolean;
};

export type SourceId = 'agecom' | 'ara';

export type FeedSource = {
  id: SourceId;
  nome: string;
  url: string;
  campusPadrao: Campus;
  /** Hosts aceitos para imagens/páginas (o resto vira fallback). */
  hosts: string[];
};

export type PipelineStats = {
  fonte: SourceId;
  totalNoFeed: number;
  selecionados: number;
  ignorados: Record<string, number>;
  erros: string[];
};
