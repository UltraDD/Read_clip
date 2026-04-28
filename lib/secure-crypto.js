/**
 * secure-crypto.js
 * - PBKDF2(SHA-256) key derivation
 * - AES-GCM encryption/decryption for JSON payloads
 *
 * NOTE:
 * - Do NOT hardcode secrets (password/token) in code.
 * - Store only ciphertext in chrome.storage.sync.
 * - Keep plaintext only in chrome.storage.session (ephemeral).
 */

(function () {
  const ITERATIONS = 200000;

  function b64FromBytes(bytes) {
    return btoa(String.fromCharCode(...new Uint8Array(bytes)));
  }

  function bytesFromB64(str) {
    return Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
  }

  async function deriveAesKey(passphrase, saltB64) {
    const enc = new TextEncoder();
    const salt = bytesFromB64(saltB64);
    const baseKey = await crypto.subtle.importKey(
      'raw',
      enc.encode(String(passphrase || '')),
      'PBKDF2',
      false,
      ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async function encryptJson(passphrase, obj) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await deriveAesKey(passphrase, b64FromBytes(salt));
    const enc = new TextEncoder();
    const plaintext = enc.encode(JSON.stringify(obj));

    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);

    return {
      v: 1,
      kdf: 'PBKDF2-SHA256',
      iter: ITERATIONS,
      alg: 'AES-GCM',
      salt: b64FromBytes(salt),
      iv: b64FromBytes(iv),
      data: b64FromBytes(ciphertext)
    };
  }

  async function decryptJson(passphrase, payload) {
    if (!payload || payload.v !== 1 || !payload.salt || !payload.iv || !payload.data) {
      throw new Error('加密配置格式不正确或版本不兼容');
    }
    const key = await deriveAesKey(passphrase, payload.salt);
    const iv = bytesFromB64(payload.iv);
    const data = bytesFromB64(payload.data);

    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
    return JSON.parse(new TextDecoder().decode(plaintext));
  }

  // Expose globals (MV3 importScripts friendly)
  self.SecureCrypto = {
    encryptJson,
    decryptJson
  };
})();


