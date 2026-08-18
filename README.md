# noticias-ufsc

Pipeline que leva os **eventos oficiais da UFSC** (calendário da Agecom e dos campi) para a aba
Eventos do app [Nossa UFSC](https://github.com/nossa-ufsc/nossa-ufsc). Roda direto no GitHub
Actions (Bun + TypeScript), sem servidor — mesmo modelo do
[cardapios-ufsc](https://github.com/nossa-ufsc/cardapios-ufsc). O nome é amplo de propósito: o
feed de notícias/Divulga UFSC pode entrar aqui depois.

## Como funciona

```
noticias.ufsc.br  ─┐  iCal (.ics)                       Edge Function events-admin
ara.ufsc.br       ─┴──▶ parse → normaliza → valida ──▶ ufsc-upsert (+ ufsc-prune) ──▶ tabela events
                        (src/lib/*)                    (Supabase; força source=ufsc, approved)
```

1. **Fontes** (`src/sources/index.ts`): os sites da UFSC usam o plugin *All-in-One Event Calendar*
   (Time.ly), que exporta iCal em
   `/?plugin=all-in-one-event-calendar&controller=ai1ec_exporter_controller&action=export_events&no_html=true`.
   Hoje: Agecom (institucional, `noticias.ufsc.br/calendario`) e campus Araranguá. Blumenau,
   Planetário e Estrutura têm o plugin mas o feed está vazio; Joinville/Curitibanos não têm.
2. **Parse** (`src/lib/ical.ts`): parser mínimo de RFC 5545 (linhas dobradas, escapes, `VALUE=DATE`).
   Não expande `RRULE` (só a ocorrência-mestre).
3. **Normalização** (`src/lib/normalize.ts`) → contrato `UfscEventRow` (`src/lib/types.ts`):
   | campo | origem |
   |---|---|
   | `source_id` | `agecom:<id>` / `ara:<id>` a partir do `UID ai1ec-<id>@…` |
   | `name` | `SUMMARY` |
   | `start_date` / `end_date` | `DTSTART`/`DTEND` em UTC. Dia inteiro: 00:00 do 1º dia → **23:59:59 do último dia (inclusivo)**, BRT |
   | `location` | `LOCATION` à esquerda do `@`; vazio → `Online` (se houver pista) ou `UFSC` |
   | `campus` | padrão da fonte; `LOCATION`/título citando Joinville/Blumenau/Araranguá/Curitibanos sobrescreve |
   | `image_url` | `X-WP-IMAGES-URL` (large > medium > thumbnail), só `*.ufsc.br`; senão imagem padrão do bucket |
   | `ticket_url` | `X-TICKETS-URL` (inscrições), só https |
   | `info_url` | `URL` (página do evento) |
   | `description` | `X-ALT-DESC` (HTML → texto, ≤ 4000 chars) |
   | `tags` | `CATEGORIES` ∪ `X-TAGS` (minúsculas, sem ruído "ufsc"/"evento") |
   | `category` | `src/lib/categorias.ts`: festa · palestra · curso · cultura · academico · esporte · saude · outro (rótulo da fonte vence o título) |
   | `is_free` | `X-COST-TYPE=free` → true; `X-COST` numérico → false; senão null |
4. **Seleção**: eventos que terminaram há < 1 dia e começam em < 120 dias.
5. **Validação** (`src/lib/validate.ts`): feed vazio, zero futuros na Agecom, `source_id` duplicado,
   datas inválidas ou > 30% sem descrição **falham o job antes de gravar**.
6. **Gravação** (`src/lib/admin.ts`): `POST events-admin { action: 'ufsc-upsert', rows }` em lotes de
   100 e, no fim, `ufsc-prune` (rejeita eventos futuros que sumiram do feed). A function é quem tem a
   service role; este repo só conhece o `PIPELINE_TOKEN`, que autoriza **exclusivamente** essas duas
   ações.

## Rodar local

```bash
bun install
bun test                                            # offline, sobre fixtures/
bun src/index.ts eventos --skip-db --fixture fixtures   # gera data/eventos.json sem rede
bun src/index.ts eventos --skip-db                  # baixa os feeds de verdade, não grava
cp .env.example .env                                # preencha EVENTS_ADMIN_TOKEN
bun src/index.ts eventos --dry-run                  # a function valida e devolve o que gravaria
bun src/index.ts eventos                            # grava + poda
```

Flags: `--source agecom,ara` restringe as fontes; `--fixture <dir>` lê `<dir>/<fonte>.ics`; `--now <iso>` fixa o relógio.
A **poda só roda numa execução completa** (todas as fontes, feed de verdade) — com `--source`/`--fixture` ela é pulada,
e a function poda apenas dentro das fontes enviadas. Rejeições manuais (`reviewed_at` preenchido) nunca são
desfeitas pelo feed; `updated_at` só muda quando o conteúdo muda.

## Workflows

- `eventos.yml` — cron 06:00 e 15:00 BRT (`0 9,18 * * *`) + `workflow_dispatch` (com opção *dry run*).
  Roda os testes, sincroniza e commita `data/eventos.json` + `data/last-run.txt` via **deploy key SSH**
  (push com deploy key conta como atividade e impede o auto-disable de 60 dias do GitHub).
- `keepalive.yml` — heartbeat semanal de backstop.
- `ci.yml` — typecheck + testes + pipeline offline em PRs.

### Secrets do repositório

| secret | valor |
|---|---|
| `EVENTS_ADMIN_URL` | `https://<ref>.supabase.co/functions/v1/events-admin` |
| `EVENTS_ADMIN_TOKEN` | o `PIPELINE_TOKEN` configurado na Edge Function (só ufsc-upsert/ufsc-prune) |
| `NEWS_COMMIT_SSH_KEY` | chave privada da deploy key (com escrita) deste repo |

## Fixtures

`fixtures/agecom.ics` (recorte de julho/2026 em diante) e `fixtures/ara.ics` são snapshots de
2026-08-17 usados pelos testes. Para atualizar: baixe os feeds das URLs em `src/sources/index.ts`.
