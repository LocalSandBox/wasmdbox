import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';
import { registerHostMounts, closeHostMounts, dispatchHostFileSystem, hostFileSystemEntriesOmitted } from '../dist/internal/node-host-filesystem.js';
import { installHostFileSystemWorkerBridge, respondToHostFileSystem } from '../dist/internal/host-filesystem.js';

test('protected subtrees reject every mutation and ancestor moves without hiding reads', t => {
  const root=fs.mkdtempSync(join(tmpdir(),'host-protected-'));const owner={};
  t.after(()=>{closeHostMounts(owner);fs.rmSync(root,{recursive:true,force:true});});
  fs.mkdirSync(join(root,'parent/protected'),{recursive:true});fs.writeFileSync(join(root,'parent/protected/a'),'original');
  fs.mkdirSync(join(root,'parent/protected-other'));fs.writeFileSync(join(root,'plain'),'plain');
  const id=registerHostMounts(owner,[{hostPath:root,guestPath:'/workfolder',denyWritePaths:['parent/protected']}]).mounts[0].id;
  const call=(m,...a)=>dispatchHostFileSystem(id,m,a);
  const open=(p,write=false,create=false,truncate=false)=>call('open',p,true,write,create,false,truncate,false);
  const reader=open('parent/protected/a');assert.equal(call('read',reader,0,20).toString(),'original');
  for(const act of [()=>open('parent/protected/a',true),()=>open('parent/protected/a',true,false,true),()=>open('parent/protected/new',true,true),
    ()=>call('mkdir','parent/protected/dir'),()=>call('remove','parent/protected/a'),()=>call('remove','parent/protected'),
    ()=>call('rename','parent','moved'),()=>call('rename','plain','parent/protected/a'),()=>call('rename','parent/protected/a','new'),
    ()=>call('rename','plain','parent'),()=>call('setTimes','parent/protected/a','1000000000',null),
    ()=>call('write',reader,0,Buffer.from('bad')),()=>call('setLen',reader,0),()=>call('setFileTimes',reader,'1000000000',null)]) assert.throws(act,{code:'EPERM'});
  const sibling=open('parent/protected-other/new',true,true);call('write',sibling,0,Buffer.from('ok'));
  assert.equal(fs.readFileSync(join(root,'parent/protected/a'),'utf8'),'original');
  if(process.platform!=='linux') assert.throws(()=>open('PARENT/PROTECTED/new',true,true),{code:'EPERM'});
  // Writes through an existing handle remain valid after an allowed ancestor rename.
  if (process.platform === 'win32') {
    // Windows forbids renaming a directory while a descendant handle is open.
    assert.throws(() => call('rename','parent/protected-other','sibling'), { code: 'EPERM' });
    call('close', sibling);
    call('rename','parent/protected-other','sibling');
    const reopened=open('sibling/new',true);call('write',reopened,0,Buffer.from('OK'));
  } else {
    call('rename','parent/protected-other','sibling');call('write',sibling,0,Buffer.from('OK'));
  }
  assert.equal(fs.readFileSync(join(root,'sibling/new'),'utf8'),'OK');
});

test('invalid protected paths are rejected before registration', t=>{
  const root=fs.mkdtempSync(join(tmpdir(),'host-paths-'));const owner={};
  t.after(()=>{closeHostMounts(owner);fs.rmSync(root,{recursive:true,force:true});});
  for(const p of ['', '.', '/abs','../outside','a/../b','a//b','a/','a\\b','a\0b'])
    assert.throws(()=>registerHostMounts(owner,[{hostPath:root,guestPath:'/workfolder',denyWritePaths:[p]}]));
});

test('large directory listing omits unsupported entries and counts repeated enumeration', t=>{
  const root=fs.mkdtempSync(join(tmpdir(),'host-directory-'));const owner={};
  t.after(()=>{closeHostMounts(owner);fs.rmSync(root,{recursive:true,force:true});});
  for(let i=0;i<10000;i++) fs.writeFileSync(join(root,`${i}-${'x'.repeat(100)}`),'');
  fs.writeFileSync(join(root,'hard-a'),'keep');fs.linkSync(join(root,'hard-a'),join(root,'hard-b'));
  const id=registerHostMounts(owner,[{hostPath:root,guestPath:'/workfolder'}]).mounts[0].id;
  const before=hostFileSystemEntriesOmitted();
  const call=(m,...args)=>dispatchHostFileSystem(id,m,args);
  let requests=0;
  installHostFileSystemWorkerBridge(req=>{requests++;respondToHostFileSystem(req,{value:call(req.method,...req.args)});return true;});
  const entries=globalThis.__wasmerHostFileSystem(id,'readDir',['']);
  assert.equal(entries.length,10000);assert.equal(requests,2);assert.equal(hostFileSystemEntriesOmitted()-before,4);
  assert.throws(()=>call('stat','hard-a'),{code:'EPERM'});
  assert.throws(()=>call('readDir','missing'),{code:'ENOENT'});
});

test('bridge never retries writes and bounds readDir replies at 32 MiB',()=>{
  for(const method of ['write','readDir']) {
    let attempts=0;
    installHostFileSystemWorkerBridge(req=>{attempts++;respondToHostFileSystem(req,{value:'x'.repeat(method==='write'?600000:33*1024*1024)});return true;});
    assert.throws(()=>globalThis.__wasmerHostFileSystem(1,method,[]),{code:'EOVERFLOW'});assert.equal(attempts,1);
  }
});

test('timed out buffers cannot be overwritten by a late reply during the next request',()=>{
  const source=fs.readFileSync(new URL('../dist/internal/host-filesystem.js',import.meta.url),'utf8').replaceAll('export ','');
  const requests=[];let late;
  const context={SharedArrayBuffer,Int32Array,Uint8Array,TextEncoder,TextDecoder,Date,Number,JSON,Error,Object,
    Atomics:{...Atomics,load:Atomics.load,store:Atomics.store,notify:Atomics.notify,wait:()=> 'timed-out'}};
  vm.createContext(context);vm.runInContext(source,context);
  context.installHostFileSystemWorkerBridge(req=>{
    requests.push(req);if(requests.length===1){late=req;return true;}
    context.respondToHostFileSystem(late,{value:'late'});context.respondToHostFileSystem(req,{value:'fresh'});return true;
  });
  assert.throws(()=>context.__wasmerHostFileSystem(1,'stat',[]),{code:'ETIMEDOUT'});
  assert.equal(context.__wasmerHostFileSystem(1,'stat',[]),'fresh');assert.notEqual(requests[0].response,requests[1].response);
});
