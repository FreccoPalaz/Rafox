# Piano: sessioni bot indipendenti in parallelo

**Obiettivo**: permettere più `BotSession` attive contemporaneamente sullo
stesso conto, ciascuna con la propria strategia, simboli e durata —
senza che si influenzino a vicenda su rischio, capitale o stop.

**Stato attuale**: una sola sessione attiva per conto (vincolo esplicito
in `bot.py`). Multi-asset FUNZIONA GIA' ma solo dentro un'unica sessione,
con strategia condivisa.

**Da fare solo dopo**: che la versione a sessione singola sia stabile e
usata in produzione per un periodo di osservazione.

---

## Fase 1 — Modello dati (`models.py`)

Decisione di prodotto da prendere prima di scrivere codice:

- **Opzione A — capitale condiviso**: tutte le sessioni attive attingono
  dalla stessa equity di conto (rischio: una sessione può "affamare"
  l'altra, i limiti di perdita giornaliera si sommano in modo poco
  intuitivo).
- **Opzione B — capitale riservato per sessione** *(consigliata)*: ogni
  sessione, all'avvio, riserva una fetta di equity (`allocated_capital`)
  che il resto del conto non può più usare finché la sessione non finisce.
  Più semplice da spiegare all'utente ("hai riservato 1000 USDT a questa
  sessione") e coerente con "rischio 2% per operazione" per strategia.

Modifiche a `BotSession`:
- Nuovo campo `allocated_capital: float`
- La colonna `symbols`/`session_id` su `Position`/`Order` restano invariate,
  già pronte

## Fase 2 — Risk engine (`risk.py`)

- `equity()`, `open_positions()`, `realized_pnl_today()` vanno rese
  filtrabili per `session_id`, non solo `account_id`
- Con Opzione B: `equity` di una sessione = `allocated_capital` + valore
  di mercato delle SUE SOLE posizioni aperte (non quelle di altre sessioni)
- `vet_entry()` va richiamato con equity/esposizione/perdita-giornaliera
  della singola sessione, non dell'intero conto
- Decisione da prendere: il limite di perdita giornaliera resta anche
  un "interruttore generale" a livello di conto (somma di tutte le
  sessioni), oltre a quello per singola sessione? Consigliato sì, come
  rete di sicurezza aggiuntiva.

## Fase 3 — Motore (`engine.py`)

- **Fix critico**: `_manage_open_positions` oggi scorre
  `risk.open_positions(db, account.id)` — va cambiato in
  `risk.open_positions(db, account.id, session_id=session.id)`, altrimenti
  una sessione applica il proprio `trail_pct` anche alle posizioni
  dell'altra
- `close_all()` e `finish_session()` vanno vincolati alla sessione
  specifica: fermare una sessione non deve liquidare le posizioni di
  un'altra sessione attiva sullo stesso conto

## Fase 4 — API backend (`bot.py`)

- Rimuovere il blocco rigido "una sessione attiva per conto"; sostituirlo
  con un controllo su capacità disponibile (capitale libero, numero
  massimo di sessioni parallele consentite dal piano)
- **Nuova dimensione di piano da decidere**: quante sessioni parallele
  indipendenti concede ciascun piano (oggi PLAN_LIMITS regola solo
  simboli-per-sessione, non sessioni-per-conto). Es. ipotesi:
  Free/Beginner = 1, Pro = 2, Elite = 3+ — da decidere come scelta di
  business, non tecnica
- `/bot/status` deve diventare una lista (tutte le sessioni attive del
  conto), non più un singolo oggetto
- `/bot/stop` e `/bot/close-all` devono accettare `session_id` per
  colpire una sessione specifica, non "quella" del conto

## Fase 5 — Frontend (`app.html`, `rafox-api.js`)

- Il pannello "Bot Live" diventa una lista di card, una per sessione
  attiva, ciascuna con il proprio stato/log/pulsanti stop
- Decisione da prendere: si può selezionare lo stesso simbolo in due
  sessioni diverse contemporaneamente? Consigliato no, per evitare
  ambiguità su quale sessione "possiede" quella posizione
- Aggiornare `botStatus`, `botStart`, `botStop`, `botCloseAll` in
  `rafox-api.js` per il nuovo formato a lista e il parametro `session_id`

## Fase 6 — Test e rilascio

- Prima solo su conto demo (paper trading), verificando in particolare
  che due sessioni con `trail_pct` diversi non si scambino gli stop —
  è esattamente il bug che abbiamo individuato nella versione attuale
- Rilascio graduale: prima Elite, osservazione, poi Pro

---

## Testo del sito da rivedere insieme a Gemini

Se si decide di implementare questo, andrà anche aggiornato il testo dei
piani su `index.html` per distinguere chiaramente "asset in parallelo
nella stessa sessione" (già vero oggi) da "sessioni/strategie
indipendenti in parallelo" (funzione nuova, da questo piano).
