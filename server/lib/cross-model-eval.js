import https from 'node:https';

async function defaultHttpPost(url, headers, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname,
      method: 'POST',
      headers: {
        ...headers,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

export async function evaluate({
  prompt,
  model = 'claude-haiku-4-5',
  apiKey = process.env.ANTHROPIC_API_KEY,
  timeoutMs = 20000,
  httpPost = defaultHttpPost,
} = {}) {
  if (!apiKey) return null;

  try {
    const body = {
      model,
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    };
    const headers = {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    };

    let result;
    if (timeoutMs > 0) {
      result = await Promise.race([
        httpPost('https://api.anthropic.com/v1/messages', headers, body),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), timeoutMs)
        ),
      ]);
    } else {
      result = await httpPost('https://api.anthropic.com/v1/messages', headers, body);
    }

    const text = result?.content?.[0]?.text;
    if (typeof text !== 'string') return null;
    return { text };
  } catch {
    return null;
  }
}

export async function criticDisagreement({
  question,
  answer,
  model,
  apiKey,
  httpPost,
} = {}) {
  if (!apiKey) return null;

  const prompt =
    `You are an independent critic. Given the question and answer below, rate how much you DISAGREE with the answer on a scale of 0.0 (fully agree) to 1.0 (fully disagree). Reply with a single float between 0 and 1.\n\nQuestion: ${question}\nAnswer: ${answer}\n\nDisagreement score:`;

  const result = await evaluate({ prompt, model, apiKey, httpPost });
  if (!result) return null;

  const match = result.text.match(/([01](?:\.\d+)?|\.\d+)/);
  if (!match) return null;
  const val = parseFloat(match[1]);
  if (isNaN(val) || val < 0 || val > 1) return null;
  return val;
}
