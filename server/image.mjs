const MAX_BYTES = 2 * 1024 * 1024;
const MAX_PIXELS = 20_000_000;
const MAX_DIMENSION = 10_000;

function fail(message) {
  const error = new Error(message);
  error.status = 400;
  throw error;
}

function inputBytes(value) {
  if (!(value instanceof Uint8Array)) fail('Image must be supplied as bytes.');
  if (!value.byteLength || value.byteLength > MAX_BYTES) fail('Image must be between 1 byte and 2 MiB.');
  return value;
}
function dimensions(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS) fail('Image dimensions are invalid or exceed the 20 megapixel limit.');
  return { width, height };
}
function matchType(type, expected) {
  if (type !== expected) fail(`Declared content type must be ${expected}.`);
}
function ascii(bytes, at, value) {
  if (at + value.length > bytes.length) return false;
  for (let i = 0; i < value.length; i++) if (bytes[at + i] !== value.charCodeAt(i)) return false;
  return true;
}
function u32be(b, p) { return b[p] * 0x1000000 + (b[p + 1] << 16) + (b[p + 2] << 8) + b[p + 3]; }
function u24le(b, p) { return b[p] | (b[p + 1] << 8) | (b[p + 2] << 16); }
function le32(b,p) { return (b[p] | (b[p+1]<<8) | (b[p+2]<<16) | (b[p+3]<<24)) >>> 0; }
function putLe32(out,p,v) { out[p]=v&255; out[p+1]=(v>>>8)&255; out[p+2]=(v>>>16)&255; out[p+3]=(v>>>24)&255; }
function concat(parts, length) { const out=new Uint8Array(length); let p=0; for (const part of parts) { out.set(part,p); p+=part.length; } return out; }

function crc32(bytes, start, end) {
  let crc = 0xffffffff;
  for (let i=start; i<end; i++) {
    crc ^= bytes[i];
    for (let j=0; j<8; j++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function png(bytes, declaredType) {
  matchType(declaredType,'image/png');
  const sig=[137,80,78,71,13,10,26,10];
  if (bytes.length < 8 || sig.some((x,i)=>bytes[i]!==x)) fail('Invalid PNG image.');
  let p=8, width=0, height=0, colorType=-1, seenIHDR=false, seenPLTE=false, seenTRNS=false, seenIDAT=false, ended=false, idatEnded=false;
  const keep=[];
  while (p < bytes.length) {
    if (p + 12 > bytes.length) fail('Truncated PNG chunk.');
    const len=u32be(bytes,p), typeAt=p+4, dataAt=p+8, crcAt=dataAt+len;
    if (len > MAX_BYTES || crcAt+4 > bytes.length) fail('Invalid or truncated PNG chunk.');
    const type=String.fromCharCode(bytes[typeAt],bytes[typeAt+1],bytes[typeAt+2],bytes[typeAt+3]);
    for (let i=0;i<4;i++) if (!((bytes[typeAt+i]>=65&&bytes[typeAt+i]<=90)||(bytes[typeAt+i]>=97&&bytes[typeAt+i]<=122))) fail('Invalid PNG chunk type.');
    if (crc32(bytes,typeAt,crcAt) !== u32be(bytes,crcAt)) fail('PNG checksum is invalid.');
    if (!seenIHDR) {
      if (type!=='IHDR'||len!==13) fail('PNG must begin with a valid IHDR chunk.');
      width=u32be(bytes,dataAt); height=u32be(bytes,dataAt+4); dimensions(width,height);
      const depth=bytes[dataAt+8], color=bytes[dataAt+9]; colorType=color;
      const compression=bytes[dataAt+10], filter=bytes[dataAt+11], interlace=bytes[dataAt+12];
      const depths={0:[1,2,4,8,16],2:[8,16],3:[1,2,4,8],4:[8,16],6:[8,16]};
      if (!depths[color]?.includes(depth)||compression!==0||filter!==0||interlace>1) fail('Unsupported or invalid PNG encoding.');
      seenIHDR=true; keep.push(bytes.slice(p,crcAt+4));
    } else if (type==='IHDR') fail('PNG contains multiple IHDR chunks.');
    else if (type==='IDAT') {
      if (idatEnded||ended) fail('PNG image data chunks are out of order.');
      seenIDAT=true; keep.push(bytes.slice(p,crcAt+4));
    } else {
      if (seenIDAT && type!=='IEND') idatEnded=true;
      if (type==='IEND') {
        if (len!==0||!seenIDAT||ended||crcAt+4!==bytes.length) fail('Invalid PNG end chunk.');
        ended=true; keep.push(bytes.slice(p,crcAt+4));
      } else if (type==='PLTE') {
        if (seenIDAT||ended||seenPLTE||colorType===0||colorType===4||len===0||len>768||len%3!==0) fail('PNG palette chunk is invalid or out of order.');
        seenPLTE=true; keep.push(bytes.slice(p,crcAt+4));
      } else if (type==='tRNS') {
        if (seenIDAT||ended||seenTRNS||(colorType===3&&!seenPLTE)||(colorType===0&&len!==2)||(colorType===2&&len!==6)||(colorType!==0&&colorType!==2&&colorType!==3)) fail('PNG transparency chunk is invalid or out of order.');
        seenTRNS=true; keep.push(bytes.slice(p,crcAt+4));
      } else if ((bytes[typeAt]&32)===0) fail('Unsupported critical PNG chunk.');
    }
    p=crcAt+4;
    if (ended) break;
  }
  if (!seenIHDR||!seenIDAT||!ended||(colorType===3&&!seenPLTE)) fail('PNG is incomplete.');
  const out=concat([Uint8Array.from(sig),...keep],8+keep.reduce((n,x)=>n+x.length,0));
  if (out.length>MAX_BYTES) fail('Sanitized image exceeds 2 MiB.');
  return {bytes:out,mediaType:'image/png',width,height};
}

const SOF = new Set([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf]);
function jpeg(bytes, declaredType) {
  matchType(declaredType,'image/jpeg');
  if (bytes.length<4||bytes[0]!==255||bytes[1]!==216) fail('Invalid JPEG image.');
  const parts=[bytes.slice(0,2)]; let p=2,width=0,height=0,hasSOS=false,hasEOI=false;
  while (p<bytes.length) {
    const start=p;
    if (bytes[p++]!==255) fail('Invalid JPEG marker sequence.');
    while (p<bytes.length&&bytes[p]===255) p++;
    if (p>=bytes.length) fail('Truncated JPEG marker.');
    const marker=bytes[p++];
    if (marker===0xd9) { hasEOI=true; if (p!==bytes.length) fail('Unexpected data after JPEG end.'); parts.push(bytes.slice(start,p)); break; }
    if (marker===0xd8||marker===0x00||(marker>=0xd0&&marker<=0xd7)||marker===0x01) fail('Invalid JPEG segment.');
    if (p+2>bytes.length) fail('Truncated JPEG segment.');
    const len=(bytes[p]<<8)|bytes[p+1];
    if (len<2||p+len>bytes.length) fail('Truncated JPEG segment.');
    const end=p+len;
    if (SOF.has(marker)) {
      if (len<8) fail('Invalid JPEG dimensions.');
      height=(bytes[p+3]<<8)|bytes[p+4]; width=(bytes[p+5]<<8)|bytes[p+6]; dimensions(width,height);
    }
    // Keep JFIF, ICC profiles, and Adobe color transform markers. Drop all other APP data and COM.
    if (!(marker===0xfe||(marker>=0xe1&&marker<=0xed)||marker===0xef)) parts.push(bytes.slice(start,end));
    p=end;
    if (marker===0xda) {
      hasSOS=true;
      // Scan entropy-coded data; 0xff00 is stuffed data and restart markers are inline.
      // Other markers delimit the scan and are parsed by the outer segment loop.
      while (p<bytes.length) {
        if (bytes[p]!==255) { p++; continue; }
        let q=p+1; while(q<bytes.length&&bytes[q]===255) q++;
        if(q>=bytes.length) fail('JPEG scan is truncated.');
        const code=bytes[q];
        if(code===0x00||(code>=0xd0&&code<=0xd7)){p=q+1;continue;}
        break;
      }
      if(p>=bytes.length) fail('JPEG scan is truncated.');
      parts.push(bytes.slice(end,p));
    }
  }
  if (!width||!height||!hasSOS||!hasEOI) fail('JPEG is incomplete or unsupported.');
  const out=concat(parts,parts.reduce((n,x)=>n+x.length,0));
  if (out.length>MAX_BYTES) fail('Sanitized image exceeds 2 MiB.');
  return {bytes:out,mediaType:'image/jpeg',width,height};
}
function webp(bytes, declaredType) {
  matchType(declaredType,'image/webp');
  if (bytes.length<20||!ascii(bytes,0,'RIFF')||!ascii(bytes,8,'WEBP')||le32(bytes,4)!==bytes.length-8) fail('Invalid WebP RIFF container.');
  let p=12,width=0,height=0,extended=false,hasImage=false,hasVP8X=false,flags=0;
  const chunks=[];
  while(p<bytes.length) {
    if(p+8>bytes.length) fail('Truncated WebP chunk.');
    const type=String.fromCharCode(...bytes.subarray(p,p+4)), len=le32(bytes,p+4), data=p+8, padded=len+(len&1), end=data+padded;
    if(end>bytes.length) fail('Truncated WebP chunk.');
    if((len&1)&&bytes[end-1]!==0) fail('Invalid WebP chunk padding.');
    const payload=bytes.subarray(data,data+len);
    if(type==='ANIM'||type==='ANMF') fail('Animated WebP images are not supported.');
    if(type==='VP8X') {
      if(hasVP8X||p!==12||len!==10) fail('Invalid WebP extended header.');
      hasVP8X=true; extended=true; flags=payload[0];
      if(flags&0xc1) fail('Invalid WebP feature flags.');
      if(flags&0x02) fail('Animated WebP images are not supported.');
      width=u24le(payload,4)+1; height=u24le(payload,7)+1; dimensions(width,height);
      // Preserve reserved bits and clear metadata feature flags (EXIF/XMP/ICC).
      const copy=bytes.slice(p,end); copy[8]&=~0x2c; // Clear ICCP, EXIF, and XMP presence flags.
      chunks.push({type,bytes:copy});
    } else if(type==='VP8 ') {
      if(len<10||payload[3]!==0x9d||payload[4]!==0x01||payload[5]!==0x2a) fail('Invalid WebP VP8 frame.');
      const w=((payload[7]&0x3f)<<8)|payload[6], h=((payload[9]&0x3f)<<8)|payload[8];
      if(!width){width=w;height=h;} else if(width!==w||height!==h) fail('WebP dimensions do not match its canvas.');
      dimensions(width,height); hasImage=true; chunks.push({type,bytes:bytes.slice(p,end)});
    } else if(type==='VP8L') {
      if(len<5||payload[0]!==0x2f) fail('Invalid WebP lossless frame.');
      const w=1+payload[1]+((payload[2]&0x3f)<<8), h=1+((payload[2]>>6)|(payload[3]<<2)|((payload[4]&0x0f)<<10));
      if(!width){width=w;height=h;} else if(width!==w||height!==h) fail('WebP dimensions do not match its canvas.');
      dimensions(width,height); hasImage=true; chunks.push({type,bytes:bytes.slice(p,end)});
    } else if(type==='ALPH') {
      if(!extended||hasImage) fail('Invalid WebP alpha chunk.');
      chunks.push({type,bytes:bytes.slice(p,end)});
    } else if(type==='ICCP'||type==='EXIF'||type==='XMP ') {
      // Metadata removed. ICCP intentionally dropped to avoid retaining untrusted ancillary data.
    } else if(type==='ANIM'||type==='ANMF') fail('Animated WebP images are not supported.');
    else fail('Unsupported WebP chunk.');
    p=end;
  }
  if(p!==bytes.length||!hasImage) fail('WebP image data is incomplete.');
  if(extended&&!hasVP8X) fail('Invalid WebP extended image.');
  if(!extended&&chunks.some(c=>c.type==='ALPH')) fail('Invalid WebP alpha image.');
  const body=concat(chunks.map(c=>c.bytes),chunks.reduce((n,c)=>n+c.bytes.length,0));
  const out=new Uint8Array(12+body.length); out.set([82,73,70,70],0); putLe32(out,4,out.length-8); out.set([87,69,66,80],8); out.set(body,12);
  if(out.length>MAX_BYTES) fail('Sanitized image exceeds 2 MiB.');
  return {bytes:out,mediaType:'image/webp',width,height};
}

/** Validate and strip location-bearing/ancillary metadata from a JPEG, PNG, or WebP upload.
 * This validates container structure and declared dimensions; it does not decode pixels.
 */
export function sanitizeImage(value, declaredContentType) {
  const bytes=inputBytes(value);
  if(bytes[0]===0xff&&bytes[1]===0xd8) return jpeg(bytes,declaredContentType);
  if(bytes.length>=8&&bytes[0]===137&&ascii(bytes,1,'PNG')) return png(bytes,declaredContentType);
  if(ascii(bytes,0,'RIFF')&&ascii(bytes,8,'WEBP')) return webp(bytes,declaredContentType);
  fail('Only JPEG, PNG, and WebP images are supported.');
}
