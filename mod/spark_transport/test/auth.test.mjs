import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { ACCESS_TOKEN_BYTES, digestAccessToken, generateAccessToken } from '../src/auth.mjs';

test('generateAccessToken creates a 256-bit prefixed token and matching digest',()=>{
  const generated=generateAccessToken({randomBytes:(size)=>{
    assert.equal(size,ACCESS_TOKEN_BYTES);
    return Buffer.alloc(size,0x5a);
  }});
  assert.equal(generated.entropyBits,256);
  assert.match(generated.token,/^spk_[A-Za-z0-9_-]{43}$/);
  assert.equal(generated.sha256,digestAccessToken(generated.token));
  assert.equal(generated.sha256,crypto.createHash('sha256').update(generated.token,'utf8').digest('hex'));
});

test('generateAccessToken rejects a broken random source',()=>{
  assert.throws(()=>generateAccessToken({randomBytes:()=>Buffer.alloc(31)}),/exactly 32 bytes/);
});
