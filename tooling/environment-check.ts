// Local environment validation helper, not the Terafleet application.
export default {
  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== '/health') {
      return new Response('Not found', { status: 404 });
    }

    const algorithm = {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    };
    const keys = await crypto.subtle.generateKey(algorithm, false, ['sign', 'verify']);
    if (!('privateKey' in keys)) {
      throw new Error('Expected an RSA key pair');
    }
    const data = new TextEncoder().encode('terafleet-runtime-check');
    const signature = await crypto.subtle.sign(algorithm.name, keys.privateKey, data);
    const verified = await crypto.subtle.verify(algorithm.name, keys.publicKey, signature, data);

    return Response.json(
      { runtime: 'cloudflare-workers', rsaSha256: verified },
      { status: verified ? 200 : 500 },
    );
  },
} satisfies ExportedHandler;
