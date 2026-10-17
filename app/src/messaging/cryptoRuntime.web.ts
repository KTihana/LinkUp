let cryptoReady: Promise<void> | undefined;

const requiredMethods = [
  'digest', 'generateKey', 'importKey', 'exportKey', 'deriveBits',
  'encrypt', 'decrypt', 'sign', 'verify',
] as const;

/** Check the primitives used by the standard MLS suite before creating state. */
async function verifyMessagingCrypto(): Promise<void> {
  const runtime = globalThis.crypto;
  if (!runtime?.subtle || typeof runtime.getRandomValues !== 'function'
    || requiredMethods.some((method) => typeof runtime.subtle[method] !== 'function')) {
    throw new Error('This browser does not provide the encryption APIs required for messaging.');
  }
  const subtle = runtime.subtle;
  const message = new TextEncoder().encode('Common MLS crypto check');
  runtime.getRandomValues(new Uint8Array(32));

  const hash = new Uint8Array(await subtle.digest('SHA-256', new TextEncoder().encode('abc')));
  if (Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('')
    !== 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad') {
    throw new Error('SHA-256 verification failed.');
  }

  const signing = await subtle.generateKey('Ed25519', true, ['sign', 'verify']) as CryptoKeyPair;
  const privateBytes = await subtle.exportKey('pkcs8', signing.privateKey);
  const publicBytes = await subtle.exportKey('raw', signing.publicKey);
  const importedPrivate = await subtle.importKey('pkcs8', privateBytes, 'Ed25519', false, ['sign']);
  const importedPublic = await subtle.importKey('raw', publicBytes, 'Ed25519', false, ['verify']);
  const signature = await subtle.sign('Ed25519', importedPrivate, message);
  if (!await subtle.verify('Ed25519', importedPublic, signature, message)) {
    throw new Error('Ed25519 verification failed.');
  }
  const changedSignature = new Uint8Array(signature.slice(0));
  changedSignature[0] ^= 1;
  if (await subtle.verify('Ed25519', importedPublic, changedSignature, message)) {
    throw new Error('Ed25519 authentication verification failed.');
  }

  const alice = await subtle.generateKey('X25519', true, ['deriveBits']) as CryptoKeyPair;
  const bob = await subtle.generateKey('X25519', true, ['deriveBits']) as CryptoKeyPair;
  const bobPublic = await subtle.importKey('raw', await subtle.exportKey('raw', bob.publicKey), 'X25519', true, []);
  const alicePrivate = await subtle.importKey('pkcs8', await subtle.exportKey('pkcs8', alice.privateKey), 'X25519', false, ['deriveBits']);
  const aliceSecret = new Uint8Array(await subtle.deriveBits({ name: 'X25519', public: bobPublic }, alicePrivate, 256));
  const bobSecret = new Uint8Array(await subtle.deriveBits({ name: 'X25519', public: alice.publicKey }, bob.privateKey, 256));
  if (aliceSecret.length !== 32 || bobSecret.length !== 32 || aliceSecret.every((byte) => byte === 0)
    || aliceSecret.some((byte, index) => byte !== bobSecret[index])) {
    throw new Error('X25519 verification failed.');
  }

  const hkdf = await subtle.importKey('raw', aliceSecret, 'HKDF', false, ['deriveBits']);
  const derived = await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: message }, hkdf, 256);
  const hmac = await subtle.importKey('raw', derived, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  if ((await subtle.sign('HMAC', hmac, message)).byteLength !== 32) {
    throw new Error('HMAC verification failed.');
  }
  const aes = await subtle.importKey('raw', new Uint8Array(derived).slice(0, 16), 'AES-GCM', false, ['encrypt', 'decrypt']);
  const algorithm = { name: 'AES-GCM', iv: runtime.getRandomValues(new Uint8Array(12)), additionalData: message };
  const sealed = new Uint8Array(await subtle.encrypt(algorithm, aes, message));
  const opened = new Uint8Array(await subtle.decrypt(algorithm, aes, sealed));
  if (opened.length !== message.length || opened.some((byte, index) => byte !== message[index])) {
    throw new Error('AES-GCM verification failed.');
  }
  sealed[sealed.length - 1] ^= 1;
  let rejected = false;
  try {
    await subtle.decrypt(algorithm, aes, sealed);
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error('AES-GCM authentication verification failed.');
  aliceSecret.fill(0);
  bobSecret.fill(0);
  new Uint8Array(privateBytes).fill(0);
  new Uint8Array(derived).fill(0);
}

/** Browser crypto is never replaced or weakened with a JavaScript fallback. */
export function ensureMessagingCrypto(): Promise<void> {
  cryptoReady ??= (async () => {
    if (typeof window !== 'undefined' && !window.isSecureContext) {
      throw new Error('Messaging requires HTTPS. Localhost is allowed for development.');
    }
    try {
      await verifyMessagingCrypto();
    } catch {
      throw new Error('Messaging needs a browser with working X25519, Ed25519, AES-GCM and HKDF support. Update your browser and use HTTPS.');
    }
  })();
  return cryptoReady;
}
