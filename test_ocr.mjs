import { score, ocrScore, classifyRenew } from './renew.mjs';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

assert(score('ACLCiouds', 'ACLClouds') >= 75, '1-letter OCR miss should still score');
assert(ocrScore('ACLCiouds', 'ACLClouds', 'ACLClouds') >= 80, 'vocab-corrected ACLCiouds must pass threshold');
assert(ocrScore('Serveur', 'Serveur', 'Serveur') === 100, 'exact Serveur');
assert(ocrScore('Semeur', 'Serveur', 'ACLClouds') < 80, 'wrong tile must not match prompt');

const skip = classifyRenew({ status: 400, data: { error: 'renewal_not_available', days_remaining: 1 } });
assert(skip.ok && skip.skip, 'window-closed is ok skip');

const cap = classifyRenew({ status: 403, data: { error: 'captcha_required' } });
assert(!cap.ok && cap.captcha, '403 captcha_required retries');

const ok = classifyRenew({ status: 200, data: { ok: true } });
assert(ok.ok && !ok.skip, '200 is success');

console.log('ok');
