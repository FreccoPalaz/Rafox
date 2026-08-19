# Come collegare frontend e backend

## Il punto da capire prima di tutto

Il backend gira sul tuo computer (`localhost:8080`). Il sito su Netlify sta
su internet. **Non possono parlarsi**: quando qualcuno apre il sito Netlify,
il suo browser cercherebbe `localhost` sul *proprio* computer, non sul tuo.

Quindi si procede in due fasi.

---

## FASE 1 — Tutto in locale (falla oggi)

### 1. Avvia il backend

```powershell
cd C:\Users\Utente\Desktop\Rafox\rafox-backend
pip install -r requirements.txt
$env:RAFOX_JWT_SECRET = "una-stringa-lunga-a-caso-almeno-32-caratteri"
$env:RAFOX_ALLOWED_ORIGINS = "http://localhost:5500,http://127.0.0.1:5500"
uvicorn app.main:app --reload --port 8080
```

Verifica: apri <http://localhost:8080/docs> — deve comparire la
documentazione interattiva.

### 2. Collega il frontend

Apri `rafox-api.js`, riga 19, e cambia:

```javascript
const BASE = 'http://localhost:8080';
```

### 3. Apri il sito in locale (NON con doppio clic)

Il doppio clic apre il file con `file://` e il browser blocca le chiamate.
Serve un piccolo server locale. In VS Code:

- installa l'estensione **Live Server**
- clic destro su `index.html` → **Open with Live Server**

Si aprirà su `http://127.0.0.1:5500` — lo stesso indirizzo che hai messo in
`RAFOX_ALLOWED_ORIGINS`. Se usi una porta diversa, aggiorna quella variabile
e riavvia il backend.

### 4. Provalo

1. Apri l'app → scheda **Bot Live**
2. **Registrati** con email e password → ricevi 10.000 USDT virtuali
3. Il bot è bloccato: il piano predefinito è starter. Promuoviti:

```powershell
cd C:\Users\Utente\Desktop\Rafox\rafox-backend
python scripts/set_plan.py tua@email.it pro
```

4. Nell'app: **Esci** e rientra (il piano è dentro il token)
5. Scegli strategia, strumenti e durata → **Avvia bot**

Chiudi pure il browser: il bot continua a lavorare sul server. Quando
riapri, ritrovi la sessione con il tempo rimanente.

---

## FASE 2 — Backend online (quando la Fase 1 funziona)

Il backend va pubblicato su un servizio che gli dia un indirizzo HTTPS.
Render ha un piano gratuito che basta per iniziare.

### 1. Pubblica il backend

1. Metti la cartella `rafox-backend` nel repository GitHub e fai push
2. Su <https://render.com> → **New** → **Web Service** → collega il repo
3. Configurazione:
   - **Root Directory**: `rafox-backend`
   - **Build Command**: `pip install -r requirements.txt`
   - **Start Command**: `uvicorn app.main:app --host 0.0.0.0 --port $PORT`
4. Variabili d'ambiente:

| Nome | Valore |
|---|---|
| `RAFOX_JWT_SECRET` | una stringa lunga e casuale (generala, non inventarla) |
| `RAFOX_ALLOWED_ORIGINS` | `https://rafox-trading.netlify.app` |
| `RAFOX_LIVE_TRADING` | `false` |

Render ti darà un indirizzo tipo `https://rafox-api.onrender.com`.

### 2. Punta il frontend lì

In `rafox-api.js`:

```javascript
const BASE = 'https://rafox-api.onrender.com';
```

Poi:

```powershell
git add .
git commit -m "Collegamento al backend"
git push
```

Netlify deploya da solo. Fatto.

### Due avvertenze pratiche

**Il piano gratuito di Render spegne il servizio dopo ~15 minuti di
inattività.** Al primo accesso successivo ci mette 30-60 secondi a
risvegliarsi, e nel frattempo **il bot non sta lavorando**. Per un bot che
deve girare davvero servirà un piano a pagamento, o un servizio che non
sospende.

**SQLite non sopravvive ai riavvii su Render.** Il filesystem viene azzerato
a ogni deploy: utenti e conti sparirebbero. Appena passi dal test a
qualcosa di serio, aggiungi un database PostgreSQL (Render ne offre uno) e
imposta `RAFOX_DATABASE_URL` con la stringa di connessione che ti dà.

---

## Cosa fa ora ogni parte

| Dove | Cosa |
|---|---|
| **Mercati / Portafoglio / Alert** | funzionano senza backend, come prima |
| **Bot Live** | richiede il backend: login, conto demo, sessioni |
| **Server** | decide piano, limiti di rischio, timer ed esecuzione |

Se `BASE` resta `null`, l'app funziona lo stesso: la scheda Bot Live mostra
un avviso e tutto il resto continua a girare.

## Quello che ancora non c'è

- **Nessun pagamento.** Il piano si imposta a mano con `set_plan.py`. Quando
  collegherai Stripe, dovrà essere il webhook del pagamento a impostarlo —
  mai il browser.
- **Nessun trading reale.** `RAFOX_LIVE_TRADING` è `false` e il codice per
  inviare ordini veri non esiste. Prima servono sandbox, test e una verifica
  regolamentare con un professionista.
- **Nessuna gestione delle API key di Binance.** Il pannello che le chiedeva
  è stato tolto: finché non c'è il live, tenere quelle credenziali sarebbe
  solo un rischio senza contropartita.
