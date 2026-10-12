import { Sandbox } from 'wasmdbox';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root=await mkdtemp(join(tmpdir(),'close-order-'));
await writeFile(join(root,'input'),'fixture');
let box;
try {
 box=await Sandbox.create({cacheDir:'.wasmer',mounts:[{hostPath:root,guestPath:'/mounted'}]});
 const proc=await box.spawn(['node','-e',`require('node:fs').openSync('/mounted/input','r'); console.log('ready'); setInterval(()=>{},1000);`]);
 proc.stderr.resume();
 for await(const b of proc.stdout) if(b.toString().includes('ready'))break;
 await box.close();
 await proc.wait().catch(()=>{});
 console.log(JSON.stringify({mode:process.env.WASMDBOX_CLOSE_PROBE,passed:true}));
} catch(error) { console.log(JSON.stringify({mode:process.env.WASMDBOX_CLOSE_PROBE,passed:false,error:String(error)})); process.exitCode=1; }
finally { await box?.close().catch(()=>{}); await rm(root,{recursive:true,force:true}); }
