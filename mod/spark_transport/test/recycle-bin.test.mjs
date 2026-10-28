import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { moveToRecycleBin } from '../src/recycle-bin.mjs';

test('Windows Recycle Bin removes the source without permanent-delete fallback',{skip:process.platform!=='win32'},async(t)=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'spark-recycle-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const target=path.join(dir,'recycle-me.txt');
  await fs.writeFile(target,'recoverable\n','utf8');
  await moveToRecycleBin(target,false);
  await assert.rejects(()=>fs.access(target),error=>error?.code==='ENOENT');
});
