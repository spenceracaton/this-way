export const countyBounds = [[27.605, -82.864], [28.181, -82.576]];
export const startView = {lat:27.789, lng:-82.642, zoom:13.5};
export const cities = [
  {id:'st-petersburg', name:'St. Petersburg', aliases:['St Pete','Saint Petersburg'], lat:27.773, lng:-82.645, zoom:13.5},
  {id:'clearwater', name:'Clearwater', aliases:[], lat:27.966, lng:-82.789, zoom:13.5},
  {id:'largo', name:'Largo', aliases:[], lat:27.910, lng:-82.785, zoom:13.5},
  {id:'dunedin', name:'Dunedin', aliases:[], lat:28.014, lng:-82.774, zoom:13.5},
  {id:'tarpon-springs', name:'Tarpon Springs', aliases:[], lat:28.146, lng:-82.756, zoom:13.5},
  {id:'gulfport', name:'Gulfport', aliases:[], lat:27.745, lng:-82.708, zoom:14},
  {id:'pinellas-park', name:'Pinellas Park', aliases:[], lat:27.844, lng:-82.699, zoom:13.5},
  {id:'safety-harbor', name:'Safety Harbor', aliases:[], lat:27.991, lng:-82.696, zoom:13.5}
];

export const normalize = value => String(value).normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
export function searchPlaces(query, places) {
  const key = normalize(query);
  if (!key) return [];
  const county={id:'county',name:'All Pinellas',aliases:['Pinellas County'],type:'county'};
  const exact=place=>[place.name,...(place.aliases||[])].some(name=>normalize(name)===key);
  return [county,...cities.map(city=>({...city,type:'city'})), ...places.map(place=>({...place,type:'neighborhood'}))]
    .filter(place=>[place.name,...(place.aliases||[])].some(name=>normalize(name).includes(key)))
    .sort((a,b)=>Number(exact(b))-Number(exact(a))||a.name.localeCompare(b.name));
}

// Nearest groups merge until every remaining pair is separated. Membership
// counts prepared maps, never listings; each source identity appears once.
export function clusterPoints(items, project, radius) {
  const groups = items.map(item=>({items:[item],...project(item)}));
  let merged = true;
  while (merged) {
    merged = false;
    for (let i=0;i<groups.length;i++) {
      let nearest = -1, distance = radius**2;
      for (let j=i+1;j<groups.length;j++) {
        const d = (groups[i].x-groups[j].x)**2 + (groups[i].y-groups[j].y)**2;
        if (d < distance) {nearest=j; distance=d;}
      }
      if (nearest<0) continue;
      const a=groups[i], b=groups.splice(nearest,1)[0], count=a.items.length+b.items.length;
      a.x=(a.x*a.items.length+b.x*b.items.length)/count;
      a.y=(a.y*a.items.length+b.y*b.items.length)/count;
      a.items.push(...b.items); merged=true;
    }
  }
  return groups;
}

export function readCamera(query) {
  const lat=Number(query.get('lat')), lng=Number(query.get('lng')), zoom=Number(query.get('z'));
  if (!['lat','lng','z'].every(key=>query.has(key)) || !Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(zoom)
    || lat<27.5 || lat>28.3 || lng< -83 || lng> -82.4 || zoom<9 || zoom>18) return {...startView};
  return {lat,lng,zoom};
}

export function approvedPhotos(photos, origin) {
  return (Array.isArray(photos)?photos:[]).filter(photo=>photo && (photo.status===undefined || photo.status==='approved'))
    .map(photo=>{try {const url=new URL(photo.url,origin);return url.origin===origin && /^\/api\/photos\/[a-zA-Z0-9_-]+$/.test(url.pathname)?url.pathname:null;}catch{return null;}})
    .filter(Boolean);
}

export function publishedRecords(listings, place, origin) {
  if (!Array.isArray(listings)) throw new Error('Invalid published display feed');
  const ids = new Set();
  return listings.map(item=>{
    if (!item || typeof item.id!=='string' || !item.id || ids.has(item.id) || typeof item.address!=='string' || !item.address
      || !Number.isFinite(item.latitude) || !Number.isFinite(item.longitude) || Math.abs(item.latitude)>90 || Math.abs(item.longitude)>180) {
      throw new Error('Invalid display identity or location');
    }
    ids.add(item.id);
    return {...item,lat:item.latitude,lng:item.longitude,neighborhoodId:place.id,neighborhood:place.name,
      photos:approvedPhotos(item.photos,origin),tags:[...(Array.isArray(item.tags)?item.tags:[]),...(Array.isArray(item.customTags)?item.customTags:[])].filter(tag=>typeof tag==='string')};
  });
}
