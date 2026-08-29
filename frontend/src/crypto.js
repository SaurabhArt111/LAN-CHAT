// End-to-end encryption primitives for 1:1 conversations.
//
// Design (deliberately simple, using only well-reviewed WebCrypto primitives —
// no custom cryptography):
//   1. Each device generates a persistent ECDH P-256 keypair on first launch.
//   2. Public keys are exchanged via the server (the server never sees a private key).
//   3. For any pair of devices, both sides independently compute the same shared
//      secret via ECDH, then derive an AES-256-GCM key from it. Neither side ever
//      transmits the symmetric key — it's re-derived locally from math both sides
//      can do with their own private key + the other's public key.
//   4. Messages are encrypted with AES-GCM (authenticated encryption — tampering
//      or using the wrong key causes decryption to fail loudly, not silently).
//   5. A short "fingerprint" of the shared secret lets two humans verbally compare
//      a code to detect a man-in-the-middle, the same idea as Signal's "safety numbers".
//
// Works identically in a browser (globalThis.crypto.subtle) and in Node 19+, which
// is what makes it possible to test this module directly with plain Node scripts
// before it's ever loaded into the app.
import { gcm } from '@noble/ciphers/aes.js';
import { p256 } from '@noble/curves/nist.js';
import { sha256 } from '@noble/hashes/sha256.js';

const subtle = globalThis.crypto?.subtle;
const useWebCrypto = Boolean(subtle);

export async function generateDeviceKeypair() {
  if (!useWebCrypto) {
    const privateKey = p256.utils.randomSecretKey();
    return {
      publicKeyBase64: bufToBase64(p256.getPublicKey(privateKey, false)),
      privateKeyJwk: { kty: 'EC', crv: 'P-256', d: bufToBase64Url(privateKey) },
    };
  }

  const keyPair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ]);
  const publicKeyRaw = await subtle.exportKey('raw', keyPair.publicKey);
  const privateKeyJwk = await subtle.exportKey('jwk', keyPair.privateKey);
  return {
    publicKeyBase64: bufToBase64(publicKeyRaw),
    privateKeyJwk,
  };
}

export async function importPrivateKey(jwk) {
  if (!useWebCrypto) return base64UrlToBuf(jwk.d);
  return subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, [
    'deriveBits',
  ]);
}

export async function importPublicKey(base64) {
  const raw = base64ToBuf(base64);
  if (!useWebCrypto) return new Uint8Array(raw);
  return subtle.importKey('raw', raw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
}

// Both sides of a conversation call this with (their own private key, the other's
// public key) and get back the identical raw shared secret — that's the ECDH property.
async function deriveSharedBits(myPrivateKey, peerPublicKey) {
  if (!useWebCrypto) return p256.getSharedSecret(myPrivateKey, peerPublicKey, false).slice(1, 33);
  return subtle.deriveBits({ name: 'ECDH', public: peerPublicKey }, myPrivateKey, 256);
}

export async function deriveConversationKey(myPrivateKey, peerPublicKey) {
  const sharedBits = await deriveSharedBits(myPrivateKey, peerPublicKey);
  if (!useWebCrypto) {
    return { aesKey: sharedBits, fingerprint: formatFingerprint(sha256(sharedBits)) };
  }

  const aesKey = await subtle.importKey('raw', sharedBits, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
  const fingerprintBits = await subtle.digest('SHA-256', sharedBits);
  return { aesKey, fingerprint: formatFingerprint(fingerprintBits) };
}

function formatFingerprint(digestBuf) {
  const bytes = new Uint8Array(digestBuf).slice(0, 8); // 8 bytes is plenty for a human-comparable code
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0').toUpperCase())
    .join('')
    .match(/.{1,4}/g)
    .join(' ');
}

export async function encryptText(aesKey, plaintext) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  if (!useWebCrypto) {
    return { ciphertext: bufToBase64(gcm(aesKey, iv).encrypt(encoded)), iv: bufToBase64(iv) };
  }

  const ciphertext = await subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, encoded);
  return { ciphertext: bufToBase64(ciphertext), iv: bufToBase64(iv) };
}

// Throws if the ciphertext was tampered with, or if aesKey is wrong — this is the
// authenticated-encryption property, not something we implement ourselves.
export async function decryptText(aesKey, ciphertextBase64, ivBase64) {
  const iv = base64ToBuf(ivBase64);
  const ciphertext = base64ToBuf(ciphertextBase64);
  if (!useWebCrypto) {
    return new TextDecoder().decode(gcm(aesKey, new Uint8Array(iv)).decrypt(new Uint8Array(ciphertext)));
  }

  const plainBuf = await subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, ciphertext);
  return new TextDecoder().decode(plainBuf);
}

function bufToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return typeof btoa === 'function' ? btoa(binary) : Buffer.from(binary, 'binary').toString('base64');
}

function base64ToBuf(base64) {
  const binary = typeof atob === 'function' ? atob(base64) : Buffer.from(base64, 'base64').toString('binary');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function bufToBase64Url(buf) {
  return bufToBase64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBuf(base64) {
  const padded = base64.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(base64.length / 4) * 4, '=');
  return new Uint8Array(base64ToBuf(padded));
}
