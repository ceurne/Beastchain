// Cloudflare Worker entry point for BeastChain.
//
// This project turned out to be set up as a "Workers with static assets"
// project rather than classic "Cloudflare Pages" -- that type doesn't use
// the /functions folder at all. Instead, ALL requests (both the website
// itself and anything dynamic like push notifications) go through this one
// script's fetch() handler, which either answers directly (for /notify-turn)
// or hands the request off to the static file server (everything else).
//
// The push-notification logic itself (VAPID signing + aes128gcm encryption)
// is unchanged from the earlier Pages Functions version -- same Web Crypto
// API approach, same ntfy.sh-based "storage", just wrapped in the shape this
// project type expects.

function base64UrlToBuffer(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const raw = atob(str);
  const buf = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
  return buf;
}
function bufferToBase64Url(buf) {
  const bytes = new Uint8Array(buf);
  let str = '';
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function concatBuffers(...parts) {
  const total = parts.reduce((sum, p) => sum + p.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) { out.set(new Uint8Array(p), offset); offset += p.byteLength; }
  return out;
}

async function buildVapidHeader(pushEndpointOrigin, vapidPublicKey, vapidPrivateKey) {
  const header = { typ: 'JWT', alg: 'ES256' };
  const claims = {
    aud: pushEndpointOrigin,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: 'mailto:no-reply@beastchain.app'
  };
  const signingInput =
    bufferToBase64Url(new TextEncoder().encode(JSON.stringify(header))) + '.' +
    bufferToBase64Url(new TextEncoder().encode(JSON.stringify(claims)));

  const pub = base64UrlToBuffer(vapidPublicKey);
  const x = pub.slice(1, 33);
  const y = pub.slice(33, 65);
  const d = base64UrlToBuffer(vapidPrivateKey);

  const jwk = {
    kty: 'EC', crv: 'P-256',
    x: bufferToBase64Url(x), y: bufferToBase64Url(y), d: bufferToBase64Url(d),
    ext: true
  };
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(signingInput));

  const jwt = signingInput + '.' + bufferToBase64Url(signature);
  return `vapid t=${jwt}, k=${vapidPublicKey}`;
}

async function encryptPayload(payloadText, p256dhB64Url, authB64Url) {
  const uaPublic = base64UrlToBuffer(p256dhB64Url);
  const authSecret = base64UrlToBuffer(authB64Url);

  const localKeyPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', localKeyPair.publicKey));

  const uaPublicKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaPublicKey }, localKeyPair.privateKey, 256));

  const salt = crypto.getRandomValues(new Uint8Array(16));

  async function hmac(keyBytes, data) {
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
  }

  const prkKey = await hmac(authSecret, ecdhSecret);
  const keyInfo = concatBuffers(new TextEncoder().encode('WebPush: info\0'), uaPublic, asPublic);
  const ikm = (await hmac(prkKey, concatBuffers(keyInfo, new Uint8Array([1])))).slice(0, 32);

  const prk = await hmac(salt, ikm);
  const cekInfo = new TextEncoder().encode('Content-Encoding: aes128gcm\0');
  const cek = (await hmac(prk, concatBuffers(cekInfo, new Uint8Array([1])))).slice(0, 16);
  const nonceInfo = new TextEncoder().encode('Content-Encoding: nonce\0');
  const nonce = (await hmac(prk, concatBuffers(nonceInfo, new Uint8Array([1])))).slice(0, 12);

  const plaintext = concatBuffers(new TextEncoder().encode(payloadText), new Uint8Array([2]));

  const cekKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, cekKey, plaintext));

  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, 4096, false);
  const idLen = new Uint8Array([asPublic.length]);

  return concatBuffers(salt, recordSize, idLen, asPublic, encrypted);
}

async function handleNotifyTurn(request, env) {
  const VAPID_PUBLIC_KEY = env.VAPID_PUBLIC_KEY;
  const VAPID_PRIVATE_KEY = env.VAPID_PRIVATE_KEY;

  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    return new Response(JSON.stringify({ ok: false, error: 'VAPID keys not configured' }), { status: 200 });
  }

  let data;
  try {
    data = await request.json();
  } catch (e) {
    return new Response('Invalid JSON', { status: 400 });
  }

  const { roomCode, opponentPlayerNum, title, body } = data;
  if (!roomCode || !opponentPlayerNum || !body) {
    return new Response('Missing roomCode, opponentPlayerNum, or body', { status: 400 });
  }

  try {
    const topic = `beastchain-push-${roomCode}-${opponentPlayerNum}`;
    const pollUrl = `https://ntfy.sh/${topic}/json?poll=1`;
    const pollRes = await fetch(pollUrl);
    const pollText = await pollRes.text();
    const lines = pollText.trim().split('\n').filter(Boolean);
    if (lines.length === 0) {
      return new Response(JSON.stringify({ ok: true, sent: false, reason: 'no subscription found' }), { status: 200 });
    }
    const lastMsg = JSON.parse(lines[lines.length - 1]);
    const subscription = JSON.parse(lastMsg.message);
    if (!subscription || !subscription.endpoint || !subscription.keys) {
      return new Response(JSON.stringify({ ok: true, sent: false, reason: 'malformed subscription' }), { status: 200 });
    }

    const endpointUrl = new URL(subscription.endpoint);
    const vapidHeader = await buildVapidHeader(endpointUrl.origin, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    const payload = JSON.stringify({ title: title || 'BeastChain', body });
    const encryptedBody = await encryptPayload(payload, subscription.keys.p256dh, subscription.keys.auth);

    const pushRes = await fetch(subscription.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Encoding': 'aes128gcm',
        'TTL': '86400',
        'Authorization': vapidHeader
      },
      body: encryptedBody
    });

    if (pushRes.status === 404 || pushRes.status === 410) {
      return new Response(JSON.stringify({ ok: true, sent: false, reason: 'stale subscription' }), { status: 200 });
    }
    if (!pushRes.ok) {
      const errText = await pushRes.text().catch(() => '');
      return new Response(JSON.stringify({ ok: false, error: `push service returned ${pushRes.status}: ${errText}` }), { status: 200 });
    }

    return new Response(JSON.stringify({ ok: true, sent: true }), { status: 200 });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e && e.stack || e) }), { status: 200 });
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/notify-turn') {
      if (request.method !== 'POST') {
        return new Response('Method not allowed', { status: 405 });
      }
      return handleNotifyTurn(request, env);
    }

    // Everything else: serve the static site as normal.
    return env.ASSETS.fetch(request);
  }
};
