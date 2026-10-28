import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { createPathPolicy } from '../src/path-policy.mjs';
import { makeFixture } from './helpers.mjs';

test('read containment and create containment',async(t)=>{
  const f=await makeFixture();
  t.after(f.cleanup);
  const p=await createPathPolicy(f.root);
  assert.equal((await p.resolveFile('hello.txt')).displayPath,'hello.txt');
  await assert.rejects(()=>p.resolveFile('../outside/secret.txt'),e=>e.code==='PATH_TRAVERSAL');
  await assert.rejects(()=>p.resolveFile(path.resolve(f.outside,'secret.txt')),e=>e.code==='ABSOLUTE_PATH_NOT_ALLOWED');
  assert.equal((await p.resolveForCreate('new.txt')).displayPath,'new.txt');
});

test('symlink escape is rejected',async(t)=>{
  const f=await makeFixture();
  t.after(f.cleanup);
  const link=path.join(f.root,'escape');
  try{await fs.symlink(f.outside,link,'dir');}catch(e){if(['EPERM','EACCES','ENOSYS'].includes(e.code)){t.skip(`symlink unavailable: ${e.code}`);return;}throw e;}
  const p=await createPathPolicy(f.root);
  await assert.rejects(()=>p.resolveDirectory('escape'),e=>e.code==='SYMLINK_ESCAPE');
  await assert.rejects(()=>p.resolveMutationEntry('escape'),e=>['SYMLINK_ESCAPE','SYMLINK_MUTATION_NOT_ALLOWED'].includes(e.code));
});

test('Windows junction escape including missing child target is rejected',{skip:process.platform!=='win32'},async(t)=>{
  const f=await makeFixture();
  t.after(f.cleanup);
  const junction=path.join(f.root,'escape-junction');
  await fs.symlink(f.outside,junction,'junction');
  const p=await createPathPolicy(f.root);
  await assert.rejects(()=>p.resolveDirectory('escape-junction'),e=>e.code==='SYMLINK_ESCAPE');
  await assert.rejects(()=>p.resolveForCreate('escape-junction/new.txt'),e=>e.code==='SYMLINK_ESCAPE');
});
