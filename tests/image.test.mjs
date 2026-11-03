import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeImage } from '../server/image.mjs';

const redPng = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/S0cAAAAASUVORK5CYII=', 'base64'));

function crc32(bytes) {
  let crc=0xffffffff;
  for(const b of bytes){crc^=b;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
  return (crc^0xffffffff)>>>0;
}
function chunk(type,data) {
  const name=Uint8Array.from([...type].map(c=>c.charCodeAt(0))), out=new Uint8Array(data.length+12);
  const n=data.length; out[0]=n>>>24;out[1]=n>>>16;out[2]=n>>>8;out[3]=n;out.set(name,4);out.set(data,8);
  const crc=crc32(out.subarray(4,8+n)), p=8+n;out[p]=crc>>>24;out[p+1]=crc>>>16;out[p+2]=crc>>>8;out[p+3]=crc;return out;
}
function crcFixPng(source) {
  const out=source.slice();let p=8;while(p<out.length){const n=(out[p]*0x1000000)+(out[p+1]<<16)+(out[p+2]<<8)+out[p+3], end=p+8+n, crc=crc32(out.subarray(p+4,end));out[end]=crc>>>24;out[end+1]=crc>>>16;out[end+2]=crc>>>8;out[end+3]=crc;p=end+4;}return out;
}
const pngFixture=crcFixPng(redPng);
function jpegFixture() {
  const seg=(marker,payload)=>{const out=new Uint8Array(payload.length+4);out.set([255,marker,0,(payload.length+2)&255]);out.set(payload,4);return out;};
  const app1=seg(0xe1,Uint8Array.from(Buffer.from('Exif\0location')));
  const sof=seg(0xc0,Uint8Array.from([8,0,1,0,1,1,1,0x11,0]));
  const sos=seg(0xda,Uint8Array.from([1,1,0,0,63,0]));
  return Buffer.concat([Buffer.from([255,216]),Buffer.from(app1),Buffer.from(sof),Buffer.from(sos),Buffer.from([0x11,0xff,0xd9])]);
}

function withPngText() {
  const parts=[pngFixture.subarray(0,33),chunk('tEXt',Uint8Array.from(Buffer.from('Location\0secret location'))),pngFixture.subarray(33)];
  return Buffer.concat(parts.map(p=>Buffer.from(p)));
}
function webpChunk(name,data) {
  const out=new Uint8Array(8+data.length+(data.length&1));
  for(let i=0;i<4;i++)out[i]=name.charCodeAt(i);out[4]=data.length;out.set(data,8);return out;
}
function simpleWebp() {
  // Minimal structurally valid 1x1 lossy frame payload.
  const vp8=Uint8Array.from([0,0,0,0x9d,0x01,0x2a,1,0,1,0]);
  const body=webpChunk('VP8 ',vp8), out=new Uint8Array(12+body.length);
  out.set(Buffer.from('RIFF'),0);out[4]=out.length-8;out.set(Buffer.from('WEBP'),8);out.set(body,12);return out;
}

test('accepts a real PNG and returns dimensions and normalized media type',()=>{
  const result=sanitizeImage(pngFixture,'image/png');
  assert.equal(result.width,1);assert.equal(result.height,1);assert.equal(result.mediaType,'image/png');
  assert.deepEqual(result.bytes,pngFixture);
});
test('removes PNG text metadata and retains decodable image chunks',()=>{
  const result=sanitizeImage(withPngText(),'image/png');
  assert.equal(Buffer.from(result.bytes).includes(Buffer.from('Location')),false);
  assert.equal(result.width,1);assert.equal(result.height,1);
});
test('accepts JPEG and strips APP1 metadata while preserving image bytes',()=>{
  const result=sanitizeImage(jpegFixture(),'image/jpeg');
  assert.equal(result.mediaType,'image/jpeg');assert.equal(result.width,1);assert.equal(result.height,1);
  assert.equal(Buffer.from(result.bytes).includes(Buffer.from('Exif')),false);
});
test('accepts simple WebP and rewrites RIFF length',()=>{
  const result=sanitizeImage(simpleWebp(),'image/webp');
  assert.equal(result.width,1);assert.equal(result.height,1);assert.equal(result.bytes.length-8,(result.bytes[4]|(result.bytes[5]<<8)|(result.bytes[6]<<16)|(result.bytes[7]<<24))>>>0);
});
test('rejects unsupported bytes, content type mismatch, malformed and over-limit inputs',()=>{
  assert.throws(()=>sanitizeImage(Uint8Array.of(1,2,3),'image/png'),/supported/);
  assert.throws(()=>sanitizeImage(pngFixture,'image/jpeg'),/Declared content type/);
  assert.throws(()=>sanitizeImage(pngFixture.subarray(0,pngFixture.length-4),'image/png'),/truncated|incomplete/i);
  assert.throws(()=>sanitizeImage(new Uint8Array(2*1024*1024+1),'image/png'),/2 MiB/);
});
test('rejects PNG dimensions above the pixel limit and zero dimensions',()=>{
  const huge=pngFixture.slice();huge[16]=0x00;huge[17]=0x4c;huge[18]=0x4b;huge[19]=0x41; // 5,000,001 width
  const crc=crc32(huge.subarray(12,29));huge[29]=crc>>>24;huge[30]=crc>>>16;huge[31]=crc>>>8;huge[32]=crc;
  assert.throws(()=>sanitizeImage(huge,'image/png'),/dimensions/);
});
test('rejects animated WebP',()=>{
  const anim=webpChunk('ANIM',new Uint8Array(6)), vp8=webpChunk('VP8 ',Uint8Array.from([0,0,0,0x9d,1,0x2a,1,0,1,0]));
  const body=Buffer.concat([Buffer.from(anim),Buffer.from(vp8)]), bytes=new Uint8Array(12+body.length);bytes.set(Buffer.from('RIFF'));bytes[4]=bytes.length-8;bytes.set(Buffer.from('WEBP'),8);bytes.set(body,12);
  assert.throws(()=>sanitizeImage(bytes,'image/webp'),/Animated/);
});
