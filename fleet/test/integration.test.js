import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createServer} from 'node:net';
import aedes from 'aedes';
import mqtt from 'mqtt';
import {io} from 'socket.io-client';
import {createFleet} from '../src/server.js';
import {startGeofence} from '../src/geofence.js';

const password='training-fleet-password';
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){
  for(let i=0;i<75;i++){const result=await check();if(result)return result;await wait(40);}
  throw new Error('timed out');
}

test('MQTT, SQLite, REST, roles, Socket.IO rooms, SSE replay and optimistic settings', {timeout:20000}, async t=>{
  const broker=aedes(), net=createServer(broker.handle);
  net.listen(0,'127.0.0.1');await once(net,'listening');
  const mqttUrl='mqtt://127.0.0.1:'+net.address().port;
  const fleet=createFleet({mqttUrl,secret:'training-secret-with-at-least-32-characters',password});
  const geo=startGeofence(mqttUrl);
  const pub=mqtt.connect(mqttUrl);
  const sockets=[];
  t.after(async()=>{
    sockets.forEach(x=>x.disconnect());
    await pub.endAsync(true);await geo.endAsync(true);await fleet.close();
    await new Promise(resolve=>broker.close(resolve));await new Promise(resolve=>net.close(resolve));
  });
  fleet.http.listen(0,'127.0.0.1');await once(fleet.http,'listening');
  const root='http://127.0.0.1:'+fleet.http.address().port;
  const call=(path,token,options={})=>fetch(root+'/api/v1'+path,{...options,headers:{...(token?{Authorization:'Bearer '+token}:{}),...options.headers}});
  const json=(method,body,headers={})=>({method,headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
  const login=async name=>{
    const r=await call('/auth/login',null,json('POST',{username:name,password}));
    assert.equal(r.status,200);return r.json();
  };
  await until(async()=>(await call('/health')).ok);
  assert.equal((await call('/devices')).status,401);
  assert.equal((await call('/auth/login',null,json('POST',{username:'driver',password:'wrong'}))).status,401);
  const [west,east,driver]=await Promise.all(['dispatch-west','dispatch-east','driver'].map(login));
  const r=await call('/auth/refresh',null,json('POST',{refreshToken:driver.refreshToken}));
  assert.equal(r.status,200);assert.equal((await call('/auth/refresh',null,json('POST',{refreshToken:driver.refreshToken}))).status,401);
  assert.deepEqual((await (await call('/devices',driver.accessToken)).json()).map(x=>x.id),['truck-07']);
  assert.equal((await call('/telemetry?device=van-03&metric=lat',driver.accessToken)).status,403);
  assert.equal((await call('/telemetry?device=truck-07',west.accessToken)).status,400);
  assert.equal((await call('/telemetry?device=missing&metric=lat',west.accessToken)).status,404);
  assert.equal((await call('/telemetry?device=truck-07&metric=lat&from=3&to=2',west.accessToken)).status,400);
  const prepare=async token=>{
    const s=io(root,{auth:{token},transports:['websocket'],reconnection:false});
    sockets.push(s);
    return s;
  };
  const [sw,se,bad]=await Promise.all([prepare(west.accessToken),prepare(east.accessToken),prepare(null)]);
  const [err]=await Promise.all([once(bad,'connect_error'),once(sw,'connect'),once(se,'connect')]);
  assert.equal(err[0].message,'unauthorized');
  const westEvents=[],eastEvents=[];
  sw.on('telemetry:update',x=>westEvents.push(x));se.on('telemetry:update',x=>eastEvents.push(x));
  const now=Date.now()-1000;
  const publish=(id,metric,value,ts)=>pub.publishAsync('fleet/'+id+'/telemetry',JSON.stringify({ts,metric,value}),{qos:1});
  for(let i=0;i<3;i++){
    await publish('truck-07','lat',50.43+i*.001,now+i);
    await publish('truck-07','lon',30.51+i*.001,now+i);
  }
  await publish('truck-07','lat',50.43,now);
  await publish('truck-07','lat',93,now+5);
  await publish('van-03','lat',50.43,now);
  await publish('van-03','lon',30.62,now);
  await until(()=>westEvents.length===6 && eastEvents.length===2 && fleet.counters.geofence>=4);
  assert.equal(fleet.counters.duplicate,1);assert.equal(fleet.counters.rejected,1);
  assert.ok(westEvents.every(x=>x.device==='truck-07'));assert.ok(eastEvents.every(x=>x.device==='van-03'));
  assert.equal(fleet.db.prepare('SELECT outside FROM geofence_events WHERE device=?').get('van-03').outside,1);
  const get=async metric=>(await (await call('/telemetry?device=truck-07&metric='+metric,west.accessToken)).json()).points;
  assert.deepEqual((await get('lat')).map(x=>x.ts),(await get('lon')).map(x=>x.ts));
  const controller=new AbortController(), since=westEvents[0].id;
  const stream=await call('/events',west.accessToken,{headers:{'Last-Event-ID':String(since)},signal:controller.signal});
  const reader=stream.body.getReader();
  try{
    const {value}=await reader.read(), text=new TextDecoder().decode(value);
    const ids=[...text.matchAll(/^id: (\d+)$/gm)].map(x=>Number(x[1]));
    assert.deepEqual(ids,westEvents.slice(1).map(x=>x.id));
  }finally{controller.abort();await reader.cancel().catch(()=>{});}
  const path='/vehicles/truck-07/alert-settings';
  const old=(await call(path,west.accessToken)).headers.get('etag');
  const put=(token,tag,speedLimit)=>call(path,token,json('PUT',{speedLimit,fuelMinPercent:10},{'If-Match':tag}));
  assert.equal((await put(driver.accessToken,old,65)).status,403);
  assert.equal((await put(west.accessToken,old,63)).status,400);
  assert.equal((await put(west.accessToken,old,65)).status,200);
  assert.equal((await put(west.accessToken,old,70)).status,412);
  const csv=await(await call('/track?device=truck-07&format=csv',west.accessToken)).text();
  assert.equal(csv.split('\n').length,4);
  console.log(JSON.stringify({mqtt:{...fleet.counters},rooms:{west:westEvents.length,east:eastEvents.length},sseReplay:5,settings:[403,400,200,412]}));
});
