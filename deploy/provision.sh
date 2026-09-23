#!/usr/bin/env bash
# Provision md-mini.com on an Ubuntu server that already runs Caddy. Run as root:
#
#   bash provision.sh
#
# Idempotent — safe to re-run. Creates the deploy user and its SSH key, prepares
# the web root, drops the site config into /etc/caddy/Caddyfile.d/ and reloads
# Caddy. Prints the deploy private key at the end.
#
# Caddy issues and renews the TLS certificate on its own, so there is no certbot
# and no deploy hook here.

set -euo pipefail

DOMAIN="md-mini.com"
DEPLOY_USER="deploy-mdmini"
WEBROOT="/var/www/${DOMAIN}"
KEY_PATH="/home/${DEPLOY_USER}/.ssh/id_ed25519"
CADDY_MAIN="/etc/caddy/Caddyfile"
CADDY_FRAGMENT_DIR="/etc/caddy/Caddyfile.d"
CADDY_SITE_CONF="${CADDY_FRAGMENT_DIR}/${DOMAIN}.caddy"
CADDY_IMPORT_LINE="import Caddyfile.d/*.caddy"

if [[ $EUID -ne 0 ]]; then
  echo "Run this as root (sudo bash provision.sh)" >&2
  exit 1
fi

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }

step "Checking that Caddy is installed"
if ! command -v caddy &>/dev/null; then
  cat >&2 <<'NOCADDY'
ERROR: caddy was not found in PATH.

This script configures an existing Caddy installation; it does not install one.
Install Caddy first (Debian/Ubuntu, official repo):

  apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
    | tee /etc/apt/sources.list.d/caddy-stable.list
  apt update && apt install -y caddy

Then re-run this script.
NOCADDY
  exit 1
fi
echo "found $(caddy version | head -1) at $(command -v caddy)"

step "Installing rsync"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq rsync

step "Creating deploy user ${DEPLOY_USER}"
if id "$DEPLOY_USER" &>/dev/null; then
  echo "user already exists — skipping"
else
  # No sudo group, no password login: this account only receives rsync over SSH.
  adduser --disabled-password --gecos "md-mini site deploy" "$DEPLOY_USER"
fi

step "Preparing web root ${WEBROOT}"
mkdir -p "$WEBROOT"
# The deploy user owns the tree (rsync writes it), but Caddy runs as the `caddy`
# system user and only needs to read it — hence world-readable files and
# world-traversable directories rather than a shared group.
chown -R "${DEPLOY_USER}:${DEPLOY_USER}" "$WEBROOT"
chmod 755 "$WEBROOT"

# Placeholder so the site has something to serve before the first CI deploy.
if [[ ! -f "${WEBROOT}/index.html" ]]; then
  cat > "${WEBROOT}/index.html" <<'PLACEHOLDER'
<!doctype html>
<meta charset="utf-8">
<title>md-mini.com</title>
<p>Coming soon.</p>
PLACEHOLDER
  chown "${DEPLOY_USER}:${DEPLOY_USER}" "${WEBROOT}/index.html"
fi

# a+rX = read for everyone, traverse only on directories. Re-running is a no-op.
chmod -R a+rX "$WEBROOT"

step "Generating deploy SSH key"
install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "/home/${DEPLOY_USER}/.ssh"
if [[ -f "$KEY_PATH" ]]; then
  echo "key already exists — reusing it"
else
  sudo -u "$DEPLOY_USER" ssh-keygen -t ed25519 -N "" -C "github-actions-deploy@${DOMAIN}" -f "$KEY_PATH"
fi
# Authorize the key for this account, without duplicating the entry on re-runs.
touch "/home/${DEPLOY_USER}/.ssh/authorized_keys"
if ! grep -qxFf <(cat "${KEY_PATH}.pub") "/home/${DEPLOY_USER}/.ssh/authorized_keys"; then
  cat "${KEY_PATH}.pub" >> "/home/${DEPLOY_USER}/.ssh/authorized_keys"
fi
chown -R "${DEPLOY_USER}:${DEPLOY_USER}" "/home/${DEPLOY_USER}/.ssh"
chmod 600 "/home/${DEPLOY_USER}/.ssh/authorized_keys"

step "Opening ports 80/443 (if ufw is active)"
if command -v ufw &>/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow 80/tcp
  ufw allow 443/tcp
else
  echo "ufw inactive or absent — nothing to do"
fi

step "Writing site config to ${CADDY_SITE_CONF}"
# This server may host other sites, so the main Caddyfile is never overwritten:
# our config is a fragment in Caddyfile.d/ and the main file only gains a single
# import line.
mkdir -p "$CADDY_FRAGMENT_DIR"
chmod 755 "$CADDY_FRAGMENT_DIR"
cat > "$CADDY_SITE_CONF" <<'CADDYFILE'
# md-mini.com — static site.
#
# Installed by deploy/provision.sh as /etc/caddy/Caddyfile.d/md-mini.com.caddy
# and pulled in from the main Caddyfile via `import Caddyfile.d/*.caddy`.
#
# Caddy does the HTTP->HTTPS redirect and the certificate issuance/renewal by
# itself, so neither appears here. `tls <email>` only sets the ACME account
# address; there is deliberately no global options block, because a global
# block has to be the first thing in the *main* Caddyfile and would break the
# moment this file is imported.

md-mini.com {
	tls m.kovalevskiy@dodobrands.io

	root * /var/www/md-mini.com
	encode zstd gzip

	# Set and delete live in separate directives on purpose. Caddy runs a header
	# handler that contains a deletion in "deferred" mode, i.e. at response-write
	# time — and a file_server 404 unwinds the chain before that, so a combined
	# block would drop the security headers on every 404. Keeping the `set` ops
	# in their own (non-deferred) handler puts them on error responses too, which
	# is what nginx's `add_header ... always` did.
	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
		X-Content-Type-Options "nosniff"
		Referrer-Policy "strict-origin-when-cross-origin"
		Content-Security-Policy "frame-ancestors 'none'"
	}
	header -Server

	# The two Cache-Control matchers are exact complements, so no response can
	# collect both values. /assets/*.js and /assets/*.css are the Vite build's
	# content-hashed bundles — safe to cache for a month; a rebuild changes the
	# filename. Unhashed .js/.css elsewhere deliberately stays no-cache.
	@assets path *.png *.jpg *.jpeg *.webp *.ico *.svg *.woff2 /assets/*.js /assets/*.css
	header @assets Cache-Control "public, max-age=2592000"

	@everything_else not path *.png *.jpg *.jpeg *.webp *.ico *.svg *.woff2 /assets/*.js /assets/*.css
	header @everything_else Cache-Control "no-cache"

	file_server
}

www.md-mini.com {
	tls m.kovalevskiy@dodobrands.io

	header Strict-Transport-Security "max-age=31536000; includeSubDomains"
	header -Server

	redir https://md-mini.com{uri} permanent
}
CADDYFILE
chmod 644 "$CADDY_SITE_CONF"

step "Wiring the fragment into ${CADDY_MAIN}"
if [[ ! -f "$CADDY_MAIN" ]]; then
  echo "no main Caddyfile — creating one that only imports Caddyfile.d/"
  printf '%s\n' "$CADDY_IMPORT_LINE" > "$CADDY_MAIN"
  chmod 644 "$CADDY_MAIN"
elif grep -qxF "$CADDY_IMPORT_LINE" "$CADDY_MAIN"; then
  echo "import line already present — leaving ${CADDY_MAIN} untouched"
else
  BACKUP="${CADDY_MAIN}.bak.$(date +%Y%m%d%H%M%S)"
  cp -a "$CADDY_MAIN" "$BACKUP"
  echo "backed up existing Caddyfile to ${BACKUP}"
  printf '\n# Site configs managed by deploy/provision.sh (md-mini.com and friends).\n%s\n' \
    "$CADDY_IMPORT_LINE" >> "$CADDY_MAIN"
  echo "appended: ${CADDY_IMPORT_LINE}"
fi

# The Caddy package ships a default `:80` example site. HTTPS keeps working next
# to it, but it swallows plain HTTP for every host: measured with caddy 2.10, an
# `http://md-mini.com` request then gets 200 + /usr/share/caddy instead of the
# automatic 308 to HTTPS, because Caddy declines to add redirect routes to a
# server that already has a catch-all site on the HTTP port.
if grep -qE '^[[:space:]]*:80[[:space:]]*\{' "$CADDY_MAIN"; then
  echo
  echo "WARNING: the packaged default ':80' site block is still active in ${CADDY_MAIN}."
  echo "         While it is there, http://${DOMAIN} serves /usr/share/caddy instead of"
  echo "         redirecting to https://${DOMAIN}, and requests by raw IP do the same."
  echo "         HTTPS and certificate issuance are unaffected. Remove or comment out"
  echo "         that block in ${CADDY_MAIN}, then: caddy validate --adapter caddyfile"
  echo "         --config ${CADDY_MAIN} && systemctl reload caddy"
fi

step "Validating the Caddy configuration"
caddy validate --adapter caddyfile --config "$CADDY_MAIN"

step "Reloading Caddy"
if systemctl is-active --quiet caddy; then
  systemctl reload caddy
else
  echo "caddy is not running — enabling and starting it"
  systemctl enable --now caddy
fi
if systemctl is-active --quiet caddy; then
  echo "caddy is active"
else
  echo "ERROR: caddy is not active after reload. Check: journalctl -u caddy -n 50" >&2
  exit 1
fi

step "Verifying"
curl -sI "http://${DOMAIN}" | head -2 || true
curl -sI "https://${DOMAIN}" | head -2 || true

cat <<EOF


================================================================
 Provisioning done.

 Certificates: Caddy requests them on the first HTTPS request and
 renews them automatically. Nothing to schedule.

 Add these three GitHub Actions secrets to malinborn/couplet:

   DEPLOY_HOST = $(curl -s4 --max-time 5 ifconfig.me || echo '<this server IP>')
   DEPLOY_USER = ${DEPLOY_USER}
   DEPLOY_SSH_KEY = the private key below (including BEGIN/END lines)

 Set the key without it passing through anyone's chat history:

   gh secret set DEPLOY_SSH_KEY --repo malinborn/couplet < ${KEY_PATH}

 …or copy it from here:
================================================================

EOF
cat "$KEY_PATH"
echo
echo "================================================================"
