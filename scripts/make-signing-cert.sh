#!/usr/bin/env bash
# One-time: mint a self-signed code-signing identity ("Kairos Dev") in the
# login keychain so shipped builds carry a stable designated requirement.
#
# Why: an ad-hoc signature has no certificate, so macOS pins TCC grants
# (Screen & System Audio Recording, Microphone, …) to the build's cdhash.
# Every `npm run ship` mints a new cdhash, the stored grant stops matching,
# and Screen Recording wedges: System Settings shows Kairos toggled ON (the
# stale row) while the OS reports the permission denied and re-prompts on
# every Record — toggling off/on never rewrites the row (2026-08-28 bug).
# With a certificate the requirement becomes
#   identifier "com.santiago.kairos" and certificate leaf = H"<cert hash>"
# which survives rebuilds, so grants stick. scripts/ship.sh picks the
# identity up automatically; without it, ship falls back to ad-hoc.
#
# Idempotent. Trusting the cert for code signing pops one macOS password
# dialog (user trust settings), so run this from an interactive shell. The
# first `npm run ship` afterwards may ask once more ("codesign wants to
# sign using key…") — click Always Allow.
set -euo pipefail

NAME="${KAIROS_SIGN_IDENTITY:-Kairos Dev}"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

has_identity() {
  security find-identity -v -p codesigning "$KEYCHAIN" | grep -q "\"$NAME\""
}

if has_identity; then
  echo "identity \"$NAME\" already valid in the login keychain — nothing to do"
  exit 0
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

cat > "$work/ext.cnf" <<CNF
[req]
distinguished_name = dn
x509_extensions = v3
prompt = no
[dn]
CN = $NAME
[v3]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
subjectKeyIdentifier = hash
CNF

openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -keyout "$work/key.pem" -out "$work/cert.pem" -config "$work/ext.cnf" 2>/dev/null
# macOS `security import` only parses the legacy PKCS#12 ciphers; OpenSSL 3's
# defaults fail with "MAC verification failed"
openssl pkcs12 -export -inkey "$work/key.pem" -in "$work/cert.pem" \
  -out "$work/id.p12" -passout pass:kairos -name "$NAME" \
  -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1
# -T: pre-authorise codesign on the private key
security import "$work/id.p12" -k "$KEYCHAIN" -P kairos -T /usr/bin/codesign

echo "trusting \"$NAME\" for code signing — macOS will ask for your login password once"
security add-trusted-cert -r trustRoot -p codeSign -k "$KEYCHAIN" "$work/cert.pem"

if has_identity; then
  echo "identity \"$NAME\" ready — the next \`npm run ship\` signs with it"
  echo "(first Record after that ship re-prompts once; the grant then survives rebuilds)"
else
  echo "identity \"$NAME\" imported but not valid for code signing —" \
       "open Keychain Access → login → My Certificates and set Code Signing to Always Trust" >&2
  exit 1
fi
