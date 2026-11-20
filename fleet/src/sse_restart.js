import {createServer} from 'node:net';
import {once} from 'node:events';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as wait} from 'node:timers/promises';
import aedes from 'aedes';
import mqtt from 'mqtt';
import assert from 'node:assert/strict';
import {createFleet} from './server.js';

const dir=await mkdtemp(join(tmpdir(),'fleet-sse-'));
const broker=aedes(), tcp=createServer(broker.handle);
tcp.listen(0,'127.0.0.1');await once(tcp,'listening');
const url='mqtt://127.0.0.1:'+tcp.address().port;
const config={database:join(dir,'fleet.sqlite'),mqttUrl:url,secret:'restart-lab-'+crypto.randomUUID(),password:'restart-demo-vehicle'};
const publisher=mqtt.connect(url);
await once(publisher,'connect');
let instance,base;
async function retry(fn){
  for(let i=0;i<50;i++){const value=await fn();if(value)return value;await wait(50);}
  throw new Error('timeout');
}
async function start(){
  instance=createFleet(config);
  instance.http.listen(0,'127.0.0.1');await once(instance.http,'listening');
  base='http://127.0.0.1:'+instance.http.address().port+'/api/v1';
  await retry(async()=>(await fetch(base+'/health')).ok);
  const reply=await fetch(base+'/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'dispatch-west',password:config.password})});
  assert.equal(reply.status,200);
  return (await reply.json()).accessToken;
}
async function read(count,token,cursor,before){
  const controller=new AbortController(),expiry=setTimeout(()=>controller.abort(),4000);
  const response=await fetch(base+'/events',{signal:controller.signal,headers:{Authorization:'Bearer '+token,...(cursor?{'Last-Event-ID':String(cursor)}:{})}});
  assert.equal(response.status,200);
  const reader=response.body.getReader(), decoder=new TextDecoder();
  let text='', ids=[];
  try{
    if(before)await before();
    while(ids.length<count){
      const item=await reader.read();if(item.done)break;
      text+=decoder.decode(item.value,{stream:true});
      ids=[...text.matchAll(/^id: (\d+)$/gm)].map(m=>Number(m[1]));
    }
  }finally{clearTimeout(expiry);controller.abort();await reader.cancel().catch(()=>{});}
  return ids;
}
const ts=Date.now();
const publish=async startIndex=>{
  for(let i=startIndex;i<startIndex+3;i++)await publisher.publishAsync('fleet/truck-07/telemetry', JSON.stringify({ts:ts+i,metric:'speed',value:50+i}),{qos:1});
};
try{
  const firstToken=await start();
  const first=await read(3,firstToken,null,()=>publish(0));
  assert.deepEqual(first,[1,2,3]);
  await instance.close();instance=null;
  const stop=Date.now();await wait(5000);
  const secondToken=await start();
  await publish(3);
  await retry(()=>instance.counters.stored===3);
  const replay=await read(3,secondToken,first.at(-1));
  assert.deepEqual(replay,[4,5,6]);
  console.log(JSON.stringify({first,pausedMs:Date.now()-stop,replay,duplicate:0,
    scope:'new messages accepted after server restart while client was still disconnected'},null,2));
}finally{
  if(instance)await instance.close();
  await publisher.endAsync(true);
  await new Promise(resolve=>broker.close(resolve));
  await new Promise(resolve=>tcp.close(resolve));
  await rm(dir,{recursive:true,force:true});
}
