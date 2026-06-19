const { pcm16BufToMulaw, mulawBufToPcm16 } = require("./dist/ws/bridge");
const buf = Buffer.alloc(10);
for (let i=0; i<10; i++) buf[i] = 128 + i*10;
const pcm = mulawBufToPcm16(buf);
console.log("Original mulaw: ", buf);
console.log("Decoded PCM:  ", pcm);
