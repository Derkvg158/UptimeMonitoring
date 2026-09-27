#!/usr/bin/env bash
# Draait de controle in rondes van INTERVAL_SECONDS, net zo lang als
# DURATION_MINUTES aangeeft. Na elke ronde: resultaten committen en zo nodig
# een mail versturen. Zo hangt de meetfrequentie niet meer af van hoe vaak
# GitHub de geplande workflow wil starten.
set -uo pipefail

INTERVAL_SECONDS="${INTERVAL_SECONDS:-300}"
DURATION_MINUTES="${DURATION_MINUTES:-0}"
deadline=$(( $(date +%s) + DURATION_MINUTES * 60 ))

git config user.name "uptime-bot"
git config user.email "uptime-bot@users.noreply.github.com"

commit_results() {
  git add docs/
  git diff --quiet --staged && return 0
  git commit -q -m "status $(date -u +'%Y-%m-%d %H:%M')"
  for attempt in 1 2 3; do
    git pull -q --rebase -X theirs && git push -q && return 0
    sleep $(( attempt * 5 ))
  done
  echo "::warning::Resultaten konden niet gepusht worden"
}

send_mail() {
  [ -f alert.txt ] || return 0
  if [ -z "${MAIL_HOST:-}" ] || [ -z "${MAIL_TO:-}" ]; then
    rm -f alert.txt
    return 0
  fi
  local port="${MAIL_PORT:-465}" scheme="smtps" extra=()
  if [ "$port" != "465" ]; then scheme="smtp"; extra=(--ssl-reqd); fi
  local subject
  subject="=?UTF-8?B?$(head -n 1 alert.txt | base64 -w0)?="
  {
    echo "From: Uptime monitor <${MAIL_USER}>"
    echo "To: ${MAIL_TO}"
    echo "Subject: ${subject}"
    echo "Date: $(date -R)"
    echo "MIME-Version: 1.0"
    echo "Content-Type: text/plain; charset=UTF-8"
    echo "Content-Transfer-Encoding: 8bit"
    echo
    tail -n +3 alert.txt
  } > mail.eml
  # MAIL_TO mag meerdere adressen bevatten, gescheiden door komma's.
  local rcpts=()
  IFS=',' read -ra addrs <<< "$MAIL_TO"
  for a in "${addrs[@]}"; do rcpts+=(--mail-rcpt "$(echo "$a" | xargs)"); done
  curl -sS --max-time 30 "${extra[@]}" \
    --url "${scheme}://${MAIL_HOST}:${port}" \
    --user "${MAIL_USER}:${MAIL_PASS}" \
    --mail-from "${MAIL_USER}" "${rcpts[@]}" \
    --upload-file mail.eml \
    || echo "::warning::E-mail versturen mislukt"
  rm -f alert.txt mail.eml
}

while true; do
  started=$(date +%s)
  node scripts/check.mjs || echo "::warning::Controle-script faalde"
  commit_results
  send_mail

  next=$(( started + INTERVAL_SECONDS ))
  [ "$next" -ge "$deadline" ] && break
  sleep $(( next - $(date +%s) > 0 ? next - $(date +%s) : 0 ))
done
