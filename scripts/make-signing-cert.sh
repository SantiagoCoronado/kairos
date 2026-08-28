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
# Idempotent on every path: a valid identity is left alone, an untrusted one
# (cert + key present, e.g. the password dialog was dismissed) only gets the
# trust step redone, and a keyless leftover certificate stops with
# instructions — never a second mint, because two distinct certs sharing a
# CN make `codesign --sign "Kairos Dev"` refuse the ambiguous identity (and
# they'd carry different leaf hashes anyway). Trusting the cert for code
# signing pops one macOS password dialog (user trust settings), so run this
# from an interactive shell. The first `npm run ship` afterwards may ask
# once more ("codesign wants to sign using key…") — click Always Allow.
set -euo pipefail

NAME="${KAIROS_SIGN_IDENTITY:-Kairos Dev}"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

# Same search list ship.sh uses, so the two scripts agree on "present".
# An identity is cert + private key; -v additionally requires it to be
# trusted for code signing. The grep is anchored by the quotes around the
# name in find-identity's output, so "Kairos Dev Old" can't match.
has_valid_identity() {
  security find-identity -v -p codesigning | grep -q "\"$NAME\""
}
has_any_identity() {
  security find-identity -p codesigning | grep -q "\"$NAME\""
}

if has_valid_identity; then
  echo "identity \"$NAME\" already valid — nothing to do"
  exit 0
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

if has_any_identity; then
  # cert + key are in a keychain but not trusted for code signing — export
  # the existing cert and only redo trust
  echo "identity \"$NAME\" exists but is not trusted for code signing — repairing trust"
  security find-certificate -c "$NAME" -p > "$work/cert.pem"
elif security find-certificate -c "$NAME" >/dev/null 2>&1; then
  # a certificate matches the name but no private key goes with it: trust
  # can't make that signable, and minting alongside it would leave two
  # same-named certs for codesign to choke on
  echo "a certificate matching \"$NAME\" exists without a private key (deleted key, half-failed" \
       "import, or a bare .cer in another keychain) — delete it in Keychain Access" \
       "(or: security delete-certificate -t -c \"$NAME\") and re-run this script" >&2
  exit 1
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

if has_valid_identity; then
  echo "identity \"$NAME\" ready — the next \`npm run ship\` signs with it"
  echo "(first Record after that ship re-prompts once; the grant then survives rebuilds)"
else
  # two hypotheses, in likelihood order: the trust dialog was dismissed, or
  # a second certificate named $NAME (e.g. a bare .cer in another keychain)
  # shadowed the real one — find-certificate -p exports whichever comes
  # first, so trust may have landed on the wrong cert. Re-running can't fix
  # the second case, so name it instead of inviting a loop.
  echo "identity \"$NAME\" is in the keychain but still not trusted for code signing." >&2
  echo "  - dismissed the password dialog? re-run this script to retry it" >&2
  echo "  - more than one certificate named \"$NAME\"? list them with" >&2
  echo "      security find-certificate -a -c \"$NAME\" -Z | grep SHA-1" >&2
  echo "    and delete the extras (Keychain Access, or: security delete-certificate -t -Z <sha1>)," >&2
  echo "    then re-run — or set Code Signing: Always Trust on the right one in Keychain Access" >&2
  exit 1
fi
