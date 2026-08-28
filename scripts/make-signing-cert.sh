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
# Idempotent: re-running with the certificate already in a keychain repairs
# trust instead of minting a second cert — two distinct certs sharing a CN
# make `codesign --sign "Kairos Dev"` refuse to sign at all (ambiguous
# identity), and they'd carry different leaf hashes anyway. Trusting the
# cert for code signing pops one macOS password dialog (user trust
# settings), so run this from an interactive shell. The first
# `npm run ship` afterwards may ask once more ("codesign wants to sign
# using key…") — click Always Allow.
set -euo pipefail

NAME="${KAIROS_SIGN_IDENTITY:-Kairos Dev}"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

# same search list ship.sh uses, so the two scripts agree on "present"
has_identity() {
  security find-identity -v -p codesigning | grep -q "\"$NAME\""
}
has_certificate() {
  security find-certificate -c "$NAME" >/dev/null 2>&1
}

if has_identity; then
  echo "identity \"$NAME\" already valid — nothing to do"
  exit 0
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

if has_certificate; then
  # imported earlier but not trusted for code signing (e.g. the password
  # dialog was dismissed) — export the existing cert and only redo trust
  echo "certificate \"$NAME\" already in a keychain but not a valid signing identity — repairing trust"
  security find-certificate -c "$NAME" -p > "$work/cert.pem"
else
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
  # macOS `security import` only parses the legacy PKCS#12 ciphers; OpenSSL
  # 3's defaults fail with "MAC verification failed"
  openssl pkcs12 -export -inkey "$work/key.pem" -in "$work/cert.pem" \
    -out "$work/id.p12" -passout pass:kairos -name "$NAME" \
    -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1
  # -T: pre-authorise codesign on the private key
  security import "$work/id.p12" -k "$KEYCHAIN" -P kairos -T /usr/bin/codesign
fi

echo "trusting \"$NAME\" for code signing — macOS will ask for your login password once"
security add-trusted-cert -r trustRoot -p codeSign -k "$KEYCHAIN" "$work/cert.pem"

if has_identity; then
  echo "identity \"$NAME\" ready — the next \`npm run ship\` signs with it"
  echo "(first Record after that ship re-prompts once; the grant then survives rebuilds)"
else
  echo "identity \"$NAME\" imported but still not valid for code signing — re-run this script" \
       "(it only redoes the trust step), or open Keychain Access → login → My Certificates" \
       "and set Code Signing to Always Trust" >&2
  exit 1
fi
