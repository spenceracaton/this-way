 const node=(tag,text)=>{const el=document.createElement(tag);if(text)el.textContent=text;return el};
 const button=(label,text,click)=>{const el=node('button',text);el.type='button';el.setAttribute('aria-label',label);el.onclick=click;return el};
 const galleries=new WeakMap(),PHOTO_TIMEOUT=20000;
 function loadingPlaceholder(){const el=node('div');el.className='photo-loading';el.setAttribute('aria-hidden','true');return el}
 function chevron(direction){
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg'),path=document.createElementNS('http://www.w3.org/2000/svg','path');
  svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');svg.setAttribute('focusable','false');
  path.setAttribute('d',direction==='previous'?'M15 6 L9 12 L15 18':'M9 6 L15 12 L9 18');svg.append(path);return svg;
 }
 function gallery(host,items,address,{large=false,onOpen,closeButton,initialIndex=0,description='',onLayout,showViewAction=true}={}){
  galleries.get(host)?.destroy();
  const photos=items;host.onkeydown=null;host.replaceChildren();if(!photos.length)return;
  let index=0,visibleIndex=-1,start=null,suppressClickUntil=0,revision=0,destroyed=false,active=null,outgoing=null,fadeTimer=null,fadeFrame=null;
  
  const cache=new Map(),dots=[],fixedPreview=!large;let viewAction=null,lastRatio=null;
  host.className=large?'photo-gallery photo-gallery-large':'photo-gallery';
  host.setAttribute('role','region');host.setAttribute('aria-roledescription','carousel');host.setAttribute('aria-label','Photos of '+address);
  const frame=node('div');frame.className='photo-frame';
  const loading=loadingPlaceholder();frame.append(loading);
  const error=node('div');error.className='photo-unavailable';error.hidden=true;
  const retry=button('Retry loading photo','Retry',()=>show(index));retry.className='photo-retry';error.append(node('span','Photo unavailable'),retry);
  const imageButton=large?node('div'):button('Enlarge photo of '+address,'',()=>{if(visibleIndex>=0&&Date.now()>suppressClickUntil)onOpen?.(visibleIndex)});
  imageButton.className='photo-image';frame.append(imageButton,error);if(closeButton&&!large)frame.append(closeButton);host.append(frame);

  const count=node('span');count.className='photo-count';count.setAttribute('aria-live','polite');count.setAttribute('aria-atomic','true');host.append(count);
  function load(i){
   if(cache.has(i))return cache.get(i).promise;
   const image=node('img');image.loading='eager';image.decoding='async';image.draggable=false;
   image.alt=(description?description+' at ':'Display at ')+address+', photo '+(i+1)+' of '+photos.length;
   const contained=true;
   image.style.objectFit=contained?'contain':'cover';
   let settle,finished=false,decoding=false,timer,source=null;
   const promise=new Promise(resolve=>{settle=resolve});
   function done(value){
    if(finished)return;finished=true;clearTimeout(timer);image.onload=null;image.onerror=null;
    if(!value){image.removeAttribute('src');cache.delete(i)}settle(value);
   }
   const entry={image,promise,cancel:()=>{done(null);image.removeAttribute('src')}};cache.set(i,entry);
   timer=setTimeout(()=>done(null),PHOTO_TIMEOUT);
   const finish=async()=>{
    if(finished||decoding)return;decoding=true;
    try{if(typeof image.decode==='function')await image.decode()}catch{if(!finished&&!destroyed){done(null)}return}
    if(finished||destroyed)return;
    // Dimension fallback protects portrait uploads whose metadata is absent.
    image.style.objectFit=contained||image.naturalHeight>image.naturalWidth?'contain':'cover';done(image);
   };
   image.onload=finish;image.onerror=()=>{if(!finished){done(null)}};
   const ready=url=>{if(finished||destroyed)return;if(!url){done(null);return}source=url;image.src=url;if(image.complete&&image.naturalWidth)finish()};
   ready(photos[i].url);
   return promise;
  }
  function finishFade(){
   clearTimeout(fadeTimer);if(fadeFrame!==null)cancelAnimationFrame(fadeFrame);fadeFrame=null;
   outgoing?.remove();outgoing=null;if(active){active.style.opacity='1';loading.hidden=true;}
  }
  function positionControls(){
   if(!active)return;
   if(fixedPreview)return;
   if(!large){const image=active.querySelector('img');const ratio=(image.naturalWidth||Number(photos[visibleIndex]?.width)||4)/(image.naturalHeight||Number(photos[visibleIndex]?.height)||3);if(lastRatio!==ratio){lastRatio=ratio;frame.style.setProperty('--photo-ratio',String(ratio));onLayout?.()}return;}
   const image=active.querySelector('img'),bounds=image.getBoundingClientRect?.(),stage=frame.getBoundingClientRect?.();
   if(!bounds||!stage||!bounds.width)return;
   frame.style.setProperty('--photo-bottom',Math.max(0,stage.bottom-bounds.bottom)+'px');
   if(!large)return;
   // Tiny portraits must not collapse the two 44px navigation targets together.
   const maxInset=Math.max(0,((stage.right-stage.left)-112)/2);
   frame.style.setProperty('--photo-left',Math.max(0,Math.min(maxInset,bounds.left-stage.left))+'px');
   frame.style.setProperty('--photo-right',Math.max(0,Math.min(maxInset,stage.right-bounds.right))+'px');
   frame.style.setProperty('--photo-close-right',Math.max(0,stage.right-bounds.right)+'px');
   frame.style.setProperty('--photo-top',Math.max(0,bounds.top-stage.top)+'px');
  }
  const resize=!fixedPreview&&typeof ResizeObserver==='function'?new ResizeObserver(positionControls):null;resize?.observe(frame);
  function announce(i){count.textContent='Photo '+(i+1)+' of '+photos.length;dots.forEach((dot,n)=>dot.setAttribute('aria-current',n===i?'true':'false'))}
  async function show(next){
   // Every navigation path hides Retry, including arrows and swipes.
   if(document.activeElement===retry)(closeButton||imageButton).focus({preventScroll:true});
   index=((next%photos.length)+photos.length)%photos.length;const target=index,ticket=++revision;
   error.hidden=true;loading.hidden=visibleIndex>=0;if(visibleIndex<0)count.textContent='Loading photo';host.setAttribute('aria-busy','true');
   const image=await load(target);
   if(destroyed||ticket!==revision)return;
   host.setAttribute('aria-busy','false');
   if(!image){loading.hidden=true;error.hidden=false;count.textContent='Photo '+(target+1)+' of '+photos.length+' unavailable';cache.delete(target);return;}
   finishFade();
   if(target!==visibleIndex){
    const layer=node('div');layer.className='photo-layer';layer.append(image);
    const animate=!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    outgoing=active;if(outgoing)outgoing.setAttribute('aria-hidden','true');active=layer;active.style.opacity=animate?'0':'1';imageButton.append(layer);visibleIndex=target;
    // Two frames establish opacity:0 before transitioning, including cached card images.
    if(animate){fadeFrame=requestAnimationFrame(()=>{fadeFrame=requestAnimationFrame(()=>{fadeFrame=null;if(destroyed)return;active.style.opacity='1';if(outgoing)outgoing.style.opacity='0';fadeTimer=setTimeout(finishFade,200)})})}
    else finishFade();
   }
   positionControls();announce(target);if(viewAction)viewAction.disabled=false;
   // At most three selected-house images; never fetch galleries for other cards.
   if(photos.length>1){load((target+1)%photos.length)}
  }
  if(photos.length>1){
   const previous=button('Previous photo','',()=>show(index-1)),next=button('Next photo','',()=>show(index+1));previous.append(chevron('previous'));next.append(chevron('next'));previous.className='photo-arrow photo-prev';next.className='photo-arrow photo-next';frame.append(previous,next);
   const controls=node('div');controls.className='photo-controls';controls.setAttribute('aria-label','Choose a photo');
   photos.forEach((_,i)=>{const dot=button('Show photo '+(i+1)+' of '+photos.length,'',()=>show(i));dot.append(node('span'));dots.push(dot);controls.append(dot)});host.append(controls);
   frame.addEventListener('touchstart',e=>{start=null;if(e.touches.length===1)start={x:e.touches[0].clientX,y:e.touches[0].clientY}},{passive:true});
   frame.addEventListener('touchend',e=>{if(!start||e.touches?.length||!e.changedTouches.length)return;const dx=e.changedTouches[0].clientX-start.x,dy=e.changedTouches[0].clientY-start.y;start=null;if(Math.abs(dx)>45&&Math.abs(dx)>Math.abs(dy)*1.5){suppressClickUntil=Date.now()+500;show(index+(dx<0?1:-1))}},{passive:true});
   frame.addEventListener('touchcancel',()=>{start=null},{passive:true});
   host.onkeydown=e=>{if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();e.stopPropagation();show(index+(e.key==='ArrowLeft'?-1:1))}};
  }
  function destroy(){if(destroyed)return;resize?.disconnect();loading.hidden=true;host.setAttribute('aria-busy','false');destroyed=true;++revision;finishFade();host.onkeydown=null;cache.forEach(entry=>entry.cancel());cache.clear();galleries.delete(host)}
  if(!large&&onOpen&&showViewAction){const caption=button('View '+photos.length+' '+(photos.length===1?'photo':'photos')+' of '+address,'View '+photos.length+' '+(photos.length===1?'photo':'photos'),()=>{if(visibleIndex>=0)onOpen(visibleIndex)});caption.className='action-text photo-view-action';caption.disabled=true;viewAction=caption;host.append(caption)}
  const api={show,destroy};galleries.set(host,api);show(initialIndex);return api;
 }
 function openViewer(items,address,index=0,description=''){
  const photos=items;if(!photos.length)return;
  document.querySelector('.photo-lightbox')?.close();
  const previous=document.activeElement,dialog=node('dialog');dialog.className='photo-lightbox';dialog.setAttribute('aria-label','Photos of '+address);
  const close=button('Close photos','×',()=>dialog.close());close.className='photo-close';const host=node('div');dialog.append(close,host);document.body.append(dialog);
  const view=gallery(host,photos,address,{large:true,closeButton:close,initialIndex:index,description});
  dialog.addEventListener('keydown',event=>{if(event.target===close)host.onkeydown?.(event)});
  dialog.addEventListener('close',()=>{view.destroy();dialog.remove();if(previous?.isConnected)previous.focus()});
  let backdropPress=false;
  dialog.addEventListener('pointerdown',e=>{backdropPress=e.target===dialog});
  dialog.addEventListener('click',e=>{if(backdropPress&&e.target===dialog)dialog.close();backdropPress=false});
  // Native modal dialog provides focus containment, Escape and inert background.
  dialog.showModal();close.focus();
 }

export function mountGallery(host, photos, address) {
  return gallery(host, photos, address, {
    showViewAction: false,
    onOpen: index => openViewer(photos, address, index)
  });
}
