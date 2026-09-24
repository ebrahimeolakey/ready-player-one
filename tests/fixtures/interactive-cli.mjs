// Real PTY peer only; never invokes a model or reads authentication files.
import {appendFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
const journal=join(process.cwd(),'cli-input.log');
process.stdin.setRawMode(true);process.stdin.resume();
console.log('CLI_READY '+JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd(),tty:process.stdin.isTTY,hub:!!process.env.RPO_HUB_TOKEN,bridge:!!process.env.RPO_COORDINATION_BRIDGE_TOKEN}));
process.stdin.on('data',bytes=>{
 appendFileSync(journal,bytes);
 if(bytes.toString()==='EXIT')process.exit(7);
 if(bytes.toString()==='CHILD'){
  const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
  writeFileSync(join(process.cwd(),'child.pid'),String(child.pid));
 }
 console.log('INPUT_HEX '+bytes.toString('hex'));
});
