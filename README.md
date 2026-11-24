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
   | `image_url` | `X-WP-IMAGES-URL` (large > medium > thumbnail), só `*.ufsc.br`; senão `""` (o app mostra a imagem padrão empacotada) |
   | `ticket_url` | `X-TICKETS-URL` (inscrições), só https |
   | `info_url` | `URL` (página do evento) |
   | `description` | `X-ALT-DESC` (HTML → texto, ≤ 4000 chars) |
   | `tags` | `CATEGORIES` ∪ `X-TAGS` (minúsculas, sem ruído "ufsc"/"evento") |
   | `category` | `src/lib/categorias.ts`: festa · palestra · curso · cultura · academico · esporte · saude · outro (rótulo da fonte vence o título) |
   | `is_free` | `X-COST-TYPE=free` → true; `X-COST` numérico → false; senão null |
4. **Seleção**: eventos que terminaram há < 1 dia e começam em < 120 dias.
5. **Validação** (`src/lib/validate.ts`), **por fonte**: feed vazio, zero futuros na Agecom, `source_id`
   duplicado, datas inválidas ou > 30% sem descrição **reprovam a fonte antes de gravar** (as outras seguem).
6. **Gravação** (`src/lib/admin.ts`): `POST events-admin { action: 'ufsc-upsert', rows }` em lotes de
   100, uma fonte por vez, e no fim `ufsc-prune` (rejeita eventos futuros que sumiram do feed) **só para as
   fontes coletadas pelo export iCal completo e gravadas com sucesso**. A function é quem tem a
   service role; este repo só conhece o `PIPELINE_TOKEN`, que autoriza **exclusivamente** essas duas
   ações.

## Tolerância a falhas

- **Isolamento por fonte** (`src/lib/sync.ts`): coleta, validação e upsert de cada fonte são
  independentes — a Agecom fora do ar não impede o Araranguá.
- **Rede** (`src/lib/http.ts`): backoff exponencial com jitter (5 s → 15 s → 45 s), prazo total de 6 min
  por URL, 403 não é repetido (é bloqueio, não instabilidade).
- **Plano B** (`src/lib/coleta.ts`, `src/lib/pagina.ts`): se o export iCal cair, a fonte percorre o
  arquivo público `/event/` (`/event/page/N/`, ordenado por publicação, do mais novo ao mais antigo) e
  lê a página de cada evento, montando o mesmo VEVENT; para na primeira página só com eventos que já
  passaram (teto de 12 páginas). Um evento futuro publicado há muito tempo pode ficar de fora, então é
  **parcial e nunca poda**. Motivo: desde 2026-09-28 a UFSC derruba (RST) qualquer requisição ao
  `ai1ec_exporter_controller` e `/calendario/` dá 404, mas `/event/…` segue no ar.
- **Plano C**: se o arquivo também falhar, lê o widget de agenda da home (`paginaEventos`, ~10 dias).
- **Status visível** em `data/eventos.json` (`fontes[].status`, `modo`, `erro`, `ultimoSucesso`) e no
  Actions: fonte que falhou gera `::warning::`, ou `::error::` se está sem sincronizar há ≥ 3 dias;
  coleta parcial gera `::warning::`; tabela no resumo do job. **Exit 1 só se todas as fontes falharem**
  — falha parcial ainda commita o snapshot.

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

- **Cron do VPS** (desde 2026-11-24) — os sites `*.ufsc.br` dão 403 aos runners do GitHub, então a
  sincronização agendada roda em `/opt/noticias-runner/run.sh` (cron 06:00 e 15:00 BRT, log em
  `/var/log/noticias/run.log`, envs em `/opt/secrets/noticias.env`). Ele faz `git reset --hard
  origin/main`, sincroniza e commita `data/` com uma deploy key própria do VPS.
- `eventos.yml` — só `workflow_dispatch` (com opção *dry run*): roda os testes, sincroniza e commita
  `data/eventos.json` + `data/last-run.txt` via **deploy key SSH** (push com deploy key conta como
  atividade e impede o auto-disable de 60 dias do GitHub).
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
`fixtures/html/` (home e arquivo `/event/` da Agecom, home do ARA e duas páginas de evento) são de
2026-11-24 e cobrem os planos B e C.
