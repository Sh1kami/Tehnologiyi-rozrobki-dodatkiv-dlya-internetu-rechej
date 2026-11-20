export const metrics = new Set(['speed', 'fuel', 'lat', 'lon', 'engine']);
export const zone = [[30.47,50.40],[30.57,50.40],[30.57,50.48],[30.47,50.48]];

export function distanceMeters(a, b) {
  const radians = Math.PI / 180;
  const latitude = (b.lat - a.lat) * radians;
  const longitude = (b.lon - a.lon) * radians;
  const haversine = Math.sin(latitude / 2) ** 2 +
    Math.cos(a.lat * radians) * Math.cos(b.lat * radians) * Math.sin(longitude / 2) ** 2;
  return 12742000 * Math.asin(Math.sqrt(Math.min(1, haversine)));
}

export function implausiblePosition(previous, current) {
  const elapsed = (current.ts - previous.ts) / 3600000;
  if (!Number.isFinite(elapsed) || elapsed <= 0 ||
      ![previous.lat,previous.lon,current.lat,current.lon].every(Number.isFinite)) return false;
  return distanceMeters(previous,current) / 1000 / elapsed > 250;
}

export function validCircle(circle) {
  return !!circle && Number.isFinite(circle.lat) && Math.abs(circle.lat) <= 90 &&
    Number.isFinite(circle.lon) && Math.abs(circle.lon) <= 180 &&
    Number.isInteger(circle.radiusM) && circle.radiusM >= 100 && circle.radiusM <= 5000;
}

export function outsideZone(position, geofence) {
  if (geofence?.radiusM) return distanceMeters(position, geofence) > geofence.radiusM;
  return isOutsideGeofence([position.lon, position.lat], geofence?.polygon ?? zone);
}

export function isOverspeed(speed, limit, tolerance = 0) {
  if (![speed, limit, tolerance].every(Number.isFinite) || speed < 0 || limit <= 0 || tolerance < 0) {
    throw new RangeError('invalid speed, limit, or tolerance');
  }
  return speed > limit + tolerance;
}

export function isOutsideGeofence([x, y], polygon) {
  if (!Number.isFinite(x) || !Number.isFinite(y) || polygon.length < 3) throw new RangeError('invalid position or zone');
  let inside = false;
  for (let i=0,j=polygon.length-1; i<polygon.length; j=i++) {
    const [ax,ay]=polygon[j], [bx,by]=polygon[i];
    const cross=(x-ax)*(by-ay)-(y-ay)*(bx-ax);
    if (Math.abs(cross)<1e-10 && x>=Math.min(ax,bx) && x<=Math.max(ax,bx) && y>=Math.min(ay,by) && y<=Math.max(ay,by)) return false;
    if ((ay>y)!==(by>y) && x < (bx-ax)*(y-ay)/(by-ay)+ax) inside=!inside;
  }
  return !inside;
}

export function point(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const {ts, metric, value}=payload;
  if (!Number.isSafeInteger(ts) || ts<0 || !metrics.has(metric) || !Number.isFinite(value)) return null;
  const bounds={speed:[0,250],fuel:[0,100],lat:[-90,90],lon:[-180,180],engine:[0,1]}[metric];
  if (value<bounds[0] || value>bounds[1] || (metric==='engine' && !Number.isInteger(value))) return null;
  return {ts,metric,value};
}

export function vehicleStatus(latest, settings, now=Date.now()) {
  if (!latest.lat || !latest.lon || latest.lat.ts!==latest.lon.ts || now-latest.lat.ts>180000) return 'offline';
  if (latest.fuel?.value < settings.fuelMinPercent) return 'critical';
  if (outsideZone({lon:latest.lon.value,lat:latest.lat.value},settings.geofence)) return 'outside';
  if (latest.speed && isOverspeed(latest.speed.value,settings.speedLimit)) return 'speed';
  if (latest.fuel?.value <= 20) return 'warning';
  return 'normal';
}

export function validSettings(v) {
  return v && Number.isInteger(v.speedLimit) && v.speedLimit>=30 && v.speedLimit<=130 && v.speedLimit%5===0 &&
    Number.isInteger(v.fuelMinPercent) && v.fuelMinPercent>=5 && v.fuelMinPercent<=30;
}

export function averageBuckets(points, step=900000) {
  const bucket=new Map();
  for (const {ts,value} of points) {
    const key=Math.floor(ts/step)*step, a=bucket.get(key) || [0,0];
    a[0]+=value; a[1]++; bucket.set(key,a);
  }
  return [...bucket].map(([ts,[sum,count]])=>({ts,value:sum/count,count}));
}

function distance(p,a,b) {
  // Equirectangular factor is adequate for this single-city training track.
  const k=Math.cos(p.lat*Math.PI/180);
  const x=(p.lon-a.lon)*k, y=p.lat-a.lat, dx=(b.lon-a.lon)*k,dy=b.lat-a.lat;
  const norm=dx*dx+dy*dy;
  const t=norm ? Math.max(0,Math.min(1,(x*dx+y*dy)/norm)) : 0;
  return Math.hypot(x-t*dx,y-t*dy);
}

export function simplifyTrack(points, maximum=500) {
  if (points.length<=maximum) return points;
  function rdp(epsilon) {
    const keep=new Set([0,points.length-1]), stack=[[0,points.length-1]];
    while(stack.length) {
      const [start,end]=stack.pop();
      let best=epsilon,index=-1;
      for(let i=start+1;i<end;i++) {
        const d=distance(points[i],points[start],points[end]);
        if(d>best) {best=d;index=i;}
      }
      if(index!==-1){keep.add(index);stack.push([start,index],[index,end]);}
    }
    return [...keep].sort((a,b)=>a-b).map(i=>points[i]);
  }
  let lower=0,upper=360,out=rdp(upper);
  for(let i=0;i<24;i++){
    const epsilon=(lower+upper)/2, current=rdp(epsilon);
    if(current.length>maximum) lower=epsilon; else {upper=epsilon;out=current;}
  }
  return out;
}
