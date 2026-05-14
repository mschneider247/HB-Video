const fs = require('fs');
const p = 'C:/Users/mschn/Desktop/Code/HB-Video/public/index.html';
let c = fs.readFileSync(p, 'utf8');
const ticks = (c.match(/\\`/g) || []).length;
const interps = (c.match(/\\\${/g) || []).length;
c = c.replace(/\\\${/g, '${');
c = c.replace(/\\`/g, '`');
fs.writeFileSync(p, c, 'utf8');
console.log('Fixed ' + ticks + ' \\` and ' + interps + ' \\${ sequences');
