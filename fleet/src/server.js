import express from 'express';
import {DatabaseSync} from 'node:sqlite';
import {createServer} from 'node:http';
import {createHash,randomBytes} from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import {Server} from 'socket.io';
import mqtt from 'mqtt';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {metrics,point,averageBuckets,validSettings,simplifyTrack,vehicleStatus} from './domain.js';

const seeds=[
  ['truck-07','Тягач 07','west','Рейс 42'],
  ['truck-12','Тягач 12','west','Рейс 18'],
  ['van-03','Фургон 03','east','Рейс 26'],
  ['van-08','Фургон 08','east','Рейс 09']
];
const web=fileURLToPath(new URL('../dist',import.meta.url));
const hash=value=>createHash('sha256').update(value).digest('hex');

export function createFleet({database=':memory:', mqttUrl, secret, password, origin, refreshMs=86400000}) {
  if (!secret || secret.length<32 || !password || password.length<12) throw new Error('Configure a signing secret and a strong account password.');
  const db=new DatabaseSync(database);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON');
  db.exec("CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY, name TEXT, region TEXT, route TEXT, speedLimit INTEGER DEFAULT 60, fuelMinPercent INTEGER DEFAULT 10, version INTEGER DEFAULT 1); CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, role TEXT NOT NULL, vehicle TEXT REFERENCES devices(id)); CREATE TABLE IF NOT EXISTS points(device TEXT REFERENCES devices(id), metric TEXT, ts INTEGER, value REAL, PRIMARY KEY(device,metric,ts)); CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, device TEXT, metric TEXT, ts INTEGER, value REAL); CREATE TABLE IF NOT EXISTS geofence_events(device TEXT, ts INTEGER, outside INTEGER, PRIMARY KEY(device,ts));");
  for (const row of seeds) db.prepare('INSERT OR IGNORE INTO devices(id,name,region,route) VALUES(?,?,?,?)').run(...row);
  for(const row of [['driver','driver','truck-07'],['dispatch-west','dispatcher',null],['dispatch-east','dispatcher',null]]) db.prepare('INSERT OR IGNORE INTO users VALUES(?,?,?)').run(...row);
  const users=new Map(db.prepare('SELECT * FROM users').all().map(x=>[x.id,{...x,region:x.id.endsWith('-west')?'west':x.id.endsWith('-east')?'east':null}]));
  const passHash=bcrypt.hashSync(password,10);
  const refresh=new Map(), attempts=new Map(), streams=new Set(), expiries=new Map();
  const counters={received:0,stored:0,rejected:0,duplicate:0,geofence:0};
  const app=express();
  app.disable('x-powered-by');
  app.disable('etag');
  app.use(express.json({limit:'16kb'}));
  if(origin) app.use((req,res,next)=>{
    if(req.get('Origin')===origin) {
      res.set({'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Headers':'Authorization, Content-Type, If-Match, Last-Event-ID','Access-Control-Allow-Methods':'GET, POST, PUT, OPTIONS','Access-Control-Expose-Headers':'ETag'});
      res.vary('Origin');
      if(req.method==='OPTIONS') return res.sendStatus(204);
    }
    next();
  });
  const http=createServer(app);
  const io=new Server(http,{cors:origin?{origin}:undefined,path:process.env.WS_PATH || '/socket.io'});
  const broker=mqtt.connect(mqttUrl,{reconnectPeriod:500,connectTimeout:3000});
  broker.on('error',()=>{});
  broker.on('connect',()=>broker.subscribe(['fleet/+/telemetry','fleet/+/geofence'],{qos:1}));

  function visible(user, device) { return user.role==='dispatcher' || user.vehicle===device; }
  function receives(user, device) {
    return user.role==='driver' ? user.vehicle===device.id : user.region===device.region;
  }
  function identify(token) {
    const claims=jwt.verify(token,secret,{algorithms:['HS256'],issuer:'fleet-watch',audience:'fleet-clients'});
    const user=users.get(claims.sub);
    if (!user || user.role!==claims.role) throw new Error('invalid identity');
    return {user, exp:claims.exp*1000};
  }
  const err=(res,status,error)=>res.status(status).json({error});
  function auth(req,res,next){
    try{
      const header=req.get('Authorization') || '';
      if(!header.startsWith('Bearer ')) throw new Error();
      const identity=identify(header.slice(7));
      req.user=identity.user; req.sessionExpires=identity.exp;
      res.set('Cache-Control','no-store');
      next();
    }catch{res.set('WWW-Authenticate','Bearer');err(res,401,'unauthorized');}
  }
  function tokens(user){
    const now=Date.now();
    for(const [key,session] of refresh) if(session.expires<=now) refresh.delete(key);
    const refreshToken=randomBytes(32).toString('base64url');
    refresh.set(hash(refreshToken),{user:user.id,expires:now+refreshMs});
    const accessToken=jwt.sign({role:user.role},secret,{subject:user.id,issuer:'fleet-watch',audience:'fleet-clients',expiresIn:900,algorithm:'HS256'});
    return {accessToken,refreshToken,expiresIn:900,role:user.role,region:user.region};
  }
  app.post('/api/v1/auth/login',(req,res)=>{
    const now=Date.now();
    for(const [ip,state] of attempts) if(state.until<=now) attempts.delete(ip);
    const key=req.ip, attempt=attempts.get(key) || {n:0,until:now+60000};
    if(attempt.n>=15){res.set('Retry-After',String(Math.ceil((attempt.until-now)/1000)));return err(res,429,'try_later');}
    const user=users.get(req.body?.username);
    const matches=typeof req.body?.password==='string' && req.body.password.length<=128 && bcrypt.compareSync(req.body.password,passHash);
    if(!user || !matches){attempt.n++;attempts.set(key,attempt);return err(res,401,'invalid_credentials');}
    attempts.delete(key);
    res.set('Cache-Control','no-store').json(tokens(user));
  });
  app.post('/api/v1/auth/refresh',(req,res)=>{
    const key=typeof req.body?.refreshToken==='string' && req.body.refreshToken.length<128 ? hash(req.body.refreshToken) : '';
    const state=refresh.get(key);
    refresh.delete(key);
    if(!state || state.expires<=Date.now()) return err(res,401,'invalid_refresh_token');
    res.set('Cache-Control','no-store').json(tokens(users.get(state.user)));
  });
  const deviceInfo=id=>db.prepare('SELECT * FROM devices WHERE id=?').get(id);
  const windowed=(id,metric,from,to)=>db.prepare('SELECT ts,value FROM points WHERE device=? AND metric=? AND ts BETWEEN ? AND ? ORDER BY ts LIMIT 10000').all(id,metric,from,to);
  function decision(req,res,id){
    const device=deviceInfo(id);
    if(!device){err(res,404,'device_not_found');return;}
    if(!visible(req.user,id)){err(res,403,'forbidden');return;}
    return device;
  }
  const getWindow=req=>{
    const to=Number(req.query.to ?? Date.now()),from=Number(req.query.from ?? to-86400000);
    if(!Number.isSafeInteger(from)||!Number.isSafeInteger(to)||from<0||from>to||to-from>604800000) return null;
    return [from,to];
  };
  app.get('/api/v1/devices',auth,(req,res)=>{
    const rows=db.prepare('SELECT * FROM devices ORDER BY id').all();
    res.json(rows.filter(d=>visible(req.user,d.id)).map(d=>{
      const latest=Object.fromEntries([...metrics].flatMap(metric=>{
        const value=db.prepare('SELECT ts,value FROM points WHERE device=? AND metric=? ORDER BY ts DESC LIMIT 1').get(d.id,metric);
        return value?[[metric,value]]:[];
      }));
      return {...d,latest,status:vehicleStatus(latest,d)};
    }));
  });
  app.get('/api/v1/telemetry',auth,(req,res)=>{
    const {device,metric,agg,interval}=req.query, time=getWindow(req);
    if(typeof device!=='string'||!metrics.has(metric)||!time|| (agg!==undefined && (agg!=='avg'||interval!=='15m'))) return err(res,400,'invalid_query');
    if(!decision(req,res,device))return;
    const points=windowed(device,metric,...time);
    res.json({device,metric,points:agg?averageBuckets(points):points});
  });
  app.get('/api/v1/track',auth,(req,res)=>{
    const {device,format}=req.query,time=getWindow(req);
    if(typeof device!=='string'||!time)return err(res,400,'invalid_query');
    if(!decision(req,res,device))return;
    const positions=db.prepare("SELECT a.ts,a.value AS lat,b.value AS lon,s.value AS speed FROM points a JOIN points b ON a.device=b.device AND a.ts=b.ts AND b.metric='lon' LEFT JOIN points s ON a.device=s.device AND a.ts=s.ts AND s.metric='speed' WHERE a.device=? AND a.metric='lat' AND a.ts BETWEEN ? AND ? ORDER BY a.ts LIMIT 20000").all(device,...time);
    if(format==='csv')return res.type('text/csv').attachment('track.csv').send('ts,lat,lon,speed\n'+positions.map(p=>[p.ts,p.lat,p.lon,p.speed??''].join(',')).join('\n'));
    res.json({device,total:positions.length,points:simplifyTrack(positions)});
  });
  app.get('/api/v1/alerts',auth,(req,res)=>{
    const {device,metric='fuel',threshold='10'}=req.query,time=getWindow(req),limit=Number(threshold);
    if(typeof device!=='string'||!['fuel','speed'].includes(metric)||!Number.isFinite(limit)||limit<0||!time) return err(res,400,'invalid_query');
    if(!decision(req,res,device))return;
    res.json({device,metric,points:windowed(device,metric,...time).filter(p=>metric==='fuel'?p.value<limit:p.value>limit)});
  });
  app.get('/api/v1/vehicles/:id/alert-settings',auth,(req,res)=>{
    const d=decision(req,res,req.params.id); if(!d)return;
    res.set('ETag','"'+d.version+'"').json({speedLimit:d.speedLimit,fuelMinPercent:d.fuelMinPercent,version:d.version});
  });
  app.put('/api/v1/vehicles/:id/alert-settings',auth,(req,res)=>{
    if(req.user.role!=='dispatcher')return err(res,403,'forbidden');
    const d=decision(req,res,req.params.id); if(!d)return;
    const tag=req.get('If-Match');
    if(!tag)return err(res,428,'precondition_required');
    if(tag!=='"'+d.version+'"')return err(res,412,'stale_version');
    if(!validSettings(req.body))return err(res,400,'invalid_settings');
    const {speedLimit,fuelMinPercent}=req.body;
    db.prepare('UPDATE devices SET speedLimit=?,fuelMinPercent=?,version=version+1 WHERE id=?').run(speedLimit,fuelMinPercent,d.id);
    res.set('ETag','"'+(d.version+1)+'"').json({speedLimit,fuelMinPercent,version:d.version+1});
  });
  app.get('/api/v1/health',(req,res)=>{
    const checks={db:'up',mqtt:broker.connected?'up':'down'};
    try{db.prepare('SELECT 1').get();}catch{checks.db='down';}
    const ok=Object.values(checks).every(v=>v==='up');
    res.status(ok?200:503).json({status:ok?'ok':'degraded',checks});
  });
  app.get('/api/v1/metrics',auth,(req,res)=>{
    if(req.user.role!=='dispatcher')return err(res,403,'forbidden');
    res.json({...counters,connections:io.sockets.sockets.size,
      dispatchers:[...io.sockets.sockets.values()].filter(s=>s.data.user?.role==='dispatcher').length,sse:streams.size});
  });

  function sendEvent(stream,event){
    stream.res.write('id: '+event.id+'\nevent: telemetry\ndata: '+JSON.stringify(event)+'\n\n');
  }
  app.get('/api/v1/events',auth,(req,res)=>{
    const raw=req.get('Last-Event-ID')??'';
    if(raw && (!/^\d+$/.test(raw)||!Number.isSafeInteger(Number(raw))))return err(res,400,'invalid_event_id');
    res.set({'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform','X-Accel-Buffering':'no'});
    res.flushHeaders();res.write('retry: 1500\n: connected\n\n');
    const stream={user:req.user,res};
    const first=db.prepare('SELECT MIN(id) AS value FROM events').get().value;
    const last=db.prepare('SELECT MAX(id) AS value FROM events').get().value;
    if(raw && ((first!==null&&Number(raw)<first-1)||(last!==null&&Number(raw)>last))) res.write('event: reset\ndata: {}\n\n');
    else if(raw) for(const event of db.prepare('SELECT * FROM events WHERE id>? ORDER BY id').all(Number(raw))) {
      const d=deviceInfo(event.device);
      if(d && receives(req.user,d)) sendEvent(stream,event);
    }
    streams.add(stream);
    const timer=setInterval(()=>res.write(': ping\n\n'),15000);
    const expiry=setTimeout(()=>res.end(),Math.max(0,req.sessionExpires-Date.now())).unref();
    res.on('close',()=>{clearInterval(timer);clearTimeout(expiry);streams.delete(stream);});
  });
  io.use((socket,next)=>{
    try { const session=identify(socket.handshake.auth?.token);socket.data.user=session.user;socket.data.exp=session.exp;next(); }
    catch { next(new Error('unauthorized')); }
  });
  io.on('connection',socket=>{
    const user=socket.data.user;
    socket.join(user.role==='driver'?'device:'+user.vehicle:'fleet:'+user.region);
    const timer=setTimeout(()=>socket.disconnect(true),Math.max(0,socket.data.exp-Date.now())).unref();
    expiries.set(socket.id,timer);
    socket.on('disconnect',()=>{clearTimeout(timer);expiries.delete(socket.id);});
  });
  broker.on('message',(topic,payload)=>{
    const match=/^fleet\/([a-z0-9-]+)\/(telemetry|geofence)$/.exec(topic);
    if(!match || !deviceInfo(match[1]))return;
    const [_,id,kind]=match;
    if(payload.length>2048){counters.rejected++;return;}
    let data;try{data=JSON.parse(payload);}catch{counters.rejected++;return;}
    if(kind==='geofence'){
      if(Number.isSafeInteger(data?.ts)&&typeof data?.outside==='boolean'){
        const ins=db.prepare('INSERT OR IGNORE INTO geofence_events VALUES(?,?,?)').run(id,data.ts,Number(data.outside));
        if(ins.changes)counters.geofence++;
      }
      return;
    }
    counters.received++;
    const p=point(data);
    if(!p){counters.rejected++;return;}
    const insert=db.prepare('INSERT OR IGNORE INTO points VALUES(?,?,?,?)').run(id,p.metric,p.ts,p.value);
    if(!insert.changes){counters.duplicate++;return;}
    counters.stored++;
    const eventId=Number(db.prepare('INSERT INTO events(device,metric,ts,value) VALUES(?,?,?,?)').run(id,p.metric,p.ts,p.value).lastInsertRowid);
    db.prepare('DELETE FROM events WHERE id<=?').run(eventId-256);
    const d=deviceInfo(id), event={id:eventId,device:id,...p};
    io.to('device:'+id).to('fleet:'+d.region).emit('telemetry:update',event);
    for(const stream of streams) if(receives(stream.user,d))sendEvent(stream,event);
  });
  app.use('/api',(_req,res)=>err(res,404,'not_found'));
  if(existsSync(web))app.use(express.static(web));
  app.use((error,_req,res,_next)=>err(res,error.type==='entity.too.large'?413: error.status===400?400:500,error.status===400?'invalid_json':'request_failed'));
  return {http,counters,db,close:async()=>{
    for(const stream of streams) stream.res.end();
    for(const timer of expiries.values())clearTimeout(timer);
    await new Promise(resolve=>io.close(resolve));
    await new Promise(resolve=>broker.end(true,resolve));
    db.close();
  }};
}
