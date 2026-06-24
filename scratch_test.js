const alawmulaw = require('alawmulaw');

const pcm = new Int16Array([0, 1000, -1000, 32767, -32768]);
console.log("Input PCM:", pcm);

const alawEncoded = alawmulaw.alaw.encode(pcm);
console.log("A-law Encoded type:", alawEncoded.constructor.name);
console.log("A-law Encoded length:", alawEncoded.length);
console.log("A-law Encoded bytes:", Array.from(alawEncoded).map(x => "0x" + x.toString(16)));

const alawDecoded = alawmulaw.alaw.decode(alawEncoded);
console.log("A-law Decoded type:", alawDecoded.constructor.name);
console.log("A-law Decoded PCM:", Array.from(alawDecoded));

const mulawEncoded = alawmulaw.mulaw.encode(pcm);
console.log("µ-law Encoded type:", mulawEncoded.constructor.name);
console.log("µ-law Encoded length:", mulawEncoded.length);
console.log("µ-law Encoded bytes:", Array.from(mulawEncoded).map(x => "0x" + x.toString(16)));

const mulawDecoded = alawmulaw.mulaw.decode(mulawEncoded);
console.log("µ-law Decoded type:", mulawDecoded.constructor.name);
console.log("µ-law Decoded PCM:", Array.from(mulawDecoded));
