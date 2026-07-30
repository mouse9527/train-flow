function canonicalize(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }

  const entries = Object.keys(value)
    .filter((key) => key !== 'checksum' && value[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`);
  return `{${entries.join(',')}}`;
}

function rotateRight(value, bits) {
  return (value >>> bits) | (value << (32 - bits));
}

function sha256(text) {
  const maxWord = 2 ** 32;
  const words = [];
  const hash = [];
  const constants = [];
  const composite = {};
  let candidate = 2;

  while (constants.length < 64) {
    if (!composite[candidate]) {
      for (let multiple = candidate * candidate; multiple < 313; multiple += candidate) {
        composite[multiple] = true;
      }
      if (hash.length < 8) {
        hash.push((candidate ** 0.5 * maxWord) | 0);
      }
      constants.push((candidate ** (1 / 3) * maxWord) | 0);
    }
    candidate += 1;
  }

  const bytes = unescape(encodeURIComponent(text));
  let binary = '';
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes.charCodeAt(index));
  }
  binary += '\x80';
  while (binary.length % 64 !== 56) {
    binary += '\x00';
  }

  const bitLength = bytes.length * 8;
  for (let index = 0; index < binary.length; index += 1) {
    words[index >> 2] |= binary.charCodeAt(index) << ((3 - index) % 4) * 8;
  }
  words.push(Math.floor(bitLength / maxWord));
  words.push(bitLength);

  for (let offset = 0; offset < words.length; offset += 16) {
    const schedule = words.slice(offset, offset + 16);
    const previousHash = hash.slice();

    for (let round = 0; round < 64; round += 1) {
      const w15 = schedule[round - 15];
      const w2 = schedule[round - 2];
      if (round >= 16) {
        const sigma0 = rotateRight(w15, 7) ^ rotateRight(w15, 18) ^ (w15 >>> 3);
        const sigma1 = rotateRight(w2, 17) ^ rotateRight(w2, 19) ^ (w2 >>> 10);
        schedule[round] = (schedule[round - 16] + sigma0 + schedule[round - 7] + sigma1) | 0;
      }

      const e = hash[4];
      const sigmaE = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & hash[5]) ^ (~e & hash[6]);
      const temp1 = (hash[7] + sigmaE + choice + constants[round] + schedule[round]) | 0;
      const a = hash[0];
      const sigmaA = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & hash[1]) ^ (a & hash[2]) ^ (hash[1] & hash[2]);
      const temp2 = (sigmaA + majority) | 0;

      hash.unshift((temp1 + temp2) | 0);
      hash[4] = (hash[4] + temp1) | 0;
      hash.pop();
    }

    for (let index = 0; index < 8; index += 1) {
      hash[index] = (hash[index] + previousHash[index]) | 0;
    }
  }

  return hash
    .map((word) => (word >>> 0).toString(16).padStart(8, '0'))
    .join('');
}

function computeChecksum(value) {
  return sha256(canonicalize(value));
}

module.exports = { canonicalize, computeChecksum };
