const fs = require('node:fs');
const path = require('node:path');
const tls = require('node:tls');
const { X509Certificate, createHash } = require('node:crypto');

// Node/Electron's OpenSSL environment-file loader can fail for Unicode Windows
// paths. Read through Node's filesystem API, retaining certificate validation.
const requested = process.env.WANGZAI_SELFHOST_CA_FILE;
if (requested) {
  const file = path.resolve(requested);
  const state = path.dirname(file);
  const manifest = JSON.parse(fs.readFileSync(path.join(state, 'deployment.json'), 'utf8'));
  const distribution = JSON.parse(fs.readFileSync(path.join(manifest.clientRoot, 'desktop/resources/distribution.json'), 'utf8'));
  const url = new URL(manifest.serverUrl);
  if (path.basename(file) !== 'ca.pem' || fs.lstatSync(file).isSymbolicLink()
      || !manifest.ready || distribution.local_self_hosting !== true || distribution.license_mode !== 'enforce'
      || distribution.license_center_url !== manifest.serverUrl
      || url.protocol !== 'https:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.hash) {
    throw new Error('SELF_HOST_TLS_CONFIGURATION_INVALID');
  }
  const pem = fs.readFileSync(file, 'utf8');
  if (createHash('sha256').update(pem).digest('hex') !== manifest.caSha256) throw new Error('SELF_HOST_CA_FINGERPRINT_MISMATCH');
  const cert = new X509Certificate(pem);
  if (!cert.ca || Date.parse(cert.validTo) <= Date.now() || Date.parse(cert.validFrom) > Date.now()) throw new Error('SELF_HOST_CA_INVALID');
  if (typeof tls.setDefaultCACertificates !== 'function') throw new Error('SELF_HOST_REQUIRES_NODE_24_5_OR_NEWER');
  tls.setDefaultCACertificates([...tls.getCACertificates('default'), pem]);
}
