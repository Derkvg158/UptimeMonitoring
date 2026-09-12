# Uptime-monitor via GitHub Actions

Controleert je websites elke paar minuten vanaf GitHub's servers, houdt een
geschiedenis bij, toont een statuspagina en waarschuwt je per Telegram en e-mail
zodra er iets omvalt.

Wat er per site gecontroleerd wordt:

- of de site antwoordt, en met welke HTTP-status
- hoe snel (bij trage reacties kleurt de pagina oranje, dat is geen storing)
- of er geen foutmelding in de pagina staat terwijl de status wel 200 is — zo vang
  je een WordPress- of Concrete-site die "draait" maar een Fatal error toont
- hoe lang het SSL-certificaat nog geldig is, met een waarschuwing vanaf 14 dagen

Een site wordt pas als storing gemeld na twee mislukte pogingen met 8 seconden
ertussen. Meldingen komen alleen bij een *verandering*: één bericht als de site
omvalt, één als hij terug is. Geen herhaling elke ronde.

## Opzetten

**1. Repository aanmaken**

Maak op GitHub een nieuwe repository, bijvoorbeeld `uptime`, en zet hem op
**Public**. Dat is belangrijk: op publieke repositories zijn Actions-minuten en
GitHub Pages gratis, op private niet. Er staat niets gevoeligs in — alleen de
adressen van je eigen websites.

Upload de inhoud van deze map naar de repository (drag-and-drop via de knop
"Add file" werkt, of met git).

**2. Je sites invullen**

In `monitors.json` staan BPCF, Overlast van wespen en Je Grote Dag al klaar.
Controleer of de URL's kloppen (mét of zónder `www`, precies zoals je site
draait) en voeg de rest toe:

```json
{
  "name": "Testverhuur",
  "url": "https://www.voorbeeld.nl/",
  "mustContain": "Offerte aanvragen",
  "mustNotContain": ["Fatal error"],
  "slowMs": 4000
}
```

`mustContain` is nuttig om te bewaken dat een belangrijk element nog bestaat,
bijvoorbeeld je contactformulier of offerteknop. Laat weg wat je niet nodig hebt.

**3. Statuspagina aanzetten**

Settings → Pages → Source: *Deploy from a branch*, branch `main`, map `/docs`.
Na een minuut staat je overzicht op `https://<gebruikersnaam>.github.io/uptime/`.

**4. Telegram-meldingen**

1. Zoek in Telegram op **@BotFather**, stuur `/newbot` en verzin een naam. Je
   krijgt een token terug (lange string met een dubbele punt erin).
2. Stuur je nieuwe bot zelf een berichtje (anders mag hij jou niets sturen).
3. Open `https://api.telegram.org/bot<TOKEN>/getUpdates` in je browser en zoek
   het getal achter `"chat":{"id":`. Dat is je chat-id.
4. In de repository: Settings → Secrets and variables → Actions → New repository
   secret. Voeg toe: `TELEGRAM_BOT_TOKEN` en `TELEGRAM_CHAT_ID`.

Wil je de meldingen ook bij een collega laten binnenkomen: maak een Telegram-groep,
zet de bot erin, en gebruik het groeps-id (begint met een min-teken).

**5. E-mailmeldingen**

Voeg deze secrets toe met de SMTP-gegevens van je eigen mailhosting:

| Secret | Voorbeeld |
|---|---|
| `MAIL_HOST` | `smtp.jouwhosting.nl` |
| `MAIL_PORT` | `465` |
| `MAIL_USER` | `monitor@bpcf.nl` |
| `MAIL_PASS` | wachtwoord van dat mailadres |
| `MAIL_TO` | `info@bpcf.nl` |

Gebruik bij voorkeur een apart mailadres, geen adres waar je zelf op werkt.
Bij Gmail werkt dit alleen met een app-wachtwoord, niet met je gewone wachtwoord.

Wil je geen SMTP instellen: laat de mailstap staan zonder secrets (hij slaat
zichzelf dan over) en zet in plaats daarvan Watch → Custom → Actions aan op de
repository. GitHub mailt je dan bij een mislukte workflow. Minder precies, maar
nul configuratie.

**6. Proefdraaien**

Tabblad Actions → *Uptime check* → *Run workflow*. De eerste run maakt
`docs/status.json` aan en vult de statuspagina.

## Waar je rekening mee moet houden

**De interval is niet strak.** De cron staat op elke 5 minuten, maar GitHub voert
geplande workflows uit wanneer er capaciteit is. In de praktijk is dat elke 5 tot
15 minuten, soms trager op drukke momenten. Voor "is mijn site vannacht een uur
plat geweest" is dat prima. Heb je alarm binnen een minuut nodig, dan is een
betaalde dienst de juiste keuze.

**Geplande workflows vallen stil bij een slapende repository.** GitHub schakelt de
cron uit na 60 dagen zonder activiteit. Deze monitor commit elke run zijn
resultaten, wat als activiteit telt, maar GitHub stuurt je sowieso een mail
voordat hij iets uitzet — één klik en hij loopt weer.

**Elke run maakt een commit.** Bij 5 minuten zijn dat een paar duizend commits per
maand. Dat is normaal voor dit soort monitors en kost je niets, maar je
commitgeschiedenis wordt er wel onleesbaar van. Zet de cron op `*/15` als je dat
storend vindt.

**Het controleert bereikbaarheid, niet correctheid.** Een site die een verkeerd
telefoonnummer toont of waarvan het contactformulier geen mail verstuurt, ziet
deze monitor als gezond. Voor het formulier zelf blijft een testaanvraag per
maand de enige echte controle.
